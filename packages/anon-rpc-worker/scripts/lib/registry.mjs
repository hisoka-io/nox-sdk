// @ts-check
/**
 * NoxRegistry state at one block, read for the pinned snapshot
 * (ARCHITECTURE §5.2). Build time only: the worker never reads the chain.
 *
 * Everything comes from the chain at block B:
 *   1. candidates: every address in a RelayerRegistered or
 *      PrivilegedRelayerRegistered log of the registry, from its deployment
 *      block to B (the only two ways the contract adds a member; the registry
 *      has no enumeration view);
 *   2. relayers(candidate) and getNodeRole(candidate) at B;
 *   3. members: the candidates with isRegistered at B.
 * The set is accepted only when relayerCount() at B equals the member count,
 * topologyFingerprint() at B equals the SDK's computeTopologyFingerprint over
 * the members, and the SDK's own verifyOnChainWithEligibility accepts every
 * member profile at B. Layers come from the SDK as well. This module
 * recomputes none of the SDK rules; it asks the SDK.
 */
import * as sdk from "@hisoka-io/nox-client";
import { Interface } from "ethers";
import { readFileSync } from "node:fs";
import { kpsAddrFromMetadataUrl } from "./kps-address.mjs";
import { CAPABILITIES_PATH, NETWORKS_PATH } from "./paths.mjs";
import {
  checkWithSdkValidator,
  isRecord,
  primaryLayer,
  SNAPSHOT_FORMAT,
  SNAPSHOT_LIMITS,
  SnapshotError,
} from "./snapshot-format.mjs";

/** Tunables of the log scans. */
export const SCAN_DEFAULTS = Object.freeze({
  /** Initial eth_getLogs span in blocks; 0 means the whole range in one request. */
  logChunkBlocks: 0,
  /** A span this small is not split further when the endpoint rejects it. */
  minLogChunkBlocks: 1_000,
});

/** The block tags accepted besides a block number. */
export const BLOCK_TAGS = Object.freeze(["finalized", "safe", "latest"]);

const ABI_URL = new URL("../abi/NoxRegistry.json", import.meta.url);
const REGISTRATION_EVENTS = Object.freeze(["RelayerRegistered", "PrivilegedRelayerRegistered"]);
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/u;
const CAPABILITIES_FORMAT = "nox-capabilities/1";

/**
 * @typedef {import("./rpc.mjs").RpcClient} RpcClient
 * @typedef {import("./snapshot-format.mjs").NoxAnonRpcSnapshot} NoxAnonRpcSnapshot
 * @typedef {import("./snapshot-format.mjs").SnapshotMember} SnapshotMember
 * @typedef {import("./kps-address.mjs").KpsEndpoint} KpsEndpoint
 */

/**
 * @typedef {object} NetworkConfig
 * @property {string} name
 * @property {number} chain_id
 * @property {string} registry        lowercase 0x address
 * @property {number} from_block      first block of the registry's logs (deployment)
 * @property {number} pow_difficulty  release input recorded in the snapshot
 */

/**
 * Chain-derived member fields (everything in a snapshot member except the
 * reviewed capability hints).
 * @typedef {Omit<SnapshotMember, "capabilities">} ChainMember
 */

/**
 * @typedef {object} RegistryState
 * @property {number} chainId
 * @property {string} registry
 * @property {{ number: number, hash: string, timestamp: number }} block
 * @property {number} relayerCount
 * @property {string} fingerprint     64 lowercase hex, no 0x
 * @property {ChainMember[]} members  ascending by address
 * @property {string[]} eligible      members the SDK routes over (status 1 or 2, not frozen)
 * @property {Record<string, { endpoint: KpsEndpoint | null, reason: string | null }>} kps
 *                                    KPS endpoint parsed from each member's metadataUrl
 * @property {{ fromBlock: number, registrationEvents: number, candidates: number }} scan
 */

/**
 * The deployed NoxRegistry ABI (scripts/abi/NoxRegistry.json).
 * @returns {Interface}
 */
export function registryInterface() {
  /** @type {{ abi: unknown }} */
  const file = JSON.parse(readFileSync(ABI_URL, "utf8"));
  return new Interface(/** @type {import("ethers").InterfaceAbi} */ (file.abi));
}

