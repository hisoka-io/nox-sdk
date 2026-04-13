/**
 * Find exact size threshold where downloads start failing.
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
  console.log("Connected.\n");

  const sizes = [
    500_000,     // 500KB
    1_000_000,   // 1MB
    1_048_576,   // 1MB exact
    1_100_000,   // 1.1MB
    1_500_000,   // 1.5MB
    2_000_000,   // 2MB
  ];

  for (const size of sizes) {
    const label = size >= 1_000_000 ? `${(size/1_000_000).toFixed(1)}MB` : `${(size/1_000).toFixed(0)}KB`;
    const t0 = Date.now();
    try {
      const resp = await client.httpRequest(
        "GET", `https://httpbin.org/bytes/${size}`, [], new Uint8Array(0),
        { timeoutMs: 30_000, expectedResponseBytes: size * 1.3 },
      );
      console.log(`${label}: PASS (${Date.now()-t0}ms) got ${resp.length} bytes`);
    } catch (e: any) {
      console.log(`${label}: FAIL (${Date.now()-t0}ms) ${e.message?.slice(0, 80)}`);
    }
  }

  client.disconnect();
}
main();
