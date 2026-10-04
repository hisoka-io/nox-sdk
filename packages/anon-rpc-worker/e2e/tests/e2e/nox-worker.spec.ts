// The Nox anon-rpc worker end to end (spine W2, TEST-PLAN TST-560/562 on bed L):
// reference harness (headless Chromium) -> hash-pinned worker -> anonRpcWorker.kps
// -> nox-kps sidecar -> local 10-node mesh -> exit HttpRequest -> upstream anvil.
//
// Skipped until the pieces exist: NOX_KPS_CMD (one nox-kps per mesh node) and
// a worker bundle (NOX_WORKER_BUILD_CMD builds one for this run's mesh, or
// NOX_WORKER_BUNDLE points at a prebuilt one). See README "Nox worker".

import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { HARNESS_VERSIONS } from "../../src/bundles.js";
import { loadConfig } from "../../src/config.js";
import { describeEvents } from "../../src/egress.js";
import { expectHex, jsonRpc } from "../../src/jsonrpc.js";
import { percentile, writeReport } from "../../src/report.js";
import {
  describeTestbed,
  publishWorker,
  workerConfigFor,
  writeTestbedInfo,
  type PublishedWorker,
} from "../../src/testbed.js";
import { resolveWorkerBundle } from "../../src/worker-bundle.js";
import { expect, test, type GuardedHost } from "./fixtures.js";
import { rpcCall, rpcResult, rpcViaWorker } from "./helpers.js";

/** TST-560.02 bound for `.ready` at mix delay 0 (8 s at 50 ms is checked by the bench). */
const READY_BOUND_MS = 5_000;
/** TST-546: a bad config must reject `.ready` within 15 s. */
const BAD_CONFIG_BOUND_MS = 15_000;
const LATENCY_SAMPLES = 20;
const EARLY_CALLS = 3;
const WORKER_ID = "nox";

const early = loadConfig();
const prerequisites: string[] = [];
if (early.kps.sidecarCommand === undefined) {
  prerequisites.push("NOX_KPS_CMD is unset (one nox-kps sidecar per mesh node)");
}
if (early.worker.buildCommand === undefined && !existsSync(early.worker.bundlePath)) {
  prerequisites.push(`no worker bundle: set NOX_WORKER_BUILD_CMD or build ${early.worker.bundlePath}`);
}

interface Published {
  readonly worker: PublishedWorker;
  readonly config: unknown;
  readonly bundleSource: string;
}

