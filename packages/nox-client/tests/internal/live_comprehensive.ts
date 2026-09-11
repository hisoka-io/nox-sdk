/**
 * Comprehensive Live Testnet E2E
 *
 * Tests against the real Hisoka 10-node mixnet on Arbitrum Sepolia.
 * Covers: echo, HTTP proxy (1KB to 100MB), public websites, Web3 RPC, signed TX broadcast.
 *
 * Run: npx tsx tests/internal/live_comprehensive.ts
 */

import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

import {
  NoxClient,
  encodeServiceRequest,
  type RelayerPayload,
} from "../../src/index.js";
const SEED = requiredEnv("SEED");
const ETH_RPC_URL = requiredEnv("ETH_RPC_URL");
const REGISTRY = requiredAddressEnv("REGISTRY_ADDRESS");
const POW = parseInt(process.env["POW"] || "3");
const TIMEOUT = 120_000;
const SURBS = 10;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredAddressEnv(name: string): string {
  const value = requiredEnv(name);
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) {
    throw new Error(`${name} must be a 20-byte Ethereum address`);
  }
  return value;
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

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
    const sizeStr = typeof size === "number" ? ` [${fmt(size)}]` : "";
    log(`  [PASS] ${name} (${ms}ms)${sizeStr}`);
    results.push({ name, pass: true, ms, size: typeof size === "number" ? size : undefined });
  } catch (caught: unknown) {
    const ms = Date.now() - t0;
    const message =
      caught instanceof Error ? caught.message : String(caught);
    log(`  [FAIL] ${name} (${ms}ms): ${message.slice(0, 120)}`);
    results.push({ name, pass: false, ms, error: message.slice(0, 120) });
  }
}

/** Send echo via AnonymousRequest (proper wrapping) */
async function echo(client: NoxClient, data: Uint8Array): Promise<Uint8Array> {
  const inner = encodeServiceRequest({ tag: "Echo", data });
  return client.send({ tag: "AnonymousRequest", inner, replySurbs: [] });
}