/**
 * Read networks.json and return one validated network.
 * @param {string} name
 * @param {URL | string} [path]
 * @returns {NetworkConfig}
 */
export function loadNetwork(name, path = NETWORKS_PATH) {
  /** @type {unknown} */
  const all = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(all)) throw new SnapshotError(`${String(path)} is not a JSON object`, "config");
  const entry = all[name];
  if (!isRecord(entry)) {
    throw new SnapshotError(
      `network "${name}" is not in ${String(path)}; known: ${Object.keys(all).join(", ")}`,
      "config",
    );
  }
  return validateNetwork({
    name,
    chain_id: /** @type {number} */ (entry["chain_id"]),
    registry: /** @type {string} */ (entry["registry"]),
    from_block: /** @type {number} */ (entry["from_block"]),
    pow_difficulty: /** @type {number} */ (entry["pow_difficulty"]),
  });
}

/**
 * @param {NetworkConfig} network
 * @returns {NetworkConfig}
 */
export function validateNetwork(network) {
  if (!Number.isSafeInteger(network.chain_id) || network.chain_id <= 0) {
    throw new SnapshotError(`network ${network.name}: chain_id must be a positive integer`, "config");
  }
  if (typeof network.registry !== "string" || !ADDRESS_PATTERN.test(network.registry.toLowerCase())) {
    throw new SnapshotError(`network ${network.name}: registry must be a 0x address`, "config");
  }
  if (!Number.isSafeInteger(network.from_block) || network.from_block < 0) {
    throw new SnapshotError(`network ${network.name}: from_block must be a non-negative integer`, "config");
  }
  if (
    !Number.isSafeInteger(network.pow_difficulty) ||
    network.pow_difficulty < 0 ||
    network.pow_difficulty > SNAPSHOT_LIMITS.maxPowDifficulty
  ) {
    throw new SnapshotError(
      `network ${network.name}: pow_difficulty must be an integer in 0..${SNAPSHOT_LIMITS.maxPowDifficulty}`,
      "config",
    );
  }
  return { ...network, registry: network.registry.toLowerCase() };
}

/**
 * Reviewed capability hints (snapshot/capabilities.json):
 * { "format": "nox-capabilities/1", "source": "...", "members": { "<address>": ["..."] } }.
 * @param {URL | string} [path]
 * @returns {Map<string, string[]>} address -> sorted unique hints
 */
export function loadCapabilities(path = CAPABILITIES_PATH) {
  /** @type {unknown} */
  const file = JSON.parse(readFileSync(path, "utf8"));
  const where = String(path);
  if (!isRecord(file) || file["format"] !== CAPABILITIES_FORMAT) {
    throw new SnapshotError(`${where} must be a JSON object with "format": "${CAPABILITIES_FORMAT}"`, "config");
  }
  if (typeof file["source"] !== "string" || file["source"].length === 0) {
    throw new SnapshotError(`${where} must say where its hints come from in "source"`, "config");
  }
  const members = file["members"];
  if (!isRecord(members)) throw new SnapshotError(`${where}: "members" must be an object keyed by address`, "config");
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const [address, hints] of Object.entries(members)) {
    if (!ADDRESS_PATTERN.test(address)) {
      throw new SnapshotError(`${where}: "${address}" is not a lowercase 0x address`, "config");
    }
    if (
      !Array.isArray(hints) ||
      hints.length > SNAPSHOT_LIMITS.maxCapabilities ||
      new Set(hints).size !== hints.length ||
      !hints.every((hint) => typeof hint === "string" && hint.length >= 1 && hint.length <= SNAPSHOT_LIMITS.maxCapabilityLength)
    ) {
      throw new SnapshotError(
        `${where}: members["${address}"] must be at most ${SNAPSHOT_LIMITS.maxCapabilities} unique strings of 1..${SNAPSHOT_LIMITS.maxCapabilityLength} characters`,
        "config",
      );
    }
    out.set(address, [.../** @type {string[]} */ (hints)].sort());
  }
  return out;
}

