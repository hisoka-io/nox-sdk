/**
 * Diagnose HTTP download failures on live testnet.
 * Dumps exact bytes, timings, and fragment progress for each download size.
 */
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") (globalThis as any).crypto = webcrypto;

import { NoxClient, encodeServiceRequest } from "../../src/index.js";

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

async function main() {
  const client = await NoxClient.connect({
    seeds: ["https://api.hisoka.io/seed"],
    powDifficulty: 3,
    timeoutMs: 120_000,
    surbsPerRequest: 10,
    dangerouslySkipFingerprintCheck: true,
  });
  (client as any)._debugPoll = true;
  log("Connected.\n");

  // Test 1: 100MB download — what does the 1067 bytes contain?
  log("=== Test: 100MB download (examining failure response) ===");
  try {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=104857600", [], new Uint8Array(0),
      { timeoutMs: 30_000, expectedResponseBytes: 110_000_000 },
    );
    log(`Got ${resp.length} bytes`);
    // Try to decode as text
    const text = new TextDecoder().decode(resp.slice(0, Math.min(resp.length, 500)));
    log(`Content (first 500 chars): ${text}`);
    // Show raw hex of first 50 bytes
    const hex = Array.from(resp.slice(0, 50)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    log(`Hex: ${hex}`);
  } catch (e: any) {
    log(`Failed: ${e.message?.slice(0, 150)}`);
  }

  // Test 2: 10MB — how far does it get before timing out?
  log("\n=== Test: 10MB download (tracking progress) ===");
  try {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=10485760", [], new Uint8Array(0),
      { timeoutMs: 60_000, expectedResponseBytes: 12_000_000 },
    );
    log(`Got ${resp.length} bytes (${(resp.length / 1024 / 1024).toFixed(2)} MB)`);
  } catch (e: any) {
    log(`Failed: ${e.message?.slice(0, 150)}`);
  }

  // Test 3: 5MB — find the size threshold
  log("\n=== Test: 5MB download ===");
  try {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=5242880", [], new Uint8Array(0),
      { timeoutMs: 60_000, expectedResponseBytes: 6_000_000 },
    );
    log(`Got ${resp.length} bytes (${(resp.length / 1024 / 1024).toFixed(2)} MB)`);
  } catch (e: any) {
    log(`Failed: ${e.message?.slice(0, 150)}`);
  }

  // Test 4: 2MB — should work
  log("\n=== Test: 2MB download ===");
  try {
    const resp = await client.httpRequest(
      "GET", "https://speed.cloudflare.com/__down?bytes=2097152", [], new Uint8Array(0),
      { timeoutMs: 60_000, expectedResponseBytes: 2_500_000 },
    );
    log(`Got ${resp.length} bytes (${(resp.length / 1024 / 1024).toFixed(2)} MB)`);
  } catch (e: any) {
    log(`Failed: ${e.message?.slice(0, 150)}`);
  }

  client.disconnect();
}
main().catch(e => { log(`Fatal: ${e}`); process.exit(1); });
