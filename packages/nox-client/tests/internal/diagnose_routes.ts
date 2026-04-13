/**
 * Route diagnostic: send 30 echoes and track which mix/exit combinations succeed vs fail.
 */
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined") (globalThis as any).crypto = webcrypto;

import {
  NoxClient,
  encodeServiceRequest,
  parseNodes,
  selectRoute,
  fetchTopology,
} from "../../src/index.js";

async function main() {
  const snap = await fetchTopology("https://api.hisoka.io/seed");
  const nodes = parseNodes(snap);

  const client = await NoxClient.connect({
    seeds: ["https://api.hisoka.io/seed"],
    powDifficulty: 3,
    timeoutMs: 10_000,
    surbsPerRequest: 3,
    dangerouslySkipFingerprintCheck: true,
  });

  const entryUrl = (client as any).entryUrl;
  const pinnedEntry = nodes.find(n => n.address === entryUrl);
  console.log(`Entry: ${entryUrl}\n`);

  const routeResults: Record<string, { pass: number; fail: number }> = {};

  for (let i = 0; i < 30; i++) {
    const route = selectRoute(nodes, pinnedEntry);
    const mixId = route.mix.id.slice(2, 10);
    const exitId = route.exit.id.slice(2, 10);
    const key = `mix=${mixId}->exit=${exitId}`;

    const data = new Uint8Array([i]);
    const inner = encodeServiceRequest({ tag: "Echo", data });
    const t0 = Date.now();

    try {
      await client.send({ tag: "AnonymousRequest", inner, replySurbs: [] });
      const ms = Date.now() - t0;
      console.log(`#${String(i).padStart(2)} PASS (${String(ms).padStart(5)}ms) ${key}`);
      routeResults[key] = routeResults[key] || { pass: 0, fail: 0 };
      routeResults[key]!.pass++;
    } catch {
      const ms = Date.now() - t0;
      console.log(`#${String(i).padStart(2)} FAIL (${String(ms).padStart(5)}ms) ${key}`);
      routeResults[key] = routeResults[key] || { pass: 0, fail: 0 };
      routeResults[key]!.fail++;
    }
  }

  console.log("\n=== Route Success/Fail Map ===");
  for (const [key, v] of Object.entries(routeResults).sort((a, b) => b[1].fail - a[1].fail)) {
    const rate = ((v.pass / (v.pass + v.fail)) * 100).toFixed(0);
    const tag = v.fail > 0 ? "UNRELIABLE" : "OK";
    console.log(`  ${key}: ${v.pass}/${v.pass + v.fail} (${rate}%) [${tag}]`);
  }

  client.disconnect();
}
main();
