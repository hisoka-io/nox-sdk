/**
 * Bundle smoke for the worker source: scripts/build.mjs (the release build,
 * with its embed plugin, ambient-network stand-ins and bundle checks) packs
 * src/worker.ts into one classic-script IIFE with the real nox-wasm web build
 * embedded and a pinned test snapshot. The script then runs with
 * `anonRpcWorker` installed, `fetch` and `WebSocket` throwing, and must boot
 * over KPS and send real 32,768-byte Sphinx packets.
 *
 * It is skipped when packages/nox-wasm/pkg-web has not been built.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildWorker } from "../scripts/build.mjs";
import { canonicalJson } from "../scripts/lib/snapshot-format.mjs";
import { FakeHarness } from "./helpers/fake-harness.js";
import { FakeNoxNetwork } from "./helpers/fake-nox-network.js";
import { exitReply, makePinned } from "./helpers/fixtures.js";

const PKG_WEB = fileURLToPath(new URL("../../nox-wasm/pkg-web/", import.meta.url));
const built = existsSync(`${PKG_WEB}nox_wasm.js`) && existsSync(`${PKG_WEB}nox_wasm_bg.wasm`);

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nox-bundle-smoke-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { anonRpcWorker?: unknown }).anonRpcWorker;
});

describe.skipIf(!built)("worker bundle smoke", () => {
  it("bundles into one classic script that boots over KPS without fetch or WebSocket", async () => {
    const pinned = makePinned();
    const snapshotPath = join(dir, "test-snapshot.json");
    writeFileSync(snapshotPath, canonicalJson(pinned));
    const { bundle } = await buildWorker({ snapshot: snapshotPath, outfile: join(dir, "worker.js"), write: false });
    const code = Buffer.from(bundle).toString("utf8");
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
