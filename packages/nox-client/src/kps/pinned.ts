/**
 * Pinned bootstrap (D-02, ARCHITECTURE §3.4, §5) and the S1 identity/location
 * split (PROPOSAL §2.2): the registry snapshot that ships inside the
 * hash-pinned bundle is the floor of who a member is (address, Sphinx key,
 * role, layer). Where a member is (url, ingressUrl, metadataUrl) is a hint
 * that served documents and chain checks may update without the member
 * counting as removed.
 *
 * Pure functions: no network, no clock reads (callers pass `nowUnix`).
 */
import {
  NoxClientError,
  NoxClientErrorCode,
  type PinnedMember,
  type PinnedSnapshot,
  type RelayerNode,
  type TopologyLiveness,
  type TopologyNode,
  type TopologySnapshot,
} from "../types.js";
import {
  computeTopologyFingerprint,
  layersForRole,
  parseNode,
  primaryLayerForRole,
  selectRoute,
  verifySelfConsistency,
} from "../topology.js";
import { kpsAddrFromMetadataUrl, kpsEntryEndpoint } from "./address.js";
import { DISCOVERY_LIMITS } from "./constants.js";

export const PINNED_SNAPSHOT_FORMAT = "nox-anon-rpc-snapshot/1";
/** Cap on pinned members and on `relayerCount` (schema `maxItems`). */
export const MAX_PINNED_MEMBERS = 256;
/** Highest PoW difficulty a pinned or served snapshot may set. */
export const MAX_PINNED_POW_DIFFICULTY = 16;

const SNAPSHOT_KEYS = [
  "format",
  "chainId",
  "registry",
  "blockNumber",
  "blockHash",
  "fingerprint",
  "relayerCount",
  "powDifficulty",
  "members",
] as const;
const MEMBER_KEYS = [
  "address",
  "sphinxKey",
  "url",
  "ingressUrl",
  "metadataUrl",
  "stake",
  "role",
  "layer",
  "status",
  "frozen",
  "capabilities",
] as const;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;
const HASH_RE = /^0x[0-9a-f]{64}$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;
const STAKE_RE = /^(?:0|[1-9][0-9]*)$/u;
const MAX_FIELD_LENGTH = 256;
const MAX_CAPABILITIES = 32;
const MAX_CAPABILITY_LENGTH = 64;

/**
 * One member the client routes over: a pinned or chain-verified profile.
 * `floor`: in the snapshot with the same identity. `probation`: outside the
 * snapshot and seen on chain for less than the policy's probation period.
 */
export interface MemberRecord extends PinnedMember {
  floor: boolean;
  probation: boolean;
}

/** One topology document a node served over KPS, with the KPS address it came from. */
export interface ServedTopology {
  anchor: string;
  snapshot: TopologySnapshot;
}

/** Route layers the floor rule protects (ARCHITECTURE §5.3). */
export type RouteLayer = "entry" | "mix" | "exit";
const ROUTE_LAYERS: readonly RouteLayer[] = ["entry", "mix", "exit"];
/** Accepted documents from this many different anchors are needed before any member is removed. */
export const MIN_REMOVAL_SOURCES = 2;
/** Members each layer keeps (or every pinned eligible member of the layer, when fewer). */
export const MIN_MEMBERS_PER_LAYER = 2;

/** Members the client routes over after applying served topologies. */
export interface WorkingSet {
  members: RelayerNode[];
  /** Base members left out (addresses, lowercase). */
  removed: string[];
  /** Served members outside the base membership, ignored (additions come from a chain check or a new bundle). */
  ignoredAdditions: number;
  /** Members whose routing `url` comes from served documents that agree on a newer value than the base. */
  relocated: string[];
  /** Served documents that passed every check. */
  sourcesAccepted: number;
  /**
   * True when accepted documents came from at least `MIN_REMOVAL_SOURCES`
   * different anchors, so removals applied. False means the working set is
   * every pinned eligible member.
   */
  removalQuorum: boolean;
  /** True when a layer would have dropped below the floor and kept its previous members. */
  floorApplied: boolean;
  /** Layers that hit the floor. */
  floorLayers: RouteLayer[];
  /**
   * Layers whose members every accepted document still lists with the pinned
   * profile but none reports online (for example while the P2P mesh re-forms
   * after a fleet restart). They keep their previous members; calls through
   * them fail one by one until a refresh sees members online again.
   */
  offlineLayers: RouteLayer[];
  /** Why each rejected served document was rejected, by anchor. */
  rejected: { anchor: string; reason: string }[];
}

