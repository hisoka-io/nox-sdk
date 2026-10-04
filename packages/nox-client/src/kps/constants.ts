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
