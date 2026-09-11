/**
 * NOX Mixnet Traffic Generator
 *
 * Generates all types of traffic to populate the dashboard:
 * - Echo requests (3 sizes)
 * - HTTP downloads (3 sizes)
 * - Website pings (3 sites)
 * - Web3 RPC reads (5 methods)
 * - Web3 signed TX broadcasts (2 self-transfer + registry call)
 * - On-chain broadcasts via mixnet (3 token transfer + approve + ETH transfer)
 *
 * For exit node paid-execution revenue, use the funded paid-mesh runner.
 *
 * Usage:
 *   SEED="https://api.hisoka.io/seed" npx tsx tests/internal/traffic_generator.ts
 *   SEED="https://api.hisoka.io/seed" ROUNDS=3 npx tsx tests/internal/traffic_generator.ts
 *   SEED="https://api.hisoka.io/seed" SKIP_WEB3_WRITES=1 npx tsx tests/internal/traffic_generator.ts
 */

import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined")
  (globalThis as unknown as { crypto: unknown }).crypto = webcrypto;

import { NoxClient, encodeServiceRequest } from "../../src/index.js";

// ============================================================================
// Configuration
// ============================================================================

const SEED = process.env["SEED"] || "https://api.hisoka.io/seed";
const POW = parseInt(process.env["POW"] || "3");
const ROUNDS = parseInt(process.env["ROUNDS"] || "1");
const SKIP_WEB3_WRITES = process.env["SKIP_WEB3_WRITES"] === "1";
const TIMEOUT = 60_000;
const SURBS = 10;

const ETH_RPC_URL = requiredEnv("ETH_RPC_URL");
const REGISTRY = requiredAddressEnv("REGISTRY_ADDRESS");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredAddressEnv(name: string): string {
  const value = requiredEnv(name);
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error(`${name} must be a 20-byte Ethereum address`);
  }
  return value;
}

function requiredPrivateKey(): string {
  const value = requiredEnv("FUNDED_KEY");
  if (!/^[0-9a-f]{64}$/u.test(value) || /^0+$/u.test(value)) {
    throw new Error("FUNDED_KEY must be a nonzero lowercase 32-byte hex private key");
  }
  return value;
}

// ============================================================================
// Helpers
// ============================================================================

const log = (msg: string) =>
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);

const fmt = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

interface Result {
  name: string;
  pass: boolean;
  ms: number;
  size?: number;
  error?: string;
}

const results: Result[] = [];

