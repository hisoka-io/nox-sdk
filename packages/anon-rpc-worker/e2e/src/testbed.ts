// Composition of the test-bed pieces, shared by the Playwright fixtures and the
// long-running `pnpm testbed` CLI.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startAnvil, type AnvilChain } from "./anvil.js";
import { sidecarAdminPort, sidecarUdpPort, type TestbedConfig } from "./config.js";
import { ContentStore } from "./content-store.js";
import { TestbedError } from "./errors.js";
import { startSidecar, type RunningKpsServer } from "./kps-server.js";
import { startMesh, type MeshNodeInfo, type RunningMesh } from "./mesh.js";
import { startResolverServer, type ResolverServer } from "./resolver-server.js";
import { deploySpecifier } from "./specifier.js";

/** Directory of one test-bed run: logs, mesh data, KPS keys, reports. */
export interface RunPaths {
  readonly root: string;
  readonly logs: string;
  readonly mesh: string;
  readonly kps: string;
  readonly keccak: string;
  readonly reports: string;
}

export function createRunPaths(config: TestbedConfig, label: string): RunPaths {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const root = join(config.runDir, `${stamp}-${label}-${process.pid}`);
  const paths: RunPaths = {
    root,
    logs: join(root, "logs"),
    mesh: join(root, "mesh"),
    kps: join(root, "kps"),
    keccak: join(root, "keccak"),
    reports: join(root, "reports"),
  };
  for (const dir of [paths.logs, paths.kps, paths.keccak, paths.reports]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config.runDir, "latest-run.txt"), `${root}\n`);
  return paths;
}

export interface Chains {
  /** Holds the WorkerSpecifier (stands in for Ethereum mainnet). */
  readonly specifier: AnvilChain;
  /** The wallet's RPC target; the exits' HttpRequest destination. */
  readonly upstream: AnvilChain;
  stop(): Promise<void>;
}

export async function startChains(config: TestbedConfig, paths: RunPaths): Promise<Chains> {
  const specifier = await startAnvil(config.anvil, {
    label: "anvil-specifier",
    chainId: config.anvil.specifierChainId,
    logDir: paths.logs,
  });
  let upstream: AnvilChain;
  try {
    upstream = await startAnvil(config.anvil, {
      label: "anvil-upstream",
      chainId: config.anvil.upstreamChainId,
      logDir: paths.logs,
    });
  } catch (error) {
    await specifier.stop();
    throw error;
  }
  return {
    specifier,
    upstream,
    stop: async () => {
      await Promise.all([specifier.stop(), upstream.stop()]);
    },
  };
}

export interface Resolver {
  readonly store: ContentStore;
  readonly server: ResolverServer;
}

export async function startResolver(): Promise<Resolver> {
  const store = new ContentStore();
  return { store, server: await startResolverServer(store) };
}

export interface PublishedWorker {
  /** WorkerSpecifier address on the specifier chain. */
  readonly address: string;
  readonly workerHash: string;
  readonly resolvers: readonly string[];
  readonly bytes: number;
}

/**
 * Put `bundle` in the resolver store and deploy a WorkerSpecifier pinning it,
 * with the local resolver as the only resolver (plus any `extraResolvers`
 * listed first, e.g. failing entries for fall-through tests).
 */
export async function publishWorker(
  chains: Chains,
  resolver: Resolver,
  bundle: Uint8Array,
  extraResolvers: readonly string[] = [],
): Promise<PublishedWorker> {
  const workerHash = resolver.store.put(bundle);
  const resolvers = [...extraResolvers, resolver.server.urlFor(workerHash)];
  const address = await deploySpecifier(chains.specifier.url, chains.specifier.account, { workerHash, resolvers });
  return { address, workerHash, resolvers, bytes: bundle.length };
}

export interface MeshWithSidecars {
  readonly mesh: RunningMesh;
  /** nox-kps sidecar per node id; empty when NOX_KPS_CMD is unset. */
  readonly sidecars: ReadonlyMap<number, RunningKpsServer>;
  stop(): Promise<void>;
}

