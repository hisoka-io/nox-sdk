/**
 * S1 chain check (PROPOSAL §2.2 "Chain check"): read NoxRegistry at one
 * finalized block through the mixnet, from `chainQuorum` different exits to
 * as many different public RPC providers, and use the answer only when every
 * pair returns byte for byte the same values. The result says who the
 * members are (identity), where they are (location) and who left.
 *
 * Every read is pinned with EIP-1898 `{ blockHash, requireCanonical: true }`.
 * The set must close: the candidates found registered number exactly
 * `relayerCount()` and XOR to `topologyFingerprint()`. Fake addresses fail
 * `relayers(a)`, so count plus per-member reads carry the argument; the XOR
 * fingerprint alone is not a commitment. The proxy's EIP-1967 implementation
 * slot must hold the implementation the bundle knows, or the storage layout
 * may differ and the answer is refused.
 *
 * The request shape depends only on the candidate set, so every client with
 * the same candidates sends the same bytes.
 */
import { Interface } from "ethers";
import {
  NoxClientError,
  NoxClientErrorCode,
  type DiscoveryPolicy,
  type KpsBootstrap,
  type MemberFirstSeen,
  type PinnedSnapshot,
} from "../types.js";
import { computeTopologyFingerprint, layersForRole, primaryLayerForRole } from "../topology.js";
import { kpsAddrFromMetadataUrl } from "./address.js";
import { rpcProviderKey } from "./bootstrap.js";
import {
  DISCOVERY_CLOCK_SKEW_SECONDS,
  DISCOVERY_LOG_SCAN,
  DISCOVERY_PAIRING_BUDGET,
  DISCOVERY_REPLY_BYTES,
} from "./constants.js";
import { eligiblePinnedMembers, type MemberRecord } from "./pinned.js";

/** EIP-1967 implementation slot: `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`. */
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** NoxRegistry reads and the two registration events. */
const REGISTRY_INTERFACE = new Interface([
  "function topologyFingerprint() view returns (bytes32)",
  "function relayerCount() view returns (uint256)",
  "function relayers(address) view returns (bytes32 sphinxKey,string url,string ingressUrl,string metadataUrl,uint256 stakedAmount,uint256 unlockTime,bool isRegistered,uint8 status,bool frozen)",
  "function getNodeRole(address) view returns (uint8)",
  "event RelayerRegistered(address indexed relayer, bytes32 sphinxKey, string url, string ingressUrl, string metadataUrl, uint256 stake, uint8 nodeRole)",
  "event PrivilegedRelayerRegistered(address indexed relayer, bytes32 sphinxKey, string url, string ingressUrl, string metadataUrl, uint8 nodeRole)",
]);

/** Topics of `RelayerRegistered` and `PrivilegedRelayerRegistered`, the two ways a member joins. */
export const REGISTRATION_TOPICS: readonly string[] = Object.freeze([
  REGISTRY_INTERFACE.getEvent("RelayerRegistered")!.topicHash,
  REGISTRY_INTERFACE.getEvent("PrivilegedRelayerRegistered")!.topicHash,
]);

const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;
const HASH_RE = /^0x[0-9a-f]{64}$/u;
const QUANTITY_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)$/u;
const DATA_RE = /^0x(?:[0-9a-f]{2})*$/u;

/** Why a chain check did not produce a membership. */
export type DiscoveryFailureKind =
  /** A pair answered with an error, a missing result or malformed JSON. */
  | "partial"
  /** The finalized block is too old, from the future, or before the snapshot or the last verified block. */
  | "stale-block"
  /** The provider serves another chain. */
  | "chain-id"
  /** The registry proxy points at an implementation the bundle does not know. */
  | "implementation"
  /** Registered candidates XOR to another value than the on-chain fingerprint. */
  | "fingerprint"
  /** Fewer registered candidates than `relayerCount()`: a member is hidden. */
  | "incomplete";

