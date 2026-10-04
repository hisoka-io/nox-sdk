// Step 2 of the test bed: does browser WebRTC-KPS work here (WSL2, headless
// Chromium)? Each KPS server is dialled
//   (a) straight from the host page with @kpstreams/webrtc-client, and
//   (b) from inside a hash-pinned worker through the harness's anonRpcWorker.kps
//       (kps.dial and the kps.openStream sugar).
// Echo servers (ethereum/kps Go and Rust): 32 B, 32 KiB (one Sphinx packet) and
// 512 KiB echoes, sequential stream cycling and parallel streams.
// Bulk-response server (tools/kps-bulk-server): small request, then 32 KiB to
// 16 MiB responses, the shape of a Nox response claim.
// One JSON report per test lands in .run/reports/kps-webrtc-<project>-<server>-<ip>.json.

import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import type { DirectEchoResult } from "../../page/api.js";
import { buildProbeWorker } from "../../src/bundles.js";
import { echoServerBinary, startEchoServer, type EchoServerKind } from "../../src/kps-server.js";
import { percentile, writeReport } from "../../src/report.js";
import { publishWorker, type PublishedWorker } from "../../src/testbed.js";
import type { TransferKind } from "../../shared/kps-probe.js";
import { expect, test } from "./fixtures.js";
import { externalIpv4, loopbackIpv4Addresses } from "./helpers.js";

const KIB = 1024;
const MIB = 1024 * KIB;

interface ServerPlan {
  readonly kind: EchoServerKind;
  readonly transfer: TransferKind;
  readonly sizes: readonly number[];
  /** Size used for sequential and parallel stream cycling. */
  readonly cycleSize: number;
}

/**
 * Echo sizes stay below the default 1 MiB KPS stream window: a single-stream
 * echo of 1,048,560 bytes or more stalls with both reference servers (pinned
 * by the "echo at the stream window" test below). Nox requests are at most
 * 64 KiB per stream, so the Nox path never meets this.
 */
const ECHO_SIZES = sizesFrom(process.env["E2E_KPS_ECHO_SIZES"], [32, 32 * KIB, 512 * KIB]);
const DOWNLOAD_SIZES = sizesFrom(process.env["E2E_KPS_DOWNLOAD_SIZES"], [32 * KIB, 1 * MIB, 4 * MIB, 16 * MIB]);

const SERVER_PLANS: readonly ServerPlan[] = [
  { kind: "go", transfer: "echo", sizes: ECHO_SIZES, cycleSize: 32 },
  { kind: "rust", transfer: "echo", sizes: ECHO_SIZES, cycleSize: 32 },
  { kind: "rust-ipfilter", transfer: "echo", sizes: ECHO_SIZES, cycleSize: 32 },
  { kind: "go-bulk", transfer: "download", sizes: DOWNLOAD_SIZES, cycleSize: 32 * KIB },
];
const SEQUENTIAL_STREAMS = 10;
const PARALLEL_STREAMS = 4;
const DIAL_ATTEMPTS = 3;
/**
 * Symptom of the loopback finding: the browser's dial never completes. The KPS
 * client reports its HELLO deadline or the page's dial deadline, whichever
 * fires first.
 */
const HELLO_TIMEOUT = /kps: (?:HELLO timeout|dial timed out)/u;
/** Symptom of the window finding: the echo waits past its deadline (shared/kps-probe.ts). */
const ECHO_STALL = /^echo did not finish within \d+ ms$/u;

/** The KPS client's own HELLO deadline is 15 s; a dial cannot take longer. */
const DIAL_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 30_000;
/** Largest single-stream echo measured to complete (1 MiB - 64 B). */
const WINDOW_ECHO_PASS_BYTES = MIB - 64;
const WINDOW_ECHO_TIMEOUT_MS = 15_000;

const loopbacks = loopbackIpv4Addresses();
const external = externalIpv4();
const bindIps = external === undefined ? ["127.0.0.1"] : ["127.0.0.1", external];

interface HarnessProbe {
  readonly mode: "dial" | "open";
  readonly status: number | undefined;
  readonly report: unknown;
  readonly error?: string;
}

interface ProbeRecord {
  readonly project: string;
  readonly server: EchoServerKind;
  readonly transfer: TransferKind;
  readonly bindIp: string;
  readonly address: string;
  readonly knownIssue: boolean;
  readonly direct: {
    readonly attempts: number;
    readonly successes: number;
    readonly dialMs: number[];
    readonly samples: { bytes: number; ms: number; ok: boolean; error?: string }[];
    readonly sequentialP50Ms: number | undefined;
    readonly parallel: { ms: number; ok: boolean; error?: string }[];
    readonly errors: string[];
  };
  readonly harness: HarnessProbe[];
}

