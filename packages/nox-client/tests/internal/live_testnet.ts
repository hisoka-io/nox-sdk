/**
 * Live Testnet E2E — tests against the real Hisoka testnet on Arbitrum Sepolia.
 *
 * NOT run in CI. Run manually:
 *   npx tsx tests/internal/live_testnet.ts
 *
 * Tests: connectivity, echo, HTTP downloads (1KB to 100MB), web3 RPC calls.
 */

// Node.js 18 crypto polyfill
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") {
  (globalThis as any).crypto = webcrypto;
}

import { NoxClient, encodeServiceRequest } from "../../src/index.js";

const SEED_URL = "https://api.hisoka.io/seed";
const TIMEOUT_MS = 60_000;
const SURBS = 10;

// Known working entry nodes (have ingress server on port 15002)
const KNOWN_ENTRY_URLS = [
  "http://3.236.170.102:15002",  // nox-1
  "http://18.214.97.24:15002",   // nox-2
];

// Arbitrum Sepolia RPC (public, used by exit nodes)
const ARB_CHAIN_ID = "0x66eee"; // 421614

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  size?: number;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    results.push({ name, passed: true, durationMs: ms });
    log(`  PASS ${name} (${ms}ms)`);
  } catch (err: any) {
    const ms = Date.now() - start;
    results.push({
      name,
      passed: false,
      durationMs: ms,
      error: err.message?.slice(0, 120),
    });
    log(`  FAIL ${name} (${ms}ms): ${err.message?.slice(0, 120)}`);
  }
}