/** A chain check step failed; `kind` says how. */
export class DiscoveryError extends Error {
  constructor(
    readonly kind: DiscoveryFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/** A finalized block as one pair reported it. */
export interface FinalizedBlock {
  hash: string;
  number: number;
  timestamp: number;
}

/** A member's registry profile at the checked block (registered members only). */
export interface ChainProfile {
  address: string;
  sphinxKey: string;
  url: string;
  ingressUrl: string;
  metadataUrl: string;
  /** Decimal string. */
  stake: string;
  status: number;
  frozen: boolean;
  role: number;
}

/** One pair's parsed answer to a registry read. */
export interface RegistryAnswer {
  chainId: number;
  block: FinalizedBlock;
  /** Address in the proxy's implementation slot, lowercase. */
  implementation: string;
  relayerCount: number;
  /** 64 lowercase hex. */
  fingerprint: string;
  /** Registered candidates, by lowercase address. */
  members: Map<string, ChainProfile>;
  /** Canonical text of every value used, in request order: two answers agree when these are equal. */
  canonical: string;
}

/** The membership a chain check established. */
export interface ChainMembership {
  block: FinalizedBlock;
  fingerprint: string;
  relayerCount: number;
  /** Every registered member, sorted by address. */
  registered: ChainProfile[];
}

/** One JSON-RPC call of a plan. */
interface PlannedCall {
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

/** The exact registry read for one block and candidate set. */
export interface RegistryReadPlan {
  readonly registry: string;
  readonly block: FinalizedBlock;
  /** Lowercase addresses, sorted and unique. */
  readonly candidates: readonly string[];
  readonly calls: readonly PlannedCall[];
}

/** JSON-RPC body asking for the finalized block header. */
export function finalizedBlockBody(): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["finalized", false] });
}

/** Parse a reply to `finalizedBlockBody`. Throws `DiscoveryError("partial")`. */
export function parseFinalizedBlock(text: string): FinalizedBlock {
  const reply = parseJson(text);
  if (!isRecord(reply) || reply["id"] !== 1) throw partial("the finalized block reply is not a JSON-RPC reply with id 1");
  return parseBlock(reply["result"], "finalized block");
}

/** The registry read: block header, chain id, implementation slot, count, fingerprint, then per candidate profile and role. */
export function registryReadPlan(registry: string, block: FinalizedBlock, candidates: Iterable<string>): RegistryReadPlan {
  const sorted = [...new Set([...candidates].map((address) => address.toLowerCase()))].sort();
  for (const address of sorted) {
    if (!ADDRESS_RE.test(address)) throw new DiscoveryError("partial", `candidate ${address.slice(0, 48)} is not an address`);
  }
  const at = { blockHash: block.hash, requireCanonical: true };
  const call = (to: string, data: string) => [{ to, data }, at];
  const calls: PlannedCall[] = [
    { id: 1, method: "eth_getBlockByHash", params: [block.hash, false] },
    { id: 2, method: "eth_chainId", params: [] },
    { id: 3, method: "eth_getStorageAt", params: [registry, EIP1967_IMPLEMENTATION_SLOT, at] },
    { id: 4, method: "eth_call", params: call(registry, REGISTRY_INTERFACE.encodeFunctionData("relayerCount", [])) },
    { id: 5, method: "eth_call", params: call(registry, REGISTRY_INTERFACE.encodeFunctionData("topologyFingerprint", [])) },
  ];
  sorted.forEach((address, index) => {
    calls.push({
      id: 6 + index * 2,
      method: "eth_call",
      params: call(registry, REGISTRY_INTERFACE.encodeFunctionData("relayers", [address])),
    });
    calls.push({
      id: 7 + index * 2,
      method: "eth_call",
      params: call(registry, REGISTRY_INTERFACE.encodeFunctionData("getNodeRole", [address])),
    });
  });
  return { registry, block, candidates: sorted, calls };
}

/** The JSON-RPC batch body of a plan. */
export function planBody(plan: RegistryReadPlan): string {
  return JSON.stringify(plan.calls.map((call) => ({ jsonrpc: "2.0", id: call.id, method: call.method, params: call.params })));
}

/** Reply bytes a plan's answer needs at most, for reply block sizing. */
export function expectedReplyBytes(candidates: number): number {
  return DISCOVERY_REPLY_BYTES.base + DISCOVERY_REPLY_BYTES.perMember * candidates;
}

/**
 * Parse one pair's reply to a plan. Every call must have a result: an error
 * or a missing id makes the whole answer partial, and partial answers are
 * never merged with others.
 */
