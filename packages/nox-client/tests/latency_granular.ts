import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined")
  (globalThis as unknown as { crypto: unknown }).crypto = webcrypto;

import { NoxClient } from "../src/index.js";
import { buildSphinxPacket } from "../src/utils.js";
import { SurbPool } from "../src/surb_pool.js";

async function main() {
  console.log("=== Granular Latency Breakdown ===\n");
  
  const client = await NoxClient.init({ timeoutMs: 60_000 });
  console.log("Connected.\n");
  
  await client.rpcCall("eth_chainId", []);
  console.log("Warmed up.\n");

  const wasm = (client as any).wasm;
  const config = (client as any).config;
  
  // Test individual operations
  const pool = new SurbPool();
  const returnPath = [
    { pubKeyHex: "aa".repeat(32), address: "127.0.0.1:15000" },
    { pubKeyHex: "bb".repeat(32), address: "127.0.0.1:15001" },
  ];
  
  // Time SURB generation (2 SURBs, PoW=0)
  let s = performance.now();
  pool.generate(wasm, returnPath, BigInt(1), 2);
  console.log(`  generate 2 SURBs (PoW=0): ${(performance.now()-s).toFixed(1)}ms`);
  
  // Time SURB generation (10 SURBs, PoW=0)
  s = performance.now();
  pool.generate(wasm, returnPath, BigInt(2), 10);
  console.log(`  generate 10 SURBs (PoW=0): ${(performance.now()-s).toFixed(1)}ms`);
  
  // Time Sphinx packet build at d=1
  const forwardPath = [
    { pubKeyHex: "cc".repeat(32), address: "127.0.0.1:15000" },
    { pubKeyHex: "dd".repeat(32), address: "127.0.0.1:15001" },
    { pubKeyHex: "ee".repeat(32), address: "127.0.0.1:15002" },
  ];
  const payload = new Uint8Array(256);
  
  s = performance.now();
  buildSphinxPacket(wasm, forwardPath, payload, 1);
  console.log(`  buildSphinxPacket (PoW d=1): ${(performance.now()-s).toFixed(1)}ms`);
  
  // Time at d=3
  s = performance.now();
  buildSphinxPacket(wasm, forwardPath, payload, 3);
  console.log(`  buildSphinxPacket (PoW d=3): ${(performance.now()-s).toFixed(1)}ms`);
  
  // Time at d=0
  s = performance.now();
  buildSphinxPacket(wasm, forwardPath, payload, 0);
  console.log(`  buildSphinxPacket (PoW d=0): ${(performance.now()-s).toFixed(1)}ms`);
  
  // Now time full rpcCall 3 times
  console.log("\n--- Full rpcCall timing ---");
  for (let i = 0; i < 3; i++) {
    s = performance.now();
    await client.rpcCall("eth_getBalance", ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]);
    console.log(`  rpcCall #${i+1}: ${(performance.now()-s).toFixed(0)}ms`);
  }
  
  client.disconnect();
}

main().catch(console.error);
