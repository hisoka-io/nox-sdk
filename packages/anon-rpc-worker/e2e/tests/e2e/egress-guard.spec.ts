// Controls for the egress check the Nox worker spec relies on (TST-562 .03).
//   Negative: a hash-pinned worker that, while getting ready, opens a WebSocket
//   to an ingress-shaped endpoint (the F16 globalThis.WebSocket fallback),
//   fetches /topology through `localhost` and calls a public RPC host. The check
//   must flag each one, at boot time, with the WebSocket seen by the proxy.
//   Positive: the KPS probe worker, which reaches the network only through
//   anonRpcWorker.kps, stays inside the allowlist while a KPS stream succeeds.
// Neither needs the mesh, so both run on every pass.

import { existsSync } from "node:fs";
import { buildTestWorker } from "../../src/bundles.js";
import { describeEvents, type EgressEvent } from "../../src/egress.js";
import { echoServerBinary, startEchoServer } from "../../src/kps-server.js";
import { writeReport } from "../../src/report.js";
import { publishWorker } from "../../src/testbed.js";
import { startTrapServer } from "../../src/trap-server.js";
import { expect, test } from "./fixtures.js";

/** How long the leaky worker waits for each leak to settle before signalReady. */
const LEAK_SETTLE_MS = 5_000;
/** A public-RPC-shaped host under the reserved .invalid TLD: the proxy refuses it, nothing resolves it. */
const PUBLIC_RPC_URL = "https://public-rpc.invalid/";
const KPS_STREAM_TIMEOUT_MS = 30_000;

interface LeakReport {
  readonly leaks: readonly { readonly url: string; readonly outcome: string }[];
}

function touches(events: readonly EgressEvent[], needle: string): EgressEvent[] {
  return events.filter((event) => event.target.includes(needle));
}