export function parseRegistryAnswer(plan: RegistryReadPlan, text: string): RegistryAnswer {
  const results = batchResults(text, plan.calls.length);
  const block = parseBlock(results.get(1), "eth_getBlockByHash");
  if (block.hash !== plan.block.hash || block.number !== plan.block.number || block.timestamp !== plan.block.timestamp) {
    throw partial("eth_getBlockByHash describes another block than the finalized block");
  }
  const chainId = parseQuantity(results.get(2), "eth_chainId");
  const slot = parseData(results.get(3), "eth_getStorageAt");
  if (slot.length !== 66) throw partial("the implementation slot is not 32 bytes");
  const implementation = `0x${slot.slice(26)}`;
  const count = decodeOne(results.get(4), "relayerCount");
  const fingerprint = String(decodeOne(results.get(5), "topologyFingerprint")[0]).toLowerCase().replace(/^0x/u, "");
  const relayerCount = Number(BigInt(String(count[0])));
  if (!Number.isSafeInteger(relayerCount)) throw partial("relayerCount is out of range");
  const canonical: string[] = [
    `block:${block.hash}:${block.number}:${block.timestamp}`,
    `chain:${chainId}`,
    `impl:${slot}`,
    `count:${relayerCount}`,
    `fingerprint:${fingerprint}`,
  ];
  const members = new Map<string, ChainProfile>();
  plan.candidates.forEach((address, index) => {
    const profileHex = parseData(results.get(6 + index * 2), `relayers(${address})`);
    const roleHex = parseData(results.get(7 + index * 2), `getNodeRole(${address})`);
    canonical.push(`${address}:${profileHex}:${roleHex}`);
    const profile = decodeOne(profileHex, "relayers");
    const role = Number(BigInt(String(decodeOne(roleHex, "getNodeRole")[0])));
    if (profile[6] !== true) return;
    members.set(address, {
      address,
      sphinxKey: String(profile[0]).toLowerCase().replace(/^0x/u, ""),
      url: String(profile[1]),
      ingressUrl: String(profile[2]),
      metadataUrl: String(profile[3]),
      stake: BigInt(String(profile[4])).toString(),
      status: Number(profile[7]),
      frozen: profile[8] === true,
      role,
    });
  });
  return { chainId, block, implementation, relayerCount, fingerprint, members, canonical: canonical.join("\n") };
}

/** True when every answer carries byte for byte the same values. */
export function answersAgree(answers: readonly { canonical: string }[]): boolean {
  return answers.length > 0 && answers.every((answer) => answer.canonical === answers[0]!.canonical);
}

/**
 * Check one agreed answer against the bootstrap: same chain, known
 * implementation, and a closed set (registered candidates = `relayerCount`
 * and their XOR = `topologyFingerprint`). Throws `DiscoveryError`
 * (`chain-id`, `implementation`, `incomplete`, `fingerprint`).
 */
export function closeMembership(answer: RegistryAnswer, bootstrap: KpsBootstrap): ChainMembership {
  if (answer.chainId !== bootstrap.chainId) {
    throw new DiscoveryError("chain-id", `the providers serve chain ${answer.chainId}, the bundle expects ${bootstrap.chainId}`);
  }
  if (answer.implementation !== bootstrap.registryImpl) {
    throw new DiscoveryError(
      "implementation",
      `the registry proxy points at implementation ${answer.implementation}, this bundle knows ${bootstrap.registryImpl}`,
    );
  }
  const registered = [...answer.members.values()].sort((left, right) => (left.address < right.address ? -1 : 1));
  if (registered.length < answer.relayerCount) {
    throw new DiscoveryError(
      "incomplete",
      `${registered.length} of ${answer.relayerCount} registered members are known; ${answer.relayerCount - registered.length} hidden`,
    );
  }
  const computed = computeTopologyFingerprint(registered.map((member) => ({
    address: member.address,
    sphinx_key: member.sphinxKey,
    url: member.url,
    stake: member.stake,
    last_seen: 0,
    is_privileged: false,
    layer: 0,
    role: member.role,
  })));
  if (registered.length !== answer.relayerCount || computed !== answer.fingerprint) {
    throw new DiscoveryError(
      "fingerprint",
      `registered members (${registered.length}) hash to ${computed}, the registry's fingerprint is ${answer.fingerprint} over ${answer.relayerCount}`,
    );
  }
  return { block: answer.block, fingerprint: answer.fingerprint, relayerCount: answer.relayerCount, registered };
}