async function main() {
  log("Comprehensive Live Testnet E2E");
  log("==============================");
  log(`Seed: ${SEED}, PoW: ${POW}, Timeout: ${TIMEOUT / 1000}s`);

  const client = await NoxClient.connect({
    seeds: [SEED],
    powDifficulty: POW,
    timeoutMs: TIMEOUT,
    surbsPerRequest: SURBS,
    ethRpcUrl: ETH_RPC_URL,
    registryAddress: REGISTRY,
  });
  log("Connected to live mixnet.\n");

  // ======================================================================
  // Echo (byte-perfect verification)
  // ======================================================================
  log("=== Echo ===");

  await test("echo_32b", async () => {
    const data = new Uint8Array(32);
    crypto.getRandomValues(data);
    const resp = await echo(client, data);
    for (let i = 0; i < 32; i++) {
      if (resp[i] !== data[i]) throw new Error(`Mismatch at byte ${i}`);
    }
    return resp.length;
  });

  await test("echo_1kb", async () => {
    const data = new Uint8Array(1024);
    crypto.getRandomValues(data);
    const resp = await echo(client, data);
    for (let i = 0; i < 1024; i++) {
      if (resp[i] !== data[i]) throw new Error(`Mismatch at byte ${i}`);
    }
    return resp.length;
  });

  await test("echo_10kb", async () => {
    const data = new Uint8Array(10240);
    crypto.getRandomValues(data);
    const resp = await echo(client, data);
    if (resp.length !== 10240) throw new Error(`Expected 10240B, got ${resp.length}B`);
    return resp.length;
  });

  // ======================================================================
  // HTTP Downloads (through mixnet exit node proxy)
  // Run 100MB FIRST while the P2P mesh is clean — burst replenishment
  // from large downloads floods mix node queues and delays subsequent
  // requests for minutes (200ms mix delay × thousands of queued packets).
  // ======================================================================
  log("\n=== HTTP Downloads ===");

  // 100MB gated behind RUN_100MB=1 env (takes ~140s, floods mix queues)
  if (process.env["RUN_100MB"] === "1") {
    await test("http_100mb", async () => {
      const resp = await client.httpRequest(
        "GET", "https://proof.ovh.net/files/100Mb.dat", [], new Uint8Array(0),
        { timeoutMs: 600_000 },
      );
      if (resp.length < 90_000_000) throw new Error(`Too small: ${resp.length}B`);
      return resp.length;
    });
  } else {
    log("  [skip] http_100mb (set RUN_100MB=1 to enable)");
  }

  await test("http_1kb", async () => {
    const resp = await client.httpRequest(
      "GET", "https://httpbin.org/bytes/1024", [], new Uint8Array(0),
    );
    if (resp.length < 500) throw new Error(`Too small: ${resp.length}B`);
    return resp.length;
  });

  await test("http_1mb", async () => {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=1048576", [], new Uint8Array(0),
      { expectedResponseBytes: 1_200_000 },
    );
    if (resp.length < 500_000) throw new Error(`Too small: ${resp.length}B`);
    return resp.length;
  });

  await test("http_2mb", async () => {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=2097152", [], new Uint8Array(0),
      { timeoutMs: 60_000 },
    );
    if (resp.length < 1_500_000) throw new Error(`Too small: ${resp.length}B`);
    return resp.length;
  });

  await test("http_5mb", async () => {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=5242880", [], new Uint8Array(0),
      { timeoutMs: 120_000 },
    );
    if (resp.length < 4_000_000) throw new Error(`Too small: ${resp.length}B`);
    return resp.length;
  });

  await test("http_10mb", async () => {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=10485760", [], new Uint8Array(0),
      { timeoutMs: 120_000 },
    );
    if (resp.length < 8_000_000) throw new Error(`Too small: ${resp.length}B`);
    return resp.length;
  });

  // ======================================================================
  // Public Websites
  // ======================================================================
  log("\n=== Public Websites ===");

  await test("web_wikipedia", async () => {
    const resp = await client.httpRequest(
      "GET", "https://en.wikipedia.org/wiki/Tor_(network)", [], new Uint8Array(0),
    );
    if (resp.length < 10_000) throw new Error(`Too small: ${resp.length}B`);
    return resp.length;
  });

  await test("web_github_api", async () => {
    const resp = await client.httpRequest(
      "GET", "https://api.github.com", [["User-Agent", "nox-sdk-test"]], new Uint8Array(0),
    );
    if (resp.length < 100) throw new Error(`Too small: ${resp.length}B`);
    return resp.length;
  });

  await test("web_httpbin_ip", async () => {
    const resp = await client.httpRequest(
      "GET", "https://httpbin.org/ip", [], new Uint8Array(0),
    );
    if (resp.length < 10) throw new Error(`Too small: ${resp.length}B`);
    return resp.length;
  });

  // ======================================================================
  // Web3 RPC (Arbitrum Sepolia via exit node default provider)
  // ======================================================================
  log("\n=== Web3 RPC (Arbitrum Sepolia) ===");

  await test("rpc_chainId", async () => {
    const r = await client.rpcCall("eth_chainId", []);
    if (r !== "0x66eee") throw new Error(`Expected 0x66eee, got ${r}`);
  });

  await test("rpc_blockNumber", async () => {
    const r = await client.rpcCall("eth_blockNumber", []);
    if (typeof r !== "string" || !(r as string).startsWith("0x")) throw new Error(`Bad: ${r}`);
    const block = parseInt(r as string, 16);
    if (block < 250_000_000) throw new Error(`Block too low: ${block}`);
  });

  await test("rpc_gasPrice", async () => {
    const r = await client.rpcCall("eth_gasPrice", []);
    if (typeof r !== "string" || !(r as string).startsWith("0x")) throw new Error(`Bad: ${r}`);
  });

  await test("rpc_getBalance_deployer", async () => {
    const deployer = "0x8F4eB35a24bF75C2C86917d324Cac34EB2EFc534";
    const r = await client.rpcCall("eth_getBalance", [deployer, "latest"]);
    if (typeof r !== "string") throw new Error(`Bad: ${typeof r}`);
  });

  await test("rpc_getBlockByNumber", async () => {
    const r = await client.rpcCall("eth_getBlockByNumber", ["latest", false]);
    if (!r || typeof r !== "object") throw new Error(`Bad: ${typeof r}`);
  });

  await test("rpc_getCode_registry", async () => {
    const r = await client.rpcCall("eth_getCode", [REGISTRY, "latest"]);
    if (typeof r !== "string" || (r as string).length < 100) throw new Error("No code at Registry");
  });

  await test("rpc_getTransactionCount", async () => {
    const deployer = "0x8F4eB35a24bF75C2C86917d324Cac34EB2EFc534";
    const r = await client.rpcCall("eth_getTransactionCount", [deployer, "latest"]);
    if (typeof r !== "string") throw new Error(`Bad: ${typeof r}`);
  });

  await test("rpc_estimateGas_transfer", async () => {
    // Estimate gas for a simple ETH transfer (always works)
    const r = await client.rpcCall("eth_estimateGas", [{
      from: "0x8F4eB35a24bF75C2C86917d324Cac34EB2EFc534",
      to: "0x0000000000000000000000000000000000000001",
      value: "0x1",
    }]);
    if (typeof r !== "string") throw new Error(`Bad: ${typeof r}`);
    const gas = parseInt(r as string, 16);
    if (gas < 21000) throw new Error(`Gas too low: ${gas}`);
  });

  // ======================================================================
  // Web3 Write Operations (Signed TX broadcast via mixnet)
  // ======================================================================
  log("\n=== Web3 Write Operations ===");

  // We need ethers for signing transactions
  const ethers = await import("ethers");
  const FUNDED_KEY = process.env["FUNDED_KEY"];
  if (FUNDED_KEY === undefined || !/^[0-9a-f]{64}$/u.test(FUNDED_KEY)) {
    throw new Error("FUNDED_KEY must be a lowercase 32-byte hex private key");
  }
  const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
  const signer = new ethers.Wallet(FUNDED_KEY, provider);
  const signerAddr = signer.address;

  await test("web3_signed_self_transfer", async () => {
    // Sign a 0-value self-transfer and broadcast via mixnet
    const nonce = await provider.getTransactionCount(signerAddr);
    const feeData = await provider.getFeeData();
    const tx = await signer.signTransaction({
      to: signerAddr,
      value: 0n,
      nonce,
      chainId: 421614n,
      gasLimit: 21000n,
      maxFeePerGas: feeData.maxFeePerGas ?? 1000000000n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 100000000n,
      type: 2,
    });
    const signedBytes = ethers.getBytes(tx);
    const resp = await client.broadcastSignedTransaction(signedBytes);
    if (resp.length < 32) throw new Error(`Response too short: ${resp.length}B`);
    const txHash = "0x" + Array.from(resp.slice(0, 32)).map(b => b.toString(16).padStart(2, "0")).join("");
    log(`    tx hash: ${txHash}`);
    // Wait for receipt via direct RPC (faster than going through mixnet)
    const receipt = await provider.waitForTransaction(txHash, 1, 30_000);
    if (!receipt || receipt.status !== 1) throw new Error(`TX failed: status=${receipt?.status}`);
    log(`    confirmed in block ${receipt.blockNumber}`);
    return resp.length;
  });

  await test("web3_signed_registry_tx", async () => {
    // Call NoxRegistry.relayerCount() via a signed transaction (view function called as TX)
    const nonce = await provider.getTransactionCount(signerAddr);
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
    const signedBytes = ethers.getBytes(tx);
    const resp = await client.broadcastSignedTransaction(signedBytes);
    if (resp.length < 32) throw new Error(`Response too short: ${resp.length}B`);
    const txHash = "0x" + Array.from(resp.slice(0, 32)).map(b => b.toString(16).padStart(2, "0")).join("");
    log(`    tx hash: ${txHash}`);
    const receipt = await provider.waitForTransaction(txHash, 1, 30_000);
    if (!receipt || receipt.status !== 1) throw new Error(`TX failed: status=${receipt?.status}`);
    log(`    confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);
    return resp.length;
  });

  // ======================================================================
  // Web3 Contract Queries (NoxRewardPool, NoxRegistry via eth_call)
  // ======================================================================
  log("\n=== Web3 Contract Queries ===");

  await test("web3_registry_relayer_count", async () => {
    const r = await client.rpcCall("eth_call", [{
      to: REGISTRY,
      data: "0xcf1a7a21", // relayerCount()
    }, "latest"]);
    if (typeof r !== "string") throw new Error(`Bad: ${typeof r}`);
    const count = parseInt(r as string, 16);
    log(`    relayerCount: ${count}`);
    if (count < 10) throw new Error(`Expected >= 10 nodes, got ${count}`);
  });

  await test("web3_registry_fingerprint", async () => {
    const r = await client.rpcCall("eth_call", [{
      to: REGISTRY,
      data: "0x3cce4d3d", // topologyFingerprint()
    }, "latest"]);
    if (typeof r !== "string" || (r as string).length < 66) throw new Error(`Bad fingerprint: ${r}`);
    log(`    fingerprint: ${(r as string).slice(0, 18)}...`);
  });

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