export interface ApplyServedOptions {
  clockSkewToleranceSeconds: number;
  livenessMaxAgeSeconds: number;
  /** KPS addresses allowed as entries; default every pinned member with one. */
  entryAddresses?: ReadonlySet<string>;
  /** Working set whose members a layer below the floor keeps; default every base member. */
  previous?: readonly RelayerNode[];
  /**
   * Eligible members the documents are judged against (snapshot floor, or a
   * chain-verified set). Default: every eligible pinned member.
   */
  membership?: readonly MemberRecord[];
  /** Member behind each anchor (KPS address → lowercase registry address). Default: the pinned KPS addresses. */
  anchorMembers?: ReadonlyMap<string, string>;
  /** Entry location per member (lowercase address → KPS address). Default: the pinned KPS addresses. */
  endpoints?: ReadonlyMap<string, string>;
  /**
   * Block the base membership's locations and member list are known at
   * (default: the snapshot block). Documents at or before it relocate
   * nobody, and members that only documents older than it omit are kept:
   * those documents cannot know them.
   */
  membershipBlock?: number;
  /** Default `MIN_REMOVAL_SOURCES`. */
  minRemovalSources?: number;
  /** Default `MIN_MEMBERS_PER_LAYER`. */
  minMembersPerLayer?: number;
}

/** Inputs of `routingNodes`: entry locations, capability hints and probation flags per member. */
export interface RoutingContext {
  /** Lowercase member address → KPS address used as its entry endpoint. */
  readonly endpoints: ReadonlyMap<string, string>;
  /** Only these KPS addresses may be entries; `undefined` = every endpoint. */
  readonly entryAddresses?: ReadonlySet<string> | undefined;
  readonly capabilities: ReadonlyMap<string, readonly string[]>;
  readonly probation: ReadonlySet<string>;
}

/**
 * Check a pinned snapshot completely (ARCHITECTURE §3.4 step 1, §5.1): exact
 * keys, field formats, canonical member order, member count, fingerprint,
 * primary layers. Throws `TOPOLOGY_VERIFICATION_FAILED` naming the problem.
 */
export function verifyPinnedSnapshot(pinned: PinnedSnapshot): void {
  const value: unknown = pinned;
  if (!isPlainRecord(value)) throw invalid("the snapshot is not an object");
  checkKeys(value, SNAPSHOT_KEYS, "snapshot");
  if (value["format"] !== PINNED_SNAPSHOT_FORMAT) {
    throw invalid(`format must be "${PINNED_SNAPSHOT_FORMAT}"`);
  }
  checkInteger(value["chainId"], "chainId", 1, Number.MAX_SAFE_INTEGER);
  checkPattern(value["registry"], ADDRESS_RE, "registry (lowercase 0x address)");
  checkInteger(value["blockNumber"], "blockNumber", 1, Number.MAX_SAFE_INTEGER);
  checkPattern(value["blockHash"], HASH_RE, "blockHash (lowercase 0x 32-byte hash)");
  checkPattern(value["fingerprint"], HEX64_RE, "fingerprint (64 lowercase hex)");
  checkInteger(value["relayerCount"], "relayerCount", 1, MAX_PINNED_MEMBERS);
  checkInteger(value["powDifficulty"], "powDifficulty", 0, MAX_PINNED_POW_DIFFICULTY);
  const members = value["members"];
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_PINNED_MEMBERS) {
    throw invalid(`members must be an array of 1..${MAX_PINNED_MEMBERS} members`);
  }
  members.forEach((member, index) => checkMember(member, index));
  const addresses = (members as PinnedMember[]).map((member) => member.address);
  for (let index = 1; index < addresses.length; index++) {
    if (!(addresses[index - 1]! < addresses[index]!)) {
      throw invalid("members must be sorted by address, ascending and without duplicates");
    }
  }
  if (members.length !== value["relayerCount"]) {
    throw invalid(`relayerCount ${String(value["relayerCount"])} does not match ${members.length} members`);
  }
  const computed = computeTopologyFingerprint(pinnedRelayerNodes(pinned));
  if (computed !== value["fingerprint"]) {
    throw invalid(`fingerprint mismatch: members hash to ${computed}`);
  }
}

