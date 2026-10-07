// @ts-check
// The nox-wasm module bytes, embedded in the worker bundle.
//
// scripts/build.mjs resolves "nox-embed:wasm-base64" to the base64 text of the
// nox-wasm web build (packages/nox-wasm/pkg-web/nox_wasm_bg.wasm). The WASM is
// therefore covered by the worker's keccak-256 pin, and the worker never
// fetches a .wasm file at run time.
import NOX_WASM_BASE64 from "nox-embed:wasm-base64";
import { decodeBase64 } from "./base64.js";

/**
 * A fresh copy of the embedded nox-wasm module bytes. Each call decodes anew,
 * so callers may transfer or detach the returned buffer.
 * @returns {Uint8Array}
 */
export function noxWasmBytes() {
  return decodeBase64(NOX_WASM_BASE64, "nox-wasm");
}