test.describe("Nox anon-rpc worker over KPS through the local mesh", () => {
  test.skip(prerequisites.length > 0, prerequisites.join("; "));

  let published: Published | undefined;

  test.beforeAll(async ({ cfg, runPaths, chains, resolver, meshBed }) => {
    const info = describeTestbed({ config: cfg, paths: runPaths, chains, resolver, mesh: meshBed });
    const testbedJson = writeTestbedInfo(runPaths, info);
    const source = await resolveWorkerBundle(cfg, runPaths.root, testbedJson, runPaths.logs);
    if (source.kind === "missing") throw new Error(source.reason);
    published = {
      worker: await publishWorker(chains, resolver, source.bytes),
      config: await workerConfigFor(cfg, info),
      bundleSource: source.path,
    };
    writeTestbedInfo(runPaths, { ...info, workers: { nox: published.worker } });
  });

  /**
   * TST-562 .03: from before the host page loads until now, the guarded
   * context reached only the host page, the resolver and the specifier RPC.
   * Any other HTTP(S) request or any WebSocket fails the test.
   */
  function expectKpsOnlyEgress(guarded: GuardedHost): void {
    expect(guarded.monitor.violations(), guarded.monitor.describeViolations()).toEqual([]);
  }

  function pin(): Published {
    if (published === undefined) throw new Error("worker was not published in beforeAll");
    return published;
  }

  async function boot(page: Page, specifierUrl: string, readyTimeoutMs: number, config?: unknown) {
    return page.evaluate((request) => window.e2e.boot(request), {
      id: WORKER_ID,
      address: pin().worker.address,
      specifierRpcUrl: specifierUrl,
      readyTimeoutMs,
      ...(config === undefined ? {} : { config }),
    });
  }

  for (const version of HARNESS_VERSIONS) {
    test(`harness ${version}: boots and serves JSON-RPC identical to direct calls`, async ({
      cfg,
      runPaths,
      chains,
      guardedHost,
    }) => {
      // The egress monitor watches from before the page loads: boot-time
      // traffic (topology, bootstrap) counts too.
      const page = await guardedHost.open(version);
      const result = await boot(page, chains.specifier.url, cfg.worker.readyTimeoutMs, pin().config);
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(result.sandbox).toBe("allow-scripts");
      expectKpsOnlyEgress(guardedHost);

      const upstream = chains.upstream;
      const timeout = cfg.worker.callTimeoutMs;
      const call = (body: unknown) => rpcViaWorker(page, WORKER_ID, upstream.url, body, timeout);

      const chainId = await call(rpcCall("eth_chainId"));
      expect(chainId.result.status, JSON.stringify(chainId.result.error)).toBe(200);
      expect(rpcResult(chainId.json)).toBe(`0x${upstream.chainId.toString(16)}`);

      const balance = await call(rpcCall("eth_getBalance", [upstream.account, "latest"]));
      expect(rpcResult(balance.json)).toBe(await jsonRpc(upstream.url, "eth_getBalance", [upstream.account, "latest"]));

      const batch = await call([rpcCall("eth_chainId", [], 1), rpcCall("eth_blockNumber", [], 2), rpcCall("net_version", [], 3)]);
      const ids = Array.isArray(batch.json) ? batch.json.map((item: { id?: unknown }) => item.id) : [];
      expect([...ids].sort()).toEqual([1, 2, 3]);

      const missing = await call(rpcCall("eth_noSuchMethod"));
      expect((missing.json as { error?: { code?: unknown } }).error?.code).toBe(-32601);

      // A signed transaction travels through the exit and lands on the upstream chain.
      const signed = expectHex(
        await jsonRpc(upstream.url, "eth_signTransaction", [
          { from: upstream.account, to: upstream.account, value: "0x1", gas: "0x5208" },
        ]),
        "eth_signTransaction",
      );
      const sent = await call(rpcCall("eth_sendRawTransaction", [signed]));
      const txHash = expectHex(rpcResult(sent.json), "eth_sendRawTransaction via worker");
      const receipt = (await jsonRpc(upstream.url, "eth_getTransactionReceipt", [txHash])) as { status?: string } | null;
      expect(receipt?.status).toBe("0x1");

      expectKpsOnlyEgress(guardedHost);
      writeReport(cfg, runPaths, `nox-worker-boot-${version}`, {
        readyMs: result.readyMs,
        bundle: pin().bundleSource,
        workerHash: pin().worker.workerHash,
        bytes: pin().worker.bytes,
        egress: describeEvents(guardedHost.monitor.events()),
      });
      if (version === "0.3.2") expect(result.readyMs).toBeLessThan(READY_BOUND_MS);
      await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
    });
  }

  test("calls issued before ready are served after it, in order", async ({ cfg, chains, guardedHost }) => {
    const page = await guardedHost.open("0.3.2");
    const started = await page.evaluate((request) => window.e2e.boot(request), {
      id: WORKER_ID,
      address: pin().worker.address,
      specifierRpcUrl: chains.specifier.url,
      readyTimeoutMs: cfg.worker.readyTimeoutMs,
      config: pin().config,
      awaitReady: false,
    });
    expect(started.ok).toBe(true);
    const calls = Array.from({ length: EARLY_CALLS }, (_, i) =>
      rpcViaWorker(page, WORKER_ID, chains.upstream.url, rpcCall("eth_chainId", [], 100 + i), cfg.worker.callTimeoutMs));
    const ready = await page.evaluate(({ id, ms }) => window.e2e.ready(id, ms), {
      id: WORKER_ID,
      ms: cfg.worker.readyTimeoutMs,
    });
    expect(ready.ok, JSON.stringify(ready.error)).toBe(true);
    const outcomes = await Promise.all(calls);
    outcomes.forEach((outcome, i) => {
      expect(outcome.result.status, JSON.stringify(outcome.result.error)).toBe(200);
      expect((outcome.json as { id?: unknown }).id).toBe(100 + i);
    });
    expectKpsOnlyEgress(guardedHost);
  });

  test("a host abort rejects with AbortError and the worker keeps serving", async ({ cfg, chains, guardedHost }) => {
    const page = await guardedHost.open("0.3.2");
    expect((await boot(page, chains.specifier.url, cfg.worker.readyTimeoutMs, pin().config)).ok).toBe(true);
    const aborted = await page.evaluate((request) => window.e2e.fetch(request), {
      id: WORKER_ID,
      url: chains.upstream.url,
      method: "POST",
      headers: [["content-type", "application/json"]] as [string, string][],
      body: JSON.stringify(rpcCall("eth_blockNumber")),
      timeoutMs: cfg.worker.callTimeoutMs,
      abortAfterMs: 0,
    });
    expect(aborted.ok).toBe(false);
    expect(aborted.error?.name).toBe("AbortError");
    const after = await rpcViaWorker(page, WORKER_ID, chains.upstream.url, rpcCall("eth_chainId"), cfg.worker.callTimeoutMs);
    expect(rpcResult(after.json)).toBe(`0x${chains.upstream.chainId.toString(16)}`);
    expectKpsOnlyEgress(guardedHost);
  });

  test("an invalid config rejects ready with the documented code", async ({ cfg, chains, guardedHost }) => {
    const page = await guardedHost.open("0.3.2");
    const result = await boot(page, chains.specifier.url, BAD_CONFIG_BOUND_MS, { bogus: 1 });
    expect(result.ok).toBe(false);
    expect(result.error?.code, JSON.stringify(result.error)).toBe(cfg.worker.expectedBadConfigCode);
    expect(result.readyMs).toBeLessThan(BAD_CONFIG_BOUND_MS);
    expectKpsOnlyEgress(guardedHost);
  });

  test("sequential call latency (recorded, not gated)", async ({ cfg, runPaths, chains, guardedHost }) => {
    const page = await guardedHost.open("0.3.2");
    expect((await boot(page, chains.specifier.url, cfg.worker.readyTimeoutMs, pin().config)).ok).toBe(true);
    const samples: number[] = [];
    for (let i = 0; i < LATENCY_SAMPLES; i++) {
      const outcome = await rpcViaWorker(
        page,
        WORKER_ID,
        chains.upstream.url,
        rpcCall("eth_getBalance", [chains.upstream.account, "latest"], i),
        cfg.worker.callTimeoutMs,
      );
      expect(outcome.result.status, JSON.stringify(outcome.result.error)).toBe(200);
      samples.push(outcome.result.ms);
    }
    writeReport(cfg, runPaths, "nox-worker-latency", {
      mixDelayMs: cfg.mesh.mixDelayMs,
      samples,
      p50: percentile(samples, 50),
      p90: percentile(samples, 90),
    });
    expectKpsOnlyEgress(guardedHost);
  });
});