export async function startMeshWithSidecars(
  config: TestbedConfig,
  paths: RunPaths,
  upstream: AnvilChain,
): Promise<MeshWithSidecars> {
  const mesh = await startMesh({
    binaries: config.nox,
    config: config.mesh,
    upstreamAnvilPort: upstream.port,
    dataDir: paths.mesh,
    logDir: paths.logs,
  });
  const sidecars = new Map<number, RunningKpsServer>();
  const stopAll = async (): Promise<void> => {
    await Promise.all([...sidecars.values()].map((sidecar) => sidecar.stop()));
    await mesh.stop();
  };
  if (config.kps.sidecarCommand !== undefined) {
    try {
      for (const node of mesh.info.nodes) {
        const udpPort = sidecarUdpPort(config.mesh.basePort, node.id);
        sidecars.set(
          node.id,
          await startSidecar({
            commandTemplate: config.kps.sidecarCommand,
            initCommandTemplate: config.kps.sidecarInitCommand,
            configTemplate: config.kps.sidecarConfigTemplate,
            logDir: paths.logs,
            addressTimeoutMs: config.kps.addressTimeoutMs,
            vars: {
              node: node.id,
              node_address: node.address,
              udp_port: udpPort,
              advertise_ip: config.kps.advertiseIp,
              listen: `${config.kps.advertiseIp}:${udpPort}`,
              ingress_port: node.ingressPort,
              ingress_url: node.ingressUrl,
              topology_port: node.metricsPort,
              topology_url: node.topologyUrl,
              admin_port: sidecarAdminPort(config.mesh.basePort, node.id),
              key_file: join(paths.kps, `node-${node.id}.key`),
              config_file: join(paths.kps, `node-${node.id}.conf`),
              bundle_dir: paths.keccak,
            },
          }),
        );
      }
    } catch (error) {
      await stopAll();
      throw error;
    }
  }
  return { mesh, sidecars, stop: stopAll };
}

/** Machine-readable description of a running test bed (written to testbed.json). */
export interface TestbedInfo {
  readonly generatedAt: string;
  readonly runDir: string;
  readonly specifierChain: { readonly url: string; readonly chainId: number };
  readonly upstreamChain: { readonly url: string; readonly chainId: number };
  readonly resolverOrigin: string;
  readonly hostPageOrigin?: string;
  readonly mesh?: {
    readonly mixDelayMs: number;
    readonly seedUrl: string;
    readonly nodes: readonly (MeshNodeInfo & { readonly kpsAddress?: string })[];
  };
  readonly workers?: Readonly<Record<string, PublishedWorker>>;
}

export interface TestbedInfoInput {
  readonly config: TestbedConfig;
  readonly paths: RunPaths;
  readonly chains: Chains;
  readonly resolver: Resolver;
  readonly hostPageOrigin?: string;
  readonly mesh?: MeshWithSidecars;
  readonly workers?: Readonly<Record<string, PublishedWorker>>;
}

export function describeTestbed(input: TestbedInfoInput): TestbedInfo {
  const { mesh } = input;
  return {
    generatedAt: new Date().toISOString(),
    runDir: input.paths.root,
    specifierChain: { url: input.chains.specifier.url, chainId: input.chains.specifier.chainId },
    upstreamChain: { url: input.chains.upstream.url, chainId: input.chains.upstream.chainId },
    resolverOrigin: input.resolver.server.origin,
    ...(input.hostPageOrigin === undefined ? {} : { hostPageOrigin: input.hostPageOrigin }),
    ...(mesh === undefined
      ? {}
      : {
        mesh: {
          mixDelayMs: input.config.mesh.mixDelayMs,
          seedUrl: mesh.mesh.seedUrl,
          nodes: mesh.mesh.info.nodes.map((node) => {
            const sidecar = mesh.sidecars.get(node.id);
            return sidecar === undefined ? node : { ...node, kpsAddress: sidecar.address };
          }),
        },
      }),
    ...(input.workers === undefined ? {} : { workers: input.workers }),
  };
}

export function writeTestbedInfo(paths: RunPaths, info: TestbedInfo): string {
  const path = join(paths.root, "testbed.json");
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);
  return path;
}

/**
 * The config handed to the Nox worker. Precedence: NOX_WORKER_CONFIG (a JSON
 * file used verbatim), then NOX_WORKER_CONFIG_MODULE (exports
 * buildWorkerConfig(info)), then the default below, which follows the
 * `gateways` shape of the adopters.json5 exampleConfig convention.
 */
export async function workerConfigFor(config: TestbedConfig, info: TestbedInfo): Promise<unknown> {
  if (config.worker.configPath !== undefined) {
    return JSON.parse(readFileSync(config.worker.configPath, "utf8")) as unknown;
  }
  if (config.worker.configModule !== undefined) {
    if (!existsSync(config.worker.configModule)) {
      throw new TestbedError("config", `NOX_WORKER_CONFIG_MODULE ${config.worker.configModule} does not exist`);
    }
    const module = (await import(pathToFileURL(config.worker.configModule).href)) as {
      buildWorkerConfig?: (testbed: TestbedInfo) => unknown;
    };
    if (typeof module.buildWorkerConfig !== "function") {
      throw new TestbedError("config", `${config.worker.configModule} must export buildWorkerConfig(testbed)`);
    }
    return await module.buildWorkerConfig(info);
  }
  return defaultWorkerConfig(info);
}

export function defaultWorkerConfig(info: TestbedInfo): { gateways: string[]; logLevel: string } {
  const gateways = (info.mesh?.nodes ?? [])
    .map((node) => node.kpsAddress)
    .filter((address): address is string => address !== undefined);
  return { gateways, logLevel: "debug" };
}