/** Pinned members in the client's `RelayerNode` shape (every member, eligible or not). */
export function pinnedRelayerNodes(pinned: PinnedSnapshot): RelayerNode[] {
  return pinned.members.map(toRelayerNode);
}

/** Members eligible for routing: status 1 or 2 and not frozen (as `verifyOnChainWithEligibility`). */
export function eligiblePinnedMembers(pinned: PinnedSnapshot): PinnedMember[] {
  return pinned.members.filter((member) => (member.status === 1 || member.status === 2) && !member.frozen);
}

/** Every eligible pinned member as a floor record. */
export function floorRecords(pinned: PinnedSnapshot): MemberRecord[] {
  return eligiblePinnedMembers(pinned).map((member) => ({ ...member, floor: true, probation: false }));
}

/** KPS address of each pinned member that published one, by lowercase registry address. */
export function pinnedKpsAddresses(pinned: PinnedSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  for (const member of pinned.members) {
    const address = kpsAddrFromMetadataUrl(member.metadataUrl);
    if (address !== null) out.set(member.address, address);
  }
  return out;
}

/**
 * Routing nodes for a working set: entry endpoint `kps:<address>` for members
 * whose KPS address is allowed as an entry, `""` for the rest (they still route
 * as mix or exit by multiaddr), and the pinned capability hints.
 */
export function kpsTopologyNodes(
  pinned: PinnedSnapshot,
  members: readonly RelayerNode[],
  entryAddresses?: ReadonlySet<string>,
): TopologyNode[] {
  return routingNodes(members, pinnedRoutingContext(pinned, entryAddresses));
}

/** Routing context of the pinned snapshot alone: pinned KPS addresses and capability hints, no probation. */
export function pinnedRoutingContext(pinned: PinnedSnapshot, entryAddresses?: ReadonlySet<string>): RoutingContext {
  return {
    endpoints: pinnedKpsAddresses(pinned),
    entryAddresses,
    capabilities: new Map(pinned.members.map((member) => [member.address, member.capabilities])),
    probation: new Set(),
  };
}

/**
 * Routing nodes for a working set: entry endpoint `kps:<address>` for members
 * whose location is allowed as an entry, `""` for the rest (they still route
 * as mix or exit by multiaddr), capability hints and probation flags.
 */
export function routingNodes(members: readonly RelayerNode[], context: RoutingContext): TopologyNode[] {
  return members.map((raw) => {
    const node = parseNode(raw);
    const address = context.endpoints.get(node.id);
    const allowed = address !== undefined && (context.entryAddresses === undefined || context.entryAddresses.has(address));
    const capabilities = context.capabilities.get(node.id) ?? [];
    return {
      ...node,
      address: allowed ? kpsEntryEndpoint(address) : "",
      capabilities: Object.freeze([...capabilities]),
      ...(context.probation.has(node.id) ? { probation: true } : {}),
    };
  });
}

