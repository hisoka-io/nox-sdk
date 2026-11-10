/**
 * anon-rpc SPEC 9.3 `anonOptions.isolationKey`: calls under different keys
 * should look like calls from unrelated clients. The worker gives each key
 * its own `NoxClient` (KPS connections, entries, SURB pool, exit choice) and
 * its own TLS pool, so no SURB set, TLS session, connection or exit pin is
 * shared across keys. Calls without a key share the boot client, which is the
 * "one further key" of SPEC 9.3.
 */
import type { AnonRequestInit } from "./spec-types.js";
import { CALL_CODES, callError } from "./errors.js";

/** Longest isolation key accepted, in UTF-16 code units. */
export const MAX_ISOLATION_KEY_LENGTH = 256;

/**
 * The call's isolation key, or `undefined` for calls without one. Unknown
 * `anonOptions` entries are ignored (reserved for later SPEC versions).
 * Throws `unsupported` for a malformed `anonOptions` or key.
 */
export function isolationKeyOf(init: AnonRequestInit | undefined): string | undefined {
  const options: unknown = init?.anonOptions;
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw callError(CALL_CODES.unsupported, "anonOptions must be an object");
  }
  const key: unknown = (options as { isolationKey?: unknown }).isolationKey;
  if (key === undefined) return undefined;
  if (typeof key !== "string") {
    throw callError(CALL_CODES.unsupported, "anonOptions.isolationKey must be a string");
  }
  if (key.length > MAX_ISOLATION_KEY_LENGTH) {
    throw callError(
      CALL_CODES.unsupported,
      `anonOptions.isolationKey is ${key.length} characters; the limit is ${MAX_ISOLATION_KEY_LENGTH}`,
    );
  }
  return key;
}
