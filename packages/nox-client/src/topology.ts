import { NoxClientError, NoxClientErrorCode } from "./types.js";
import type {
  TopologySnapshot,
  RelayerNode,
  TopologyNode,
  Route,
} from "./types.js";
import { hexToBytes, bytesToHex } from "./utils.js";

import sha3 from "js-sha3"; // CJS — no named ESM exports
const keccak_256 = sha3.keccak_256;

export async function fetchTopology(
  seedBaseUrl: string,
  timeoutMs = 5_000,
): Promise<TopologySnapshot> {
  const url = `${seedBaseUrl}/topology`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw new NoxClientError(
      `Topology fetch failed from ${url}: ${String(err)}`,
      NoxClientErrorCode.TopologyFetchFailed,
      err,
    );
  }
  clearTimeout(timer);

  if (!resp.ok) {
    throw new NoxClientError(
      `Topology fetch returned HTTP ${resp.status} from ${url}`,
      NoxClientErrorCode.TopologyFetchFailed,
    );
  }

  let snapshot: TopologySnapshot;
  try {
    snapshot = (await resp.json()) as TopologySnapshot;
  } catch (err) {
    throw new NoxClientError(
      `Topology response is not valid JSON from ${url}`,
      NoxClientErrorCode.TopologyFetchFailed,
      err,
    );
  }

  if (!Array.isArray(snapshot.nodes) || typeof snapshot.fingerprint !== "string") {
    throw new NoxClientError(
      `Topology response missing required fields (nodes, fingerprint) from ${url}`,
      NoxClientErrorCode.TopologyFetchFailed,
    );
  }

  return snapshot;
}

/** XOR of keccak256(address) for each node → 64-char hex fingerprint. */
export function computeTopologyFingerprint(nodes: RelayerNode[]): string {
  const xor = new Uint8Array(32);
  for (const node of nodes) {
    const addrHex = node.address.replace(/^0x/i, "").toLowerCase();
    const addrBytes = hexToBytes(addrHex);
    const hash = new Uint8Array(keccak_256.arrayBuffer(addrBytes));
    for (let i = 0; i < 32; i++) {
      xor[i]! ^= hash[i]!;
    }
  }
  return bytesToHex(xor);
}

/** Verify that the snapshot's fingerprint matches the computed one. */
export function verifySelfConsistency(snapshot: TopologySnapshot): void {
  const computed = computeTopologyFingerprint(snapshot.nodes);
  const claimed = snapshot.fingerprint.toLowerCase().replace(/^0x/, "");
  if (computed !== claimed) {
    throw new NoxClientError(
      `Topology fingerprint mismatch: computed ${computed}, got ${claimed}`,
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }
}

/** Verify the topology fingerprint against the on-chain NoxRegistry contract. */
export async function verifyOnChain(
  ethRpcUrl: string,
  registryAddress: string,
  expectedFingerprint: string,
): Promise<void> {
  const selector = "0x7a5f9f6f"; // keccak256("topologyFingerprint()")[:4]

  let onChainHex: string;
  try {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: registryAddress, data: selector }, "latest"],
    });
    const resp = await fetch(ethRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const json = (await resp.json()) as { result?: string; error?: { message: string } };
    if (json.error != null) {
      throw new Error(json.error.message);
    }
    onChainHex = (json.result ?? "").replace(/^0x/, "").toLowerCase();
  } catch (err) {
    throw new NoxClientError(
      `On-chain topology verification failed: ${String(err)}`,
      NoxClientErrorCode.TopologyVerificationFailed,
      err,
    );
  }

  const expected = expectedFingerprint.replace(/^0x/, "").toLowerCase();
  if (onChainHex !== expected) {
    throw new NoxClientError(
      `On-chain fingerprint mismatch: chain=${onChainHex}, computed=${expected}`,
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }
}

/** Parse a raw `RelayerNode` into a typed `TopologyNode`. Prefers `ingress_url` over `url`. */
export function parseNode(raw: RelayerNode): TopologyNode {
  const keyHex = raw.sphinx_key.replace(/^0x/i, "");
  if (keyHex.length !== 64) {
    throw new NoxClientError(
      `Node ${raw.address}: sphinx_key must be 64 hex chars, got ${keyHex.length}`,
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }

  return {
    id: normalizeAddress(raw.address),
    address: raw.ingress_url ?? raw.url,
    routingAddress: raw.url,
    publicKey: hexToBytes(keyHex),
    layer: raw.layer,
    role: raw.role,
  };
}

export function parseNodes(snapshot: TopologySnapshot): TopologyNode[] {
  return snapshot.nodes.map(parseNode);
}

/** Select a random 3-hop route (entry, mix, exit). */
export function selectRoute(
  nodes: TopologyNode[],
  pinnedEntry?: TopologyNode,
): Route {
  const entries = nodes.filter((n) => layersForRole(n.role).includes(0));
  const mixes = nodes.filter((n) => layersForRole(n.role).includes(1));
  const exits = nodes.filter((n) => layersForRole(n.role).includes(2) && (n.role === 2 || n.role === 3));

  if (entries.length === 0) {
    throw new NoxClientError("No entry nodes available", NoxClientErrorCode.NoNodesAvailable);
  }
  if (mixes.length === 0) {
    throw new NoxClientError("No mix nodes available", NoxClientErrorCode.NoNodesAvailable);
  }
  if (exits.length === 0) {
    throw new NoxClientError("No exit nodes available", NoxClientErrorCode.NoNodesAvailable);
  }

  const entryOnly = entries.filter((n) => !exits.some((e) => e.id === n.id));
  const entry = pinnedEntry ?? pickRandom(entryOnly) ?? pickRandom(entries)!;

  const eligibleMixes = mixes.filter((n) => n.id !== entry.id);
  const mixOnly = eligibleMixes.filter((n) => !exits.some((e) => e.id === n.id));
  const mix = pickRandom(mixOnly) ?? pickRandom(eligibleMixes) ?? pickRandom(mixes)!;

  const eligibleExits = exits.filter((n) => n.id !== entry.id && n.id !== mix.id);
  const exit = pickRandom(eligibleExits) ?? pickRandom(exits)!;

  return { entry, mix, exit };
}

/** Layers a node can serve: Relay=[0,1], Exit/Full=[0,1,2]. */
export function layersForRole(role: number): number[] {
  switch (role) {
    case 1:
      return [0, 1];
    default:
      return [0, 1, 2];
  }
}

function pickRandom<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeAddress(addr: string): string {
  const hex = addr.replace(/^0x/i, "").toLowerCase();
  return `0x${hex}`;
}
