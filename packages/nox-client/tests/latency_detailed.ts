import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined")
  (globalThis as unknown as { crypto: unknown }).crypto = webcrypto;

import { NoxClient } from "../src/index.js";

async function main() {
  console.log("=== Detailed Latency Breakdown ===\n");
  
  // Monkey-patch to add timing
  const origSend = (NoxClient.prototype as any)._sendWithSurbCount;
  (NoxClient.prototype as any)._sendWithSurbCount = async function(payload: Uint8Array, surbCount: number) {
    const t0 = performance.now();
    
    // Route selection
    const { selectRoute } = await import("../src/topology.js");
    const route = selectRoute(this.nodes);
    const t1 = performance.now();
    console.log(`  [timing] route selection: ${(t1-t0).toFixed(0)}ms`);
    
    // Call original
    const result = await origSend.call(this, payload, surbCount);
    const t2 = performance.now();
    console.log(`  [timing] total _sendWithSurbCount: ${(t2-t0).toFixed(0)}ms`);
    
    return result;
  };

  const client = await NoxClient.init({ timeoutMs: 60_000 });
  console.log("Connected.\n");
  
  // Warmup
  console.log("Warmup:");
  await client.rpcCall("eth_chainId", []);
  
  console.log("\nMeasured call:");
  const start = performance.now();
  await client.rpcCall("eth_getBalance", ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]);
  console.log(`  TOTAL: ${(performance.now() - start).toFixed(0)}ms\n`);
  
  // Echo
  console.log("Echo:");
  const echoStart = performance.now();
  await client.sendEcho(new Uint8Array(32));
  console.log(`  TOTAL: ${(performance.now() - echoStart).toFixed(0)}ms`);
  
  client.disconnect();
}

main().catch(console.error);
