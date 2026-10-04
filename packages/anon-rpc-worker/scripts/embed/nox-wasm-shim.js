// @ts-check
// Stand-in for "@hisoka-io/nox-wasm" inside the worker bundle.
//
// It re-exports the wasm-bindgen web glue (pkg-web/nox_wasm.js) and replaces
// the glue's default init, which would fetch nox_wasm_bg.wasm relative to
// import.meta.url, with a synchronous init from the embedded bytes. Code that
// awaits the default export and then calls the named exports (as
// NoxClient._initWasm does) runs unchanged and makes no network request.
// Synchronous compilation of a module this size is allowed in Web Workers,
// where anon-rpc workers run.
import { initSync } from "nox-embed:wasm-glue";
import { noxWasmBytes } from "nox-embed:wasm-bytes";

export * from "nox-embed:wasm-glue";

let initialised = false;

/**
 * Initialise nox-wasm from the embedded bytes. Idempotent.
 * @returns {void}
 */
export function initEmbedded() {
  if (initialised) return;
  initSync({ module: noxWasmBytes() });
  initialised = true;
}

/**
 * Default export with the shape of the wasm-bindgen init function.
 * @returns {Promise<void>}
 */
export default async function init() {
  initEmbedded();
}