test.describe("egress check controls", () => {
  test("flags a worker that opens a WebSocket and ambient fetches while getting ready", async ({
    cfg,
    runPaths,
    chains,
    resolver,
    guardedHost,
  }) => {
    const trap = await startTrapServer();
    try {
      const leaky = await publishWorker(chains, resolver, await buildTestWorker("leaky", cfg.e2eRoot));
      const websocketUrl = `ws://127.0.0.1:${trap.port}/api/v1/ws`;
      const topologyUrl = `http://localhost:${trap.port}/topology`;
      const page = await guardedHost.open("0.3.2");
      const boot = await page.evaluate((request) => window.e2e.boot(request), {
        id: "leaky",
        address: leaky.address,
        specifierRpcUrl: chains.specifier.url,
        readyTimeoutMs: cfg.worker.readyTimeoutMs,
        config: { websockets: [websocketUrl], fetches: [topologyUrl, PUBLIC_RPC_URL], settleMs: LEAK_SETTLE_MS },
      });
      expect(boot.ok, JSON.stringify(boot.error)).toBe(true);

      // Every leak ran before signalReady, so everything below was observed at boot.
      const flaggedAtReady = guardedHost.monitor.violations();
      const report = await page.evaluate((request) => window.e2e.fetch(request), {
        id: "leaky",
        url: "https://leak-report.invalid/",
        timeoutMs: cfg.worker.callTimeoutMs,
      });
      const leaks = (JSON.parse(report.bodyText ?? "{}") as LeakReport).leaks;
      writeReport(cfg, runPaths, "egress-guard-negative", {
        leaks,
        trapHits: trap.hits,
        flaggedAtReady: describeEvents(flaggedAtReady),
        events: describeEvents(guardedHost.monitor.events()),
      });

      // The WebSocket really left the browser: the trap completed the handshake.
      expect(leaks.find((leak) => leak.url === websocketUrl)?.outcome).toBe("open");
      expect(trap.hits.filter((hit) => hit.kind === "websocket").map((hit) => hit.path)).toEqual(["/api/v1/ws"]);

      // ...and the check flagged every leak at boot. The proxy layer alone must
      // catch all three (context `request` events do not report WebSockets);
      // the page `websocket` event is a second witness for the socket.
      const description = describeEvents(flaggedAtReady).join("\n");
      const flaggedByProxy = flaggedAtReady.filter((event) => event.layer === "proxy");
      for (const needle of [`127.0.0.1:${trap.port}`, `localhost:${trap.port}`, "public-rpc.invalid"]) {
        expect(touches(flaggedByProxy, needle).length, `${needle}\n${description}`).toBeGreaterThanOrEqual(1);
      }
      const socketEvents = flaggedAtReady.filter((event) => event.kind === "websocket" || event.kind === "connect");
      expect(touches(socketEvents, `127.0.0.1:${trap.port}`).length, description).toBeGreaterThanOrEqual(1);
      // A public RPC host is refused by the proxy without being resolved or reached.
      expect(trap.hits.some((hit) => hit.host.startsWith("public-rpc"))).toBe(false);
      expect(leaks.find((leak) => leak.url === PUBLIC_RPC_URL)?.outcome).toMatch(/^rejected/u);

      // The allowlisted origins carried the boot itself and are never flagged.
      for (const allowed of [resolver.server.origin, chains.specifier.url]) {
        expect(touches(flaggedAtReady, new URL(allowed).host), allowed).toEqual([]);
      }
      await page.evaluate((id) => window.e2e.close(id), "leaky");
    } finally {
      await trap.close();
    }
  });

  test("a worker that reaches the network only through KPS stays inside the allowlist", async ({
    cfg,
    runPaths,
    chains,
    resolver,
    guardedHost,
  }, testInfo) => {
    const probe = await publishWorker(chains, resolver, await buildTestWorker("kps-probe", cfg.e2eRoot));
    const page = await guardedHost.open("0.3.2");
    const boot = await page.evaluate((request) => window.e2e.boot(request), {
      id: "kps-probe",
      address: probe.address,
      specifierRpcUrl: chains.specifier.url,
      readyTimeoutMs: cfg.worker.readyTimeoutMs,
    });
    expect(boot.ok, JSON.stringify(boot.error)).toBe(true);

    const bin = echoServerBinary(cfg.kps.binDir, "go");
    let stream: unknown = "skipped: run scripts/build-kps-servers.sh for the KPS stream part";
    if (existsSync(bin)) {
      const server = await startEchoServer({
        kind: "go",
        binDir: cfg.kps.binDir,
        bindIp: "127.0.0.1",
        stateDir: runPaths.kps,
        logDir: runPaths.logs,
        addressTimeoutMs: cfg.kps.addressTimeoutMs,
      });
      try {
        const result = await page.evaluate((request) => window.e2e.fetch(request), {
          id: "kps-probe",
          url: `kps-echo://${server.address}?sizes=32,32768&seq=2&par=0&mode=dial&timeout=${KPS_STREAM_TIMEOUT_MS}`,
          timeoutMs: 2 * KPS_STREAM_TIMEOUT_MS,
        });
        stream = JSON.parse(result.bodyText ?? "null") as unknown;
        expect(result.status, result.bodyText).toBe(200);
        expect((stream as { ok?: unknown } | null)?.ok, result.bodyText).toBe(true);
      } finally {
        await server.stop();
      }
    } else {
      testInfo.annotations.push({ type: "kps-stream", description: String(stream) });
    }

    writeReport(cfg, runPaths, "egress-guard-positive", { stream, events: describeEvents(guardedHost.monitor.events()) });
    expect(guardedHost.monitor.violations(), guardedHost.monitor.describeViolations()).toEqual([]);
    // The monitor did watch: the boot's own allowlisted traffic is on record.
    expect(touches(guardedHost.monitor.events("proxy"), new URL(resolver.server.origin).host).length).toBeGreaterThanOrEqual(1);
    await page.evaluate((id) => window.e2e.close(id), "kps-probe");
  });
});