async function test(name: string, fn: () => Promise<number | void>) {
  log(`  [test] ${name} ...`);
  const t0 = Date.now();
  try {
    const size = await fn();
    const ms = Date.now() - t0;
    const s = typeof size === "number" ? ` [${fmt(size)}]` : "";
    log(`  [PASS] ${name} (${ms}ms)${s}`);
    results.push({
      name,
      pass: true,
      ms,
      size: typeof size === "number" ? size : undefined,
    });
  } catch (e: unknown) {
    const ms = Date.now() - t0;
    const msg =
      e instanceof Error ? e.message?.slice(0, 150) : String(e).slice(0, 150);
    log(`  [FAIL] ${name} (${ms}ms): ${msg}`);
    results.push({ name, pass: false, ms, error: msg });
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  log("NOX Mixnet Traffic Generator");
  log("============================");
  log(`Seed: ${SEED}, PoW: ${POW}, Rounds: ${ROUNDS}`);
  log(`Skip Web3 Writes: ${SKIP_WEB3_WRITES}`);

  const client = await NoxClient.connect({
    seeds: [SEED],
    powDifficulty: POW,
    timeoutMs: TIMEOUT,
    surbsPerRequest: SURBS,
    ethRpcUrl: ETH_RPC_URL,
    registryAddress: REGISTRY,
  });
  log("Connected to mixnet.\n");

  const ethers = await import("ethers");
  const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
  const signer = SKIP_WEB3_WRITES
    ? null
    : new ethers.Wallet(requiredPrivateKey(), provider);

  for (let round = 1; round <= ROUNDS; round++) {
    if (ROUNDS > 1) log(`\n========== ROUND ${round}/${ROUNDS} ==========`);

    // ======================================================================
    // Echo (populates exitEcho)
    // ======================================================================
    log("\n=== Echo ===");

    await test("echo_32b", async () => {
      const data = new Uint8Array(32);
      crypto.getRandomValues(data);
      const inner = encodeServiceRequest({ tag: "Echo", data });
      const resp = await client.send({
        tag: "AnonymousRequest",
        inner,
        replySurbs: [],
      });
      if (resp.length !== 32) throw new Error(`Expected 32, got ${resp.length}`);
      return resp.length;
    });

    await test("echo_1kb", async () => {
      const data = new Uint8Array(1024);
      crypto.getRandomValues(data);
      const inner = encodeServiceRequest({ tag: "Echo", data });
      const resp = await client.send({
        tag: "AnonymousRequest",
        inner,
        replySurbs: [],
      });
      if (resp.length !== 1024)
        throw new Error(`Expected 1024, got ${resp.length}`);
      return resp.length;
    });

    await test("echo_10kb", async () => {
      const data = new Uint8Array(10240);
      crypto.getRandomValues(data);
      const inner = encodeServiceRequest({ tag: "Echo", data });
      const resp = await client.send({
        tag: "AnonymousRequest",
        inner,
        replySurbs: [],
      });
      if (resp.length !== 10240)
        throw new Error(`Expected 10240, got ${resp.length}`);
      return resp.length;
    });

    // ======================================================================
    // HTTP Downloads (populates exitHttp)
    // ======================================================================
    log("\n=== HTTP Downloads ===");

    await test("http_1kb", async () => {
      const resp = await client.httpRequest(
        "GET",
        "https://httpbin.org/bytes/1024",
        [],
        new Uint8Array(0),
      );
      if (resp.length < 500) throw new Error(`Too small: ${resp.length}`);
      return resp.length;
    });

    await test("http_1mb", async () => {
      const resp = await client.httpRequest(
        "GET",
        "https://speed.cloudflare.com/__down?bytes=1048576",
        [],
        new Uint8Array(0),
        { expectedResponseBytes: 1_200_000 },
      );
      if (resp.length < 500_000) throw new Error(`Too small: ${resp.length}`);
      return resp.length;
    });

    await test("http_10mb", async () => {
      const resp = await client.httpRequest(
        "GET",
        "https://speed.cloudflare.com/__down?bytes=10485760",
        [],
        new Uint8Array(0),
        { timeoutMs: 120_000 },
      );
      if (resp.length < 8_000_000)
        throw new Error(`Too small: ${resp.length}`);
      return resp.length;
    });

    // ======================================================================
    // Public Websites (populates exitHttp)
    // ======================================================================
    log("\n=== Websites ===");

    await test("web_wikipedia", async () => {
      const resp = await client.httpRequest(
        "GET",
        "https://en.wikipedia.org/wiki/Tor_(network)",
        [],
        new Uint8Array(0),
      );
      if (resp.length < 10_000) throw new Error(`Too small: ${resp.length}`);
      return resp.length;
    });

    await test("web_github_api", async () => {
      const resp = await client.httpRequest(
        "GET",
        "https://api.github.com",
        [["User-Agent", "nox-traffic-gen"]],
        new Uint8Array(0),
      );
      if (resp.length < 100) throw new Error(`Too small: ${resp.length}`);
      return resp.length;
    });

    await test("web_httpbin_ip", async () => {
      const resp = await client.httpRequest(
        "GET",
        "https://httpbin.org/ip",
        [],
        new Uint8Array(0),
      );
      if (resp.length < 10) throw new Error(`Too small: ${resp.length}`);
      return resp.length;
    });

    // ======================================================================
    // Web3 RPC Reads (populates exitRpc)
    // ======================================================================
    log("\n=== Web3 RPC ===");

    await test("rpc_chainId", async () => {
      const r = await client.rpcCall("eth_chainId", []);
      if (r !== "0x66eee") throw new Error(`Expected 0x66eee, got ${r}`);
    });

    await test("rpc_blockNumber", async () => {
      const r = await client.rpcCall("eth_blockNumber", []);
      if (typeof r !== "string") throw new Error(`Bad: ${typeof r}`);
    });

    await test("rpc_gasPrice", async () => {
      const r = await client.rpcCall("eth_gasPrice", []);
      if (typeof r !== "string") throw new Error(`Bad: ${typeof r}`);
    });

    await test("rpc_getBalance", async () => {
      const r = await client.rpcCall("eth_getBalance", [
        REGISTRY,
        "latest",
      ]);
      if (typeof r !== "string") throw new Error(`Bad: ${typeof r}`);
    });

    await test("rpc_registry_nodeCount", async () => {
      const r = await client.rpcCall("eth_call", [
        { to: REGISTRY, data: "0xcf1a7a21" },
        "latest",
      ]);
      const count = parseInt(r as string, 16);
      log(`    relayerCount: ${count}`);
      if (count < 10) throw new Error(`Expected >= 10, got ${count}`);
    });

    // ======================================================================
    // Web3 Signed TX Broadcasts (populates exitBroadcast)
    // ======================================================================
    if (!SKIP_WEB3_WRITES) {
      if (signer === null) throw new Error("FUNDED_KEY is required for write traffic");
      log("\n=== Signed TX Broadcasts ===");

      await test("signed_self_transfer", async () => {
        const nonce = await provider.getTransactionCount(signer.address);
        const feeData = await provider.getFeeData();
        const tx = await signer.signTransaction({
          to: signer.address,
          value: 0n,
          nonce,
          chainId: 421614n,
          gasLimit: 21000n,
          maxFeePerGas: feeData.maxFeePerGas ?? 1000000000n,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 100000000n,
          type: 2,
        });
        const resp = await client.broadcastSignedTransaction(
          ethers.getBytes(tx),
        );
        if (resp.length < 32)
          throw new Error(`Response too short: ${resp.length}`);
        const txHash =
          "0x" +
          Array.from(resp.slice(0, 32))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        log(`    tx: ${txHash}`);
        const receipt = await provider.waitForTransaction(txHash, 1, 30_000);
        if (!receipt || receipt.status !== 1) throw new Error("TX failed");
        return resp.length;
      });

      await test("signed_registry_call", async () => {
        const nonce = await provider.getTransactionCount(signer.address);
        const feeData = await provider.getFeeData();
        const tx = await signer.signTransaction({
          to: REGISTRY,
          data: "0xcf1a7a21", // relayerCount()
          value: 0n,
          nonce,
          chainId: 421614n,
          gasLimit: 100000n,
          maxFeePerGas: feeData.maxFeePerGas ?? 1000000000n,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 100000000n,
          type: 2,
        });
        const resp = await client.broadcastSignedTransaction(
          ethers.getBytes(tx),
        );
        if (resp.length < 32)
          throw new Error(`Response too short: ${resp.length}`);
        const txHash =
          "0x" +
          Array.from(resp.slice(0, 32))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        log(`    tx: ${txHash}`);
        const receipt = await provider.waitForTransaction(txHash, 1, 30_000);
        if (!receipt || receipt.status !== 1) throw new Error("TX failed");
        return resp.length;
      });

    }
  }

  // ======================================================================
  // Summary
  // ======================================================================
  log("\n========================================");
  log("RESULTS SUMMARY");
  log("========================================\n");

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;

  for (const r of results) {
    const s = r.size ? ` [${fmt(r.size)}]` : "";
    if (r.pass) {
      log(`  PASS ${r.name} (${r.ms}ms)${s}`);
    } else {
      log(`  FAIL ${r.name} (${r.ms}ms): ${r.error}`);
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
