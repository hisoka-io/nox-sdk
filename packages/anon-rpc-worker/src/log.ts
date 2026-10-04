/**
 * Logging through `anonRpcWorker.log` (SPEC §13, ARCHITECTURE §4.9).
 *
 * Every entry is `("nox-worker", event, fields?)` where `event` is a stable
 * name (`boot.start`, `ready`, `entry.switch`, ...) and `fields` is a plain
 * object of primitives. The worker never logs URLs, query strings, headers,
 * bodies, signed transactions, SURB IDs or keys. `redact` is a second line of
 * defence for free text that comes from lower layers (error messages).
 * Delivery is best effort: a throwing host log never affects the worker.
 */
import type { LogApi, LogArg } from "./spec-types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Field values the worker logs: primitives only. */
export type LogField = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogField>>;

export interface WorkerLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** True when entries at `level` reach the host. */
  enabled(level: LogLevel): boolean;
}

/** Source tag of every entry. */
export const LOG_SOURCE = "nox-worker";

/** A logger that forwards entries at or above `level` to the host. */
export function createLogger(api: LogApi | undefined, level: LogLevel): WorkerLogger {
  const min = LOG_LEVELS.indexOf(level);
  const enabled = (entryLevel: LogLevel): boolean => api !== undefined && LOG_LEVELS.indexOf(entryLevel) >= min;
  const emit = (entryLevel: LogLevel, event: string, fields?: LogFields): void => {
    if (!enabled(entryLevel) || api === undefined) return;
    const args: LogArg[] = [LOG_SOURCE, redact(event)];
    if (fields !== undefined) args.push(sanitizeFields(fields));
    try {
      api[entryLevel](...args);
    } catch {
      // Best effort: a lost log line is never a worker failure.
    }
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    enabled,
  };
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/giu;
const LONG_HEX_RE = /\b(?:0x)?[0-9a-fA-F]{32,}\b/gu;
const BEARER_RE = /\b(?:bearer|basic)\s+[^\s"']+/giu;
const CONTROL_RE = /[\u0000-\u001f\u007f]/gu;
/** Longest free-text value forwarded. */
export const MAX_LOGGED_TEXT = 300;

/**
 * Remove what must never reach host logs from free text: URLs (they can carry
 * API keys and name the destination), long hex (signed transactions, keys,
 * SURB IDs), credentials and control characters. Bounded in length.
 */
export function redact(text: string): string {
  const cleaned = text
    .replace(URL_RE, "<url>")
    .replace(LONG_HEX_RE, "<hex>")
    .replace(BEARER_RE, "<credential>")
    .replace(CONTROL_RE, " ");
  return cleaned.length <= MAX_LOGGED_TEXT ? cleaned : `${cleaned.slice(0, MAX_LOGGED_TEXT)}…`;
}

/** `Name: message` of a thrown value, redacted. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return redact(message);
  }
  return redact(String(error));
}

/** The string `code` of a thrown value, if it has one. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function sanitizeFields(fields: LogFields): { [key: string]: LogArg } {
  const out: { [key: string]: LogArg } = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" ? redact(value) : value;
  }
  return out;
}
