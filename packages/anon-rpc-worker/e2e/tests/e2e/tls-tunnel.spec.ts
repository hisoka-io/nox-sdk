// End-to-end TLS through exit tunnels (E2E TLS design §7.2 item 5):
//   reference harness -> hash-pinned worker (TLS in WebAssembly, the bed's
//   test CA trusted next to the Mozilla roots) -> anonRpcWorker.kps -> nox-kps
//   -> local mesh -> exit tunnel (TCP relay of TLS records) -> HTTPS front on
//   localhost:443 -> upstream anvil.
// The exits see TLS records only: a canary in the request reaches the front
// and appears in no nox or nox-kps log, and no exit dispatches an HttpRequest.
//
// Port 443 is the only port tunnels open, so the whole bed runs in a network
// namespace (`unshare -rn`, see README "TLS tunnels"); exits need nox rc.9
// with `[tunnel]` (the bed sets NOX__TUNNEL__ENABLED unless E2E_TUNNELS=0).

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { loadConfig } from "../../src/config.js";
import { startHttpsFront, type HttpsFront } from "../../src/https-front.js";
import { expectHex, jsonRpc } from "../../src/jsonrpc.js";
import { summarize, writeReport, type LatencySummary } from "../../src/report.js";
import { defaultWorkerConfig, describeTestbed, publishWorker, writeTestbedInfo, type PublishedWorker, type TestbedInfo } from "../../src/testbed.js";
import { resolveWorkerBundle } from "../../src/worker-bundle.js";
import type { LogLine } from "../../page/api.js";
import { expect, test } from "./fixtures.js";
import { rpcCall, rpcResult, rpcViaWorker } from "./helpers.js";

const WORKER_ID = "nox";
/** Sequential calls measured per session mode. */
const LATENCY_CALLS = 8;
/** Gap between measured calls: a replacement spare opens after an exponential delay with a 2 s mean. */
const SPARE_GAP_MS = 4_000;
const LOG_DRAIN_MAX = 2_000;
const LOG_DRAIN_WAIT_MS = 200;

const early = loadConfig();
const prerequisites: string[] = [];
if (early.kps.sidecarCommand === undefined) prerequisites.push("NOX_KPS_CMD is unset (one nox-kps sidecar per mesh node)");
if (!early.mesh.localRegistry) prerequisites.push("E2E_LOCAL_REGISTRY=0: the worker pins a snapshot of the mesh's local NoxRegistry");
if (early.worker.buildCommand === undefined) prerequisites.push("NOX_WORKER_BUILD_CMD is unset: the spec builds bundles that trust the bed's test CA");
if (!early.mesh.tunnels) prerequisites.push("E2E_TUNNELS=0: exits do not accept tunnels");

interface Published {
  readonly info: TestbedInfo;
  readonly front: HttpsFront;
  /** Hints name every exit's `tunnel_v1`. */
  readonly tunnels: PublishedWorker;
  /** The same mesh with `tunnel_v1` left out of every hint: no tunnel exit is known. */
  readonly noTunnels: PublishedWorker;
}

/** Totals over every node's `/metrics/json`. */
async function exitCounters(info: TestbedInfo): Promise<{ http: number; tunnelsOpened: number; tunnelCapable: number }> {
  let http = 0;
  let tunnelsOpened = 0;
  let tunnelCapable = 0;
  for (const node of info.mesh?.nodes ?? []) {
    const metrics = (await (await fetch(new URL("/metrics/json", node.topologyUrl))).json()) as {
      exitHttp?: number;
      tunnelOpened?: number;
      capabilities?: string[];
    };
    http += metrics.exitHttp ?? 0;
    tunnelsOpened += metrics.tunnelOpened ?? 0;
    if (metrics.capabilities?.includes("tunnel_v1") === true) tunnelCapable += 1;
  }
  return { http, tunnelsOpened, tunnelCapable };
}

/** Files under `dir` (logs, node data) whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const bytes = Buffer.from(needle);
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile() && readFileSync(child).includes(bytes)) hits.push(child);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

/** `tls.open` events in drained worker logs: handshake round trip and TLS CPU time. */
function tlsOpens(lines: readonly LogLine[]): { ms: number; cpuMs: number; spare: boolean }[] {
  const opens: { ms: number; cpuMs: number; spare: boolean }[] = [];
  for (const line of lines) {
    if (!line.text.includes("tls.open")) continue;
    const ms = /"ms":(\d+(?:\.\d+)?)/u.exec(line.text)?.[1];
    const cpu = /"cpuMs":(\d+(?:\.\d+)?)/u.exec(line.text)?.[1];
    if (ms === undefined || cpu === undefined) continue;
    opens.push({ ms: Number(ms), cpuMs: Number(cpu), spare: line.text.includes('"spare":true') });
  }
  return opens;
}

