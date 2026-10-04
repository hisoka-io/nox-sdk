// Local Nox mesh: N real `nox` processes started by nox-sim's nox_mesh_server
// (benchmark mode, topology injected through each node's admin endpoint).
// Exits run the HTTP + Echo + simulation-RPC services with private targets
// allowed, so the local anvil is reachable as an HttpRequest target.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MeshConfig, MeshRole, NoxBinaries } from "./config.js";
import { TestbedError } from "./errors.js";
import { assertTcpPortsFree, meshPorts } from "./ports.js";
import { delay, ManagedProcess } from "./process.js";

/** Poll interval while waiting for mesh_info.json. */
const MESH_INFO_POLL_MS = 250;

export interface MeshNodeInfo {
  readonly id: number;
  readonly p2pPort: number;
  readonly metricsPort: number;
  readonly ingressPort: number;
  readonly sphinxPublicKey: string;
  readonly peerId: string;
  readonly p2pMultiaddr: string;
  readonly role: MeshRole;
  /** Registry-style address the mesh registers this node under (process_mesh::mesh_node_address). */
  readonly address: string;
  readonly ingressUrl: string;
  /** Node-served topology (the metrics port also serves GET /topology). */
  readonly topologyUrl: string;
}

export interface MeshInfo {
  readonly nodeCount: number;
  readonly entryUrl: string;
  readonly anvilRpcUrl: string;
  readonly nodes: readonly MeshNodeInfo[];
}

export interface RunningMesh {
  readonly info: MeshInfo;
  readonly dataDir: string;
  readonly logFile: string;
  /** Seed URL for the classic SDK path (node 0's topology endpoint). */
  readonly seedUrl: string;
  stop(): Promise<void>;
}

function field<T>(record: Record<string, unknown>, key: string, check: (v: unknown) => v is T, where: string): T {
  const value = record[key];
  if (!check(value)) {
    throw new TestbedError("mesh-info", `${where}.${key} has an unexpected value: ${JSON.stringify(value)}`);
  }
  return value;
}

const isPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) < 65_536;
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isHex32 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/u.test(v);
const isRole = (v: unknown): v is MeshRole => v === 1 || v === 2 || v === 3;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isNodeId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** Registry address nox_mesh_server registers node `id` under (crates/nox-sim/src/process_mesh.rs). */
export function meshNodeAddress(id: number): string {
  return `0x${(0xb0_0000 + id).toString(16).padStart(40, "0")}`;
}

/** Validate the JSON nox_mesh_server writes to <data-dir>/mesh_info.json. */
export function parseMeshInfo(json: unknown): MeshInfo {
  if (typeof json !== "object" || json === null) throw new TestbedError("mesh-info", "mesh_info is not an object");
  const root = json as Record<string, unknown>;
  const nodeCount = field(root, "node_count", isCount, "mesh_info");
  const entryUrl = field(root, "entry_url", isString, "mesh_info");
  const anvilRpcUrl = field(root, "anvil_rpc_url", isString, "mesh_info");
  const rawNodes = root["nodes"];
  if (!Array.isArray(rawNodes) || rawNodes.length !== nodeCount) {
    throw new TestbedError("mesh-info", `mesh_info.nodes must list ${nodeCount} nodes`);
  }
  const nodes = rawNodes.map((raw: unknown, index): MeshNodeInfo => {
    if (typeof raw !== "object" || raw === null) {
      throw new TestbedError("mesh-info", `mesh_info.nodes[${index}] is not an object`);
    }
    const node = raw as Record<string, unknown>;
    const where = `mesh_info.nodes[${index}]`;
    const id = field(node, "id", isNodeId, where);
    const metricsPort = field(node, "metrics_port", isPort, where);
    const ingressPort = field(node, "ingress_port", isPort, where);
    return {
      id,
      p2pPort: field(node, "p2p_port", isPort, where),
      metricsPort,
      ingressPort,
      sphinxPublicKey: field(node, "sphinx_public_key", isHex32, where),
      peerId: field(node, "peer_id", isString, where),
      p2pMultiaddr: field(node, "p2p_multiaddr", isString, where),
      role: field(node, "role", isRole, where),
      address: meshNodeAddress(id),
      ingressUrl: `http://127.0.0.1:${ingressPort}`,
      topologyUrl: `http://127.0.0.1:${metricsPort}/topology`,
    };
  });
  nodes.forEach((node, index) => {
    if (node.id !== index) throw new TestbedError("mesh-info", `mesh_info.nodes[${index}].id is ${node.id}`);
  });
  return { nodeCount, entryUrl, anvilRpcUrl, nodes };
}