/**
 * @typedef {object} CollectOptions
 * @property {RpcClient} rpc
 * @property {NetworkConfig} network
 * @property {number | "finalized" | "safe" | "latest"} block
 * @property {boolean} [requireSafe]     refuse a block above the chain's `safe` block (default true)
 * @property {number} [logChunkBlocks]
 * @property {number} [minLogChunkBlocks]
 * @property {typeof fetch} [fetchImpl]  used by the SDK verifier (defaults to the client's retrying fetch)
 */

/**
 * Read the registry at one block and cross-check it with the SDK.
 * @param {CollectOptions} options
 * @returns {Promise<RegistryState>}
 */
export async function collectRegistryState(options) {
  const { rpc } = options;
  const network = validateNetwork(options.network);
  const iface = registryInterface();

  const chainId = parseQuantity(await rpc.call("eth_chainId", []), "eth_chainId");
  if (chainId !== network.chain_id) {
    throw new SnapshotError(
      `${rpc.origin} serves chain ${chainId}, but network ${network.name} is chain ${network.chain_id}`,
      "chain-mismatch",
    );
  }

  const block = await resolveBlock(rpc, options.block);
  if (block.number < network.from_block) {
    throw new SnapshotError(
      `block ${block.number} is before the registry deployment block ${network.from_block}`,
      "block-unavailable",
    );
  }
  if (options.requireSafe ?? true) {
    const safe = await resolveBlock(rpc, "safe");
    if (block.number > safe.number) {
      throw new SnapshotError(
        `block ${block.number} is above the chain's safe block ${safe.number} on ${rpc.origin}; ` +
          "snapshot a safe or finalized block so a reorg cannot change it",
        "block-unsafe",
      );
    }
  }
  const blockTag = toQuantity(block.number);

  const code = await stateRead(rpc, block.number, () => rpc.call("eth_getCode", [network.registry, blockTag]));
  if (typeof code !== "string" || code === "0x" || code === "") {
    throw new SnapshotError(
      `no contract code at registry ${network.registry} at block ${block.number} on chain ${chainId}`,
      "registry-missing",
    );
  }

  const tunables = {
    logChunkBlocks: options.logChunkBlocks ?? SCAN_DEFAULTS.logChunkBlocks,
    minLogChunkBlocks: options.minLogChunkBlocks ?? SCAN_DEFAULTS.minLogChunkBlocks,
  };
  let registrationEvents = 0;
  /** @type {Set<string>} */
  const candidates = new Set();
  for (const name of REGISTRATION_EVENTS) {
    const event = iface.getEvent(name);
    if (event === null) throw new SnapshotError(`the vendored NoxRegistry ABI has no ${name} event`, "config");
    const logs = await scanLogs(rpc, network.registry, event.topicHash, network.from_block, block.number, tunables);
    for (const log of logs) {
      registrationEvents += 1;
      candidates.add(indexedAddress(log, name));
    }
  }
  const addresses = [...candidates].sort();

  const reads = await stateRead(rpc, block.number, () => readRegistry(rpc, iface, network.registry, addresses, blockTag));
  const registered = reads.profiles.filter((entry) => entry.isRegistered);
  const nodes = registered.map((entry) => entry.node);

  if (nodes.length !== reads.relayerCount) {
    throw new SnapshotError(
      `relayerCount() at block ${block.number} is ${reads.relayerCount}, but ${nodes.length} of ${addresses.length} ` +
        `registered addresses are members; the log scan from block ${network.from_block} missed registrations ` +
        "(check from_block and the endpoint's eth_getLogs coverage)",
      "registry-inconsistent",
    );
  }
  if (nodes.length === 0) {
    throw new SnapshotError(`the registry has no members at block ${block.number}`, "registry-inconsistent");
  }
  const fingerprint = sdk.computeTopologyFingerprint(nodes);
  if (fingerprint !== reads.topologyFingerprint) {
    throw new SnapshotError(
      `topologyFingerprint() at block ${block.number} is ${reads.topologyFingerprint}, but the SDK fingerprint of the ` +
        `${nodes.length} members is ${fingerprint}; the member set is incomplete or wrong`,
      "registry-inconsistent",
    );
  }

  const withLayers = nodes.map((node) => ({ ...node, layer: primaryLayer(node) }));
  checkWithSdkValidator(withLayers, fingerprint, block.number);

  /** @type {Set<string>} */
  let eligible;
  try {
    eligible = await sdk.verifyOnChainWithEligibility(rpc.url, network.registry, withLayers, block.number, {
      fetch: options.fetchImpl ?? rpc.fetch,
    });
  } catch (error) {
    throw new SnapshotError(
      `the SDK's on-chain verification rejected the members at block ${block.number}: ${errorText(error)}`,
      "sdk-rejected",
    );
  }

  /** @type {RegistryState["kps"]} */
  const kps = {};
  /** @type {ChainMember[]} */
  const members = withLayers.map((node, index) => {
    const extra = /** @type {ProfileRead} */ (registered[index]);
    if (extra.status !== 1 && extra.status !== 2) {
      throw new SnapshotError(
        `member ${node.address} is registered with status ${extra.status} at block ${block.number}; ` +
          "the snapshot format knows 1 (Registered) and 2 (Unstaking), check the vendored ABI against the deployed registry",
        "registry-inconsistent",
      );
    }
    kps[node.address] = kpsAddrFromMetadataUrl(node.metadata_url ?? "");
    return {
      address: node.address,
      sphinxKey: node.sphinx_key,
      url: node.url,
      ingressUrl: node.ingress_url ?? "",
      metadataUrl: node.metadata_url ?? "",
      stake: node.stake,
      role: /** @type {1 | 2 | 3} */ (node.role),
      layer: /** @type {0 | 1 | 2} */ (node.layer),
      status: /** @type {1 | 2} */ (extra.status),
      frozen: extra.frozen,
    };
  });

  return {
    chainId,
    registry: network.registry,
    block,
    relayerCount: reads.relayerCount,
    fingerprint,
    members,
    eligible: members.map((member) => member.address).filter((address) => eligible.has(address)),
    kps,
    scan: { fromBlock: network.from_block, registrationEvents, candidates: addresses.length },
  };
}