async function main() {
  log("Live Testnet E2E");
  log("================");
  log(`Seed: ${SEED_URL}`);

  // Connect with retry (SDK picks random entry, retry until it picks a reachable one)
  log("Connecting to live mixnet...");
  let client: NoxClient | null = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const c = await NoxClient.connect({
        seeds: [SEED_URL],
        powDifficulty: 3, // must match node min_pow_difficulty
        timeoutMs: TIMEOUT_MS,
        surbsPerRequest: SURBS,
        dangerouslySkipFingerprintCheck: true,
      });
      // Quick echo to verify the full path works end to end
      const probe = new Uint8Array([0x42]);
      const inner = encodeServiceRequest({ tag: "Echo", data: probe });
      const resp = await c.send({ tag: "AnonymousRequest", inner, replySurbs: [] });
      if (resp[0] !== 0x42) throw new Error("Echo mismatch");
      client = c;
      log(`Connected on attempt ${attempt + 1}.`);
      break;
    } catch (err: any) {
      log(`  attempt ${attempt + 1}: ${err.message?.slice(0, 100)}`);
    }
  }
  if (!client) {
    log("FATAL: Could not connect after 15 attempts");
    process.exit(1);
  }

  // ======================================================================
  // Category 1: Echo
  // ======================================================================
  log("\n=== Echo Tests ===");

  await runTest("echo_32b", async () => {
    const data = new Uint8Array(32);
    crypto.getRandomValues(data);
    const inner = encodeServiceRequest({ tag: "Echo", data });
    const resp = await client.send({ tag: "AnonymousRequest", inner, replySurbs: [] });
    if (resp.length !== 32) throw new Error(`Expected 32B, got ${resp.length}B`);
    for (let i = 0; i < 32; i++) {
      if (resp[i] !== data[i]) throw new Error(`Byte mismatch at ${i}`);
    }
  });

  await runTest("echo_1kb", async () => {
    const data = new Uint8Array(1024);
    crypto.getRandomValues(data);
    const inner = encodeServiceRequest({ tag: "Echo", data });
    const resp = await client.send({ tag: "AnonymousRequest", inner, replySurbs: [] });
    if (resp.length !== 1024) throw new Error(`Expected 1024B, got ${resp.length}B`);
    for (let i = 0; i < 1024; i++) {
      if (resp[i] !== data[i]) throw new Error(`Byte mismatch at ${i}`);
    }
  });

  // ======================================================================
  // Category 2: HTTP Downloads
  // ======================================================================
  log("\n=== HTTP Download Tests ===");

  await runTest("http_1kb", async () => {
    const resp = await client.httpRequest(
      "GET", "https://httpbin.org/bytes/1024", {}, new Uint8Array(0),
    );
    if (resp.length < 500) throw new Error(`Too small: ${resp.length}B`);
    results[results.length - 1]!.size = resp.length;
  });

  await runTest("http_1mb", async () => {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=1048576", {}, new Uint8Array(0),
    );
    if (resp.length < 500_000) throw new Error(`Too small: ${resp.length}B`);
    results[results.length - 1]!.size = resp.length;
  });

  await runTest("http_10mb", async () => {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=10485760", {}, new Uint8Array(0),
    );
    if (resp.length < 5_000_000) throw new Error(`Too small: ${resp.length}B`);
    results[results.length - 1]!.size = resp.length;
  });

  await runTest("http_100mb", async () => {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=104857600", {}, new Uint8Array(0),
    );
    if (resp.length < 50_000_000) throw new Error(`Too small: ${resp.length}B`);
    results[results.length - 1]!.size = resp.length;
  });

  // ======================================================================
  // Category 3: Public Websites
  // ======================================================================
  log("\n=== Public Website Tests ===");

  await runTest("web_wikipedia", async () => {
    const resp = await client.httpRequest(
      "GET", "https://en.wikipedia.org/wiki/Tor_(network)", {}, new Uint8Array(0),
    );
    if (resp.length < 10_000) throw new Error(`Too small: ${resp.length}B`);
    results[results.length - 1]!.size = resp.length;
  });

  await runTest("web_github_api", async () => {
    const resp = await client.httpRequest(
      "GET", "https://api.github.com", { "User-Agent": "nox-sdk-test" }, new Uint8Array(0),
    );
    if (resp.length < 100) throw new Error(`Too small: ${resp.length}B`);
    results[results.length - 1]!.size = resp.length;
  });

  // ======================================================================
  // Category 4: Web3 RPC (Arbitrum Sepolia via exit node)
  // ======================================================================
  log("\n=== Web3 RPC Tests (Arbitrum Sepolia) ===");

  await runTest("rpc_chainId", async () => {
    const result = await client.rpcCall("eth_chainId", []);
    if (result !== ARB_CHAIN_ID) throw new Error(`Expected ${ARB_CHAIN_ID}, got ${result}`);
  });

  await runTest("rpc_blockNumber", async () => {
    const result = await client.rpcCall("eth_blockNumber", []);
    if (typeof result !== "string" || !result.startsWith("0x"))
      throw new Error(`Bad block number: ${result}`);
    const block = parseInt(result as string, 16);
    if (block < 250_000_000) throw new Error(`Block too low: ${block}`);
  });

  await runTest("rpc_gasPrice", async () => {
    const result = await client.rpcCall("eth_gasPrice", []);
    if (typeof result !== "string" || !result.startsWith("0x"))
      throw new Error(`Bad gas price: ${result}`);
  });

  await runTest("rpc_getBalance", async () => {
    // Check deployer balance (should have ETH)
    const deployer = "0x8F4eB35a24bF75C2C86917d324Cac34EB2EFc534";
    const result = await client.rpcCall("eth_getBalance", [deployer, "latest"]);
    if (typeof result !== "string" || !result.startsWith("0x"))
      throw new Error(`Bad balance: ${result}`);
  });

  await runTest("rpc_getBlockByNumber", async () => {
    const result = await client.rpcCall("eth_getBlockByNumber", ["latest", false]);
    if (!result || typeof result !== "object") throw new Error(`Bad block: ${typeof result}`);
  });

  await runTest("rpc_getCode_darkpool", async () => {
    // DarkPool contract on Arb Sepolia
    const darkpool = "0x7A3B2A44559A4b66cCA2E207cd8aDE5b23BE6b7B";
    const result = await client.rpcCall("eth_getCode", [darkpool, "latest"]);
    if (typeof result !== "string" || (result as string).length < 100)
      throw new Error(`No code at DarkPool address`);
  });

  // ======================================================================
  // Summary
  // ======================================================================
  log("\n========================================");
  log("RESULTS SUMMARY");
  log("========================================\n");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const r of results) {
    const sizeStr = r.size ? ` [${formatSize(r.size)}]` : "";
    if (r.passed) {
      log(`  PASS ${r.name} (${r.durationMs}ms)${sizeStr}`);
    } else {
      log(`  FAIL ${r.name} (${r.durationMs}ms) — ${r.error}`);
    }
  }

  log(`\n  TOTAL: ${passed} passed, ${failed} failed, ${results.length} tests`);
  log("========================================");

  client.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
