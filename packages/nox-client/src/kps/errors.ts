/**
 * Internal failure type of the KPS transport. `code` uses the SPEC §12
 * vocabulary; `createKpsFetch` turns these into `NoxClientError`s whose
 * `cause` names the phase that failed.
 */
import type { KpsErrorCode } from "../types.js";

const KPS_ERROR_CODES: ReadonlySet<string> = new Set<KpsErrorCode>([
  "cancelled",
  "closed",
  "reset",
  "timeout",
  "network-error",
  "protocol-error",
  "unsupported",
  "too-large",
  "queue-full",
  "permission-denied",
  "internal-error",
]);

/** True when `value` is one of the SPEC §12 `KpsErrorCode` strings. */
export function isKpsErrorCode(value: unknown): value is KpsErrorCode {
  return typeof value === "string" && KPS_ERROR_CODES.has(value);
}

/** A failure of the KPS transport or of the KPS-HTTP/1 exchange profile. */
export class NoxKpsError extends Error {
  constructor(
    message: string,
    public readonly code: KpsErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NoxKpsError";
  }
}

/**
 * Best-effort `KpsErrorCode` of a thrown value: a `NoxKpsError`'s code, a
 * harness error's string `code` when it is a SPEC §12 code, else `fallback`.
 */
export function kpsErrorCodeOf(error: unknown, fallback: KpsErrorCode): KpsErrorCode {
  if (error instanceof NoxKpsError) return error.code;
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (isKpsErrorCode(code)) return code;
  }
  return fallback;
}

/** Short diagnostic text of a thrown value, without stack traces. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}