/**
 * Apply node-served topology documents to the base membership (the eligible
 * pinned members, or a chain-verified set) under the removals-only rule
 * (ARCHITECTURE §5.3) with identity-only presence (PROPOSAL §2.2 step 5).
 *
 * A served document S from anchor a is accepted only if it is self-consistent
 * with complete liveness, pinned at or after the snapshot block, timestamped
 * within the liveness window plus the clock skew tolerance, the anchor maps to
 * a base member, and S lists that member. A base member is kept when at least
 * one accepted document lists it with its identity (address, Sphinx key,
 * role, layer) and reports it online with a fresh observation, so a removal
 * needs every accepted source to agree. Members a document adds are ignored.
 * A changed url, ingressUrl or metadataUrl is a location change, never a
 * removal: when documents from at least `minRemovalSources` different anchors
 * agree on a newer routing `url`, the member routes over it (listed in
 * `relocated`); a wrong host cannot peel the layer encrypted to the member's
 * key, so the worst case is a dropped packet until the next chain check.
 *
 * Single-source rule: removals apply only when documents from at least
 * `minRemovalSources` different anchors are accepted. Two different anchors
 * always include one that is not the current entry, so the entry, which
 * already knows the client's address, can never shrink the set on its own.
 * With fewer, the result is every base member.
 *
 * Floor: each layer (KPS entries, mixes, exits) keeps at least
 * `min(minMembersPerLayer, base members in that layer)` members. A layer the
 * agreed removals would leave below the floor keeps the previous working
 * set's members of that layer and is listed in `floorLayers`.
 *
 * Registry evidence versus liveness: `TOPOLOGY_STALE` rests on registry
 * evidence only, that is every accepted document omits each base member of a
 * layer or lists it with another identity. A layer whose members are still
 * listed but reported offline (node liveness is an in-memory P2P view that
 * starts empty after a restart) is a transient state: the layer keeps its
 * previous members, is listed in `floorLayers` and `offlineLayers`, and calls
 * fail one by one until members come back online.
 */
