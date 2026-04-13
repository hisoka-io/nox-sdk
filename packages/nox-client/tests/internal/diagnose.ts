/**
 * Diagnostic: traces EXACTLY what happens at each step.
 * Outputs detailed logs to understand why 45% of requests timeout.
 */
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") (globalThis as any).crypto = webcrypto;

import {
  NoxClient,
  encodeServiceRequest,
  fetchTopology,
  parseNodes,
  selectRoute,
} from "../../src/index.js";

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

async function main() {
  log("=== DIAGNOSTIC START ===");

  // 1. Fetch topology and show all nodes
  log("Fetching topology...");
  const snap = await fetchTopology("https://api.hisoka.io/seed");
  const nodes = parseNodes(snap);
  log(`Topology: ${nodes.length} nodes`);
  for (const n of nodes) {
    log(`  ${n.id.slice(0, 10)} layer=${n.layer} role=${n.role} addr=${n.address.slice(0, 35)} routing=${n.routingAddress.slice(0, 40)}`);
  }

  // 2. Connect
  log("\nConnecting...");
  const client = await NoxClient.connect({
    seeds: ["https://api.hisoka.io/seed"],
    powDifficulty: 3,
    timeoutMs: 15_000,
    surbsPerRequest: 3,
    dangerouslySkipFingerprintCheck: true,
  });
  log("Connected.");

  // 3. Find which entry the client pinned
  // Access private field via any cast
  const entryUrl = (client as any).entryUrl;
  log(`Pinned entry: ${entryUrl}`);

  // 4. Test HTTP POST to each entry candidate
  log("\n=== Testing HTTP POST to each potential entry node ===");
  const entryNodes = nodes.filter(n => [0, 1].includes(n.layer) || [1, 3].includes(n.role));
  for (const n of entryNodes) {
    const url = `${n.address}/health`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
      log(`  ${n.address.slice(0, 30)} -> ${resp.status} (${resp.ok ? "OK" : "FAIL"})`);
    } catch (e: any) {
      log(`  ${n.address.slice(0, 30)} -> UNREACHABLE (${e.message?.slice(0, 40)})`);
    }
  }

  // 5. Send 5 echoes with detailed timing
  log("\n=== Sending 5 echoes with route details ===");
  for (let i = 0; i < 5; i++) {
    // Get the route that will be selected
    const pinnedEntry = nodes.find(n => n.address === entryUrl);
    const route = selectRoute(nodes, pinnedEntry);
    log(`\nEcho #${i}:`);
    log(`  Route: entry=${route.entry.id.slice(0, 10)}(${route.entry.address.slice(0, 25)}) -> mix=${route.mix.id.slice(0, 10)} -> exit=${route.exit.id.slice(0, 10)}`);
    log(`  Exit routing: ${route.exit.routingAddress.slice(0, 50)}`);

    const data = new Uint8Array([i]);
    const inner = encodeServiceRequest({ tag: "Echo", data });

    const t0 = Date.now();
    log(`  Sending at ${t0}...`);

    try {
      const resp = await client.send({ tag: "AnonymousRequest", inner, replySurbs: [] });
      const ms = Date.now() - t0;
      log(`  PASS in ${ms}ms. resp[0]=${resp[0]}`);
    } catch (e: any) {
      const ms = Date.now() - t0;
      log(`  FAIL in ${ms}ms: ${e.message?.slice(0, 80)}`);
    }
  }

  // 6. Check response buffer on entry node
  log("\n=== Checking response buffer on pinned entry ===");
  try {
    const resp = await fetch(`${entryUrl}/api/v1/responses/pending`, {
      signal: AbortSignal.timeout(3000),
    });
    const text = await resp.text();
    log(`  Status: ${resp.status}, Body length: ${text.length}, Content: ${text.slice(0, 100)}`);
  } catch (e: any) {
    log(`  FAILED: ${e.message}`);
  }

  client.disconnect();
  log("\n=== DIAGNOSTIC COMPLETE ===");
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