test.describe("End-to-end TLS through exit tunnels", () => {
  test.skip(prerequisites.length > 0, prerequisites.join("; "));

  let published: Published | undefined;

  test.beforeAll(async ({ cfg, runPaths, chains, resolver, meshBed }) => {
    const info = describeTestbed({ config: cfg, paths: runPaths, chains, resolver, mesh: meshBed });
    const testbedJson = writeTestbedInfo(runPaths, info);
    const counters = await exitCounters(info);
    if (counters.tunnelCapable === 0) throw new Error("no mesh node advertises tunnel_v1: build NOX_REPO at rc.9 or later");
    const front = await startHttpsFront(join(cfg.e2eRoot, "fixtures", "tls"), chains.upstream.url);
    const build = async (name: string, extraArgs: string[]) => {
      const source = await resolveWorkerBundle(cfg, runPaths.root, testbedJson, runPaths.logs, { name, extraArgs });
      if (source.kind === "missing") throw new Error(source.reason);
      return publishWorker(chains, resolver, source.bytes);
    };
    const tunnels = await build("tls", ["--extra-root", front.caDerPath]);
    const noTunnels = await build("tls-no-tunnel-exit", ["--extra-root", front.caDerPath, "--without-capability", "tunnel_v1"]);
    published = { info, front, tunnels, noTunnels };
    writeReport(cfg, runPaths, "tls-tunnel-fixture", {
      workerHash: tunnels.workerHash,
      bytes: tunnels.bytes,
      tunnelCapableNodes: counters.tunnelCapable,
      front: front.url,
    });
  });

  test.afterAll(async () => {
    await published?.front.close();
  });

  function pin(): Published {
    if (published === undefined) throw new Error("bundles were not published in beforeAll");
    return published;
  }

  function config(overrides: Record<string, unknown>): Record<string, unknown> {
    // Registry checks read the chain through exit HttpRequest (by design); "snapshot" keeps them out of the counters.
    return { ...defaultWorkerConfig(pin().info), discovery: "snapshot", ...overrides };
  }

  async function boot(page: Page, specifierUrl: string, worker: PublishedWorker, readyTimeoutMs: number, workerConfig: unknown) {
    const result = await page.evaluate((request) => window.e2e.boot(request), {
      id: WORKER_ID,
      address: worker.address,
      specifierRpcUrl: specifierUrl,
      readyTimeoutMs,
      config: workerConfig,
    });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
  }

  async function drain(page: Page): Promise<LogLine[]> {
    return page.evaluate(({ id, max, wait }) => window.e2e.logs(id, max, wait), { id: WORKER_ID, max: LOG_DRAIN_MAX, wait: LOG_DRAIN_WAIT_MS });
  }

  /** `LATENCY_CALLS` sequential eth_blockNumber calls to `url`, `gapMs` apart. */
  async function measure(page: Page, url: string, timeoutMs: number, gapMs: number): Promise<{ first: number; rest: LatencySummary }> {
    const samples: number[] = [];
    for (let index = 0; index < LATENCY_CALLS; index++) {
      const outcome = await rpcViaWorker(page, WORKER_ID, url, rpcCall("eth_blockNumber"), timeoutMs);
      expect(outcome.result.ok, JSON.stringify(outcome.result.error)).toBe(true);
      samples.push(outcome.result.ms);
      if (gapMs > 0) await page.waitForTimeout(gapMs);
    }
    return { first: samples[0] ?? 0, rest: summarize(samples.slice(1)) };
  }

  test("tls required, per-call with a spare: reads, a batch and a transaction match direct answers; exits relay ciphertext only", async ({
    cfg,
    runPaths,
    chains,
    meshBed,
    openHost,
  }) => {
    const { front, info } = pin();
    const upstream = chains.upstream;
    const before = await exitCounters(info);
    const page = await openHost("0.3.2");
    await boot(page, chains.specifier.url, pin().tunnels, cfg.worker.readyTimeoutMs, config({ tls: "required", tlsSession: "per-call", tlsSpares: 1 }));
    const call = (body: unknown) => rpcViaWorker(page, WORKER_ID, front.url, body, cfg.worker.callTimeoutMs);

    const canary = `canary-${randomBytes(12).toString("hex")}`;
    const balanceBody = { jsonrpc: "2.0", id: canary, method: "eth_getBalance", params: [upstream.account, "latest"] };
    const balance = await call(balanceBody);
    expect(balance.result.ok, JSON.stringify(balance.result.error)).toBe(true);
    expect(balance.json).toEqual({ jsonrpc: "2.0", id: canary, result: await jsonRpc(upstream.url, "eth_getBalance", [upstream.account, "latest"]) });

    const batchBody = [
      rpcCall("eth_chainId", [], 1),
      rpcCall("eth_blockNumber", [], 2),
      rpcCall("eth_getBalance", [upstream.account, "latest"], 3),
      rpcCall("net_version", [], 4),
      rpcCall("eth_gasPrice", [], 5),
    ];
    const batch = await call(batchBody);
    expect(batch.result.ok, JSON.stringify(batch.result.error)).toBe(true);
    const items = (batch.json as { id: number; result?: unknown }[]).sort((left, right) => left.id - right.id);
    expect(items.map((item) => item.id)).toEqual([1, 2, 3, 4, 5]);
    expect(items[0]?.result).toBe(`0x${upstream.chainId.toString(16)}`);
    expect(items[2]?.result).toBe(await jsonRpc(upstream.url, "eth_getBalance", [upstream.account, "latest"]));

    const signed = expectHex(
      await jsonRpc(upstream.url, "eth_signTransaction", [{ from: upstream.account, to: upstream.account, value: "0x1", gas: "0x5208" }]),
      "eth_signTransaction",
    );
    const sent = await call(rpcCall("eth_sendRawTransaction", [signed]));
    const txHash = expectHex(rpcResult(sent.json), "eth_sendRawTransaction through a tunnel");
    const receipt = (await jsonRpc(upstream.url, "eth_getTransactionReceipt", [txHash])) as { status?: string } | null;
    expect(receipt?.status).toBe("0x1");

    const perCallSpare = await measure(page, front.url, cfg.worker.callTimeoutMs, SPARE_GAP_MS);
    const opens = tlsOpens(await drain(page));
    await page.evaluate((id) => window.e2e.close(id), WORKER_ID);

    // The canary reached the provider, and only there.
    expect(front.bodies.some((body) => body.includes(canary))).toBe(true);
    expect(filesContaining(runPaths.root, canary)).toEqual([]);
    expect(filesContaining(meshBed.mesh.dataDir, canary)).toEqual([]);
    const after = await exitCounters(info);
    expect(after.http - before.http).toBe(0);
    expect(after.tunnelsOpened - before.tunnelsOpened).toBeGreaterThan(0);
    expect(opens.length).toBeGreaterThan(0);
    expect(opens.some((open) => open.spare)).toBe(true);

    writeReport(cfg, runPaths, "tls-tunnel-required", {
      callMs: { eth_getBalance: balance.result.ms, batch_5: batch.result.ms, eth_sendRawTransaction: sent.result.ms },
      perCallWithSpare: perCallSpare,
      handshakes: { count: opens.length, spares: opens.filter((open) => open.spare).length, roundTripMs: summarize(opens.map((open) => open.ms)), cpuMs: summarize(opens.map((open) => open.cpuMs)) },
      tunnelsOpened: after.tunnelsOpened - before.tunnelsOpened,
      frontRequests: front.bodies.length,
    });
  });

  test("latency per session mode on the bed: per-call without spares, keep-alive, and the exit HttpRequest path", async ({
    cfg,
    runPaths,
    chains,
    openHost,
  }) => {
    const { front } = pin();
    const page = await openHost("0.3.2");
    const modes: Record<string, { first: number; rest: LatencySummary }> = {};
    const runs: [string, Record<string, unknown>, string][] = [
      ["per-call-no-spare", { tls: "required", tlsSession: "per-call", tlsSpares: 0 }, front.url],
      ["keep-alive", { tls: "required", tlsSession: "keep-alive", tlsKeepAliveMs: 50_000 }, front.url],
      ["http-request", { tls: "off" }, chains.upstream.url],
    ];
    for (const [name, overrides, url] of runs) {
      await boot(page, chains.specifier.url, pin().tunnels, cfg.worker.readyTimeoutMs, config(overrides));
      modes[name] = await measure(page, url, cfg.worker.callTimeoutMs, 0);
      await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
    }
    expect(front.reusedConnections).toBeGreaterThan(0);
    writeReport(cfg, runPaths, "tls-tunnel-latency", { mixDelayMs: cfg.mesh.mixDelayMs, calls: LATENCY_CALLS, modes });
  });

  test("tls required with no known tunnel exit: calls reject network-error and nothing reaches the exit HttpRequest path", async ({
    cfg,
    chains,
    openHost,
  }) => {
    const { front, info } = pin();
    const before = await exitCounters(info);
    const served = front.bodies.length;
    const page = await openHost("0.3.2");
    await boot(page, chains.specifier.url, pin().noTunnels, cfg.worker.readyTimeoutMs, config({ tls: "required" }));
    const outcome = await rpcViaWorker(page, WORKER_ID, front.url, rpcCall("eth_blockNumber"), cfg.worker.callTimeoutMs);
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("network-error");
    const plain = await rpcViaWorker(page, WORKER_ID, chains.upstream.url, rpcCall("eth_blockNumber"), cfg.worker.callTimeoutMs);
    expect(plain.result.error?.code).toBe("unsupported");
    await page.evaluate((id) => window.e2e.close(id), WORKER_ID);
    expect(front.bodies.length).toBe(served);
    expect((await exitCounters(info)).http).toBe(before.http);
  });
});
