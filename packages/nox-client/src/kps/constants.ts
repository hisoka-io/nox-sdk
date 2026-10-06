/**
 * KPS mode defaults (ARCHITECTURE §3.2-§3.6). Transport defaults live in
 * `transport.ts` (`KPS_TRANSPORT_DEFAULTS`).
 */

/** Defaults of the `KpsModeOptions` fields that are not transport settings. */
export const KPS_CLIENT_DEFAULTS = Object.freeze({
  /** Served topologies wanted per boot and per refresh. */
  topologySources: 2,
  /** Anchors dialled at once during boot. */
  anchorParallelism: 3,
  /** Reply claim interval (classic polling uses the same 200 ms). */
  claimIntervalMs: 200,
  /** Clock skew tolerated on served topology timestamps (classic: 60 s). */
  clockSkewToleranceSeconds: 600,
});

/** Allowed range of `topologySources`. */
export const KPS_TOPOLOGY_SOURCES_RANGE = Object.freeze({ min: 1, max: 4 });

/** Allowed range of `anchorParallelism`. */
export const KPS_ANCHOR_PARALLELISM_RANGE = Object.freeze({ min: 1, max: 16 });

/** Delay between starting two boot anchors. */
export const KPS_ANCHOR_STAGGER_MS = 250;

/** After the first served topology arrives, how long boot waits for more. */
export const KPS_SECOND_SOURCE_WAIT_MS = 1_500;

/** Consecutive transport failures on the pinned entry before it is replaced. */
export const KPS_ENTRY_SWITCH_AFTER_FAILURES = 2;

/**
 * Most SURB IDs sent in one reply claim over KPS. Equal to the `nox-kps`
 * default `claim_max_surb_ids` (published as `claimMaxSurbIds` in its
 * `/metadata.json`): 128 full replies fit the 16 MiB claim response cap. When
 * more IDs are active, successive claims rotate through them; unclaimed
 * replies wait in the entry's response buffer for the next poll.
 */
export const KPS_CLAIM_MAX_SURB_IDS = 128;

/**
 * The claim window for one poll: at most `max` IDs starting at `cursor`
 * (wrapping), and the cursor for the next poll. With `max` or fewer IDs every
 * ID is claimed and the cursor stays 0.
 */
export function claimWindow(
  ids: readonly string[],
  cursor: number,
  max: number,
): { window: string[]; next: number } {
  if (ids.length <= max) return { window: [...ids], next: 0 };
  const start = cursor % ids.length;
  const window = ids.slice(start, start + max);
  if (window.length < max) window.push(...ids.slice(0, max - window.length));
  return { window, next: (start + max) % ids.length };
}

/** Format tag of the discovery bootstrap a bundle pins (`KpsBootstrap`). */
export const BOOTSTRAP_FORMAT = "nox-anon-rpc-bootstrap/1";

/** Inclusive ranges of the `DiscoveryPolicy` fields. */
export const DISCOVERY_POLICY_RANGES = Object.freeze({
  chainQuorum: [2, 4],
  maxStateAgeSeconds: [60, 86_400],
  chainRefreshSeconds: [1, 86_400],
  probationMaxPerRoute: [0, 2],
  probationSeconds: [0, 31_536_000],
  minRemovalSources: [2, 4],
  minMembersPerLayer: [1, 4],
} as const satisfies Record<string, readonly [number, number]>);

/** Policy of the production bootstrap (PROPOSAL §2.2). */
export const DISCOVERY_POLICY_DEFAULTS = Object.freeze({
  chainQuorum: 2,
  maxStateAgeSeconds: 3_600,
  chainRefreshSeconds: 600,
  probationMaxPerRoute: 1,
  probationSeconds: 1_209_600,
  minRemovalSources: 2,
  minMembersPerLayer: 2,
});

/** Bounds on list fields of the bootstrap and discovery options. */
export const DISCOVERY_LIMITS = Object.freeze({
  /** Anchors, gateways or bridges. */
  maxAnchors: 16,
  /** Learned anchors accepted from a cache. */
  maxLearned: 32,
  /** Registry RPC endpoints. */
  minRpcUrls: 2,
  maxRpcUrls: 8,
  maxRpcUrlLength: 256,
  /** First-seen records accepted (the registry holds at most 256 members). */
  maxFirstSeen: 256,
  /**
   * Member addresses one chain check reads, and nodes one served topology
   * document may list: the same 256-member bound. Each candidate costs two
   * `eth_call`s per pair at the public providers, so one anchor must not be
   * able to grow the read without limit.
   */
  maxCandidates: 256,
});

/** Pairings a chain check tries before it gives up until the next run. */
export const DISCOVERY_PAIRING_BUDGET = 3;

/**
 * Longest wait of the first chain check after ready for the first wallet call
 * to settle (wallet calls first); `discovery.firstCheckDeferMs` overrides it.
 */
export const DISCOVERY_FIRST_CHECK_MAX_DEFER_MS = 15_000;

/** Reply blocks of a registry read: one data block and one parity block. */
export const DISCOVERY_MIN_SURBS = 2;

/** Shortest gap between two chain checks that a trigger (not the timer) starts. */
export const DISCOVERY_TRIGGER_MIN_GAP_MS = 30_000;

/** Per-request reply budget of a registry read: fixed part plus per candidate member. */
export const DISCOVERY_REPLY_BYTES = Object.freeze({ base: 8_192, perMember: 2_048 });

/**
 * `eth_getLogs` fallback when served topologies do not name every member:
 * block span per request and requests per check.
 */
export const DISCOVERY_LOG_SCAN = Object.freeze({ chunkBlocks: 2_000_000, maxChunks: 8 });

/**
 * Most JSON-RPC calls in one request of a chain check. Public providers cap
 * batches (Tenderly's gateway answers 429 above 20 calls), so a larger read
 * goes out as several requests, one after another, all pinned to one block.
 */
export const DISCOVERY_MAX_BATCH_CALLS = 20;

/** Clock skew tolerated on a finalized block's timestamp. */
export const DISCOVERY_CLOCK_SKEW_SECONDS = 600;
