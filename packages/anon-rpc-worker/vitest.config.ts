import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Bundle builds run esbuild and compile WASM; give them room on slow hosts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    server: {
      deps: {
        // Load the built SDK with Node itself: its lazy import("@hisoka-io/nox-wasm")
        // runs only in classic mode and must not be resolved at transform time.
        external: [/packages\/nox-client\/dist\//u],
      },
    },
  },
});
