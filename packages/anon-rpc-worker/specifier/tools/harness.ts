// The anon-rpc reference harness's specifier code path (SPEC.md §4), straight from the pinned npm package
// @anon-rpc/browser-harness 0.3.2: src/host/specifier.ts and src/host/kps-http.ts, which are identical to
// ethereum/anon-rpc commit f2c8a75. Nothing here re-implements them; tests and tools call the same functions
// wallets run to read a specifier and admit a bundle.
//
// "@anon-rpc-harness/*" is an alias: vite.config.ts maps it to the package's TypeScript sources (executed),
// tsconfig.json maps it to the package's published declaration files (type-checked).

export { fetchAndVerifyBundle, MAX_BUNDLE_BYTES, readSpecifier } from "@anon-rpc-harness/specifier";
export type { Specifier } from "@anon-rpc-harness/specifier";
export { parseKpsResolver } from "@anon-rpc-harness/kps-http";

/** Version of the harness package the alias points at (asserted by the tests against its package.json). */
export const HARNESS_PACKAGE = "@anon-rpc/browser-harness@0.3.2";
