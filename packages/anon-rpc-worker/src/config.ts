/**
 * `anonRpcWorker.config` (ARCHITECTURE §4.2): optional, JSON-compatible, and
 * validated before anything touches the network. `undefined` and `{}` both
 * mean "defaults": entries and the snapshot are pinned in the bundle, so the
 * worker boots with no config at all (D-02).
 *
 * The host's value is never mutated; the parsed result is a frozen copy.
 */
import { isKpsAddress } from "@hisoka-io/nox-client";
import { FAILED_CODES, NoxWorkerError } from "./errors.js";
import { LOG_LEVELS, type LogLevel } from "./log.js";

export type SurbFormatSetting = "auto" | "v1" | "v2";

export interface NoxWorkerConfig {
  readonly v: 1;
  /** Allowed entry KPS addresses (`<ip>:<port>:<certhash>`); `undefined` = every KPS-capable pinned member. */
  readonly gateways: readonly string[] | undefined;
  readonly logLevel: LogLevel;
  /** Per attempt for small and medium reads. */
  readonly attemptTimeoutMs: number;
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
}

export const CONFIG_DEFAULTS: NoxWorkerConfig = Object.freeze({
  v: 1,
  gateways: undefined,
  logLevel: "info",
  attemptTimeoutMs: 12_000,
  callDeadlineMs: 25_000,
  maxConcurrentCalls: 16,
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 8_388_608,
  surbFormat: "auto",
  claimIntervalMs: 200,
  bootRetryMaxMs: 60_000,
  topologySources: 2,
  warmup: false,
});

/** Inclusive integer ranges of the numeric fields. */
export const CONFIG_RANGES = Object.freeze({
  attemptTimeoutMs: [3_000, 60_000],
  callDeadlineMs: [3_000, 120_000],
  maxConcurrentCalls: [1, 64],
  maxRequestBytes: [1_024, 4_194_304],
  maxResponseBytes: [65_536, 67_108_864],
  claimIntervalMs: [50, 2_000],
  bootRetryMaxMs: [5_000, 300_000],
  topologySources: [1, 4],
} as const satisfies Record<string, readonly [number, number]>);

/** `gateways` list length bounds. */
export const GATEWAYS_RANGE = Object.freeze([1, 16] as const);

const SURB_FORMATS: readonly SurbFormatSetting[] = ["auto", "v1", "v2"];
const KNOWN_KEYS = new Set<string>(Object.keys(CONFIG_DEFAULTS));

type NumericField = keyof typeof CONFIG_RANGES;

/** `bad-config` naming the field. */
export class ConfigError extends NoxWorkerError {
  constructor(message: string) {
    super(FAILED_CODES.badConfig, message);
    this.name = "ConfigError";
  }
}

/**
 * Validate `raw` and fill defaults. `pinnedGateways` is the set of KPS
 * addresses the pinned snapshot publishes; each configured gateway must be one
 * of them (config can restrict entries, never add identities).
 */
export function parseConfig(raw: unknown, pinnedGateways: ReadonlySet<string>): NoxWorkerConfig {
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
  if (raw["gateways"] !== undefined) out.gateways = parseGateways(raw["gateways"], pinnedGateways);
  return Object.freeze(out);
}

function parseGateways(value: unknown, pinned: ReadonlySet<string>): readonly string[] {
  const [min, max] = GATEWAYS_RANGE;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new ConfigError(`config.gateways must be a list of ${min}..${max} KPS addresses`);
  }
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    if (typeof entry !== "string" || !isKpsAddress(entry)) {
      throw new ConfigError(`config.gateways[${index}] is not a KPS address <ip>:<port>:<certhash>`);
    }
    if (!pinned.has(entry)) {
      throw new ConfigError(`config.gateways[${index}] is not the KPS address of a node pinned in this bundle`);
    }
    if (seen.has(entry)) throw new ConfigError(`config.gateways[${index}] repeats an address`);
    seen.add(entry);
  });
  return Object.freeze([...seen]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
