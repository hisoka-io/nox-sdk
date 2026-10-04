// Step 2 of the test bed: does browser WebRTC-KPS work here (WSL2, headless
// Chromium)? Each reference KPS echo server from ethereum/kps is dialled
//   (a) straight from the host page with @kpstreams/webrtc-client, and
//   (b) from inside a hash-pinned worker through the harness's anonRpcWorker.kps,
// with 32 B, 32 KiB (one Sphinx packet) and 1 MiB (past the 1 MiB stream
// window) echoes, sequential stream cycling and parallel streams. Results are
// written to .run/reports/kps-webrtc-<project>.json.

import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import type { DirectEchoResult } from "../../page/api.js";
import { buildProbeWorker } from "../../src/bundles.js";
import { echoServerBinary, startEchoServer, type EchoServerKind } from "../../src/kps-server.js";
import { percentile, writeReport } from "../../src/report.js";
import { publishWorker, type PublishedWorker } from "../../src/testbed.js";
import { expect, test } from "./fixtures.js";
import { externalIpv4, loopbackIpv4Addresses } from "./helpers.js";

const SERVER_KINDS: readonly EchoServerKind[] = ["go", "rust", "rust-ipfilter"];
const SIZES = [32, 32 * 1024, 1024 * 1024];
const SEQUENTIAL_STREAMS = 10;
const PARALLEL_STREAMS = 4;
const DIAL_ATTEMPTS = 3;
/** The KPS client's own HELLO deadline is 15 s; a dial cannot take longer. */
const DIAL_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 20_000;

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
  readonly bindIp: string;
  readonly address: string;
  readonly knownIssue: boolean;
  readonly direct: {
    readonly attempts: number;
    readonly successes: number;
    readonly dialMs: number[];
    readonly echo: { bytes: number; ms: number; ok: boolean; error?: string }[];
    readonly sequentialP50Ms: number | undefined;
    readonly parallel: { ms: number; ok: boolean; error?: string }[];
    readonly errors: string[];
  };
  readonly harness: HarnessProbe[];
}

const records: ProbeRecord[] = [];
let probeWorker: PublishedWorker | undefined;

function failureText(result: DirectEchoResult): string {
  const failed = [...result.samples, ...result.sequential, ...result.parallel].filter((sample) => !sample.ok);
  return result.error ?? failed.map((sample) => `${sample.bytes} B: ${sample.error ?? "failed"}`).join("; ");
}

function reportOk(report: unknown): boolean {
  return typeof report === "object" && report !== null && (report as { ok?: unknown }).ok === true;
}

test.describe("browser WebRTC-KPS against the reference KPS servers", () => {
  test.afterAll(async ({ cfg, runPaths }, workerInfo) => {
    writeReport(cfg, runPaths, `kps-webrtc-${workerInfo.project.name}`, {
      kernel: release(),
      loopbackIpv4: loopbacks,
      externalIpv4: external ?? null,
      chromiumArgs: workerInfo.project.use.launchOptions?.args ?? [],
      records,
    });
  });

  for (const kind of SERVER_KINDS) {
    for (const bindIp of bindIps) {
      test(`${kind} server on ${bindIp}`, async ({ cfg, runPaths, chains, resolver, openHost }, testInfo) => {
        const bin = echoServerBinary(cfg.kps.binDir, kind);
        test.skip(
          !existsSync(bin),
          `${bin} is missing: run scripts/build-kps-servers.sh` +
            (kind === "rust-ipfilter" ? " and scripts/build-kps-ipfilter-probe.sh" : ""),
        );
        // The stock kps crate pins WebRTC ICE gathering to interfaces named lo*
        // and expects one candidate per family; a second IPv4 on lo (WSL2 adds
        // 10.255.255.254) breaks ICE convergence. See LANE-NOTES / README.
        const knownIssue = kind === "rust" && loopbacks.length > 1;
        test.fail(
          knownIssue,
          `stock kps crate on a host whose loopback carries ${loopbacks.join(", ")}: ICE does not converge`,
        );

        const server = await startEchoServer({
          kind,
          binDir: cfg.kps.binDir,
          bindIp,
          stateDir: runPaths.kps,
          logDir: runPaths.logs,
          addressTimeoutMs: cfg.kps.addressTimeoutMs,
          ...(cfg.kps.debug && kind !== "go" ? { env: { KPS_DEBUG: "1" } } : {}),
        });
        try {
          const page = await openHost("0.3.2");
          const browserVersion = page.context().browser()?.version() ?? "unknown";
          testInfo.annotations.push({ type: "browser", description: browserVersion });

          // (a) Direct: the page dials with @kpstreams/webrtc-client.
          const attempts: DirectEchoResult[] = [];
          for (let attempt = 0; attempt < DIAL_ATTEMPTS; attempt++) {
            attempts.push(
              await page.evaluate((request) => window.e2e.directKpsEcho(request), {
                addr: server.address,
                sizes: attempt === 0 ? SIZES : [SIZES[0] ?? 32],
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
              ? `sizes=${SIZES.join(",")}&seq=${SEQUENTIAL_STREAMS}&par=${PARALLEL_STREAMS}&mode=dial&timeout=${STREAM_TIMEOUT_MS}`
              : `sizes=${32 * 1024}&seq=2&mode=open&timeout=${STREAM_TIMEOUT_MS}`;
            const result = await page.evaluate((request) => window.e2e.fetch(request), {
              id: "kps-probe",
              url: `kps-echo://${server.address}?${query}`,
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
          records.push({
            project: testInfo.project.name,
            server: kind,
            bindIp,
            address: server.address,
            knownIssue,
            direct: {
              attempts: attempts.length,
              successes: attempts.filter((a) => a.ok).length,
              dialMs: attempts.map((a) => a.dialMs),
              echo: (first?.samples ?? []).map((s) => ({ ...s })),
              sequentialP50Ms: percentile(sequentialMs, 50),
              parallel: (first?.parallel ?? []).map((s) => ({ ...s })),
              errors: attempts.filter((a) => !a.ok).map(failureText),
            },
            harness,
          });

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
});
