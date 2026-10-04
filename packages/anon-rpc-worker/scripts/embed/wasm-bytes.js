// @ts-check
// The nox-wasm module bytes, embedded in the worker bundle.
//
// scripts/build.mjs resolves "nox-embed:wasm-base64" to the base64 text of the
// nox-wasm web build (packages/nox-wasm/pkg-web/nox_wasm_bg.wasm). The WASM is
// therefore covered by the worker's keccak-256 pin, and the worker never
// fetches a .wasm file at run time.
import NOX_WASM_BASE64 from "nox-embed:wasm-base64";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * A fresh copy of the embedded nox-wasm module bytes. Each call decodes anew,
 * so callers may transfer or detach the returned buffer.
 * @returns {Uint8Array}
 */
export function noxWasmBytes() {
  return decodeBase64(NOX_WASM_BASE64);
}

/**
 * Strict RFC 4648 base64 decoder (standard alphabet, padded). The input comes
 * from the build, so any deviation is a build defect and throws. A local
 * decoder keeps the bundle free of ambient `atob`.
 * @param {string} text
 * @returns {Uint8Array}
 */
function decodeBase64(text) {
  if (text.length === 0 || text.length % 4 !== 0) {
    throw new Error(`embedded nox-wasm base64 has invalid length ${text.length}`);
  }
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) lookup[ALPHABET.charCodeAt(i)] = i;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let written = 0;
  for (let i = 0; i < text.length; i += 4) {
    const last = i + 4 === text.length;
    const a = sextet(text, i, lookup);
    const b = sextet(text, i + 1, lookup);
    const c = last && padding === 2 ? 0 : sextet(text, i + 2, lookup);
    const d = last && padding >= 1 ? 0 : sextet(text, i + 3, lookup);
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    out[written++] = (triple >> 16) & 0xff;
    if (written < out.length) out[written++] = (triple >> 8) & 0xff;
    if (written < out.length) out[written++] = triple & 0xff;
  }
  return out;
}

/**
 * @param {string} text
 * @param {number} index
 * @param {Int16Array} lookup
 * @returns {number}
 */
function sextet(text, index, lookup) {
  const code = text.charCodeAt(index);
  const value = code < 128 ? lookup[code] : -1;
  if (value === undefined || value < 0) {
    throw new Error(`embedded nox-wasm base64 has an invalid character at offset ${index}`);
  }
  return value;
}