export function applyServedTopologies(
  pinned: PinnedSnapshot,
  served: readonly ServedTopology[],
  nowUnix: number,
  options: ApplyServedOptions,
): WorkingSet {
  const base = options.membership ?? floorRecords(pinned);
  const baseByAddress = new Map(base.map((member) => [member.address, member]));
  const anchorMembers = options.anchorMembers ?? invertMap(pinnedKpsAddresses(pinned));
  const minSources = options.minRemovalSources ?? MIN_REMOVAL_SOURCES;
  const minPerLayer = options.minMembersPerLayer ?? MIN_MEMBERS_PER_LAYER;

  const accepted: { anchor: string; snapshot: TopologySnapshot }[] = [];
  const acceptedAnchors = new Set<string>();
  const rejected: { anchor: string; reason: string }[] = [];
  for (const source of served) {
    const reason = rejectionReason(pinned, source, anchorMembers, baseByAddress, nowUnix, options);
    if (reason === null) {
      accepted.push(source);
      acceptedAnchors.add(source.anchor);
    } else {
      rejected.push({ anchor: source.anchor, reason });
    }
  }

  const additions = new Set<string>();
  for (const { snapshot } of accepted) {
    for (const node of snapshot.nodes) {
      const address = node.address.toLowerCase();
      if (!baseByAddress.has(address)) additions.add(address);
    }
  }
  const unchanged = (removalQuorum: boolean): WorkingSet => ({
    members: base.map(toRelayerNode),
    removed: [],
    ignoredAdditions: additions.size,
    relocated: [],
    sourcesAccepted: accepted.length,
    removalQuorum,
    floorApplied: false,
    floorLayers: [],
    offlineLayers: [],
    rejected,
  });
  if (acceptedAnchors.size < minSources) return unchanged(false);

  // `listed`: registry evidence, some accepted document lists the member with
  // its identity. `kept`: listed and reported online by such a document.
  const listed = new Set<string>();
  const kept = new Set<string>();
  const relocatedUrls = new Map<string, string>();
  const membershipBlock = options.membershipBlock ?? pinned.blockNumber;
  const allOlder = accepted.every(({ snapshot }) => (snapshot.block_number ?? 0) < membershipBlock);
  for (const member of base) {
    const present = accepted.filter(({ snapshot }) => findWithIdentity(snapshot, member) !== undefined);
    if (present.length === 0) {
      if (allOlder && !accepted.some(({ snapshot }) => listsAddress(snapshot, member.address))) {
        // Every document predates what the client knows about this member.
        listed.add(member.address);
        kept.add(member.address);
      }
      continue;
    }
    listed.add(member.address);
    if (present.some(({ snapshot }) => isOnline(snapshot, member.address, options.livenessMaxAgeSeconds))) {
      kept.add(member.address);
    }
    const newer = present.filter(({ snapshot }) => (snapshot.block_number ?? 0) > membershipBlock);
    const agreed = agreedNewUrl(newer, member, minSources);
    if (agreed !== undefined) relocatedUrls.set(member.address, agreed);
  }

  const context: RoutingContext = {
    endpoints: options.endpoints ?? pinnedKpsAddresses(pinned),
    entryAddresses: options.entryAddresses,
    capabilities: new Map(),
    probation: new Set(),
  };
  const baseNodes = routingNodes(base.map(toRelayerNode), context);
  const previous = new Set((options.previous ?? base.map(toRelayerNode)).map((node) => node.address.toLowerCase()));
  // Layers overlap (a relay can be entry and mix), so every layer is measured
  // against the agreed set before any layer gets its previous members back.
  const agreed = new Set(kept);
  const floorLayers: RouteLayer[] = [];
  const offlineLayers: RouteLayer[] = [];
  const gone: RouteLayer[] = [];
  for (const layer of ROUTE_LAYERS) {
    const inLayer = baseNodes.filter((node) => isInLayer(node, layer));
    if (inLayer.length === 0) continue;
    if (!inLayer.some((node) => listed.has(node.id))) {
      gone.push(layer);
      continue;
    }
    const floor = Math.min(minPerLayer, inLayer.length);
    const remaining = inLayer.filter((node) => agreed.has(node.id)).length;
    if (remaining >= floor) continue;
    floorLayers.push(layer);
    const restored = inLayer.filter((node) => previous.has(node.id));
    if (remaining === 0) {
      offlineLayers.push(layer);
      // A previous set without this layer falls back to the members still listed.
      const back = restored.length > 0 ? restored : inLayer.filter((node) => listed.has(node.id));
      for (const node of back) kept.add(node.id);
    } else {
      for (const node of restored) kept.add(node.id);
    }
  }
  if (gone.length > 0) {
    throw new NoxClientError(
      `${acceptedAnchors.size} served topologies from different anchors agree that the registry no longer lists ` +
        `the ${gone.join(", ")} members with their known identities (${base.length} eligible members known); ` +
        "this bundle's snapshot is stale",
      NoxClientErrorCode.TopologyStale,
    );
  }
  const relocated = base.filter((member) => kept.has(member.address) && relocatedUrls.has(member.address));
  return {
    members: base
      .filter((member) => kept.has(member.address))
      .map((member) => {
        const url = relocatedUrls.get(member.address);
        return toRelayerNode(url === undefined ? member : { ...member, url });
      }),
    removed: base.filter((member) => !kept.has(member.address)).map((member) => member.address),
    ignoredAdditions: additions.size,
    relocated: relocated.map((member) => member.address),
    sourcesAccepted: accepted.length,
    removalQuorum: true,
    floorApplied: floorLayers.length > 0,
    floorLayers,
    offlineLayers,
    rejected,
  };
}

/**
 * The routing `url` that documents from at least `minSources` different
 * anchors list for `member` (with its identity) when it differs from the
 * base, or `undefined`.
 */
function agreedNewUrl(
  present: readonly { anchor: string; snapshot: TopologySnapshot }[],
  member: PinnedMember,
  minSources: number,
): string | undefined {
  const anchorsByUrl = new Map<string, Set<string>>();
  for (const { anchor, snapshot } of present) {
    const node = findWithIdentity(snapshot, member);
    if (node === undefined || node.url === member.url) continue;
    const anchors = anchorsByUrl.get(node.url) ?? new Set<string>();
    anchors.add(anchor);
    anchorsByUrl.set(node.url, anchors);
  }
  const agreed = [...anchorsByUrl].filter(([, anchors]) => anchors.size >= minSources);
  // Two different newer values with quorum each: no agreement, keep the base.
  return agreed.length === 1 ? agreed[0]![0] : undefined;
}