/**
 * The snapshot document for a registry state and the release inputs.
 * @param {RegistryState} state
 * @param {{ powDifficulty: number, capabilities: Map<string, string[]> }} inputs
 * @returns {NoxAnonRpcSnapshot}
 */
export function buildSnapshot(state, inputs) {
  const memberSet = new Set(state.members.map((member) => member.address));
  const strangers = [...inputs.capabilities.keys()].filter((address) => !memberSet.has(address));
  if (strangers.length > 0) {
    throw new SnapshotError(
      `the capability hints name ${strangers.join(", ")}, which ${strangers.length === 1 ? "is" : "are"} not a registry ` +
        `member at block ${state.block.number}; review snapshot/capabilities.json against the registry`,
      "config",
    );
  }
  return {
    format: SNAPSHOT_FORMAT,
    chainId: state.chainId,
    registry: state.registry,
    blockNumber: state.block.number,
    blockHash: state.block.hash,
    fingerprint: state.fingerprint,
    relayerCount: state.relayerCount,
    powDifficulty: inputs.powDifficulty,
    members: state.members.map((member) => ({
      ...member,
      capabilities: inputs.capabilities.get(member.address) ?? [],
    })),
  };
}

/**
 * Differences between the chain-derived fields of a snapshot and a registry
 * state, one line per field, naming the member address.
 * @param {NoxAnonRpcSnapshot} snapshot
 * @param {RegistryState} state
 * @returns {string[]}
 */
export function chainDifferences(snapshot, state) {
  /** @type {string[]} */
  const out = [];
  /**
   * @param {string} field
   * @param {unknown} recorded
   * @param {unknown} chain
   */
  const compare = (field, recorded, chain) => {
    if (recorded !== chain) out.push(`${field}: snapshot ${JSON.stringify(recorded)}, chain ${JSON.stringify(chain)}`);
  };
  compare("chainId", snapshot.chainId, state.chainId);
  compare("registry", snapshot.registry, state.registry);
  compare("blockNumber", snapshot.blockNumber, state.block.number);
  compare("blockHash", snapshot.blockHash, state.block.hash);
  compare("fingerprint", snapshot.fingerprint, state.fingerprint);
  compare("relayerCount", snapshot.relayerCount, state.relayerCount);
  const chainMembers = new Map(state.members.map((member) => [member.address, member]));
  const recordedMembers = new Set(snapshot.members.map((member) => member.address));
  for (const member of snapshot.members) {
    const chain = chainMembers.get(member.address);
    if (chain === undefined) {
      out.push(`member ${member.address}: in the snapshot, not a registry member on chain`);
      continue;
    }
    for (const field of /** @type {const} */ (["sphinxKey", "url", "ingressUrl", "metadataUrl", "stake", "role", "layer", "status", "frozen"])) {
      compare(`member ${member.address}.${field}`, member[field], chain[field]);
    }
  }
  for (const address of chainMembers.keys()) {
    if (!recordedMembers.has(address)) out.push(`member ${address}: a registry member on chain, missing from the snapshot`);
  }
  return out;
}

