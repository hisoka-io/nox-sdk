/**
 * Codes the worker reports (ARCHITECTURE §4.8). Hosts branch on `code`, never
 * on `message` (anon-rpc SPEC §7, §12).
 *
 * - `signalFailed` codes are permanent: this bundle cannot become (or stay)
 *   ready here, and a retry would not help. Failure is final (SPEC §7).
 * - Per-call codes use the SPEC §12 `KpsErrorCode` vocabulary. A failed call
 *   never fails the worker.
 * - Boot retry codes are only logged: the worker keeps retrying with back-off
 *   and `ready` stays pending.
 */

/** Codes passed to `anonRpcWorker.signalFailed`. */
export const FAILED_CODES = Object.freeze({
  /** `config` is not a valid `NoxWorkerConfig` (unknown key, type, range, a gateway outside the pinned set). */
  badConfig: "bad-config",
  /** `anonRpcWorker.kps` is missing or unsupported, or `crypto.getRandomValues` or `WebAssembly` is missing. */
  unsupportedPlatform: "unsupported-platform",
  /** WebAssembly compile or instantiate failed (an embedder CSP without 'wasm-unsafe-eval'). */
  wasmBlocked: "wasm-blocked",
  /** The pinned snapshot inside the bundle fails its own check (a build defect). */
  snapshotInvalid: "snapshot-invalid",
  /** Two or more nodes agree the pinned member set no longer forms a route: the bundle is superseded. */
  snapshotStale: "snapshot-stale",
  /** An invariant broke, or WebAssembly trapped repeatedly. */
  internalError: "internal-error",
} as const);

export type FailedCode = (typeof FAILED_CODES)[keyof typeof FAILED_CODES];

/** Codes logged while boot retries (never passed to `signalFailed`). */
export const BOOT_RETRY_CODES = Object.freeze({
  noAnchorReachable: "no-anchor-reachable",
  topologyFetchFailed: "topology-fetch-failed",
  topologyRejected: "topology-rejected",
  kpsDialFailed: "kps-dial-failed",
} as const);

export type BootRetryCode = (typeof BOOT_RETRY_CODES)[keyof typeof BOOT_RETRY_CODES];

/** Codes carried by a rejected fetch call (SPEC §12 vocabulary). */
export const CALL_CODES = Object.freeze({
  /** The host aborted the call (error name `AbortError`). */
  cancelled: "cancelled",
  /** The call deadline passed: not ready in time, or no reply after the allowed attempts. */
  timeout: "timeout",
  /**
   * No KPS entry reachable, or packet submission failed on every entry tried;
   * or a redirect refused (`redirect: "error"`, more than 5 hops, a target
   * that is not http(s), the deadline between hops).
   */
  networkError: "network-error",
  /** The request or the reply is over a size limit, or the exit truncated the reply. */
  tooLarge: "too-large",
  /** Not an absolute http(s) URL, or an invalid method, header or redirect mode. */
  unsupported: "unsupported",
  /** The exit's reply could not be decoded or is not a valid HTTP response. */
  protocolError: "protocol-error",
  /** An unexpected exception (a bug). */
  internalError: "internal-error",
} as const);

export type CallCode = (typeof CALL_CODES)[keyof typeof CALL_CODES];

/**
 * A worker failure with a stable string `code`. It is an `Error`, so the
 * reference harness forwards `{ name, message, code }` to the host.
 */
export class NoxWorkerError extends Error {
  readonly code: CallCode | FailedCode;

  constructor(code: CallCode | FailedCode, message: string, options?: { cause?: unknown; name?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.name = options?.name ?? "NoxWorkerError";
  }
}

/** Per-call rejection. */
export function callError(code: CallCode, message: string, cause?: unknown): NoxWorkerError {
  return new NoxWorkerError(code, message, cause === undefined ? undefined : { cause });
}

/** Rejection for a call the host aborted: an `AbortError` with code `cancelled`, like `fetch`. */
export function abortedByHost(): NoxWorkerError {
  return new NoxWorkerError(CALL_CODES.cancelled, "The host aborted the call", { name: "AbortError" });
}

/** True for a `NoxWorkerError` (or any error) whose `code` is `code`. */
export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
