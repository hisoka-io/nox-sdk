/**
 * Pinned snapshot (`nox-anon-rpc-snapshot/1`) and node-served topology
 * fixtures that satisfy every structural rule: canonical order, primary
 * layers, fingerprints and complete liveness.
 */
import { computeTopologyFingerprint, primaryLayerForRole } from "../../src/topology.js";
import type {
  DiscoveryPolicy,
  KpsBootstrap,
  PinnedMember,
  PinnedSnapshot,
  RelayerNode,
  TopologySnapshot,
} from "../../src/types.js";
import { kpsAddressFor } from "./fake_kps.js";

export const PINNED_BLOCK = 315_453_396;

export interface MemberSpec {
  role: 1 | 2 | 3;
  /** Default true: publishes `kps:<address>/metadata.json`. */
  kps?: boolean;
  status?: 1 | 2;
  frozen?: boolean;
  capabilities?: string[];
}

/** Address of fixture member `index` (1-based), lowercase and ascending with the index. */
export function memberAddress(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`;
}

/** Default fleet shape: 5 relays then 3 exits, every one KPS-capable. */
export const DEFAULT_MEMBERS: MemberSpec[] = [
  { role: 1 },
  { role: 1 },
  { role: 1 },
  { role: 1 },
  { role: 1 },
  { role: 2 },
  { role: 2 },
  { role: 2 },
];

export function makePinned(specs: MemberSpec[] = DEFAULT_MEMBERS, extra: Partial<PinnedSnapshot> = {}): PinnedSnapshot {
  const members: PinnedMember[] = specs.map((spec, offset) => {
    const index = offset + 1;
    const address = memberAddress(index);
    return {
      address,
      sphinxKey: index.toString(16).padStart(2, "0").repeat(32),
      url: `/ip4/10.0.0.${index}/tcp/15000/p2p/12D3KooWNode${index}`,
      ingressUrl: `https://nox-${index}.test`,
      metadataUrl: spec.kps === false ? "" : `kps:${kpsAddressFor(index)}/metadata.json`,
      stake: "0",
      role: spec.role,
      layer: primaryLayerForRole(address, spec.role) as 0 | 1 | 2,
      status: spec.status ?? 1,
      frozen: spec.frozen ?? false,
      capabilities: spec.capabilities ?? [],
    };
  });
  const pinned: PinnedSnapshot = {
    format: "nox-anon-rpc-snapshot/1",
    chainId: 421614,
    registry: "0xf7bff88a1412054a001dc4b8acbddad6f9b26cb6",
    blockNumber: PINNED_BLOCK,
    blockHash: `0x${"ab".repeat(32)}`,
    fingerprint: "",
    relayerCount: members.length,
    powDifficulty: 1,
    members,
    ...extra,
  };
  if (extra.fingerprint === undefined) {
    pinned.fingerprint = computeTopologyFingerprint(pinned.members.map(relayer));
  }
  return pinned;
}

export function relayer(member: PinnedMember): RelayerNode {
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

export interface ServedSpec {
  /** Member indexes (1-based) reported offline. */
  offline?: number[];
  /** Member indexes left out of the document. */
  omit?: number[];
  /** Extra members appended (not pinned). */
  add?: RelayerNode[];
  /** Change one member's profile. */
  mutate?: (node: RelayerNode, index: number) => RelayerNode;
  blockNumber?: number;
  timestamp?: number;
  powDifficulty?: number;
}

/** A node-served schema v2 topology consistent with `pinned`, adjusted by `spec`. */
export function served(pinned: PinnedSnapshot, nowUnix: number, spec: ServedSpec = {}): TopologySnapshot {
  const timestamp = spec.timestamp ?? nowUnix;
  let nodes = pinned.members
    .map((member, offset) => ({ node: relayer(member), index: offset + 1 }))
    .filter(({ index }) => !(spec.omit ?? []).includes(index))
    .map(({ node, index }) => (spec.mutate === undefined ? node : spec.mutate(node, index)));
  nodes = [...nodes, ...(spec.add ?? [])].sort((left, right) =>
    left.address.toLowerCase() < right.address.toLowerCase() ? -1 : 1
  );
  return {
    nodes,
    fingerprint: computeTopologyFingerprint(nodes),
    schema_version: 2,
    block_number: spec.blockNumber ?? pinned.blockNumber + 10,
    timestamp,
    pow_difficulty: spec.powDifficulty ?? 1,
    liveness: nodes.map((node) => {
      const index = Number.parseInt(node.address.slice(2), 16);
      return {
        address: node.address,
        status: (spec.offline ?? []).includes(index) ? "offline" as const : "online" as const,
        observed_at_unix: timestamp,
      };
    }),
  };
}

/** RPC endpoints of the fixture bootstrap: three different organisations. */
export const FIXTURE_PROVIDERS = [
  "https://rpc.provider-a.test/rpc",
  "https://gateway.provider-b.test/",
  "https://api.provider-c.test/v1",
];

/** A `nox-anon-rpc-bootstrap/1` for `pinned`: anchors default to the KPS addresses of members `anchorIndexes`. */
export function makeBootstrap(
  pinned: PinnedSnapshot,
  overrides: Partial<KpsBootstrap> & { policy?: Partial<DiscoveryPolicy> } = {},
): KpsBootstrap {
  const { policy, ...rest } = overrides;
  return {
    format: "nox-anon-rpc-bootstrap/1",
    chainId: pinned.chainId,
    registry: pinned.registry,
    registryImpl: "0x7285125cfdcb6337aaed2d56d4fe99f870ede2a2",
    anchors: [],
    registryRpcUrls: [...FIXTURE_PROVIDERS],
    ...rest,
    policy: {
      chainQuorum: 2,
      maxStateAgeSeconds: 3_600,
      chainRefreshSeconds: 600,
      probationMaxPerRoute: 1,
      probationSeconds: 1_209_600,
      minRemovalSources: 2,
      minMembersPerLayer: 2,
      ...policy,
    },
  };
}