/**
 * Logs of the registry in (fromBlock, toBlock] for any event, used when an
 * endpoint cannot serve state at an old block: if the state at `toBlock`
 * equals the snapshot and no registry event happened since, the snapshot
 * still describes the chain at its block.
 * @param {RpcClient} rpc
 * @param {string} registry
 * @param {number} afterBlock
 * @param {number} toBlock
 * @param {{ logChunkBlocks: number, minLogChunkBlocks: number }} tunables
 * @returns {Promise<number>} number of registry logs in the range
 */
export async function registryEventsAfter(rpc, registry, afterBlock, toBlock, tunables) {
  if (toBlock <= afterBlock) return 0;
  const logs = await scanLogs(rpc, registry, null, afterBlock + 1, toBlock, tunables);
  return logs.length;
}

/**
 * JSON-RPC error messages that mean "this endpoint keeps no state for that
 * block", by client: Nitro and Geth ("historical state <root> is not
 * available", "missing trie node", "required historical state unavailable",
 * "header not found"), Reth ("state at block #N is pruned"), Nethermind
 * ("No state available for block"), Erigon ("state history ... not
 * available"). Only these let verify-snapshot.mjs fall back to the latest
 * state; any other JSON-RPC error (a rate limit, a revert) fails the read.
 */
export const MISSING_STATE_PATTERNS = Object.freeze([
  /historical state\b.*\bnot available/iu,
  /required historical state unavailable/iu,
  /missing trie node/iu,
  /header not found/iu,
  /state at block #?\d+ is pruned/iu,
  /no state available/iu,
  /state histor(?:y|ies)\b.*\bnot available/iu,
]);

/**
 * True when an RPC failure is the endpoint saying it keeps no state for the
 * requested block (MISSING_STATE_PATTERNS), as opposed to a transient or
 * unrelated JSON-RPC error.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isMissingStateError(error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "rpc") return false;
  const details = "details" in error && isRecord(error.details) ? error.details : {};
  const text = typeof details["rpcMessage"] === "string" ? details["rpcMessage"] : error.message;
  return MISSING_STATE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Run a read of historical state. An endpoint that keeps no state for the
 * block (pruning nodes keep only recent state) gives "block-unavailable";
 * any other JSON-RPC error gives "state-read-failed", so a rate limit or a
 * revert is never mistaken for missing history.
 * @template T
 * @param {RpcClient} rpc
 * @param {number} blockNumber
 * @param {() => Promise<T>} read
 * @returns {Promise<T>}
 */
async function stateRead(rpc, blockNumber, read) {
  try {
    return await read();
  } catch (error) {
    if (isMissingStateError(error)) {
      throw new SnapshotError(
        `${rpc.origin} cannot serve registry state at block ${blockNumber} (${errorText(error)}); ` +
          "use an endpoint that keeps historical state for that block (an archive node)",
        "block-unavailable",
      );
    }
    if (error instanceof Error && "code" in error && error.code === "rpc") {
      throw new SnapshotError(
        `reading registry state at block ${blockNumber} through ${rpc.origin} failed (${error.message}); ` +
          "this is not a missing-state error, so retry or use another endpoint",
        "state-read-failed",
      );
    }
    throw error;
  }
}

/**
 * Resolve a block number or tag to its number, hash and timestamp.
 * @param {RpcClient} rpc
 * @param {number | string} spec
 * @returns {Promise<{ number: number, hash: string, timestamp: number }>}
 */