/** `eth_getLogs` requests for both registration events from `fromBlock` to `toBlock`, in chunks. */
export function registrationLogsBody(registry: string, fromBlock: number, toBlock: number): { body: string; chunks: number } {
  const calls: { jsonrpc: string; id: number; method: string; params: unknown[] }[] = [];
  for (let start = fromBlock, id = 1; start <= toBlock; start += DISCOVERY_LOG_SCAN.chunkBlocks, id++) {
    const end = Math.min(toBlock, start + DISCOVERY_LOG_SCAN.chunkBlocks - 1);
    calls.push({
      jsonrpc: "2.0",
      id,
      method: "eth_getLogs",
      params: [{
        address: registry,
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
        topics: [[...REGISTRATION_TOPICS]],
      }],
    });
  }
  if (calls.length > DISCOVERY_LOG_SCAN.maxChunks) {
    throw new DiscoveryError(
      "incomplete",
      `the registration log scan spans ${calls.length} chunks of ${DISCOVERY_LOG_SCAN.chunkBlocks} blocks, more than ${DISCOVERY_LOG_SCAN.maxChunks}`,
    );
  }
  return { body: JSON.stringify(calls), chunks: calls.length };
}

/** Addresses a registration log reply names, plus its canonical text for agreement. */
export function parseRegistrationLogs(text: string, chunks: number): { addresses: string[]; canonical: string } {
  const results = batchResults(text, chunks);
  const addresses = new Set<string>();
  const canonical: string[] = [];
  for (let id = 1; id <= chunks; id++) {
    const logs = results.get(id);
    if (!Array.isArray(logs)) throw partial(`eth_getLogs chunk ${id} is not a list`);
    for (const log of logs) {
      if (!isRecord(log) || !Array.isArray(log["topics"])) throw partial("a registration log has no topics");
      const topics = log["topics"] as unknown[];
      const topic = topics[1];
      if (typeof topic !== "string" || !HASH_RE.test(topic.toLowerCase())) throw partial("a registration log has no relayer topic");
      const address = `0x${topic.toLowerCase().slice(26)}`;
      addresses.add(address);
      canonical.push(`${id}:${String(log["blockNumber"]).toLowerCase()}:${String(log["logIndex"]).toLowerCase()}:${address}`);
    }
  }
  return { addresses: [...addresses].sort(), canonical: canonical.join("\n") };
}

/** Everything `runChainCheck` needs; `send` routes one HTTP POST through one exit. */
export interface ChainCheckContext {
  readonly bootstrap: KpsBootstrap;
  /** RPC URLs to read (bootstrap list or the wallet's override). */
  readonly providers: readonly string[];
  readonly quorum: number;
  /** Exit node IDs available for the reads (members not on probation). */
  readonly exits: readonly string[];
  /** Candidate member addresses: snapshot, served documents, last verified set. */
  readonly candidates: readonly string[];
  /** Lowest acceptable block number: the snapshot block, or the last verified block. */
  readonly minBlock: number;
  /** First block of the registration log scan: the snapshot block (members outside it registered later). */
  readonly logsFromBlock: number;
  readonly nowUnix: number;
  /** POST `body` to `url` through exit `exitId`; resolves with the response text on HTTP 200, rejects otherwise. */
  send(exitId: string, url: string, body: string, expectedBytes: number): Promise<string>;
  /** Uniform index in [0, n). */
  randomIndex(n: number): number;
  /** Exits and provider keys that misbehaved; tried last. Updated in place. */
  readonly avoid: { readonly exits: Set<string>; readonly providers: Set<string> };
}

/** One (exit, provider) pair. */
export interface ReadPair {
  exit: string;
  provider: string;
}

export type ChainCheckOutcome =
  | { kind: "verified"; membership: ChainMembership; pairs: ReadPair[]; attempts: number; logScan: boolean }
  | { kind: "insufficient"; detail: string }
  | { kind: "disagreement"; attempts: number; detail: string }
  | { kind: "incomplete"; detail: string }
  | { kind: "rejected"; reason: DiscoveryFailureKind; detail: string }
  | { kind: "failed"; attempts: number; detail: string };

/**
 * `quorum` pairs with different exits and different providers (by
 * organisation), preferring exits and providers that have not misbehaved.
 * `null` when there are not enough of either.
 */
