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
 * For exit node REVENUE (ZK gas payment proofs), use micro_mainnet_sim:
 *   cargo run --bin micro_mainnet_sim -p nox-sim --features dev-node
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

// Contracts (Arbitrum Sepolia)
const STAKING_TOKEN = "0x208be235AAB9b8b5d86285b2684c8e6743e662b5";
const REWARD_POOL = "0x1D336Fd873178a41333Ec7B50Be0fF52A5F69E1d";
const REGISTRY = "0x8626aF80db409BeD3C19871FAdf9b0Ce7Aa641Bc";
const ARB_SEPOLIA_RPC = "https://sepolia-rollup.arbitrum.io/rpc";
const FUNDED_KEY =
  "3e8a4387dce9ecce4d3dabf84e8d3883074a4756ae369906175e8ca40f52af68";

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
    dangerouslySkipFingerprintCheck: true,
  });
  log("Connected to mixnet.\n");

  const ethers = await import("ethers");
  const provider = new ethers.JsonRpcProvider(ARB_SEPOLIA_RPC);
  const signer = new ethers.Wallet(FUNDED_KEY, provider);

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
        signer.address,
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

      // ====================================================================
      // On-Chain Broadcasts via Mixnet (populates exitBroadcast)
      //
      // These are user-signed TXs broadcast through the mixnet for IP privacy.
      // The user pays gas directly. Exit nodes broadcast but don't earn revenue.
      //
      // For exit node REVENUE, use the full ZK gas_payment flow via
      // micro_mainnet_sim (Rust) which builds real ZK proofs:
      //   cargo run --bin micro_mainnet_sim -p nox-sim --features dev-node
      // ====================================================================
      log("\n=== On-Chain Broadcasts via Mixnet ===");

      const erc20Iface = new ethers.Interface([
        "function transfer(address,uint256) returns (bool)",
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ]);

      // Token transfer via mixnet (user pays gas, exit node broadcasts)
      await test("broadcast_token_transfer", async () => {
        const nonce = await provider.getTransactionCount(signer.address);
        const feeData2 = await provider.getFeeData();
        const calldata = erc20Iface.encodeFunctionData("transfer", [
          REGISTRY, // send to registry address (harmless, it's a contract)
          ethers.parseUnits("1", 18),
        ]);
        const tx = await signer.signTransaction({
          to: STAKING_TOKEN,
          data: calldata,
          value: 0n,
          nonce,
          chainId: 421614n,
          gasLimit: 100000n,
          maxFeePerGas: feeData2.maxFeePerGas ?? 1000000000n,
          maxPriorityFeePerGas: feeData2.maxPriorityFeePerGas ?? 100000000n,
          type: 2,
        });
        const resp = await client.broadcastSignedTransaction(ethers.getBytes(tx));
        if (resp.length < 32) throw new Error(`Response too short: ${resp.length}`);
        const txHash = "0x" + Array.from(resp.slice(0, 32)).map((b) => b.toString(16).padStart(2, "0")).join("");
        log(`    tx: ${txHash}`);
        const receipt = await provider.waitForTransaction(txHash, 1, 30_000);
        if (!receipt || receipt.status !== 1) throw new Error("TX failed");
        log(`    gas: ${receipt.gasUsed}, block: ${receipt.blockNumber}`);
        return resp.length;
      });

      // Token approval via mixnet
      await test("broadcast_token_approve", async () => {
        const nonce = await provider.getTransactionCount(signer.address);
        const feeData2 = await provider.getFeeData();
        const calldata = erc20Iface.encodeFunctionData("approve", [
          REWARD_POOL,
          ethers.MaxUint256,
        ]);
        const tx = await signer.signTransaction({
          to: STAKING_TOKEN,
          data: calldata,
          value: 0n,
          nonce,
          chainId: 421614n,
          gasLimit: 100000n,
          maxFeePerGas: feeData2.maxFeePerGas ?? 1000000000n,
          maxPriorityFeePerGas: feeData2.maxPriorityFeePerGas ?? 100000000n,
          type: 2,
        });
        const resp = await client.broadcastSignedTransaction(ethers.getBytes(tx));
        if (resp.length < 32) throw new Error(`Response too short: ${resp.length}`);
        const txHash = "0x" + Array.from(resp.slice(0, 32)).map((b) => b.toString(16).padStart(2, "0")).join("");
        log(`    tx: ${txHash}`);
        const receipt = await provider.waitForTransaction(txHash, 1, 30_000);
        if (!receipt || receipt.status !== 1) throw new Error("TX failed");
        log(`    gas: ${receipt.gasUsed}, block: ${receipt.blockNumber}`);
        return resp.length;
      });

      // ETH transfer via mixnet
      await test("broadcast_eth_transfer", async () => {
        const nonce = await provider.getTransactionCount(signer.address);
        const feeData2 = await provider.getFeeData();
        const tx = await signer.signTransaction({
          to: ethers.Wallet.createRandom().address,
          value: ethers.parseEther("0.0001"),
          nonce,
          chainId: 421614n,
          gasLimit: 21000n,
          maxFeePerGas: feeData2.maxFeePerGas ?? 1000000000n,
          maxPriorityFeePerGas: feeData2.maxPriorityFeePerGas ?? 100000000n,
          type: 2,
        });
        const resp = await client.broadcastSignedTransaction(ethers.getBytes(tx));
        if (resp.length < 32) throw new Error(`Response too short: ${resp.length}`);
        const txHash = "0x" + Array.from(resp.slice(0, 32)).map((b) => b.toString(16).padStart(2, "0")).join("");
        log(`    tx: ${txHash}`);
        const receipt = await provider.waitForTransaction(txHash, 1, 30_000);
        if (!receipt || receipt.status !== 1) throw new Error("TX failed");
        log(`    gas: ${receipt.gasUsed}, block: ${receipt.blockNumber}`);
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

  // ======================================================================
  // Dashboard Metrics Check
  // ======================================================================
  if (!SKIP_WEB3_WRITES) {
    log("\n=== EXIT NODE DASHBOARD METRICS ===");
    for (const [name, ip] of [
      ["nox-6", "98.92.70.228"],
      ["nox-7", "3.226.251.110"],
      ["nox-10", "13.223.188.90"],
    ] as const) {
      try {
        const m = await (
          await fetch(`http://${ip}:15001/metrics/json`)
        ).json();
        if (
          m.exitEthereum > 0 ||
          m.exitHttp > 0 ||
          m.exitRpc > 0 ||
          m.exitEcho > 0
        ) {
          log(`${name}:`);
          log(
            `  exit: echo=${m.exitEcho} http=${m.exitHttp} rpc=${m.exitRpc} broadcast=${m.exitBroadcast} ethereum=${m.exitEthereum}`,
          );
          log(
            `  econ: revenue=$${m.cumulativeRevenueUsd?.toFixed(2)} cost=$${m.cumulativeCostUsd?.toFixed(4)} P&L=$${(m.cumulativeRevenueUsd - m.cumulativeCostUsd)?.toFixed(2)}`,
          );
          log(
            `  prof: profitable=${m.profitableCount} unprofitable=${m.unprofitableCount} submitted=${m.ethTransactionsSubmitted}`,
          );
        }
      } catch {
        /* skip unreachable */
      }
    }
  }

  log("========================================");
  client.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
