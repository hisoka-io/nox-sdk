import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// "@anon-rpc-harness/<module>" runs the reference harness's own TypeScript sources from the pinned npm package
// (src/host/<module>.ts), so the §4 read path under test is the one wallets ship. tsconfig.json resolves the same
// specifiers to the package's published .d.ts files for type checking.
const harnessHostSources = fileURLToPath(
  new URL("./node_modules/@anon-rpc/browser-harness/src/host/", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [{ find: /^@anon-rpc-harness\/(.+)$/, replacement: `${harnessHostSources}$1` }],
  },
  test: {
    environment: "node",
    include: ["tools/**/*.test.ts", "itest/**/*.test.ts"],
    globalSetup: ["./itest/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
