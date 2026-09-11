import { NoxClientError, NoxClientErrorCode } from "./types.js";
import type {
  TopologySnapshot,
  RelayerNode,
  TopologyLiveness,
  TopologyNode,
  Route,
} from "./types.js";
import { hexToBytes, bytesToHex, secureRandomIndex } from "./utils.js";

import sha3 from "js-sha3"; // CJS — no named ESM exports
import { Interface, sha256, toUtf8Bytes } from "ethers";
const keccak_256 = sha3.keccak_256;

const REGISTRY_INTERFACE = new Interface([
  "function topologyFingerprint() view returns (bytes32)",
  "function relayerCount() view returns (uint256)",
  "function relayers(address) view returns (bytes32 sphinxKey,string url,string ingressUrl,string metadataUrl,uint256 stakedAmount,uint256 unlockTime,bool isRegistered,uint8 status,bool frozen)",
  "function getNodeRole(address) view returns (uint8)",
]);

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

  let candidate: unknown;
  try {
    candidate = await resp.json();
  } catch (err) {
    throw new NoxClientError(
      `Topology response is not valid JSON from ${url}`,
      NoxClientErrorCode.TopologyFetchFailed,
      err,
    );
  }

  if (!isTopologySnapshot(candidate)) {
    throw new NoxClientError(
      `Topology response has invalid topology fields from ${url}`,
      NoxClientErrorCode.TopologyFetchFailed,
    );
  }

  return candidate;
}

function isTopologySnapshot(value: unknown): value is TopologySnapshot {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return false;
  if (
    typeof value.fingerprint !== "string" ||
    !/^(?:0x)?[0-9a-fA-F]{64}$/u.test(value.fingerprint)
  ) {
    return false;
  }
  for (const field of [
    "schema_version",
    "timestamp",
    "block_number",
    "pow_difficulty",
  ] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (!Number.isSafeInteger(candidate) || Number(candidate) < 0)
    ) {
      return false;
    }
  }
  if (!value.nodes.every(
    (node) =>
      isRecord(node) &&
      typeof node.address === "string" &&
      /^0x[0-9a-fA-F]{40}$/u.test(node.address) &&
      typeof node.sphinx_key === "string" &&
      /^[0-9a-fA-F]{64}$/u.test(node.sphinx_key) &&
      typeof node.url === "string" &&
      node.url.length > 0 &&
      typeof node.stake === "string" &&
      /^(?:0|[1-9][0-9]*)$/u.test(node.stake) &&
      Number.isSafeInteger(node.last_seen) &&
      Number(node.last_seen) >= 0 &&
      typeof node.is_privileged === "boolean" &&
      Number.isSafeInteger(node.layer) &&
      Number(node.layer) >= 0 &&
      Number.isSafeInteger(node.role) &&
      Number(node.role) >= 1 &&
      Number(node.role) <= 3 &&
      (node.ingress_url === undefined || typeof node.ingress_url === "string") &&
      (node.metadata_url === undefined || typeof node.metadata_url === "string"),
  )) {
    return false;
  }
  return value.liveness === undefined || (
    Array.isArray(value.liveness) &&
    value.liveness.every(isTopologyLiveness)
  );
}

