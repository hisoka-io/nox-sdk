// The Nox anon-rpc worker end to end (spine W2, TEST-PLAN TC-560/561/562 and
// the TC-570 drills on bed L):
//   reference harness (headless Chromium) -> specifier on anvil -> resolver
//   (local https-style, or kps: from a nox-kps sidecar) -> hash-pinned worker
//   -> anonRpcWorker.kps -> nox-kps sidecar -> local 10-node mesh -> exit
//   HttpRequest -> upstream anvil.
// The worker's pinned snapshot is generated from the NoxRegistry the mesh
// nodes observe on the upstream chain (scripts/build-test-worker.mjs).
//
// Skipped until the pieces exist: NOX_KPS_CMD (one nox-kps per mesh node) and
// a worker bundle (NOX_WORKER_BUILD_CMD builds one for this run's mesh, or
// NOX_WORKER_BUNDLE points at a prebuilt one). See README "Nox worker".

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { HARNESS_VERSIONS } from "../../src/bundles.js";
import { deployLogFixture, type LogFixture } from "../../src/chain-fixture.js";
import { loadConfig } from "../../src/config.js";
import { describeEvents } from "../../src/egress.js";
import { expectHex, jsonRpc } from "../../src/jsonrpc.js";
import { keccakHex, selector } from "../../src/abi.js";
import { summarize, writeReport, type LatencySummary } from "../../src/report.js";
import {
  describeTestbed,
  publishWorker,
  publishWorkerViaKps,
  workerConfigFor,
  writeTestbedInfo,
  type MeshWithSidecars,
  type PublishedWorker,
} from "../../src/testbed.js";
import { resolveWorkerBundle } from "../../src/worker-bundle.js";
import type { FetchResult, LogLine } from "../../page/api.js";
import { expect, test, type GuardedHost } from "./fixtures.js";
import { rpcCall, rpcResult, rpcViaWorker, type RpcOutcome } from "./helpers.js";

/** TC-560.02 bound for `.ready` at mix delay 0 (8 s at 50 ms is checked by the bench). */
const READY_BOUND_MS = 5_000;
/** TST-546: a bad config must reject `.ready` within 15 s. */
const BAD_CONFIG_BOUND_MS = 15_000;
const EARLY_CALLS = 3;
const WORKER_ID = "nox";
/** Boots measured by the latency test (each a fresh worker in the same page). */
const BOOT_SAMPLES = 3;
/** Samples per method in the latency test. */
const LATENCY_SAMPLES = { small: 20, logsSmall: 10, logsLarge: 5, batch: 10 } as const;
/** Calls in flight when the host closes the worker (TC-576). */
const CLOSE_IN_FLIGHT = 6;
const CLOSE_AFTER_MS = 300;
/** Drill configs: short per-attempt timeouts so a dead entry costs seconds, not the default 12 s. */
const DRILL_ATTEMPT_TIMEOUT_MS = 4_000;
const DRILL_CALL_DEADLINE_MS = 15_000;
/** The wrong-certhash drill waits this long for `ready`, which must not come. */
const NO_READY_WINDOW_MS = 12_000;
/** nox-kps rescans its bundle directory every second in the bed (fixtures/nox-kps.toml.tmpl). */
const BUNDLE_SETTLE_MS = 2_500;
/** Logs drained from the worker after a drill (harness 0.3.2 only). */
const LOG_DRAIN_MAX = 400;
const LOG_DRAIN_WAIT_MS = 200;
/** A transaction no node can decode: the upstream answers with a JSON-RPC error. */
const INVALID_RAW_TX = "0xdeadbeef";

const early = loadConfig();
const prerequisites: string[] = [];
if (early.kps.sidecarCommand === undefined) {
  prerequisites.push("NOX_KPS_CMD is unset (one nox-kps sidecar per mesh node)");
}
if (!early.mesh.localRegistry) {
  prerequisites.push("E2E_LOCAL_REGISTRY=0: the worker pins a snapshot of the mesh's local NoxRegistry");
}
if (early.worker.buildCommand === undefined && !existsSync(early.worker.bundlePath)) {
  prerequisites.push(`no worker bundle: set NOX_WORKER_BUILD_CMD or build ${early.worker.bundlePath}`);
}