function invertMap(map: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of map) out.set(value, key);
  return out;
}

/** True when `node` can serve `layer` under `selectRoute`'s rules (entries need a `kps:` endpoint). */
function isInLayer(node: TopologyNode, layer: RouteLayer): boolean {
  const layers = layersForRole(node.role);
  switch (layer) {
    case "entry":
      return layers.includes(0) && node.address.length > 0;
    case "mix":
      return layers.includes(1);
    case "exit":
      return layers.includes(2) && (node.role === 2 || node.role === 3);
  }
}

/** Highest PoW difficulty among the pinned value and accepted served documents, capped. */
export function pinnedPowDifficulty(pinned: PinnedSnapshot, served: readonly TopologySnapshot[]): number {
  let difficulty = pinned.powDifficulty;
  for (const snapshot of served) {
    const value = snapshot.pow_difficulty;
    if (value !== undefined && Number.isSafeInteger(value) && value > difficulty) difficulty = value;
  }
  return Math.min(difficulty, MAX_PINNED_POW_DIFFICULTY);
}

/** True when `members` can carry one entry → mix → exit route under the entry rule. */
export function formsRoute(
  pinned: PinnedSnapshot,
  members: readonly RelayerNode[],
  entryAddresses?: ReadonlySet<string>,
): boolean {
  return formsRouteWith(members, pinnedRoutingContext(pinned, entryAddresses));
}

/** `formsRoute` with an explicit routing context (discovery). */
export function formsRouteWith(members: readonly RelayerNode[], context: RoutingContext): boolean {
  if (members.length === 0) return false;
  try {
    selectRoute(routingNodes(members, context), undefined, undefined, undefined, (node) => node.address.length > 0);
    return true;
  } catch {
    return false;
  }
}

function rejectionReason(
  pinned: PinnedSnapshot,
  source: ServedTopology,
  anchorMembers: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, MemberRecord>,
  nowUnix: number,
  options: ApplyServedOptions,
): string | null {
  const snapshot = source.snapshot;
  if (snapshot.nodes.length > DISCOVERY_LIMITS.maxCandidates) {
    return `lists ${snapshot.nodes.length} nodes, more than the ${DISCOVERY_LIMITS.maxCandidates} a registry holds for this client`;
  }
  try {
    verifySelfConsistency(snapshot, true);
  } catch (error) {
    return `not self-consistent: ${error instanceof Error ? error.message : String(error)}`;
  }
  const block = snapshot.block_number ?? 0;
  if (block < pinned.blockNumber) {
    return `pinned at block ${block}, before the snapshot block ${pinned.blockNumber}`;
  }
  const timestamp = snapshot.timestamp ?? 0;
  const oldest = nowUnix - (options.livenessMaxAgeSeconds + options.clockSkewToleranceSeconds);
  const newest = nowUnix + options.clockSkewToleranceSeconds;
  if (timestamp < oldest || timestamp > newest) {
    return `timestamp ${timestamp} is outside [${oldest}, ${newest}] (local clock ${nowUnix})`;
  }
  const anchorMember = anchorMembers.get(source.anchor);
  if (anchorMember === undefined) {
    return options.anchorMembers === undefined
      ? "the anchor is not a pinned member's KPS address"
      : "the anchor maps to no known member";
  }
  const member = base.get(anchorMember);
  if (member === undefined) return "the anchor's member is not an eligible known member";
  if (findWithIdentity(snapshot, member) === undefined) {
    return "the anchor's own member is missing from the document it served";
  }
  return null;
}

function listsAddress(snapshot: TopologySnapshot, address: string): boolean {
  return snapshot.nodes.some((node) => node.address.toLowerCase() === address);
}

/** The document's entry for `member` when it carries the same identity (address, Sphinx key, role, layer). */
function findWithIdentity(snapshot: TopologySnapshot, member: PinnedMember): RelayerNode | undefined {
  const node = snapshot.nodes.find((candidate) => candidate.address.toLowerCase() === member.address);
  return node !== undefined &&
      node.sphinx_key.toLowerCase().replace(/^0x/u, "") === member.sphinxKey &&
      node.role === member.role &&
      node.layer === member.layer
    ? node
    : undefined;
}