function isTopologyLiveness(value: unknown): value is TopologyLiveness {
  return isRecord(value) &&
    typeof value.address === "string" &&
    /^0x[0-9a-fA-F]{40}$/u.test(value.address) &&
    (value.status === "online" || value.status === "offline") &&
    Number.isSafeInteger(value.observed_at_unix) &&
    Number(value.observed_at_unix) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
export function verifySelfConsistency(
  snapshot: TopologySnapshot,
  requireCompleteLiveness = false,
): void {
  validateSnapshotNodes(snapshot.nodes);
  validateLiveness(snapshot, requireCompleteLiveness);
  const computed = computeTopologyFingerprint(snapshot.nodes);
  const claimed = snapshot.fingerprint.toLowerCase().replace(/^0x/, "");
  if (computed !== claimed) {
    throw new NoxClientError(
      `Topology fingerprint mismatch: computed ${computed}, got ${claimed}`,
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }
}

function validateLiveness(
  snapshot: TopologySnapshot,
  requireCompleteLiveness: boolean,
): void {
  const schemaVersion = snapshot.schema_version ?? 1;
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion !== 1 && schemaVersion !== 2)) {
    throw new NoxClientError(
      `Unsupported topology schema_version ${String(snapshot.schema_version)}`,
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }
  if (schemaVersion !== 2) {
    if (requireCompleteLiveness) {
      throw new NoxClientError(
        "Topology schema_version 2 with complete liveness is required",
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    return;
  }
  if (
    snapshot.block_number === undefined ||
    snapshot.block_number <= 0 ||
    snapshot.timestamp === undefined ||
    snapshot.timestamp <= 0 ||
    snapshot.liveness === undefined
  ) {
    throw new NoxClientError(
      "Topology schema_version 2 requires a pinned block, timestamp, and liveness set",
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }

  const memberAddresses = snapshot.nodes.map((node) => normalizeAddress(node.address));
  const livenessAddresses = snapshot.liveness.map((observation) =>
    normalizeAddress(observation.address)
  );
  if (!isCanonicalAddressOrder(memberAddresses) || !isCanonicalAddressOrder(livenessAddresses)) {
    throw new NoxClientError(
      "Topology schema_version 2 members and liveness must use canonical address ordering",
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }
  for (const node of snapshot.nodes) {
    const expectedLayer = primaryLayerForRole(node.address, node.role);
    if (node.layer !== expectedLayer) {
      throw new NoxClientError(
        `Topology node ${node.address} primary layer expected=${expectedLayer} actual=${node.layer}`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
  }
  const members = new Set(memberAddresses);
  const observations = new Set<string>();
  for (const observation of snapshot.liveness) {
    const address = normalizeAddress(observation.address);
    if (!members.has(address)) {
      throw new NoxClientError(
        `Topology liveness contains non-member ${observation.address}`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    if (observations.has(address)) {
      throw new NoxClientError(
        `Topology liveness contains duplicate member ${observation.address}`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    observations.add(address);
  }
  if (observations.size !== members.size) {
    throw new NoxClientError(
      "Topology liveness does not cover every registered member",
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }
}

function isCanonicalAddressOrder(addresses: readonly string[]): boolean {
  return addresses.every((address, index) => index === 0 || addresses[index - 1]! < address);
}

function primaryLayerForRole(address: string, role: number): number {
  const firstHashByte = Number.parseInt(
    sha256(toUtf8Bytes(normalizeAddress(address))).slice(2, 4),
    16,
  );
  switch (role) {
    case 1:
      return firstHashByte % 2;
    case 2:
      return 2;
    default:
      return firstHashByte % 3;
  }
}

/** Select only indexer-live members after membership has been chain-verified. */
export function selectLiveNodes(
  snapshot: TopologySnapshot,
  nowUnix: number,
  maxAgeSeconds: number,
): RelayerNode[] {
  if (
    !Number.isSafeInteger(nowUnix) ||
    nowUnix < 0 ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds <= 0
  ) {
    throw new NoxClientError(
      "Liveness selection requires non-negative time and positive maximum age",
      NoxClientErrorCode.InvalidConfig,
    );
  }
  validateLiveness(snapshot, true);
  const livenessByAddress = new Map(
    snapshot.liveness!.map((observation) => [
      normalizeAddress(observation.address),
      observation,
    ]),
  );
  return snapshot.nodes.filter((node) => {
    const observation = livenessByAddress.get(normalizeAddress(node.address));
    return observation !== undefined &&
      observation.status === "online" &&
      observation.observed_at_unix <= nowUnix &&
      nowUnix - observation.observed_at_unix <= maxAgeSeconds;
  });
}

/** Verify the topology fingerprint against the on-chain NoxRegistry contract. */
export async function verifyOnChain(
  ethRpcUrl: string,
  registryAddress: string,
  nodes: RelayerNode[],
  snapshotBlockNumber?: number,
): Promise<void> {
  await verifyOnChainWithEligibility(
    ethRpcUrl,
    registryAddress,
    nodes,
    snapshotBlockNumber,
  );
}

/** Verify every registered member, then return the subset eligible for routing. */
export async function verifyOnChainWithEligibility(
  ethRpcUrl: string,
  registryAddress: string,
  nodes: RelayerNode[],
  snapshotBlockNumber?: number,
): Promise<Set<string>> {
  validateSnapshotNodes(nodes);
  const expectedFingerprint = computeTopologyFingerprint(nodes);
  if (
    snapshotBlockNumber !== undefined &&
    (!Number.isSafeInteger(snapshotBlockNumber) || snapshotBlockNumber < 0)
  ) {
    throw new NoxClientError(
      "Topology snapshot block_number must be a non-negative safe integer",
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }
  const blockTag = snapshotBlockNumber === undefined || snapshotBlockNumber === 0
    ? await rpcRequest(ethRpcUrl, "eth_blockNumber", [])
    : `0x${snapshotBlockNumber.toString(16)}`;
  const fingerprint = await registryCall(
    ethRpcUrl,
    registryAddress,
    "topologyFingerprint",
    [],
    blockTag,
  );
  const onChainFingerprint = String(fingerprint[0]).replace(/^0x/u, "").toLowerCase();
  if (onChainFingerprint !== expectedFingerprint) {
    throw new NoxClientError(
      `On-chain fingerprint mismatch: chain=${onChainFingerprint}, computed=${expectedFingerprint}`,
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }

  const count = await registryCall(
    ethRpcUrl,
    registryAddress,
    "relayerCount",
    [],
    blockTag,
  );
  if (BigInt(String(count[0])) !== BigInt(nodes.length)) {
    throw new NoxClientError(
      `On-chain relayer count mismatch: seed=${nodes.length}, chain=${String(count[0])}`,
      NoxClientErrorCode.TopologyVerificationFailed,
    );
  }

  const eligibleAddresses = new Set<string>();
  for (const node of nodes) {
    const profile = await registryCall(
      ethRpcUrl,
      registryAddress,
      "relayers",
      [node.address],
      blockTag,
    );
    const role = await registryCall(
      ethRpcUrl,
      registryAddress,
      "getNodeRole",
      [node.address],
      blockTag,
    );
    const chainStake = BigInt(String(profile[4]));
    const mismatches: string[] = [];
    recordMismatch(
      mismatches,
      "sphinxKey",
      node.sphinx_key.replace(/^0x/u, "").toLowerCase(),
      String(profile[0]).replace(/^0x/u, "").toLowerCase(),
    );
    recordMismatch(mismatches, "url", node.url, profile[1]);
    recordMismatch(
      mismatches,
      "ingressUrl",
      node.ingress_url ?? "",
      profile[2],
    );
    recordMismatch(
      mismatches,
      "metadataUrl",
      node.metadata_url ?? "",
      profile[3],
    );
    recordMismatch(mismatches, "stake", BigInt(node.stake), chainStake);
    recordMismatch(
      mismatches,
      "isPrivileged",
      node.is_privileged,
      chainStake === 0n,
    );
    recordMismatch(mismatches, "isRegistered", true, profile[6]);
    recordMismatch(mismatches, "role", node.role, Number(role[0]));
    if (mismatches.length > 0) {
      throw new NoxClientError(
        `Topology node ${node.address} differs from NoxRegistry: ${mismatches.join(", ")}`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    const chainStatus = Number(profile[7]);
    if ((chainStatus === 1 || chainStatus === 2) && profile[8] === false) {
      eligibleAddresses.add(normalizeAddress(node.address));
    }
  }
  return eligibleAddresses;
}

function recordMismatch(
  mismatches: string[],
  field: string,
  expected: unknown,
  actual: unknown,
): void {
  if (String(expected) !== String(actual)) {
    mismatches.push(
      `${field} expected=${diagnosticValue(field, expected)} actual=${diagnosticValue(field, actual)}`,
    );
  }
}

function diagnosticValue(field: string, value: unknown): string {
  if (field === "url" || field === "ingressUrl" || field === "metadataUrl") {
    return `keccak256:${keccak_256(String(value)).slice(0, 16)}`;
  }
  return boundedValue(value);
}

function boundedValue(value: unknown): string {
  const rendered = String(value).replace(/[\u0000-\u001f\u007f]/gu, "?");
  return rendered.length <= 96 ? rendered : `${rendered.slice(0, 93)}...`;
}

async function registryCall(
  ethRpcUrl: string,
  registryAddress: string,
  method: string,
  args: readonly unknown[],
  blockTag: string,
): Promise<readonly unknown[]> {
  const data = REGISTRY_INTERFACE.encodeFunctionData(method, args);
  const result = await rpcRequest(ethRpcUrl, "eth_call", [
    { to: registryAddress, data },
    blockTag,
  ]);
  try {
    return REGISTRY_INTERFACE.decodeFunctionResult(method, result);
  } catch (error) {
    throw new NoxClientError(
      `On-chain topology verification failed decoding ${method}: ${String(error)}`,
      NoxClientErrorCode.TopologyVerificationFailed,
      error,
    );
  }
}

async function rpcRequest(
  ethRpcUrl: string,
  method: string,
  params: readonly unknown[],
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(ethRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });
    const json = (await response.json()) as {
      result?: unknown;
      error?: { message?: unknown };
    };
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (typeof json.error?.message === "string") {
      throw new Error(json.error.message);
    }
    if (typeof json.result !== "string") {
      throw new Error("RPC response has no hex result");
    }
    return json.result;
  } catch (error) {
    if (error instanceof NoxClientError) throw error;
    throw new NoxClientError(
      `On-chain topology verification failed during ${method}: ${String(error)}`,
      NoxClientErrorCode.TopologyVerificationFailed,
      error,
    );
  } finally {
    clearTimeout(timer);
  }
}

function validateSnapshotNodes(nodes: RelayerNode[]): void {
  const addresses = new Set<string>();
  for (const node of nodes) {
    if (!/^0x[0-9a-fA-F]{40}$/u.test(node.address)) {
      throw new NoxClientError(
        `Topology node has invalid Ethereum address: ${node.address}`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    const normalized = node.address.toLowerCase();
    if (addresses.has(normalized)) {
      throw new NoxClientError(
        `Topology contains duplicate node address: ${node.address}`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    addresses.add(normalized);
    if (!/^[0-9a-fA-F]{64}$/u.test(node.sphinx_key)) {
      throw new NoxClientError(
        `Topology node ${node.address} has invalid Sphinx key`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(node.stake)) {
      throw new NoxClientError(
        `Topology node ${node.address} has invalid stake`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    if (
      typeof node.url !== "string" ||
      typeof node.ingress_url !== "undefined" && typeof node.ingress_url !== "string" ||
      typeof node.metadata_url !== "undefined" && typeof node.metadata_url !== "string" ||
      typeof node.is_privileged !== "boolean"
    ) {
      throw new NoxClientError(
        `Topology node ${node.address} has invalid profile fields`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    if (node.role < 1 || node.role > 3) {
      throw new NoxClientError(
        `Topology node ${node.address} has unsupported role ${node.role}`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
    if (!layersForRole(node.role).includes(node.layer)) {
      throw new NoxClientError(
        `Topology node ${node.address} has layer ${node.layer} outside role ${node.role}`,
        NoxClientErrorCode.TopologyVerificationFailed,
      );
    }
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
    address: raw.ingress_url ?? "",
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
  selectedExit?: TopologyNode,
): Route {
  const entries = nodes.filter(
    (node) =>
      layersForRole(node.role).includes(0) && hasUsableIngress(node.address),
  );
  const mixes = nodes.filter((node) => layersForRole(node.role).includes(1));
  const exits = nodes.filter(
    (node) =>
      layersForRole(node.role).includes(2) &&
      (node.role === 2 || node.role === 3),
  );

  if (entries.length === 0) {
    throw new NoxClientError("No entry nodes available", NoxClientErrorCode.NoNodesAvailable);
  }
  if (mixes.length === 0) {
    throw new NoxClientError("No mix nodes available", NoxClientErrorCode.NoNodesAvailable);
  }
  if (exits.length === 0) {
    throw new NoxClientError("No exit nodes available", NoxClientErrorCode.NoNodesAvailable);
  }

  const pinnedExit = selectedExit === undefined
    ? undefined
    : exits.find((candidate) => candidate.id === selectedExit.id);
  if (selectedExit !== undefined && pinnedExit === undefined) {
    throw new NoxClientError(
      "Selected exit is not in the verified topology",
      NoxClientErrorCode.NoNodesAvailable,
    );
  }

  const canonicalPinnedEntry = pinnedEntry === undefined
    ? undefined
    : entries.find((candidate) => candidate.id === pinnedEntry.id);
  if (pinnedEntry !== undefined && canonicalPinnedEntry === undefined) {
    throw new NoxClientError(
      "Pinned entry is not in the verified topology",
      NoxClientErrorCode.NoNodesAvailable,
    );
  }
  if (
    pinnedExit !== undefined &&
    canonicalPinnedEntry !== undefined &&
    pinnedExit.id === canonicalPinnedEntry.id
  ) {
    throw new NoxClientError(
      "Selected exit cannot also be the pinned entry",
      NoxClientErrorCode.NoNodesAvailable,
    );
  }

  const selectableEntries = entries.filter((node) => node.id !== pinnedExit?.id);
  const entryOnly = selectableEntries.filter(
    (node) => !exits.some((exit) => exit.id === node.id),
  );
  const entry = canonicalPinnedEntry ?? pickRandom(entryOnly) ?? pickRandom(selectableEntries);
  if (entry === undefined) {
    throw new NoxClientError(
      "No distinct entry node is available for the selected exit",
      NoxClientErrorCode.NoNodesAvailable,
    );
  }

  const eligibleMixes = mixes.filter(
    (n) => n.id !== entry.id && n.id !== pinnedExit?.id,
  );
  const mixOnly = eligibleMixes.filter((n) => !exits.some((e) => e.id === n.id));
  const mix = pickRandom(mixOnly) ?? pickRandom(eligibleMixes);
  if (mix === undefined) {
    throw new NoxClientError(
      "No distinct mix node is available for the selected exit",
      NoxClientErrorCode.NoNodesAvailable,
    );
  }

  const eligibleExits = exits.filter((n) => n.id !== entry.id && n.id !== mix.id);
  const exit = pinnedExit ?? pickRandom(eligibleExits);
  if (exit === undefined) {
    throw new NoxClientError(
      "No distinct exit node is available",
      NoxClientErrorCode.NoNodesAvailable,
    );
  }

  return { entry, mix, exit };
}

export function hasUsableIngress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
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
  return arr[secureRandomIndex(arr.length)];
}

function normalizeAddress(addr: string): string {
  const hex = addr.replace(/^0x/i, "").toLowerCase();
  return `0x${hex}`;
}
