import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") (globalThis as any).crypto = webcrypto;
import { NoxClient, encodeServiceRequest } from "../../src/index.js";

async function main() {
  const seed = process.env["SEED"] || "http://127.0.0.1:14001";
  const pow = parseInt(process.env["POW"] || "0");
  console.log(`Seed: ${seed}, PoW: ${pow}`);

  const client = await NoxClient.connect({
    seeds: [seed], powDifficulty: pow, timeoutMs: 30_000, surbsPerRequest: 3,
    dangerouslySkipFingerprintCheck: true,
  });
  console.log("Connected");

  const data = new Uint8Array([42, 43, 44]);
  const inner = encodeServiceRequest({ tag: "Echo", data });
  const start = Date.now();
  try {
    const resp = await client.send({
      tag: "AnonymousRequest",
      inner,
      replySurbs: [],
    });
    console.log(`ECHO SUCCESS in ${Date.now() - start}ms: [${resp.slice(0, 3)}]`);
  } catch(e: any) {
    console.log(`ECHO FAIL in ${Date.now() - start}ms:`, e.message?.slice(0, 100));
  }
  client.disconnect();
}
main();