export async function resolveBlock(rpc, spec) {
  let tag;
  if (typeof spec === "number") {
    if (!Number.isSafeInteger(spec) || spec < 0) {
      throw new SnapshotError(`block must be a non-negative integer or one of ${BLOCK_TAGS.join(", ")}`, "config");
    }
    tag = toQuantity(spec);
  } else if (BLOCK_TAGS.includes(spec)) {
    tag = spec;
  } else {
    throw new SnapshotError(`block must be a non-negative integer or one of ${BLOCK_TAGS.join(", ")}, got "${spec}"`, "config");
  }
  const raw = await rpc.call("eth_getBlockByNumber", [tag, false]);
  if (!isRecord(raw)) {
    throw new SnapshotError(`${rpc.origin} has no block ${String(spec)}`, "block-unavailable");
  }
  const number = parseQuantity(raw["number"], "block number");
  const timestamp = parseQuantity(raw["timestamp"], "block timestamp");
  const hash = raw["hash"];
  if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/u.test(hash.toLowerCase())) {
    throw new SnapshotError(`block ${number} from ${rpc.origin} has no valid hash`, "block-unavailable");
  }
  if (typeof spec === "number" && number !== spec) {
    throw new SnapshotError(`${rpc.origin} returned block ${number} for block ${spec}`, "block-unavailable");
  }
  return { number, hash: hash.toLowerCase(), timestamp };
}

/**
 * Every log of `address` (optionally with first topic `topic`) in
 * [fromBlock, toBlock]. When the endpoint rejects a span, the span is halved
 * and the smaller span is kept for the rest of the scan, down to
 * minLogChunkBlocks.
 * @param {RpcClient} rpc
 * @param {string} address
 * @param {string | null} topic
 * @param {number} fromBlock
 * @param {number} toBlock
 * @param {{ logChunkBlocks: number, minLogChunkBlocks: number }} tunables
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function scanLogs(rpc, address, topic, fromBlock, toBlock, tunables) {
  const { logChunkBlocks, minLogChunkBlocks } = tunables;
  if (!Number.isSafeInteger(logChunkBlocks) || logChunkBlocks < 0) {
    throw new SnapshotError("logChunkBlocks must be a non-negative integer", "config");
  }
  if (!Number.isSafeInteger(minLogChunkBlocks) || minLogChunkBlocks <= 0) {
    throw new SnapshotError("minLogChunkBlocks must be a positive integer", "config");
  }
  /** @type {Record<string, unknown>[]} */
  const out = [];
  let span = logChunkBlocks === 0 ? toBlock - fromBlock + 1 : logChunkBlocks;
  let start = fromBlock;
  while (start <= toBlock) {
    const end = Math.min(toBlock, start + span - 1);
    /** @type {unknown} */
    let raw;
    try {
      raw = await rpc.call("eth_getLogs", [
        {
          address,
          fromBlock: toQuantity(start),
          toBlock: toQuantity(end),
          ...(topic === null ? {} : { topics: [topic] }),
        },
      ]);
    } catch (error) {
      const rejected = error instanceof Error && "code" in error && error.code === "rpc";
      if (!rejected || end - start + 1 <= minLogChunkBlocks) {
        throw new SnapshotError(`eth_getLogs for blocks ${start}-${end} failed: ${errorText(error)}`, "scan-failed");
      }
      span = Math.max(minLogChunkBlocks, Math.floor((end - start + 1) / 2));
      continue;
    }
    if (!Array.isArray(raw)) {
      throw new SnapshotError(`eth_getLogs for blocks ${start}-${end} did not return an array`, "scan-failed");
    }
    for (const entry of raw) {
      if (!isRecord(entry)) throw new SnapshotError(`eth_getLogs for blocks ${start}-${end} returned a non-object log`, "scan-failed");
      if (entry["removed"] === true) continue;
      const topics = entry["topics"];
      const logAddress = entry["address"];
      if (
        typeof logAddress !== "string" ||
        logAddress.toLowerCase() !== address ||
        !Array.isArray(topics) ||
        (topic !== null && (typeof topics[0] !== "string" || topics[0].toLowerCase() !== topic))
      ) {
        throw new SnapshotError(`eth_getLogs for blocks ${start}-${end} returned a log that does not match the filter`, "scan-failed");
      }
      out.push(entry);
    }
    start = end + 1;
  }
  return out;
}

