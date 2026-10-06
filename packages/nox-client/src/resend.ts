/**
 * Resend policy (`NoxClientConfig.resend`) and the reply-time statistics the
 * adaptive hedge reads.
 */
import { NoxClientError, NoxClientErrorCode, type ResendPolicy } from "./types.js";

export type { ResendPolicy } from "./types.js";

/** The 0.6 behaviour: one resend after a timeout or a transport failure, nothing earlier. */
export const RESEND_LEGACY: Readonly<ResendPolicy> = Object.freeze({
  hedgeAfterMs: 0,
  hedgeAdaptive: false,
  maxHedgesInFlight: 2,
  transportResends: 0,
  resendOnLostReply: false,
  sameEntryFallback: false,
});

/**
 * Low-latency policy for interactive callers (the anon-rpc worker): hedge at
 * about the p95 reply time with a 3 s floor, resend at once on a lost reply,
 * two transport-failure resends of their own, and same-entry resends for
 * single-bridge setups.
 */
export const RESEND_FAST: Readonly<ResendPolicy> = Object.freeze({
  hedgeAfterMs: 3_000,
  hedgeAdaptive: true,
  maxHedgesInFlight: 2,
  transportResends: 2,
  resendOnLostReply: true,
  sameEntryFallback: true,
});

/** Upper bound of `transportResends`. */
export const MAX_TRANSPORT_RESENDS = 4;
/** Upper bound of `maxHedgesInFlight`. */
export const MAX_HEDGES_IN_FLIGHT = 16;

/** Validate and fill a resend policy over `base`. Throws `INVALID_CONFIG` naming the field. */
export function resolveResendPolicy(
  overrides: Partial<ResendPolicy> | undefined,
  base: Readonly<ResendPolicy> = RESEND_LEGACY,
): ResendPolicy {
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null)) {
    throw new NoxClientError("resend must be an object", NoxClientErrorCode.InvalidConfig);
  }
  const policy: Record<string, number | boolean> = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in RESEND_LEGACY)) {
      throw new NoxClientError(`resend.${key} is not a resend setting`, NoxClientErrorCode.InvalidConfig);
    }
    if (value === undefined) continue;
    const current = (RESEND_LEGACY as unknown as Record<string, unknown>)[key];
    if (typeof current === "boolean") {
      if (typeof value !== "boolean") {
        throw new NoxClientError(`resend.${key} must be a boolean`, NoxClientErrorCode.InvalidConfig);
      }
      policy[key] = value;
      continue;
    }
    const max = key === "transportResends"
      ? MAX_TRANSPORT_RESENDS
      : key === "maxHedgesInFlight"
      ? MAX_HEDGES_IN_FLIGHT
      : 600_000;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
      throw new NoxClientError(`resend.${key} must be an integer in 0..${max}`, NoxClientErrorCode.InvalidConfig);
    }
    policy[key] = value;
  }
  return Object.freeze(policy) as unknown as ResendPolicy;
}

/** Reply-time samples kept for the adaptive hedge. */
export const LATENCY_SAMPLES = 64;
/** Samples needed before the adaptive hedge moves off its floor. */
export const LATENCY_MIN_SAMPLES = 8;

/** Recent reply times (send to reply) of successful attempts, for quantiles. */
export class LatencyTracker {
  private readonly samples: number[] = [];
  private next = 0;

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.samples.length < LATENCY_SAMPLES) this.samples.push(ms);
    else this.samples[this.next] = ms;
    this.next = (this.next + 1) % LATENCY_SAMPLES;
  }

  get count(): number {
    return this.samples.length;
  }

  /** The `q` quantile (0..1) of the samples, or undefined below `LATENCY_MIN_SAMPLES`. */
  quantile(q: number): number | undefined {
    if (this.samples.length < LATENCY_MIN_SAMPLES) return undefined;
    const sorted = [...this.samples].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[index];
  }

  /**
   * Hedge delay: the floor, raised to the p95 reply time when adaptive, and
   * kept below the attempt timeout (a hedge at the timeout is a resend).
   */
  hedgeDelay(policy: Readonly<ResendPolicy>, attemptTimeoutMs: number): number {
    let delay = policy.hedgeAfterMs;
    if (policy.hedgeAdaptive) {
      const p95 = this.quantile(0.95);
      if (p95 !== undefined) delay = Math.max(delay, Math.round(p95));
    }
    return Math.min(delay, Math.max(0, attemptTimeoutMs - 1));
  }
}
