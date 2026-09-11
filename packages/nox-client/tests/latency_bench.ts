import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined")
  (globalThis as unknown as { crypto: unknown }).crypto = webcrypto;

import { NoxClient } from "../src/index.js";

async function measure(label: string, fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  const elapsed = performance.now() - start;
  console.log(`  ${label}: ${elapsed.toFixed(0)}ms`);
  return elapsed;
}

async function main() {
  console.log("=== NOX Latency Benchmark (post-optimization) ===\n");
  
  let client: NoxClient;
  const connectTime = await measure("NoxClient.init()", async () => {
    client = await NoxClient.init({ timeoutMs: 60_000 });
  });
  
  console.log("\n--- RPC Calls ---");
  await measure("warmup: eth_chainId", () => client!.rpcCall("eth_chainId", []));
  
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = await measure(`eth_getBalance #${i+1}`, () => 
      client!.rpcCall("eth_getBalance", ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"])
    );
    times.push(t);
  }
  
  console.log("\n--- Other ops ---");
  await measure("echo 32 bytes", () => client!.sendEcho(new Uint8Array(32)));
  await measure("eth_blockNumber", () => client!.rpcCall("eth_blockNumber", []));
  
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`\n=== RESULTS ===`);
  console.log(`  Connect: ${connectTime.toFixed(0)}ms`);
  console.log(`  eth_getBalance avg: ${avg.toFixed(0)}ms`);
  console.log(`  min: ${Math.min(...times).toFixed(0)}ms, max: ${Math.max(...times).toFixed(0)}ms`);
  
  client!.disconnect();
}

main().catch(console.error);