export function choosePairs(context: Pick<ChainCheckContext, "exits" | "providers" | "quorum" | "avoid" | "randomIndex">): ReadPair[] | null {
  const exits = orderPreferred([...new Set(context.exits)], (exit) => context.avoid.exits.has(exit), context.randomIndex);
  const byKey = new Map<string, string[]>();
  for (const url of context.providers) {
    const key = rpcProviderKey(url);
    byKey.set(key, [...(byKey.get(key) ?? []), url]);
  }
  const keys = orderPreferred([...byKey.keys()], (key) => context.avoid.providers.has(key), context.randomIndex);
  if (exits.length < context.quorum || keys.length < context.quorum) return null;
  return keys.slice(0, context.quorum).map((key, index) => {
    const urls = byKey.get(key)!;
    return { exit: exits[index]!, provider: urls[context.randomIndex(urls.length)]! };
  });
}

/**
 * Run one chain check (PROPOSAL §2.2 steps 2-7): pick pairs, pin the
 * finalized block through the first pair, read the registry through every
 * pair at once, accept only byte-identical answers that close, else try
 * another pairing (budget `DISCOVERY_PAIRING_BUDGET`). A set that does not
 * close is completed from the registration logs through the same pairs.
 */
export async function runChainCheck(context: ChainCheckContext): Promise<ChainCheckOutcome> {
  let disagreements = 0;
  let lastFailure = "no pairing was tried";
  for (let attempt = 1; attempt <= DISCOVERY_PAIRING_BUDGET; attempt++) {
    const pairs = choosePairs(context);
    if (pairs === null) {
      return {
        kind: "insufficient",
        detail: `need ${context.quorum} distinct exits and providers, have ${new Set(context.exits).size} exits and ${new Set(context.providers.map(rpcProviderKey)).size} providers`,
      };
    }
    const blame = (pair: ReadPair): void => {
      context.avoid.exits.add(pair.exit);
      context.avoid.providers.add(rpcProviderKey(pair.provider));
    };
    let block: FinalizedBlock;
    try {
      block = parseFinalizedBlock(await context.send(pairs[0]!.exit, pairs[0]!.provider, finalizedBlockBody(), 4_096));
      checkBlockWindow(block, context);
    } catch (error) {
      blame(pairs[0]!);
      lastFailure = `finalized block: ${describe(error)}`;
      continue;
    }
    let candidates = [...context.candidates];
    let logScan = false;
    for (;;) {
      const plan = registryReadPlan(context.bootstrap.registry, block, candidates);
      const read = await readAll(context, pairs, planBody(plan), expectedReplyBytes(plan.candidates.length), (text) =>
        parseRegistryAnswer(plan, text)
      );
      if (read.kind === "failed") {
        read.failed.forEach(blame);
        lastFailure = read.detail;
        break;
      }
      if (!answersAgree(read.values)) {
        disagreements += 1;
        pairs.forEach(blame);
        lastFailure = `the ${pairs.length} pairs answered differently at block ${block.number}`;
        break;
      }
      try {
        return { kind: "verified", membership: closeMembership(read.values[0]!, context.bootstrap), pairs, attempts: attempt, logScan };
      } catch (error) {
        if (!(error instanceof DiscoveryError)) throw error;
        if (error.kind !== "incomplete") return { kind: "rejected", reason: error.kind, detail: error.message };
        if (logScan) return { kind: "incomplete", detail: error.message };
      }
      // Served documents hid a member: complete the candidates from the registration logs.
      let scan: { body: string; chunks: number };
      try {
        scan = registrationLogsBody(context.bootstrap.registry, context.logsFromBlock, block.number);
      } catch (error) {
        return { kind: "incomplete", detail: describe(error) };
      }
      const logs = await readAll(context, pairs, scan.body, 65_536, (text) => parseRegistrationLogs(text, scan.chunks));
      if (logs.kind === "failed") {
        return { kind: "incomplete", detail: `registration log scan: ${logs.detail}` };
      }
      if (!answersAgree(logs.values)) {
        disagreements += 1;
        pairs.forEach(blame);
        lastFailure = "the pairs disagree on the registration logs";
        break;
      }
      logScan = true;
      candidates = [...new Set([...candidates, ...logs.values[0]!.addresses])];
    }
  }
  return disagreements > 0
    ? { kind: "disagreement", attempts: DISCOVERY_PAIRING_BUDGET, detail: lastFailure }
    : { kind: "failed", attempts: DISCOVERY_PAIRING_BUDGET, detail: lastFailure };
}