interface Published {
  /** Pinned behind the local https-style resolver. */
  readonly worker: PublishedWorker;
  /** The same bundle behind a `kps:` resolver on node 0's sidecar only. */
  readonly kpsWorker: PublishedWorker;
  readonly config: unknown;
  readonly bundleSource: string;
  readonly logs: LogFixture;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** POST `body` straight to the upstream (the wallet's direct RPC call), parsed. */
async function direct(url: string, body: unknown): Promise<{ text: string; json: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { text, json: JSON.parse(text) as unknown };
}

test.describe("Nox anon-rpc worker over KPS through the local mesh", () => {
  test.skip(prerequisites.length > 0, prerequisites.join("; "));

  let published: Published | undefined;

  test.beforeAll(async ({ cfg, runPaths, chains, resolver, meshBed }) => {
    const info = describeTestbed({ config: cfg, paths: runPaths, chains, resolver, mesh: meshBed });
    const testbedJson = writeTestbedInfo(runPaths, info);
    const source = await resolveWorkerBundle(cfg, runPaths.root, testbedJson, runPaths.logs);
    if (source.kind === "missing") throw new Error(source.reason);
    const entry = meshBed.publishedKps.get(0);
    if (entry === undefined) throw new Error("node 0 has no published KPS address");
    const worker = await publishWorker(chains, resolver, source.bytes);
    const kpsWorker = await publishWorkerViaKps(chains, resolver, source.bytes, runPaths.keccak, entry, BUNDLE_SETTLE_MS);
    const logs = await deployLogFixture(chains.upstream.url, chains.upstream.account);
    published = { worker, kpsWorker, config: await workerConfigFor(cfg, info), bundleSource: source.path, logs };
    writeTestbedInfo(runPaths, { ...info, workers: { nox: worker, "nox-kps-resolver": kpsWorker } });
    writeReport(cfg, runPaths, "nox-worker-fixture", {
      bundle: source.path,
      workerHash: worker.workerHash,
      bytes: worker.bytes,
      registry: info.mesh?.registry,
      logs,
    });
  });

  /**
   * TC-562 .03: from before the host page loads until now, the guarded
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

  async function boot(page: Page, specifierUrl: string, readyTimeoutMs: number, config?: unknown, address?: string) {
    return page.evaluate((request) => window.e2e.boot(request), {
      id: WORKER_ID,
      address: address ?? pin().worker.address,
      specifierRpcUrl: specifierUrl,
      readyTimeoutMs,
      ...(config === undefined ? {} : { config }),
    });
  }

  async function drainLogs(page: Page): Promise<LogLine[]> {
    return page.evaluate(({ id, max, wait }) => window.e2e.logs(id, max, wait), {
      id: WORKER_ID,
      max: LOG_DRAIN_MAX,
      wait: LOG_DRAIN_WAIT_MS,
    });
  }

  function okStatus(outcome: RpcOutcome): void {
    expect(outcome.result.ok, JSON.stringify(outcome.result.error)).toBe(true);
    expect(outcome.result.status).toBe(200);
  }

  function logsFilter(fixture: LogFixture, which: "pings" | "blobs"): Record<string, unknown> {
    const range = fixture[which];
    const topic = keccakHex(new TextEncoder().encode(which === "pings" ? "Ping(address,uint256)" : "Blob(uint256,bytes)"));
    return {
      address: fixture.emitter,
      fromBlock: `0x${range.fromBlock.toString(16)}`,
      toBlock: `0x${range.toBlock.toString(16)}`,
      topics: [topic],
    };
  }

  /** TC-561 core matrix against the upstream, compared with direct calls. Returns per-method ms. */
  async function jsonRpcMatrix(page: Page, chainsUpstream: { url: string; account: string; chainId: number }, timeoutMs: number) {
    const upstream = chainsUpstream;
    const fixture = pin().logs;
    const call = (body: unknown) => rpcViaWorker(page, WORKER_ID, upstream.url, body, timeoutMs);
    const ms: Record<string, number> = {};

    const chainId = await call(rpcCall("eth_chainId"));
    okStatus(chainId);
    expect(rpcResult(chainId.json)).toBe(`0x${upstream.chainId.toString(16)}`);
    ms["eth_chainId"] = chainId.result.ms;

    const before = Number.parseInt(expectHex(await jsonRpc(upstream.url, "eth_blockNumber"), "eth_blockNumber"), 16);
    const blockNumber = await call(rpcCall("eth_blockNumber"));
    okStatus(blockNumber);
    expect(Number.parseInt(expectHex(rpcResult(blockNumber.json), "eth_blockNumber via worker"), 16)).toBeGreaterThanOrEqual(before);
    ms["eth_blockNumber"] = blockNumber.result.ms;

    const balanceBody = rpcCall("eth_getBalance", [upstream.account, "latest"]);
    const balance = await call(balanceBody);
    okStatus(balance);
    expect(balance.json).toEqual((await direct(upstream.url, balanceBody)).json);
    ms["eth_getBalance"] = balance.result.ms;

    // probe(21) at a fixed block: identical bytes to the direct call.
    const callBody = rpcCall("eth_call", [
      { to: fixture.emitter, from: upstream.account, data: `${selector("probe(uint256)")}${"0".repeat(62)}15` },
      `0x${fixture.pings.toBlock.toString(16)}`,
    ]);
    const ethCall = await call(callBody);
    okStatus(ethCall);
    const directCall = await direct(upstream.url, callBody);
    expect(ethCall.json).toEqual(directCall.json);
    expect(String(rpcResult(ethCall.json)).slice(0, 66)).toBe(`0x${"0".repeat(62)}2a`);
    ms["eth_call"] = ethCall.result.ms;

    const smallLogsBody = rpcCall("eth_getLogs", [logsFilter(fixture, "pings")]);
    const smallLogs = await call(smallLogsBody);
    okStatus(smallLogs);
    expect(Array.isArray(rpcResult(smallLogs.json)) ? (rpcResult(smallLogs.json) as unknown[]).length : -1).toBe(fixture.pings.count);
    expect(smallLogs.json).toEqual((await direct(upstream.url, smallLogsBody)).json);
    ms["eth_getLogs_small"] = smallLogs.result.ms;

    const largeLogsBody = rpcCall("eth_getLogs", [logsFilter(fixture, "blobs")]);
    const largeLogs = await call(largeLogsBody);
    okStatus(largeLogs);
    const largeDirect = await direct(upstream.url, largeLogsBody);
    const largeBytes = largeLogs.result.bodyText?.length ?? 0;
    expect(largeBytes).toBeGreaterThan(1_000_000);
    expect(largeLogs.json).toEqual(largeDirect.json);
    expect(sha256(JSON.stringify(largeLogs.json))).toBe(sha256(JSON.stringify(largeDirect.json)));
    ms["eth_getLogs_1MB"] = largeLogs.result.ms;

    const batchBody = [
      rpcCall("eth_chainId", [], 1),
      rpcCall("eth_getBalance", [upstream.account, "latest"], 2),
      rpcCall("eth_getLogs", [logsFilter(fixture, "pings")], 3),
      rpcCall("net_version", [], 4),
    ];
    const batch = await call(batchBody);
    okStatus(batch);
    const items = Array.isArray(batch.json) ? (batch.json as { id?: unknown }[]) : [];
    expect(items.map((item) => item.id).sort()).toEqual([1, 2, 3, 4]);
    const directBatch = (await direct(upstream.url, batchBody)).json as { id?: unknown }[];
    const byId = (list: { id?: unknown }[]) => [...list].sort((a, b) => Number(a.id) - Number(b.id));
    expect(byId(items)).toEqual(byId(directBatch));
    ms["batch_4"] = batch.result.ms;

    const invalidBody = rpcCall("eth_sendRawTransaction", [INVALID_RAW_TX]);
    const invalid = await call(invalidBody);
    okStatus(invalid);
    const invalidError = (invalid.json as { error?: { code?: unknown; message?: unknown } }).error;
    const directInvalid = (await direct(upstream.url, invalidBody)).json as { error?: { code?: unknown; message?: unknown } };
    expect(invalidError?.code, JSON.stringify(invalid.json)).toBe(directInvalid.error?.code);
    expect(invalidError?.message).toBe(directInvalid.error?.message);
    ms["eth_sendRawTransaction_invalid"] = invalid.result.ms;

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
    ms["eth_sendRawTransaction_valid"] = sent.result.ms;
    return { ms, largeLogsBytes: largeBytes };
  }

  for (const version of HARNESS_VERSIONS) {
    test(`harness ${version}: boots by specifier and serves the JSON-RPC matrix identical to direct calls`, async ({
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

      const matrix = await jsonRpcMatrix(page, chains.upstream, cfg.worker.callTimeoutMs);

      expectKpsOnlyEgress(guardedHost);
      writeReport(cfg, runPaths, `nox-worker-matrix-${version}`, {
        readyMs: result.readyMs,
        resolver: "local https-style",
        bundle: pin().bundleSource,
        workerHash: pin().worker.workerHash,
        bytes: pin().worker.bytes,
        callMs: matrix.ms,
        largeLogsBytes: matrix.largeLogsBytes,
        egress: describeEvents(guardedHost.monitor.events()),
      });
      if (version === "0.3.2") expect(result.readyMs).toBeLessThan(READY_BOUND_MS);
      await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
    });
  }

  test("kps: resolver only: the bundle loads from a nox-kps sidecar and the worker serves", async ({
    cfg,
    runPaths,
    chains,
    guardedHost,
  }) => {
    const page = await guardedHost.open("0.3.2");
    const result = await boot(page, chains.specifier.url, cfg.worker.readyTimeoutMs, pin().config, pin().kpsWorker.address);
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const balance = await rpcViaWorker(
      page,
      WORKER_ID,
      chains.upstream.url,
      rpcCall("eth_getBalance", [chains.upstream.account, "latest"]),
      cfg.worker.callTimeoutMs,
    );
    okStatus(balance);
    expect(rpcResult(balance.json)).toBe(await jsonRpc(chains.upstream.url, "eth_getBalance", [chains.upstream.account, "latest"]));
    // The resolver origin is not even contacted: the bundle came over KPS.
    expectKpsOnlyEgress(guardedHost);
    writeReport(cfg, runPaths, "nox-worker-kps-resolver", {
      readyMs: result.readyMs,
      resolvers: pin().kpsWorker.resolvers,
      egress: describeEvents(guardedHost.monitor.events()),
    });
    await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
  });

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
    const abortAt = async (abortAfterMs: number): Promise<FetchResult> =>
      page.evaluate((request) => window.e2e.fetch(request), {
        id: WORKER_ID,
        url: chains.upstream.url,
        method: "POST",
        headers: [["content-type", "application/json"]] as [string, string][],
        body: JSON.stringify(rpcCall("eth_getLogs", [logsFilter(pin().logs, "blobs")])),
        timeoutMs: cfg.worker.callTimeoutMs,
        abortAfterMs,
      });
    // At once (queued) and 50 ms in (the request is in the mixnet).
    for (const after of [0, 50]) {
      const aborted = await abortAt(after);
      expect(aborted.ok, `abort after ${after} ms`).toBe(false);
      expect(aborted.error?.name).toBe("AbortError");
      expect(aborted.ms).toBeLessThan(after + 1_000);
    }
    const next = await rpcViaWorker(page, WORKER_ID, chains.upstream.url, rpcCall("eth_chainId"), cfg.worker.callTimeoutMs);
    expect(rpcResult(next.json)).toBe(`0x${chains.upstream.chainId.toString(16)}`);
    expectKpsOnlyEgress(guardedHost);
  });

  test("worker.close() rejects the calls in flight and a new worker boots fresh", async ({ cfg, runPaths, chains, guardedHost }) => {
    const page = await guardedHost.open("0.3.2");
    expect((await boot(page, chains.specifier.url, cfg.worker.readyTimeoutMs, pin().config)).ok).toBe(true);
    const inFlight = Array.from({ length: CLOSE_IN_FLIGHT }, (_, i) =>
      rpcViaWorker(
        page,
        WORKER_ID,
        chains.upstream.url,
        rpcCall("eth_getLogs", [logsFilter(pin().logs, "blobs")], 200 + i),
        cfg.worker.callTimeoutMs,
      ));
    await page.waitForTimeout(CLOSE_AFTER_MS);
    const closedAt = Date.now();
    await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
    const outcomes = await Promise.all(inFlight);
    const settledMs = Date.now() - closedAt;
    const rejected = outcomes.filter((outcome) => !outcome.result.ok);
    // Every call still in flight at close() rejects; none hangs to its timeout.
    expect(rejected.length + outcomes.filter((o) => o.result.ok).length).toBe(CLOSE_IN_FLIGHT);
    expect(rejected.length).toBeGreaterThan(0);
    expect(settledMs).toBeLessThan(cfg.worker.callTimeoutMs);

    const again = await boot(page, chains.specifier.url, cfg.worker.readyTimeoutMs, pin().config);
    expect(again.ok, JSON.stringify(again.error)).toBe(true);
    const after = await rpcViaWorker(page, WORKER_ID, chains.upstream.url, rpcCall("eth_chainId"), cfg.worker.callTimeoutMs);
    okStatus(after);
    expectKpsOnlyEgress(guardedHost);
    writeReport(cfg, runPaths, "nox-worker-close", {
      inFlight: CLOSE_IN_FLIGHT,
      closeAfterMs: CLOSE_AFTER_MS,
      rejected: rejected.map((outcome) => outcome.result.error),
      completedBeforeClose: CLOSE_IN_FLIGHT - rejected.length,
      settledMsAfterClose: settledMs,
      rebootReadyMs: again.readyMs,
    });
    await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
  });

  test("an invalid config rejects ready with the documented code", async ({ cfg, chains, guardedHost }) => {
    const page = await guardedHost.open("0.3.2");
    const result = await boot(page, chains.specifier.url, BAD_CONFIG_BOUND_MS, { bogus: 1 });
    expect(result.ok).toBe(false);
    expect(result.error?.code, JSON.stringify(result.error)).toBe(cfg.worker.expectedBadConfigCode);
    expect(result.readyMs).toBeLessThan(BAD_CONFIG_BOUND_MS);
    expectKpsOnlyEgress(guardedHost);
  });

  test("latency: boot time and per-call p50/p95 (recorded, not gated)", async ({ cfg, runPaths, chains, guardedHost }) => {
    const page = await guardedHost.open("0.3.2");
    const boots: number[] = [];
    for (let i = 0; i < BOOT_SAMPLES; i++) {
      const result = await boot(page, chains.specifier.url, cfg.worker.readyTimeoutMs, pin().config);
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      boots.push(result.readyMs);
    }
    const upstream = chains.upstream;
    const fixture = pin().logs;
    const sample = async (n: number, body: (i: number) => unknown): Promise<LatencySummary & { samples: number[] }> => {
      const samples: number[] = [];
      for (let i = 0; i < n; i++) {
        const outcome = await rpcViaWorker(page, WORKER_ID, upstream.url, body(i), cfg.worker.callTimeoutMs);
        okStatus(outcome);
        samples.push(outcome.result.ms);
      }
      return { ...summarize(samples), samples };
    };
    const directSamples: number[] = [];
    for (let i = 0; i < LATENCY_SAMPLES.small; i++) {
      const started = performance.now();
      await jsonRpc(upstream.url, "eth_getBalance", [upstream.account, "latest"]);
      directSamples.push(Math.round(performance.now() - started));
    }
    const methods = {
      eth_blockNumber: await sample(LATENCY_SAMPLES.small, (i) => rpcCall("eth_blockNumber", [], i)),
      eth_getBalance: await sample(LATENCY_SAMPLES.small, (i) => rpcCall("eth_getBalance", [upstream.account, "latest"], i)),
      eth_call: await sample(LATENCY_SAMPLES.small, (i) =>
        rpcCall("eth_call", [{ to: fixture.emitter, data: `${selector("probe(uint256)")}${i.toString(16).padStart(64, "0")}` }, "latest"], i)),
      eth_getLogs_small: await sample(LATENCY_SAMPLES.logsSmall, (i) => rpcCall("eth_getLogs", [logsFilter(fixture, "pings")], i)),
      eth_getLogs_1MB: await sample(LATENCY_SAMPLES.logsLarge, (i) => rpcCall("eth_getLogs", [logsFilter(fixture, "blobs")], i)),
      batch_4: await sample(LATENCY_SAMPLES.batch, (i) => [
        rpcCall("eth_chainId", [], 4 * i),
        rpcCall("eth_blockNumber", [], 4 * i + 1),
        rpcCall("eth_getBalance", [upstream.account, "latest"], 4 * i + 2),
        rpcCall("net_version", [], 4 * i + 3),
      ]),
    };
    expectKpsOnlyEgress(guardedHost);
    writeReport(cfg, runPaths, "nox-worker-latency", {
      mixDelayMs: cfg.mesh.mixDelayMs,
      boot: { ...summarize(boots), samples: boots },
      directGetBalance: { ...summarize(directSamples), samples: directSamples },
      methods,
    });
    await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
  });

  test.describe("failure drills", () => {
    /** Two entries the drills restrict the worker to. */
    const ENTRY_A = 1;
    const ENTRY_B = 2;

    function entries(meshBed: MeshWithSidecars, ids: readonly number[]): string[] {
      return ids.map((id) => {
        const address = meshBed.publishedKps.get(id);
        if (address === undefined) throw new Error(`node ${id} has no published KPS address`);
        return address;
      });
    }

    function drillConfig(gateways: readonly string[]): Record<string, unknown> {
      return {
        gateways,
        logLevel: "debug",
        attemptTimeoutMs: DRILL_ATTEMPT_TIMEOUT_MS,
        callDeadlineMs: DRILL_CALL_DEADLINE_MS,
      };
    }

    test("TC-571 entry down: calls move to the other entry, and back", async ({ cfg, runPaths, chains, meshBed, guardedHost }) => {
      const page = await guardedHost.open("0.3.2");
      const gateways = entries(meshBed, [ENTRY_A, ENTRY_B]);
      const ready = await boot(page, chains.specifier.url, cfg.worker.readyTimeoutMs, drillConfig(gateways));
      expect(ready.ok, JSON.stringify(ready.error)).toBe(true);
      const callOnce = () =>
        rpcViaWorker(page, WORKER_ID, chains.upstream.url, rpcCall("eth_blockNumber"), cfg.worker.callTimeoutMs);
      const record: Record<string, unknown>[] = [];
      try {
        for (const [down, up] of [[ENTRY_A, ENTRY_B], [ENTRY_B, ENTRY_A]] as const) {
          await meshBed.stopSidecar(down);
          const first = await callOnce();
          const second = first.result.ok ? first : await callOnce();
          record.push({
            down,
            up,
            first: { ok: first.result.ok, ms: first.result.ms, error: first.result.error },
            ...(second === first ? {} : { second: { ok: second.result.ok, ms: second.result.ms, error: second.result.error } }),
          });
          // The next call succeeds within one retry, through the entry still up.
          okStatus(second);
          await meshBed.startSidecar(down, "original");
        }
      } finally {
        for (const id of [ENTRY_A, ENTRY_B]) {
          if (!meshBed.sidecars.has(id)) await meshBed.startSidecar(id, "original");
        }
      }
      const logs = await drainLogs(page);
      expectKpsOnlyEgress(guardedHost);
      writeReport(cfg, runPaths, "nox-worker-drill-entry-down", {
        record,
        logEvents: logs.filter((line) => /entry|anchor|kps|retry/u.test(line.text)).slice(-60),
      });
      await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
    });

    test("TC-570 wrong certhash: no fallback, the documented error, and other entries keep serving", async ({
      cfg,
      runPaths,
      chains,
      meshBed,
      guardedHost,
    }) => {
      const page = await guardedHost.open("0.3.2");
      const [pinnedA, pinnedB] = entries(meshBed, [ENTRY_A, ENTRY_B]);
      if (pinnedA === undefined || pinnedB === undefined) throw new Error("drill entries missing");
      // Node A's sidecar now serves a different identity on the published address.
      const rotated = await meshBed.startSidecar(ENTRY_A, "rotated");
      try {
        expect(rotated.address).not.toBe(pinnedA);
        expect(rotated.address.split(":").slice(0, 2)).toEqual(pinnedA.split(":").slice(0, 2));

        // (a) Only the rotated entry allowed: the worker never becomes ready,
        // never falls back to HTTP, and a call fails with `timeout`.
        const onlyRotated = await page.evaluate((request) => window.e2e.boot(request), {
          id: WORKER_ID,
          address: pin().worker.address,
          specifierRpcUrl: chains.specifier.url,
          readyTimeoutMs: NO_READY_WINDOW_MS,
          config: drillConfig([pinnedA]),
          awaitReady: false,
        });
        expect(onlyRotated.ok).toBe(true);
        const stuckCall = await rpcViaWorker(page, WORKER_ID, chains.upstream.url, rpcCall("eth_chainId"), cfg.worker.callTimeoutMs);
        const notReady = await page.evaluate(({ id, ms }) => window.e2e.ready(id, ms), { id: WORKER_ID, ms: 1_000 });
        expect(notReady.ok).toBe(false);
        expect(notReady.error?.message ?? "").toMatch(/did not settle/u);
        expect(stuckCall.result.ok).toBe(false);
        expect(stuckCall.result.error?.code, JSON.stringify(stuckCall.result.error)).toBe("timeout");
        expect(stuckCall.result.ms).toBeLessThan(DRILL_CALL_DEADLINE_MS + 2_000);
        const stuckLogs = await drainLogs(page);
        const retries = stuckLogs.filter((line) => /boot\.retry/u.test(line.text));
        expect(retries.length, stuckLogs.map((line) => line.text).slice(-20).join("\n")).toBeGreaterThan(0);
        expect(retries.some((line) => /no-anchor-reachable|kps-dial-failed/u.test(line.text))).toBe(true);
        await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
        expectKpsOnlyEgress(guardedHost);

        // (b) Rotated entry plus a good one: boot and calls go through the good one.
        const mixed = await boot(page, chains.specifier.url, cfg.worker.readyTimeoutMs, drillConfig([pinnedA, pinnedB]));
        expect(mixed.ok, JSON.stringify(mixed.error)).toBe(true);
        for (let i = 0; i < 3; i++) {
          okStatus(await rpcViaWorker(page, WORKER_ID, chains.upstream.url, rpcCall("eth_chainId", [], i), cfg.worker.callTimeoutMs));
        }
        expectKpsOnlyEgress(guardedHost);
        writeReport(cfg, runPaths, "nox-worker-drill-wrong-certhash", {
          pinned: pinnedA.split(":").slice(0, 2).join(":"),
          onlyRotated: { stuckCall: stuckCall.result, readyWithin: NO_READY_WINDOW_MS, bootRetries: retries.map((l) => l.text).slice(0, 10) },
          mixedReadyMs: mixed.readyMs,
        });
        await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
      } finally {
        await meshBed.startSidecar(ENTRY_A, "original");
      }
    });
  });
});
