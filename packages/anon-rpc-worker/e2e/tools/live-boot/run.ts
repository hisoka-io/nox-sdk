// Boots the Nox anon-rpc worker from a live specifier in one browser, through
// the reference harness on the bed's host page, then runs two JSON-RPC calls.
// Prints the stage it reached (harness, WASM init, TLS init, KPS dial, SURB
// reply, RPC call) with the worker's boot log and timings; exits 1 on failure.
//
//   tsx tools/live-boot/run.ts <chromium|webkit>
//
// Environment (defaults: the stable specifier on Ethereum Sepolia):
//   LIVE_SPECIFIER       WorkerSpecifier address
//   LIVE_SPECIFIER_RPC   JSON-RPC URL the page reads the specifier through
//   LIVE_CALL_RPC        upstream the worker calls (eth_chainId, eth_blockNumber)
//   LIVE_HARNESS         harness version on the host page (0.3.0, 0.3.2, 0.4.0)
//   LIVE_OUT             report and trace directory (default .run/live-boot)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit, type Page } from "@playwright/test";
import { HARNESS_VERSIONS, type HarnessVersion } from "../../src/bundles.js";
import { E2E_ROOT } from "../../src/config.js";
import { startHostServer } from "../../src/host-server.js";
import type { BootResult, FetchResult, LogLine } from "../../page/api.js";

const STABLE_SPECIFIER = "0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA_CHAIN_ID = "0xaa36a7";
const WORKER_ID = "live";
const READY_TIMEOUT_MS = 150_000;
const CALL_TIMEOUT_MS = 60_000;
const LOG_BATCH = 50;
const LOG_WAIT_MS = 250;
/** Logs that arrive after the last call: one more drain this long. */
const LOG_TAIL_MS = 2_000;

type Stage = "harness" | "wasm-init" | "tls-init" | "kps-dial" | "surb-reply" | "rpc-call" | "done";

const STAGE_TEXT: Record<Stage, string> = {
  harness: "harness: specifier read, bundle fetch and keccak check, sandbox iframe (before the worker's boot.start)",
  "wasm-init": "WASM init: nox-wasm (Sphinx) compile and instantiate",
  "tls-init": "TLS init: nox-tls WASM compile and instantiate",
  "kps-dial": "KPS dial (WebRTC: ICE, DTLS, SCTP, KPS HELLO) and topology",
  "surb-reply": "SURB reply: warmup echo through a full route",
  "rpc-call": "RPC call through worker.fetch",
  done: "all steps passed",
};

interface TimedLog extends LogLine {
  readonly atMs: number;
}

interface CallReport {
  readonly method: string;
  readonly result: FetchResult;
  readonly ok: boolean;
  readonly detail: string;
}

interface Report {
  browser: string;
  browserVersion: string;
  harness: string;
  specifier: string;
  specifierRpc: string;
  callRpc: string;
  userAgent?: string;
  boot?: BootResult;
  calls: CallReport[];
  stageReached: Stage;
  failedAt?: string;
  logs: TimedLog[];
  console: string[];
  pageErrors: string[];
  ok: boolean;
}

const [browserName] = process.argv.slice(2);
const engines = { chromium, webkit };
if (browserName !== "chromium" && browserName !== "webkit") {
  console.error("usage: tsx tools/live-boot/run.ts <chromium|webkit>");
  process.exit(2);
}
const harness = (process.env["LIVE_HARNESS"] ?? "0.4.0") as HarnessVersion;
if (!HARNESS_VERSIONS.includes(harness)) {
  console.error(`LIVE_HARNESS must be one of ${HARNESS_VERSIONS.join(", ")}`);
  process.exit(2);
}
const specifier = process.env["LIVE_SPECIFIER"] ?? STABLE_SPECIFIER;
const specifierRpc = process.env["LIVE_SPECIFIER_RPC"] ?? SEPOLIA_RPC;
const callRpc = process.env["LIVE_CALL_RPC"] ?? SEPOLIA_RPC;
const outDir = process.env["LIVE_OUT"] ?? join(E2E_ROOT, ".run", "live-boot");
mkdirSync(outDir, { recursive: true });

/** The worker logs `nox-worker <event> {fields}`; SDK and harness lines carry other tags. */
const eventOf = (line: LogLine): string | undefined => {
  const [source, event] = line.text.split(" ");
  return source === "nox-worker" ? event : undefined;
};
const has = (logs: readonly TimedLog[], event: string): boolean => logs.some((line) => eventOf(line) === event);

/** The furthest stage the worker's log proves, given that boot did or did not reach `ready`. */
function bootStage(logs: readonly TimedLog[]): Stage {
  if (!has(logs, "boot.start")) return "harness";
  if (!has(logs, "boot.wasm")) return "wasm-init";
  if (!has(logs, "boot.tls")) return "tls-init";
  return "kps-dial";
}

function rpcBody(method: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });
}

async function drain(page: Page, sink: TimedLog[], t0: number, waitMs: number): Promise<number> {
  const lines = await page.evaluate(
    ({ id, max, wait }) => window.e2e.logs(id, max, wait),
    { id: WORKER_ID, max: LOG_BATCH, wait: waitMs },
  );
  const atMs = Date.now() - t0;
  for (const line of lines) sink.push({ ...line, atMs });
  return lines.length;
}

