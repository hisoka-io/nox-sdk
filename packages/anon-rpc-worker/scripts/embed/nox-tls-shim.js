// @ts-check
// Stand-in for "nox-embed:tls" inside the worker bundle: the wasm-bindgen web
// glue of packages/nox-tls (pkg-web/nox_tls.js) with an init that compiles the
// embedded bytes, as nox-wasm-shim.js does for nox-wasm. The bytes are covered
// by the worker's keccak-256 pin and no .wasm is ever fetched.
import { initSync } from "nox-embed:tls-glue";
import NOX_TLS_BASE64 from "nox-embed:tls-base64";
import { decodeBase64 } from "./base64.js";

export * from "nox-embed:tls-glue";

let initialised = false;

/**
 * Initialise nox-tls from the embedded bytes. Idempotent.
 * @returns {Promise<void>}
 */
export default async function init() {
  if (initialised) return;
  initSync({ module: decodeBase64(NOX_TLS_BASE64, "nox-tls") });
  initialised = true;
}
