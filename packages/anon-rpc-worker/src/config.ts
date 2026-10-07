/**
 * `anonRpcWorker.config` (ARCHITECTURE §4.2, PROPOSAL §2.5): optional,
 * JSON-compatible, and validated before anything touches the network.
 * `undefined` and `{}` both mean "defaults": the bundle pins the snapshot and
 * the default anchors, so the worker boots with no config at all (D-24).
 *
 * The host's value is never mutated; the parsed result is a frozen copy.
 */
import { checkAnchorList, checkRpcUrls, DISCOVERY_POLICY_RANGES } from "@hisoka-io/nox-client";
import { FAILED_CODES, NoxWorkerError } from "./errors.js";
import { LOG_LEVELS, type LogLevel } from "./log.js";

export type SurbFormatSetting = "auto" | "v1" | "v2";

/** `"chain"`: registry reads through the mixnet (S1). `"snapshot"`: the pinned snapshot is the only membership source. */
export type DiscoverySetting = "chain" | "snapshot";

/**
 * End-to-end TLS (README "End-to-end TLS"):
 * - `"required"`: https calls to a host name on port 443 go through TLS
 *   tunnels, so exits relay ciphertext only; every other call is refused and
 *   nothing ever falls back to the exit's `HttpRequest` path.
 * - `"preferred"`: tunnels where a tunnel exit is known and the URL allows
 *   one, `HttpRequest` otherwise. An operator who withholds `tunnel_v1` gets
 *   plaintext, so only `"required"` holds against the operator.
 * - `"off"`: every call is an exit `HttpRequest` (worker 0.3 behaviour).
 */
export type TlsSetting = "required" | "preferred" | "off";

/**
 * `"per-call"`: one TLS session per call (with `tlsSpares` handshaken spares
 * per recent host). `"keep-alive"`: calls to one host share a session on one
 * exit, which links them at the exit and at the provider.
 */
export type TlsSessionSetting = "per-call" | "keep-alive";

export interface NoxWorkerConfig {
  readonly v: 1;
  /** KPS addresses (`<ip>:<port>:<certhash>`) tried first, in place of the bundle's default anchors. */
  readonly gateways: readonly string[] | undefined;
  /** The only KPS addresses the worker dials (Tor bridge semantics); excludes `gateways`. */
  readonly bridges: readonly string[] | undefined;
  /** Replaces the bundle's registry RPC URLs. */
  readonly registryRpcUrls: readonly string[] | undefined;
  /** Distinct exit/provider pairs that must agree; `undefined` = the bundle's policy. */
  readonly chainQuorum: number | undefined;
  readonly discovery: DiscoverySetting;
  /** Reserved for proof-backed discovery; only `"auto"` is accepted. */
  readonly trust: "auto";
  readonly logLevel: LogLevel;
  /** Per attempt for small and medium reads. */
  readonly attemptTimeoutMs: number;
  /**
   * Resendable reads: a second copy goes out on another route when no reply
   * arrived after this long (raised to the observed p95 reply time); the
   * first reply wins. 0 turns hedging off.
   */
  readonly hedgeAfterMs: number;
  /** Whole call, from acceptance: waiting for ready, sending, attempts. */
  readonly callDeadlineMs: number;
  readonly maxConcurrentCalls: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly surbFormat: SurbFormatSetting;
  readonly claimIntervalMs: number;
  /** Ceiling of the boot retry back-off. */
  readonly bootRetryMaxMs: number;
  readonly topologySources: number;
  /** One echo through a full route before `signalReady`. */
  readonly warmup: boolean;
  readonly tls: TlsSetting;
  readonly tlsSession: TlsSessionSetting;
  /** Per-call mode: handshaken, unused sessions kept per recently used host. */
  readonly tlsSpares: number;
  /** An unused spare is torn down after this long. */
  readonly tlsSpareTtlMs: number;
  /** Keep-alive mode: a session serves calls for this long after it opened. */
  readonly tlsKeepAliveMs: number;
  /** Keep-alive mode: calls per session. */
  readonly tlsMaxCallsPerSession: number;
  /** An exit that does not answer a tunnel open in this long is skipped for a while. */
  readonly tlsOpenTimeoutMs: number;
  /** Another copy of the current exchange when nothing arrived for this long (raised to the observed p95). */
  readonly tlsCopyAfterMs: number;
  /** Another copy when a gap in the reply stream stays open this long. */
  readonly tlsGapMs: number;
  /** Copies per exchange sent for silence or a gap. */
  readonly tlsMaxCopies: number;
}

