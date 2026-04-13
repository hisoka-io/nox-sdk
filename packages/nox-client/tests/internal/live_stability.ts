/**
 * Stability test: send 20 echoes rapidly to measure success rate and identify failing routes.
 */
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") (globalThis as any).crypto = webcrypto;
import { NoxClient, encodeServiceRequest } from "../../src/index.js";

async function main() {
  const client = await NoxClient.connect({
    seeds: ["https://api.hisoka.io/seed"],
    powDifficulty: 3,
    timeoutMs: 15_000,
    surbsPerRequest: 3,
    dangerouslySkipFingerprintCheck: true,
  });
  console.log("Connected. Sending 20 rapid echoes...\n");

  let pass = 0;
  let fail = 0;
  for (let i = 0; i < 20; i++) {
    const data = new Uint8Array([i]);
    const inner = encodeServiceRequest({ tag: "Echo", data });
    const t0 = Date.now();
    try {
      const resp = await client.send({ tag: "AnonymousRequest", inner, replySurbs: [] });
      const ms = Date.now() - t0;
      console.log(`  #${i}: PASS (${ms}ms) resp=${resp[0]}`);
      pass++;
    } catch (e: any) {
      const ms = Date.now() - t0;
      console.log(`  #${i}: FAIL (${ms}ms) ${e.message?.slice(0, 60)}`);
      fail++;
    }
  }

  console.log(`\nResults: ${pass}/20 passed (${(pass/20*100).toFixed(0)}% success rate)`);
  client.disconnect();
}
main();
