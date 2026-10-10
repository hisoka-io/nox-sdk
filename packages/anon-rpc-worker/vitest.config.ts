import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // e2e/tests/unit needs no mesh or browser; its registry suite runs when anvil is on PATH.
    include: ["tests/**/*.test.ts", "e2e/tests/unit/**/*.test.ts"],
    // The build scripts load the SDK's built entry with Node's own resolver,
    // exactly as they do on the command line; Vite must not transform it.
    server: { deps: { external: [/packages\/nox-client\/dist\//u] } },
    // Bundle builds run esbuild and compile WASM; give them room on slow hosts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
