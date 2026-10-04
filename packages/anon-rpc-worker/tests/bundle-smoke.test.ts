/**
 * Bundle smoke for the worker source: esbuild packs src/worker.ts into one
 * classic-script IIFE (the shape the harness loads with importScripts), with
 * the real nox-wasm web build embedded as bytes and a pinned test snapshot.
 * The script then runs with `anonRpcWorker` installed, `fetch` and
 * `WebSocket` throwing, and must boot over KPS and send real 32,768-byte
 * Sphinx packets.
 *
 * The release bundle is built by scripts/build.mjs (reproducible, keccak
 * pinned); this test only proves the source bundles and boots. It is skipped
 * when packages/nox-wasm/pkg-web has not been built.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeHarness } from "./helpers/fake-harness.js";
import { FakeNoxNetwork } from "./helpers/fake-nox-network.js";
import { exitReply, makePinned } from "./helpers/fixtures.js";

const PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
const PKG_WEB = fileURLToPath(new URL("../../nox-wasm/pkg-web/", import.meta.url));
const GLUE = `${PKG_WEB}nox_wasm.js`;
const WASM = `${PKG_WEB}nox_wasm_bg.wasm`;
const built = existsSync(GLUE) && existsSync(WASM);

function embedPlugin(snapshotJson: string): Plugin {
  return {
    name: "smoke-embed",
    setup(context) {
      context.onResolve({ filter: /^@hisoka-io\/nox-wasm$/ }, () => ({ path: "nox-wasm", namespace: "smoke" }));
      context.onResolve({ filter: /^nox-embed:snapshot$/ }, () => ({ path: "snapshot", namespace: "smoke" }));
      context.onLoad({ filter: /^nox-wasm$/, namespace: "smoke" }, () => ({
        resolveDir: PKG_WEB,
        loader: "js",
        contents: [
          `import { initSync } from ${JSON.stringify(GLUE)};`,
          `export * from ${JSON.stringify(GLUE)};`,
          `const B64 = ${JSON.stringify(readFileSync(WASM).toString("base64"))};`,
          "export default async function init() {",
          "  initSync({ module: Uint8Array.from(atob(B64), (c) => c.charCodeAt(0)) });",
          "}",
        ].join("\n"),
      }));
      context.onLoad({ filter: /^snapshot$/, namespace: "smoke" }, () => ({ contents: snapshotJson, loader: "json" }));
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { anonRpcWorker?: unknown }).anonRpcWorker;
});

describe.skipIf(!built)("worker bundle smoke", () => {
  it("bundles into one classic script that boots over KPS without fetch or WebSocket", async () => {
    const pinned = makePinned();
    const result = await build({
      entryPoints: [`${PACKAGE_DIR}src/worker.ts`],
      tsconfig: `${PACKAGE_DIR}tsconfig.json`,
      bundle: true,
      format: "iife",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
      plugins: [embedPlugin(JSON.stringify(pinned))],
    });
    const code = result.outputFiles[0]?.text ?? "";
    expect(code.length).toBeGreaterThan(100_000);
    expect(code).not.toMatch(/^\s*(?:import|export)\s/mu);
    expect(code).not.toMatch(/\bimport\s*\(/u);
    expect(code).not.toContain("import.meta");

    const ambientFetch = vi.fn(() => {
      throw new Error("the bundle must never call fetch");
    });
    vi.stubGlobal("fetch", ambientFetch);
    vi.stubGlobal("WebSocket", class {
      constructor() {
        throw new Error("the bundle must never open a WebSocket");
      }
    });
    const network = new FakeNoxNetwork(pinned, () => exitReply(200, [], "{}"));
    const harness = new FakeHarness({ topologySources: 1, callDeadlineMs: 3_000, attemptTimeoutMs: 3_000 }, network.kps);
    (globalThis as { anonRpcWorker?: unknown }).anonRpcWorker = harness.api;
    new Function(code)();
    try {
      await harness.ready;
      expect(harness.failures).toEqual([]);
      const controller = new AbortController();
      const call = harness.fetch("https://rpc.example.test/", {
        method: "POST",
        body: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}'),
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(network.opaquePackets).toBeGreaterThanOrEqual(1), { timeout: 2_000 });
      controller.abort();
      await expect(call).rejects.toMatchObject({ code: "cancelled" });
      expect(ambientFetch).not.toHaveBeenCalled();
    } finally {
      harness.breakAccept(new Error("smoke test done"));
    }
  });
});