export const CONFIG_DEFAULTS: NoxWorkerConfig = Object.freeze({
  v: 1,
  gateways: undefined,
  bridges: undefined,
  registryRpcUrls: undefined,
  chainQuorum: undefined,
  discovery: "chain",
  trust: "auto",
  logLevel: "info",
  attemptTimeoutMs: 12_000,
  hedgeAfterMs: 3_000,
  callDeadlineMs: 25_000,
  maxConcurrentCalls: 16,
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 8_388_608,
  surbFormat: "auto",
  claimIntervalMs: 200,
  bootRetryMaxMs: 60_000,
  topologySources: 2,
  warmup: false,
  // Founder decisions D1/D2 (E2E TLS design §8): the most private settings until decided.
  tls: "required",
  tlsSession: "per-call",
  tlsSpares: 1,
  tlsSpareTtlMs: 20_000,
  tlsKeepAliveMs: 30_000,
  tlsMaxCallsPerSession: 100,
  tlsOpenTimeoutMs: 5_000,
  tlsCopyAfterMs: 2_500,
  tlsGapMs: 800,
  tlsMaxCopies: 3,
});

/** Inclusive integer ranges of the numeric fields. */
export const CONFIG_RANGES = Object.freeze({
  attemptTimeoutMs: [3_000, 60_000],
  hedgeAfterMs: [0, 60_000],
  callDeadlineMs: [3_000, 120_000],
  maxConcurrentCalls: [1, 64],
  maxRequestBytes: [1_024, 4_194_304],
  maxResponseBytes: [65_536, 67_108_864],
  claimIntervalMs: [50, 2_000],
  bootRetryMaxMs: [5_000, 300_000],
  topologySources: [1, 4],
  tlsSpares: [0, 4],
  tlsSpareTtlMs: [1_000, 50_000],
  tlsKeepAliveMs: [1_000, 50_000],
  tlsMaxCallsPerSession: [1, 1_000],
  tlsOpenTimeoutMs: [1_000, 30_000],
  tlsCopyAfterMs: [500, 30_000],
  tlsGapMs: [100, 10_000],
  tlsMaxCopies: [1, 5],
} as const satisfies Record<string, readonly [number, number]>);

/** `gateways` and `bridges` list length bounds. */
export const GATEWAYS_RANGE = Object.freeze([1, 16] as const);

const SURB_FORMATS: readonly SurbFormatSetting[] = ["auto", "v1", "v2"];
const DISCOVERY_SETTINGS: readonly DiscoverySetting[] = ["chain", "snapshot"];
const TLS_SETTINGS: readonly TlsSetting[] = ["required", "preferred", "off"];
const TLS_SESSION_SETTINGS: readonly TlsSessionSetting[] = ["per-call", "keep-alive"];
/** Names reserved for later stages (PROPOSAL §2.5): refused so they are never reused differently. */
const RESERVED_KEYS = new Set(["checkpoint"]);
const KNOWN_KEYS = new Set<string>([...Object.keys(CONFIG_DEFAULTS), ...RESERVED_KEYS]);

type NumericField = keyof typeof CONFIG_RANGES;

/** `bad-config` naming the field. */
export class ConfigError extends NoxWorkerError {
  constructor(message: string) {
    super(FAILED_CODES.badConfig, message);
    this.name = "ConfigError";
  }
}

/**
 * Validate `raw` and fill defaults. Gateways and bridges are addresses, not
 * identities: any well-formed KPS address is accepted, and the node behind it
 * must still be a known member (its `/metadata.json` names it) before the
 * worker routes through it.
 */