function isOnline(snapshot: TopologySnapshot, address: string, maxAgeSeconds: number): boolean {
  const timestamp = snapshot.timestamp ?? 0;
  const observation: TopologyLiveness | undefined = snapshot.liveness?.find(
    (entry) => entry.address.toLowerCase() === address,
  );
  return (
    observation !== undefined &&
    observation.status === "online" &&
    observation.observed_at_unix <= timestamp &&
    timestamp - observation.observed_at_unix <= maxAgeSeconds
  );
}

/** A member profile in the client's `RelayerNode` shape. */
export function toRelayerNode(member: PinnedMember): RelayerNode {
  return {
    address: member.address,
    sphinx_key: member.sphinxKey,
    url: member.url,
    stake: member.stake,
    last_seen: 0,
    is_privileged: member.stake === "0",
    layer: member.layer,
    role: member.role,
    ingress_url: member.ingressUrl,
    metadata_url: member.metadataUrl,
  };
}

function checkMember(member: unknown, index: number): void {
  const where = `members[${index}]`;
  if (!isPlainRecord(member)) throw invalid(`${where} is not an object`);
  checkKeys(member, MEMBER_KEYS, where);
  checkPattern(member["address"], ADDRESS_RE, `${where}.address (lowercase 0x address)`);
  checkPattern(member["sphinxKey"], HEX64_RE, `${where}.sphinxKey (64 lowercase hex)`);
  checkString(member["url"], `${where}.url`, 1);
  checkString(member["ingressUrl"], `${where}.ingressUrl`, 0);
  checkString(member["metadataUrl"], `${where}.metadataUrl`, 0);
  checkPattern(member["stake"], STAKE_RE, `${where}.stake (decimal string)`);
  const role = member["role"];
  if (role !== 1 && role !== 2 && role !== 3) throw invalid(`${where}.role must be 1, 2 or 3`);
  const layer = member["layer"];
  if (layer !== 0 && layer !== 1 && layer !== 2) throw invalid(`${where}.layer must be 0, 1 or 2`);
  if (!layersForRole(role).includes(layer)) throw invalid(`${where}.layer ${layer} is outside role ${role}`);
  if (layer !== primaryLayerForRole(member["address"] as string, role)) {
    throw invalid(`${where}.layer ${layer} is not the primary layer of role ${role}`);
  }
  const status = member["status"];
  if (status !== 1 && status !== 2) throw invalid(`${where}.status must be 1 or 2`);
  if (typeof member["frozen"] !== "boolean") throw invalid(`${where}.frozen must be a boolean`);
  const capabilities = member["capabilities"];
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > MAX_CAPABILITIES ||
    !capabilities.every(
      (entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= MAX_CAPABILITY_LENGTH,
    ) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    throw invalid(`${where}.capabilities must be up to ${MAX_CAPABILITIES} unique strings of 1..${MAX_CAPABILITY_LENGTH} characters`);
  }
}

function checkKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalid(`${where} has an unknown field "${key}"`);
  }
  for (const key of keys) {
    if (!(key in value)) throw invalid(`${where} is missing "${key}"`);
  }
}

function checkInteger(value: unknown, field: string, min: number, max: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid(`${field} must be an integer in ${min}..${max}`);
  }
}

function checkPattern(value: unknown, pattern: RegExp, field: string): void {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(`${field} is malformed`);
}

function checkString(value: unknown, field: string, minLength: number): void {
  if (typeof value !== "string" || value.length < minLength || value.length > MAX_FIELD_LENGTH) {
    throw invalid(`${field} must be a string of ${minLength}..${MAX_FIELD_LENGTH} characters`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function invalid(detail: string): NoxClientError {
  return new NoxClientError(`Pinned snapshot is invalid: ${detail}`, NoxClientErrorCode.TopologyVerificationFailed);
}
