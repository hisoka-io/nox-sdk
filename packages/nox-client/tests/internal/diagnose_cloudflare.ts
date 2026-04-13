/**
 * Download size tests using Cloudflare speed test endpoint (no size cap).
 */
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") (globalThis as any).crypto = webcrypto;
import { NoxClient } from "../../src/index.js";

function fmt(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n/1024).toFixed(1)}KB`;
  return `${(n/1048576).toFixed(2)}MB`;
}

async function main() {
  const client = await NoxClient.connect({
    seeds: ["https://api.hisoka.io/seed"],
    powDifficulty: 3, timeoutMs: 60_000, surbsPerRequest: 5,
    dangerouslySkipFingerprintCheck: true,
  });
  (client as any)._debugPoll = true;
  console.log("Connected.\n");

  // First verify Cloudflare works directly
  console.log("Direct Cloudflare test (no mixnet):");
  for (const size of [1024, 102400, 1048576]) {
    const t0 = Date.now();
    const resp = await fetch(`https://speed.cloudflare.com/__down?bytes=${size}`);
    const data = await resp.arrayBuffer();
    console.log(`  ${fmt(size)}: got ${fmt(data.byteLength)} in ${Date.now()-t0}ms`);
  }

  console.log("\nVia mixnet:");
  const sizes = [
    [1024, "1KB"],
    [102400, "100KB"],
    [524288, "512KB"],
    [1048576, "1MB"],
    [2097152, "2MB"],
  ] as const;

  for (const [size, label] of sizes) {
    const t0 = Date.now();
    try {
      const resp = await client.httpRequest(
        "GET", `https://speed.cloudflare.com/__down?bytes=${size}`, [], new Uint8Array(0),
        { timeoutMs: 60_000, expectedResponseBytes: Math.ceil(size * 1.3) },
      );
      const ms = Date.now() - t0;
      const speed = (resp.length / 1024) / (ms / 1000);
      console.log(`  ${label}: PASS got ${fmt(resp.length)} in ${ms}ms (${speed.toFixed(0)} KB/s)`);
    } catch (e: any) {
      console.log(`  ${label}: FAIL (${Date.now()-t0}ms) ${e.message?.slice(0, 80)}`);
    }
  }

  client.disconnect();
}
main();
