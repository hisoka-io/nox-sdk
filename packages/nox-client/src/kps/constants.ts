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