export function parseConfig(raw: unknown): NoxWorkerConfig {
  if (raw === undefined || raw === null) return CONFIG_DEFAULTS;
  if (!isPlainObject(raw)) {
    throw new ConfigError("config must be a plain object (or absent)");
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) throw new ConfigError(`config.${key} is not a known field`);
  }
  const out: { -readonly [K in keyof NoxWorkerConfig]: NoxWorkerConfig[K] } = { ...CONFIG_DEFAULTS };
  if (raw["v"] !== undefined && raw["v"] !== 1) throw new ConfigError("config.v must be 1");
  for (const field of Object.keys(CONFIG_RANGES) as NumericField[]) {
    const value = raw[field];
    if (value === undefined) continue;
    const [min, max] = CONFIG_RANGES[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new ConfigError(`config.${field} must be an integer in ${min}..${max}`);
    }
    out[field] = value;
  }
  if (out.callDeadlineMs < out.attemptTimeoutMs) {
    throw new ConfigError("config.callDeadlineMs must be at least config.attemptTimeoutMs");
  }
  const logLevel = raw["logLevel"];
  if (logLevel !== undefined) {
    if (typeof logLevel !== "string" || !(LOG_LEVELS as readonly string[]).includes(logLevel)) {
      throw new ConfigError(`config.logLevel must be one of ${LOG_LEVELS.join(", ")}`);
    }
    out.logLevel = logLevel as LogLevel;
  }
  const surbFormat = raw["surbFormat"];
  if (surbFormat !== undefined) {
    if (typeof surbFormat !== "string" || !(SURB_FORMATS as readonly string[]).includes(surbFormat)) {
      throw new ConfigError(`config.surbFormat must be one of ${SURB_FORMATS.join(", ")}`);
    }
    out.surbFormat = surbFormat as SurbFormatSetting;
  }
  const warmup = raw["warmup"];
  if (warmup !== undefined) {
    if (typeof warmup !== "boolean") throw new ConfigError("config.warmup must be a boolean");
    out.warmup = warmup;
  }
  for (const key of RESERVED_KEYS) {
    if (raw[key] !== undefined) throw new ConfigError(`config.${key} is reserved for a later version and not accepted yet`);
  }
  const trust = raw["trust"];
  if (trust !== undefined && trust !== "auto") {
    throw new ConfigError('config.trust is reserved: only "auto" is accepted until proof-backed discovery ships');
  }
  const discovery = raw["discovery"];
  if (discovery !== undefined) {
    if (typeof discovery !== "string" || !(DISCOVERY_SETTINGS as readonly string[]).includes(discovery)) {
      throw new ConfigError(`config.discovery must be one of ${DISCOVERY_SETTINGS.join(", ")}`);
    }
    out.discovery = discovery as DiscoverySetting;
  }
  out.tls = pickOne(raw, "tls", TLS_SETTINGS, out.tls);
  out.tlsSession = pickOne(raw, "tlsSession", TLS_SESSION_SETTINGS, out.tlsSession);
  const fail = (detail: string): ConfigError => new ConfigError(`config.${detail}`);
  if (raw["gateways"] !== undefined && raw["bridges"] !== undefined) {
    throw new ConfigError("config.gateways and config.bridges exclude each other: with bridges the worker dials only bridges");
  }
  if (raw["gateways"] !== undefined) out.gateways = Object.freeze(checkAnchorList(raw["gateways"], "gateways", GATEWAYS_RANGE[0], fail));
  if (raw["bridges"] !== undefined) out.bridges = Object.freeze(checkAnchorList(raw["bridges"], "bridges", GATEWAYS_RANGE[0], fail));
  if (raw["registryRpcUrls"] !== undefined) {
    out.registryRpcUrls = Object.freeze(checkRpcUrls(raw["registryRpcUrls"], "registryRpcUrls", fail));
  }
  const quorum = raw["chainQuorum"];
  if (quorum !== undefined) {
    const [min, max] = DISCOVERY_POLICY_RANGES.chainQuorum;
    if (typeof quorum !== "number" || !Number.isSafeInteger(quorum) || quorum < min || quorum > max) {
      throw new ConfigError(`config.chainQuorum must be an integer in ${min}..${max}`);
    }
    out.chainQuorum = quorum;
  }
  return Object.freeze(out);
}

function pickOne<T extends string>(raw: Record<string, unknown>, field: string, allowed: readonly T[], fallback: T): T {
  const value = raw[field];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`config.${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
