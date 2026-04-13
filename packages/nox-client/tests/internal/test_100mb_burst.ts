/**
 * 100MB burst replenishment test.
 *
 * Usage: npx tsx tests/test_100mb_burst.ts
 * Set DEBUG_POLL=1 for verbose SURB replenishment logs.
 */

import * as fs from "node:fs";
import { NoxClient } from "../../src/index.js";

const MESH_INFO_PATH = process.env["MESH_INFO_PATH"] ?? "/tmp/nox_mesh/mesh_info.json";

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

async function main(): Promise<void> {
  const meshInfo = JSON.parse(fs.readFileSync(MESH_INFO_PATH, "utf-8"));
  const seedUrl = `http://127.0.0.1:${meshInfo.nodes[0].metrics_port}`;
  log(`Seed: ${seedUrl}`);

  const client = await NoxClient.connect({
    seeds: [seedUrl],
    timeoutMs: 600_000,
    powDifficulty: 0,
    surbsPerRequest: 40,
    dangerouslySkipFingerprintCheck: true,
  });
  client._debugPoll = true;

  log("Starting 100MB download via mixnet (burst replenishment)...");
  const start = Date.now();
  try {
    const response = await client.httpRequest(
      "GET",
      "https://proof.ovh.net/files/100Mb.dat",
      [],
      new Uint8Array(0),
      { timeoutMs: 600_000 },
    );
    const elapsed = Date.now() - start;
    const mb = response.length / (1024 * 1024);
    log(`SUCCESS: ${mb.toFixed(2)} MB in ${elapsed}ms (${(elapsed / 1000).toFixed(1)}s)`);
    log(`Throughput: ${(mb / (elapsed / 1000)).toFixed(2)} MB/s`);
  } catch (err) {
    const elapsed = Date.now() - start;
    log(`FAIL: ${String(err)} (after ${(elapsed / 1000).toFixed(1)}s)`);
  }

  client.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