/** Reject a finalized block that is before `minBlock`, older than the policy allows, or in the future. */
export function checkBlockWindow(block: FinalizedBlock, context: Pick<ChainCheckContext, "minBlock" | "nowUnix" | "bootstrap">): void {
  if (block.number < context.minBlock) {
    throw new DiscoveryError("stale-block", `finalized block ${block.number} is before block ${context.minBlock}`);
  }
  const age = context.nowUnix - block.timestamp;
  if (age > context.bootstrap.policy.maxStateAgeSeconds) {
    throw new DiscoveryError(
      "stale-block",
      `finalized block ${block.number} is ${age}s old (limit ${context.bootstrap.policy.maxStateAgeSeconds}s)`,
    );
  }
  if (-age > DISCOVERY_CLOCK_SKEW_SECONDS) {
    throw new DiscoveryError("stale-block", `finalized block ${block.number} is ${-age}s in the future`);
  }
}

/**
 * The membership a verified read gives the client (PROPOSAL §2.6): eligible
 * members (status 1 or 2, not frozen, valid role) with their chain location.
 * A member in the snapshot with the same identity (address, Sphinx key, role)
 * is a floor member. Any other member is on probation until
 * `probationSeconds` after the client first saw it on chain.
 *
 * Removal floor: per route layer, at least `min(minMembersPerLayer, eligible
 * snapshot members of the layer)` floor members stay. When a read removes
 * more, removed snapshot members (absent from the read, not re-keyed) come
 * back with their snapshot profile, in address order. Forged answers can then
 * never strip the floor that bounds them.
 */
export function membershipFromChain(
  pinned: PinnedSnapshot,
  chain: ChainMembership,
  firstSeen: ReadonlyMap<string, MemberFirstSeen>,
  policy: DiscoveryPolicy,
  nowUnix: number,
): { members: MemberRecord[]; firstSeen: Map<string, MemberFirstSeen>; keptByFloor: string[]; probation: string[] } {
  const floorByAddress = new Map(eligiblePinnedMembers(pinned).map((member) => [member.address, member]));
  const seen = new Map<string, MemberFirstSeen>();
  const members: MemberRecord[] = [];
  for (const profile of chain.registered) {
    if (!isEligible(profile)) continue;
    const role = profile.role as 1 | 2 | 3;
    const floorMember = floorByAddress.get(profile.address);
    const floor = floorMember !== undefined && floorMember.sphinxKey === profile.sphinxKey && floorMember.role === role;
    let probation = false;
    if (!floor) {
      const first = firstSeen.get(profile.address) ?? { address: profile.address, block: chain.block.number, time: chain.block.timestamp };
      seen.set(profile.address, first);
      probation = nowUnix - first.time < policy.probationSeconds;
    }
    members.push({
      address: profile.address,
      sphinxKey: profile.sphinxKey,
      url: profile.url,
      ingressUrl: profile.ingressUrl,
      metadataUrl: profile.metadataUrl,
      stake: profile.stake,
      role,
      layer: primaryLayerForRole(profile.address, role) as 0 | 1 | 2,
      status: profile.status as 1 | 2,
      frozen: false,
      capabilities: floor ? [...floorMember!.capabilities] : [],
      floor,
      probation,
    });
  }
  const present = new Set(members.map((member) => member.address));
  const keptByFloor: string[] = [];
  for (const layer of FLOOR_LAYERS) {
    const floorInLayer = [...floorByAddress.values()].filter((member) => layer.has(member.role, kpsAddrFromMetadataUrl(member.metadataUrl) !== null));
    const target = Math.min(policy.minMembersPerLayer, floorInLayer.length);
    const keptCount = (): number =>
      members.filter((member) => member.floor && layer.has(member.role, kpsAddrFromMetadataUrl(member.metadataUrl) !== null)).length;
    for (const member of floorInLayer) {
      if (keptCount() >= target) break;
      if (present.has(member.address)) continue;
      members.push({ ...member, capabilities: [...member.capabilities], floor: true, probation: false });
      present.add(member.address);
      keptByFloor.push(member.address);
    }
  }
  members.sort((left, right) => (left.address < right.address ? -1 : 1));
  return {
    members,
    firstSeen: seen,
    keptByFloor,
    probation: members.filter((member) => member.probation).map((member) => member.address),
  };
}

/** Route layers for the removal floor, as role and entry-capability predicates. */
const FLOOR_LAYERS: readonly { has(role: number, kps: boolean): boolean }[] = [
  { has: (role, kps) => layersForRole(role).includes(0) && kps },
  { has: (role) => layersForRole(role).includes(1) },
  { has: (role) => role === 2 || role === 3 },
];