let probeWorker: PublishedWorker | undefined;

function sizesFrom(raw: string | undefined, fallback: number[]): number[] {
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.split(",").map((part) => {
    const size = Number(part.trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > 64 * MIB) {
      throw new Error(`size list entry ${part} is not a byte count in [0, 64 MiB]`);
    }
    return size;
  });
}

function failureText(result: DirectEchoResult): string {
  const failed = [...result.samples, ...result.sequential, ...result.parallel].filter((sample) => !sample.ok);
  return result.error ?? failed.map((sample) => `${sample.bytes} B: ${sample.error ?? "failed"}`).join("; ");
}

function reportOk(report: unknown): boolean {
  return typeof report === "object" && report !== null && (report as { ok?: unknown }).ok === true;
}

test.describe("browser WebRTC-KPS against reference KPS servers", () => {
  for (const plan of SERVER_PLANS) {
    for (const bindIp of bindIps) {
      test(`${plan.kind} server (${plan.transfer}) on ${bindIp}`, async (
        { cfg, runPaths, chains, resolver, openHost },
        testInfo,
      ) => {
        const { kind } = plan;
        const bin = echoServerBinary(cfg.kps.binDir, kind);
        test.skip(
          !existsSync(bin),
          `${bin} is missing: run scripts/build-kps-servers.sh` +
            (kind === "rust-ipfilter" ? " and scripts/build-kps-ipfilter-probe.sh" : ""),
        );
        // The stock kps crate pins WebRTC ICE gathering to interfaces named lo*
        // and expects one candidate per family; a second IPv4 on lo (WSL2 adds
        // 10.255.255.254) breaks ICE convergence. See README "Findings". The
        // test is marked as an expected failure only after the run shows that
        // exact symptom, so any other failure stays unexpected.
        const knownIssue = kind === "rust" && loopbacks.length > 1;

        const server = await startEchoServer({
          kind,
          binDir: cfg.kps.binDir,
          bindIp,
          stateDir: runPaths.kps,
          logDir: runPaths.logs,
          addressTimeoutMs: cfg.kps.addressTimeoutMs,
          ...(cfg.kps.debug && kind.startsWith("rust") ? { env: { KPS_DEBUG: "1" } } : {}),
        });
        try {
          const page = await openHost("0.3.2");
          const browserVersion = page.context().browser()?.version() ?? "unknown";
          testInfo.annotations.push({ type: "browser", description: browserVersion });

          // (a) Direct: the page dials with @kpstreams/webrtc-client. The first
          // attempt runs the full plan; later attempts measure dial reliability.
          const attempts: DirectEchoResult[] = [];
          for (let attempt = 0; attempt < DIAL_ATTEMPTS; attempt++) {
            attempts.push(
              await page.evaluate((request) => window.e2e.directKpsEcho(request), {
                addr: server.address,
                transfer: plan.transfer,
                sizes: attempt === 0 ? plan.sizes : [plan.cycleSize],
                sequentialStreams: attempt === 0 ? SEQUENTIAL_STREAMS : 0,
                parallelStreams: attempt === 0 ? PARALLEL_STREAMS : 0,
                dialTimeoutMs: DIAL_TIMEOUT_MS,
                streamTimeoutMs: STREAM_TIMEOUT_MS,
              }),
            );
          }
          const first = attempts[0];

          // (b) Through the harness: a hash-pinned probe worker uses anonRpcWorker.kps.
          probeWorker ??= await publishWorker(chains, resolver, await buildProbeWorker(cfg.e2eRoot));
          const boot = await page.evaluate((request) => window.e2e.boot(request), {
            id: "kps-probe",
            address: probeWorker.address,
            specifierRpcUrl: chains.specifier.url,
            readyTimeoutMs: cfg.worker.readyTimeoutMs,
          });
          expect(boot.ok, JSON.stringify(boot.error)).toBe(true);
          const modes: ("dial" | "open")[] = knownIssue ? ["dial"] : ["dial", "open"];
          const harness: HarnessProbe[] = [];
          for (const mode of modes) {
            const query = mode === "dial"
              ? `sizes=${plan.sizes.join(",")}&seq=${SEQUENTIAL_STREAMS}&par=${PARALLEL_STREAMS}`
              : `sizes=${plan.cycleSize}&seq=2`;
            const result = await page.evaluate((request) => window.e2e.fetch(request), {
              id: "kps-probe",
              url: `kps-echo://${server.address}?${query}&mode=${mode}&transfer=${plan.transfer}&timeout=${STREAM_TIMEOUT_MS}`,
              timeoutMs: 4 * 60_000,
            });
            let report: unknown;
            try {
              report = result.bodyText === undefined ? undefined : (JSON.parse(result.bodyText) as unknown);
            } catch {
              report = result.bodyText;
            }
            harness.push({
              mode,
              status: result.status,
              report,
              ...(result.error === undefined ? {} : { error: `${result.error.name}: ${result.error.message}` }),
            });
          }
          await page.evaluate((id) => window.e2e.close(id), "kps-probe");

          const sequentialMs = (first?.sequential ?? []).filter((s) => s.ok).map((s) => s.ms);
          const record: ProbeRecord = {
            project: testInfo.project.name,
            server: kind,
            transfer: plan.transfer,
            bindIp,
            address: server.address,
            knownIssue,
            direct: {
              attempts: attempts.length,
              successes: attempts.filter((a) => a.ok).length,
              dialMs: attempts.map((a) => a.dialMs),
              samples: (first?.samples ?? []).map((s) => ({ ...s })),
              sequentialP50Ms: percentile(sequentialMs, 50),
              parallel: (first?.parallel ?? []).map((s) => ({ ...s })),
              errors: attempts.filter((a) => !a.ok).map(failureText),
            },
            harness,
          };
          // One report per test: Playwright restarts the worker process after a
          // failure, so module-level state cannot collect a whole run.
          writeReport(cfg, runPaths, `kps-webrtc-${testInfo.project.name}-${kind}-${bindIp}`, {
            kernel: release(),
            loopbackIpv4: loopbacks,
            externalIpv4: external ?? null,
            chromiumArgs: testInfo.project.use.launchOptions?.args ?? [],
            browser: browserVersion,
            record,
          });

          if (knownIssue) {
            const failures = attempts.filter((attempt) => !attempt.ok).map(failureText);
            for (const failure of failures) expect(failure, "the pinned symptom of the loopback finding").toMatch(HELLO_TIMEOUT);
            // With the symptom confirmed (or gone: then the test passes and is
            // reported as "expected to fail, but passed", flipping the finding).
            test.fail(true, `stock kps crate on a host whose loopback carries ${loopbacks.join(", ")}: ICE does not converge`);
          }
          for (const attempt of attempts) expect(attempt.ok, failureText(attempt)).toBe(true);
          for (const probe of harness) {
            expect(probe.status, probe.error).toBe(200);
            expect(reportOk(probe.report), JSON.stringify(probe.report)).toBe(true);
          }
        } finally {
          await server.stop();
          const log = readFileSync(server.logFile, "utf8");
          if (log.includes("CONCURRENT inbox readers")) {
            testInfo.annotations.push({ type: "kps-listener", description: "CONCURRENT inbox readers logged" });
          }
        }
      });
    }
  }

  test("finding: a single-stream echo of 1 MiB stalls (Go reference server)", async (
    { cfg, runPaths, openHost },
    testInfo,
  ) => {
    const bin = echoServerBinary(cfg.kps.binDir, "go");
    test.skip(!existsSync(bin), `${bin} is missing: run scripts/build-kps-servers.sh`);
    // Expected to fail until the cause is found and fixed upstream: the test
    // turns red ("expected to fail, but passed") the day the stall is gone. It
    // is marked as expected only after the control echo passed and the 1 MiB
    // echo failed with the pinned symptom, so a server that does not start, a
    // page that does not load or another error stays an unexpected failure.
    const server = await startEchoServer({
      kind: "go",
      binDir: cfg.kps.binDir,
      bindIp: "127.0.0.1",
      stateDir: runPaths.kps,
      logDir: runPaths.logs,
      addressTimeoutMs: cfg.kps.addressTimeoutMs,
    });
    try {
      const page = await openHost("0.3.2");
      const result = await page.evaluate((request) => window.e2e.directKpsEcho(request), {
        addr: server.address,
        transfer: "echo" as const,
        sizes: [WINDOW_ECHO_PASS_BYTES, MIB],
        sequentialStreams: 0,
        parallelStreams: 0,
        dialTimeoutMs: DIAL_TIMEOUT_MS,
        streamTimeoutMs: WINDOW_ECHO_TIMEOUT_MS,
      });
      writeReport(cfg, runPaths, `kps-echo-window-${testInfo.project.name}`, { samples: result.samples });
      expect(result.samples[0]?.ok, "echo just below the window must pass").toBe(true);
      const atWindow = result.samples[1];
      if (atWindow !== undefined && !atWindow.ok) {
        expect(atWindow.error ?? "", "the pinned symptom of the window finding").toMatch(ECHO_STALL);
      }
      test.fail(true, "single-stream echo at the 1 MiB stream window does not complete");
      expect(result.ok, failureText(result)).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