export interface StartMeshOptions {
  readonly binaries: NoxBinaries;
  readonly config: MeshConfig;
  readonly upstreamAnvilPort: number;
  readonly dataDir: string;
  readonly logDir: string;
}

function assertBinary(path: string, what: string, repo: string): void {
  if (!existsSync(path)) {
    throw new TestbedError(
      "prerequisite",
      `${what} not found at ${path}. Build it in the nox checkout (${repo}):\n` +
        "  cargo build --release --bin nox\n" +
        "  cargo build --release -p nox-sim --bin nox_mesh_server --features dev-node\n" +
        "or point NOX_REPO / NOX_BIN / NOX_MESH_BIN at existing binaries.",
    );
  }
}

/** Start nox_mesh_server and wait for mesh_info.json. */
export async function startMesh(options: StartMeshOptions): Promise<RunningMesh> {
  const { binaries, config } = options;
  assertBinary(binaries.noxBin, "nox", binaries.repo);
  assertBinary(binaries.meshBin, "nox_mesh_server", binaries.repo);
  await assertTcpPortsFree(meshPorts(config.basePort, config.nodes), "local Nox mesh");

  const logFile = join(options.logDir, "mesh-server.log");
  const proc = ManagedProcess.start({
    label: "nox_mesh_server",
    command: binaries.meshBin,
    args: [
      "--nodes", String(config.nodes),
      "--roles", config.roles.join(","),
      "--data-dir", options.dataDir,
      "--base-port", String(config.basePort),
      "--anvil-port", String(options.upstreamAnvilPort),
      "--mix-delay-ms", String(config.mixDelayMs),
      "--nox-binary", binaries.noxBin,
    ],
    // Keep node logs after teardown for post-mortems (<data-dir>/node_N/node.log).
    env: { NOX_KEEP_LOGS: "1" },
    logFile,
    processGroup: true,
  });

  const infoPath = join(options.dataDir, "mesh_info.json");
  const deadline = Date.now() + config.startupTimeoutMs;
  let info: MeshInfo | undefined;
  try {
    while (info === undefined) {
      proc.assertRunning("before writing mesh_info.json");
      if (existsSync(infoPath)) {
        try {
          info = parseMeshInfo(JSON.parse(readFileSync(infoPath, "utf8")));
        } catch (error) {
          // The file may be mid-write; a malformed complete file fails at the deadline.
          if (Date.now() > deadline) throw error;
        }
      }
      if (info === undefined) {
        if (Date.now() > deadline) {
          throw new TestbedError(
            "timeout",
            `mesh not ready within ${config.startupTimeoutMs} ms (log: ${logFile})\n${proc.tail()}`,
          );
        }
        await delay(MESH_INFO_POLL_MS);
      }
    }
  } catch (error) {
    await proc.stop("SIGINT", config.teardownGraceMs);
    throw error;
  }

  const first = info.nodes[0];
  if (first === undefined) throw new TestbedError("mesh-info", "mesh has no nodes");
  return {
    info,
    dataDir: options.dataDir,
    logFile,
    seedUrl: `http://127.0.0.1:${first.metricsPort}`,
    // SIGINT runs the server's own teardown (kills every node); the process
    // group SIGKILL afterwards catches anything left behind.
    stop: () => proc.stop("SIGINT", config.teardownGraceMs),
  };
}
