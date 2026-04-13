/**
 * Repeat 1MB download 10 times to measure reliability and speed.
 */
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") (globalThis as any).crypto = webcrypto;
import { NoxClient } from "../../src/index.js";

async function main() {
  const client = await NoxClient.connect({
    seeds: ["https://api.hisoka.io/seed"],
    powDifficulty: 3, timeoutMs: 30_000, surbsPerRequest: 5,
    dangerouslySkipFingerprintCheck: true,
  });
  console.log("Connected. Testing 1MB download x10:\n");

  let pass = 0;
  let totalMs = 0;
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    try {
      const resp = await client.httpRequest(
        "GET", "https://speed.cloudflare.com/__down?bytes=1048576", [], new Uint8Array(0),
        { expectedResponseBytes: 1_200_000 },
      );
      const ms = Date.now() - t0;
      const speed = (resp.length / 1024) / (ms / 1000);
      console.log(`#${i}: PASS ${(resp.length/1048576).toFixed(2)}MB in ${ms}ms (${speed.toFixed(0)} KB/s)`);
      pass++;
      totalMs += ms;
    } catch (e: any) {
      console.log(`#${i}: FAIL (${Date.now()-t0}ms) ${e.message?.slice(0, 60)}`);
    }
  }
  const avgMs = pass > 0 ? (totalMs / pass).toFixed(0) : "N/A";
  console.log(`\n${pass}/10 passed. Avg latency: ${avgMs}ms`);
  client.disconnect();
}
main();