/**
 * The indexed relayer address (topic 1) of a registration log.
 * @param {Record<string, unknown>} log
 * @param {string} event
 * @returns {string}
 */
function indexedAddress(log, event) {
  const topics = /** @type {unknown[]} */ (log["topics"]);
  const word = typeof topics[1] === "string" ? topics[1].toLowerCase() : "";
  if (!/^0x0{24}[0-9a-f]{40}$/u.test(word)) {
    throw new SnapshotError(`${event} log topic 1 (${word || "missing"}) is not an address`, "scan-failed");
  }
  return `0x${word.slice(26)}`;
}

/**
 * @typedef {object} ProfileRead
 * @property {import("@hisoka-io/nox-client").RelayerNode} node  SDK-shaped node (layer 0 until assigned)
 * @property {boolean} isRegistered
 * @property {number} status
 * @property {boolean} frozen
 */

/**
 * relayerCount, topologyFingerprint and every candidate's profile and role at one block.
 * @param {RpcClient} rpc
 * @param {Interface} iface
 * @param {string} registry
 * @param {string[]} addresses
 * @param {string} blockTag
 * @returns {Promise<{ relayerCount: number, topologyFingerprint: string, profiles: ProfileRead[] }>}
 */
async function readRegistry(rpc, iface, registry, addresses, blockTag) {
  /** @type {Array<{ fn: string, args: unknown[] }>} */
  const reads = [
    { fn: "relayerCount", args: [] },
    { fn: "topologyFingerprint", args: [] },
  ];
  for (const address of addresses) {
    reads.push({ fn: "relayers", args: [address] });
    reads.push({ fn: "getNodeRole", args: [address] });
  }
  const results = await rpc.batch(
    reads.map((read) => ({
      method: "eth_call",
      params: [{ to: registry, data: iface.encodeFunctionData(read.fn, read.args) }, blockTag],
    })),
  );
  const decoded = reads.map((read, index) => {
    const data = results[index];
    if (typeof data !== "string") {
      throw new SnapshotError(`eth_call ${read.fn} returned a non-string result`, "registry-inconsistent");
    }
    try {
      return iface.decodeFunctionResult(read.fn, data);
    } catch (error) {
      throw new SnapshotError(
        `cannot decode ${read.fn}(${read.args.join(", ")}) at ${blockTag}: ${errorText(error)}`,
        "registry-inconsistent",
      );
    }
  });
  const relayerCount = toSafeNumber(decoded[0]?.[0], "relayerCount");
  const topologyFingerprint = String(decoded[1]?.[0]).toLowerCase().replace(/^0x/u, "");
  /** @type {ProfileRead[]} */
  const profiles = addresses.map((address, index) => {
    const profile = /** @type {import("ethers").Result} */ (decoded[2 + index * 2]);
    const role = toSafeNumber(decoded[3 + index * 2]?.[0], `getNodeRole(${address})`);
    const stake = BigInt(profile[4]);
    return {
      node: {
        address,
        sphinx_key: String(profile[0]).toLowerCase().replace(/^0x/u, ""),
        url: String(profile[1]),
        stake: stake.toString(),
        last_seen: 0,
        is_privileged: stake === 0n,
        layer: 0,
        role,
        ingress_url: String(profile[2]),
        metadata_url: String(profile[3]),
      },
      isRegistered: profile[6] === true,
      status: toSafeNumber(profile[7], `relayers(${address}).status`),
      frozen: profile[8] === true,
    };
  });
  return { relayerCount, topologyFingerprint, profiles };
}

/**
 * @param {number} value
 * @returns {string}
 */
export function toQuantity(value) {
  return `0x${value.toString(16)}`;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {number}
 */
function parseQuantity(value, what) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value.toLowerCase())) {
    throw new SnapshotError(`${what} is not a JSON-RPC quantity: ${JSON.stringify(value)}`, "block-unavailable");
  }
  return toSafeNumber(BigInt(value), what);
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {number}
 */
function toSafeNumber(value, what) {
  if (typeof value !== "bigint" && typeof value !== "number") {
    throw new SnapshotError(`${what} is not an integer`, "registry-inconsistent");
  }
  const big = BigInt(value);
  if (big < 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SnapshotError(`${what} = ${big} is outside the safe integer range`, "registry-inconsistent");
  }
  return Number(big);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
