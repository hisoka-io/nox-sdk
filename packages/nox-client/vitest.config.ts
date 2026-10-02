import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Stub @hisoka-io/nox-wasm when the WASM package isn't built (e.g. CI
    // TypeScript-only jobs). Tests mock the WASM module via vi.mock(),
    // but Vite's module resolver still tries to find the entry point.
    // This alias points to a minimal stub that exports empty functions.
    // Live suites (LIVE_TESTS=1) build real Sphinx packets, so they load the
    // installed package instead.
    alias: process.env["LIVE_TESTS"]
      ? {}
      : {
        "@hisoka-io/nox-wasm": new URL(
          "./tests/__mocks__/nox-wasm.ts",
          import.meta.url,
        ).pathname,
      },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
    },
  },
});