const host = await startHostServer();
const browser = await engines[browserName].launch({ headless: true });
const context = await browser.newContext();
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
const report: Report = {
  browser: browserName,
  browserVersion: browser.version(),
  harness,
  specifier,
  specifierRpc,
  callRpc,
  calls: [],
  stageReached: "harness",
  logs: [],
  console: [],
  pageErrors: [],
  ok: false,
};
page.on("console", (message) => report.console.push(`${message.type()}: ${message.text().slice(0, 500)}`));
page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 500)));

try {
  await page.goto(host.pageUrl(harness));
  await page.waitForFunction(() => window.e2e !== undefined);
  report.userAgent = await page.evaluate(() => navigator.userAgent);

  const t0 = Date.now();
  // warmup: one echo through a full route, so the SURB reply path is its own step.
  const config = { logLevel: "debug", warmup: true };
  await page.evaluate((request) => window.e2e.boot(request), {
    id: WORKER_ID,
    address: specifier,
    specifierRpcUrl: specifierRpc,
    readyTimeoutMs: READY_TIMEOUT_MS,
    config,
    awaitReady: false,
  });
  let settled = false;
  const ready = page
    .evaluate(({ id, ms }) => window.e2e.ready(id, ms), { id: WORKER_ID, ms: READY_TIMEOUT_MS })
    .finally(() => {
      settled = true;
    });
  while (!settled) await drain(page, report.logs, t0, LOG_WAIT_MS);
  report.boot = await ready;
  while ((await drain(page, report.logs, t0, LOG_WAIT_MS)) > 0);

  if (!report.boot.ok) {
    report.stageReached = bootStage(report.logs);
    const error = report.boot.error;
    report.failedAt = `${STAGE_TEXT[report.stageReached]}: ${error?.name ?? "Error"}${error?.code === undefined ? "" : ` (${error.code})`}: ${error?.message ?? "no error"}`;
  } else {
    const warmup = report.logs.find((line) => eventOf(line) === "boot.warmup");
    if (warmup === undefined || !/"ok":true/u.test(warmup.text)) {
      report.stageReached = "surb-reply";
      report.failedAt = `${STAGE_TEXT["surb-reply"]}: ${warmup?.text ?? "no boot.warmup log line"}`;
    } else {
      report.stageReached = "rpc-call";
      for (const method of ["eth_chainId", "eth_blockNumber"]) {
        const result = await page.evaluate((request) => window.e2e.fetch(request), {
          id: WORKER_ID,
          url: callRpc,
          method: "POST",
          headers: [["content-type", "application/json"]] as const,
          body: rpcBody(method),
          timeoutMs: CALL_TIMEOUT_MS,
        });
        let parsed: { result?: unknown; error?: unknown } = {};
        try {
          parsed = JSON.parse(result.bodyText ?? "") as typeof parsed;
        } catch {
          parsed = {};
        }
        const ok = result.ok && result.status === 200 && typeof parsed.result === "string"
          && (method !== "eth_chainId" || parsed.result === SEPOLIA_CHAIN_ID);
        const detail = result.ok
          ? `HTTP ${String(result.status)} ${JSON.stringify(parsed.result ?? parsed.error ?? result.bodyText?.slice(0, 200))}`
          : `${result.error?.name ?? "Error"}${result.error?.code === undefined ? "" : ` (${result.error.code})`}: ${result.error?.message ?? ""}`;
        report.calls.push({ method, result: { ...result, bodyText: result.bodyText?.slice(0, 500) ?? "" }, ok, detail });
        if (!ok) {
          report.failedAt = `${STAGE_TEXT["rpc-call"]}: ${method}: ${detail}`;
          break;
        }
      }
      if (report.failedAt === undefined) report.stageReached = "done";
    }
  }
  await drain(page, report.logs, t0, LOG_TAIL_MS);
  report.ok = report.stageReached === "done";
} catch (error) {
  report.failedAt = `runner: ${error instanceof Error ? error.message : String(error)}`;
} finally {
  await context.tracing.stop({ path: join(outDir, `trace-${browserName}.zip`) }).catch(() => undefined);
  await browser.close();
  await host.close();
}

writeFileSync(join(outDir, `report-${browserName}.json`), `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  `### Live boot: ${browserName} ${report.browserVersion} (harness ${harness})`,
  "",
  `- specifier: ${specifier} via ${specifierRpc}`,
  `- result: ${report.ok ? "ok" : "FAILED"}; stage reached: ${STAGE_TEXT[report.stageReached]}`,
  ...(report.failedAt === undefined ? [] : [`- failed at: ${report.failedAt}`]),
  ...(report.boot === undefined ? [] : [`- ready settled after ${report.boot.readyMs} ms; sandbox ${report.boot.sandbox ?? "(no iframe)"}`]),
  ...report.calls.map((call) => `- ${call.method}: ${call.ok ? "ok" : "FAILED"} in ${call.result.ms} ms, ${call.detail}`),
  "",
  "Worker log (ms since boot, level, event):",
  "",
  "```",
  ...report.logs.map((line) => `+${line.atMs}ms ${line.level} ${line.text.slice(0, 400)}`),
  "```",
  ...(report.pageErrors.length === 0 ? [] : ["", "Page errors:", "", "```", ...report.pageErrors, "```"]),
];
console.log(lines.join("\n"));
process.exit(report.ok ? 0 : 1);