function isEligible(profile: ChainProfile): boolean {
  return (profile.status === 1 || profile.status === 2) &&
    !profile.frozen &&
    (profile.role === 1 || profile.role === 2 || profile.role === 3) &&
    /^[0-9a-f]{64}$/u.test(profile.sphinxKey) &&
    profile.url.length > 0;
}

async function readAll<T>(
  context: ChainCheckContext,
  pairs: readonly ReadPair[],
  body: string,
  expectedBytes: number,
  parse: (text: string) => T,
): Promise<{ kind: "ok"; values: T[] } | { kind: "failed"; failed: ReadPair[]; detail: string }> {
  const settled = await Promise.allSettled(
    pairs.map(async (pair) => parse(await context.send(pair.exit, pair.provider, body, expectedBytes))),
  );
  const failed: ReadPair[] = [];
  const reasons: string[] = [];
  const values: T[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      values.push(result.value);
    } else {
      failed.push(pairs[index]!);
      reasons.push(describe(result.reason));
    }
  });
  return failed.length > 0 ? { kind: "failed", failed, detail: reasons.join("; ") } : { kind: "ok", values };
}

function orderPreferred<T>(items: T[], avoided: (item: T) => boolean, randomIndex: (n: number) => number): T[] {
  const shuffle = (list: T[]): T[] => {
    for (let index = list.length - 1; index > 0; index--) {
      const other = randomIndex(index + 1);
      [list[index], list[other]] = [list[other]!, list[index]!];
    }
    return list;
  };
  return [...shuffle(items.filter((item) => !avoided(item))), ...shuffle(items.filter(avoided))];
}

function batchResults(text: string, expected: number): Map<number, unknown> {
  const reply = parseJson(text);
  if (!Array.isArray(reply)) throw partial("the batch reply is not a JSON array");
  const results = new Map<number, unknown>();
  for (const item of reply) {
    if (!isRecord(item) || typeof item["id"] !== "number") throw partial("a batch item has no numeric id");
    if (item["error"] !== undefined) {
      const message = isRecord(item["error"]) ? String(item["error"]["message"]).slice(0, 160) : "error";
      throw partial(`call ${item["id"]} failed: ${message}`);
    }
    if (!("result" in item)) throw partial(`call ${item["id"]} has no result`);
    if (results.has(item["id"])) throw partial(`call ${item["id"]} answered twice`);
    results.set(item["id"], item["result"]);
  }
  for (let id = 1; id <= expected; id++) {
    if (!results.has(id)) throw partial(`call ${id} is missing from the batch reply`);
  }
  if (results.size !== expected) throw partial(`the batch reply has ${results.size} items, expected ${expected}`);
  return results;
}

function parseBlock(value: unknown, what: string): FinalizedBlock {
  if (!isRecord(value)) throw partial(`${what} is not a block object`);
  const hash = typeof value["hash"] === "string" ? value["hash"].toLowerCase() : "";
  if (!HASH_RE.test(hash)) throw partial(`${what} has no block hash`);
  return {
    hash,
    number: parseQuantity(value["number"], `${what}.number`),
    timestamp: parseQuantity(value["timestamp"], `${what}.timestamp`),
  };
}

function parseQuantity(value: unknown, what: string): number {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (!QUANTITY_RE.test(text)) throw partial(`${what} is not a hex quantity`);
  const number = Number.parseInt(text.slice(2), 16);
  if (!Number.isSafeInteger(number)) throw partial(`${what} is out of range`);
  return number;
}

function parseData(value: unknown, what: string): string {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (!DATA_RE.test(text)) throw partial(`${what} is not hex data`);
  return text;
}

function decodeOne(value: unknown, method: string): readonly unknown[] {
  const data = typeof value === "string" ? value : parseData(value, method);
  try {
    return REGISTRY_INTERFACE.decodeFunctionResult(method, data);
  } catch (error) {
    throw partial(`${method} returned undecodable data: ${describe(error).slice(0, 120)}`);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw partial("the reply is not JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function partial(message: string): DiscoveryError {
  return new DiscoveryError("partial", message);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A `NoxClientError` for a chain check outcome other than `verified`, for `topologyRefreshError`. */
export function discoveryOutcomeError(outcome: Exclude<ChainCheckOutcome, { kind: "verified" }>): NoxClientError {
  return new NoxClientError(
    `KPS discovery chain check ${outcome.kind}: ${outcome.detail}`,
    NoxClientErrorCode.TopologyVerificationFailed,
  );
}
