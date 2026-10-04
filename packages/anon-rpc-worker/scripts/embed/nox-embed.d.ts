// Types for the virtual modules that scripts/build.mjs provides to the worker
// bundle. Worker code imports "@hisoka-io/nox-wasm" (resolved to
// scripts/embed/nox-wasm-shim.js) or "nox-embed:wasm-bytes"; the other two
// names are internal to the shim.

declare module "nox-embed:wasm-bytes" {
  /** A fresh copy of the nox-wasm module bytes embedded in the bundle. */
  export function noxWasmBytes(): Uint8Array;
}

declare module "nox-embed:wasm-base64" {
  const base64: string;
  export default base64;
}

declare module "nox-embed:wasm-glue" {
  export * from "@hisoka-io/nox-wasm";
  export function initSync(options: { module: BufferSource | WebAssembly.Module }): unknown;
}
