/**
 * Stress test: connect TS SDK to a real NOX mesh and download data through the mixnet.
 *
 * Prerequisites:
 *   1. Build the nox binary:  cargo build --release -p nox
 *   2. Start the mesh server: cargo run -p nox-sim --bin nox_mesh_server --features dev-node -- --nodes 10
 *   3. Run this test:         npx tsx tests/internal/stress_mesh.ts
 *
 * The test reads mesh_info.json from the mesh server's data directory,
 * connects via NoxClient.connect(), and sends HTTP requests through the mixnet.
 *
 * Environment variables:
 *   MESH_INFO_PATH — path to mesh_info.json (default: /tmp/nox_mesh/mesh_info.json)
 *   TEST_URL       — URL to fetch through the mixnet (default: small Wikipedia page)
 *   TIMEOUT_MS     — per-request timeout in ms (default: 60000)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  fetchTopology,
  verifySelfConsistency,
  parseNodes,
  selectRoute,
  NoxClient,
  type TopologyNode,
} from "../../src/index.js";

// ============================================================================
// Config
// ============================================================================

const MESH_INFO_PATH = process.env["MESH_INFO_PATH"] ?? "/tmp/nox_mesh/mesh_info.json";
const TIMEOUT_MS = Number(process.env["TIMEOUT_MS"] ?? "120000");

// Test targets: small to large. Responses are bincode-serialized
// SerializableHttpResponse (status + headers + body), adding ~200-400 bytes
// overhead. Bounds are widened accordingly.
//
// NOTE: httpbin.org caps /bytes/N at 102400 (100KB) regardless of N.
// For > 100KB, we use proof.ovh.net which serves exact file sizes.
//
// Larger responses (> surbsPerRequest * 30KB) trigger multi-round SURB
// replenishment with continuation fragment numbering.
const TEST_TARGETS = [
  {
    name: "httpbin 1KB",
    url: "https://httpbin.org/bytes/1024",
    expectMinBytes: 1024,
    expectMaxBytes: 2048,
    timeoutMs: 30_000,
  },
  {
    name: "OVH 1MB (multi-round replenishment)",
    url: "https://proof.ovh.net/files/1Mb.dat",
    expectMinBytes: 1_048_000,
    expectMaxBytes: 1_100_000,
    timeoutMs: 60_000,
  },
  {
    name: "OVH 10MB (sustained replenishment)",
    url: "https://proof.ovh.net/files/10Mb.dat",
    expectMinBytes: 10_485_000,
    expectMaxBytes: 10_540_000,
    timeoutMs: 300_000,
  },
  {
    name: "OVH 100MB (stress replenishment)",
    url: "https://proof.ovh.net/files/100Mb.dat",
    expectMinBytes: 104_857_000,
    expectMaxBytes: 104_910_000,
    timeoutMs: 600_000,
  },
];

// ============================================================================
// Types for mesh_info.json
// ============================================================================

interface MeshNodeInfo {
  id: number;
  p2p_port: number;
  metrics_port: number;
  ingress_port: number;
  sphinx_public_key: string;
  peer_id: string;
  p2p_multiaddr: string;
  layer: number;
  role: number;
}

interface MeshInfo {
  node_count: number;
  entry_url: string;
  nodes: MeshNodeInfo[];
}

// ============================================================================
// Helpers
// ============================================================================

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // 1. Read mesh info
  log(`Reading mesh info from ${MESH_INFO_PATH}`);
  if (!fs.existsSync(MESH_INFO_PATH)) {
    console.error(`ERROR: ${MESH_INFO_PATH} not found.`);
    console.error("Start the mesh server first:");
    console.error("  cargo run -p nox-sim --bin nox_mesh_server --features dev-node -- --nodes 10");
    process.exit(1);
  }

  const meshInfo: MeshInfo = JSON.parse(fs.readFileSync(MESH_INFO_PATH, "utf-8"));
  log(`Mesh has ${meshInfo.node_count} nodes, entry at ${meshInfo.entry_url}`);

  // 2. Pick a seed URL (metrics port serves /topology)
  const seedUrl = `http://127.0.0.1:${meshInfo.nodes[0]!.metrics_port}`;
  log(`Using seed URL: ${seedUrl}`);

  // 3. Verify topology is accessible
  log("Fetching topology from seed...");
  const snapshot = await fetchTopology(seedUrl, 10_000);
  const claimedFp = snapshot.fingerprint.replace(/^0x/, "");
  const isZeroFp = /^0+$/.test(claimedFp);
  if (isZeroFp) {
    log("Topology fingerprint is all-zeros (local test mesh) — skipping self-consistency check");
  } else {
    verifySelfConsistency(snapshot);
    log("Topology fingerprint verified OK");
  }
  const nodes = parseNodes(snapshot);
  log(`Topology: ${nodes.length} nodes`);

  // 4. Verify layer distribution
  const layers = new Map<number, TopologyNode[]>();
  for (const node of nodes) {
    const arr = layers.get(node.layer) ?? [];
    arr.push(node);
    layers.set(node.layer, arr);
  }
  log(`Layer distribution: ${[...layers.entries()].map(([l, ns]) => `L${l}=${ns.length}`).join(", ")}`);

  // Verify we have at least one node per layer for routing
  if (!layers.has(0) || !layers.has(1) || !layers.has(2)) {
    console.error("ERROR: Need at least one node in each layer (0, 1, 2) for routing");
    process.exit(1);
  }

  // 5. Verify route selection works
  const route = selectRoute(nodes);
  log(`Route selected: entry=${route.entry.id.slice(0, 16)}... (L${route.entry.layer}) → mix=${route.mix.id.slice(0, 16)}... (L${route.mix.layer}) → exit=${route.exit.id.slice(0, 16)}... (L${route.exit.layer})`);

  // 6. Verify ingress URLs are present
  const entryNodes = nodes.filter(n => n.layer === 0);
  const hasIngressUrls = entryNodes.every(n => n.address.startsWith("http://"));
  if (!hasIngressUrls) {
    console.error("ERROR: Entry nodes missing HTTP ingress URLs.");
    console.error("Addresses:", entryNodes.map(n => n.address));
    process.exit(1);
  }
  log(`Entry node ingress URLs: ${entryNodes.map(n => n.address).join(", ")}`);

  // 7. Connect NoxClient
  // Each SURB is ~700 bytes serialized. A single forward Sphinx packet has
  // MAX_PAYLOAD_SIZE=31,716 bytes. With ~100 bytes of envelope overhead,
  // we can fit ~45 SURBs per packet (no forward fragmentation in the SDK).
  // 40 SURBs × 30KB = ~1.2MB per round. A 10MB response needs ~9 rounds.
  log("Connecting NoxClient...");
  const client = await NoxClient.connect({
    seeds: [seedUrl],
    timeoutMs: TIMEOUT_MS,
    powDifficulty: 0,
    surbsPerRequest: 40,
    dangerouslySkipFingerprintCheck: isZeroFp,
  });
  client._debugPoll = process.env["DEBUG_POLL"] === "1";
  log("NoxClient connected successfully!");

  // 8. Run test targets
  let passed = 0;
  let failed = 0;

  for (const target of TEST_TARGETS) {
    log(`\n--- Test: ${target.name} ---`);
    log(`  URL: ${target.url}`);
    log(`  Expected: ${formatBytes(target.expectMinBytes)} - ${formatBytes(target.expectMaxBytes)}`);
    log(`  Timeout: ${(target.timeoutMs / 1000).toFixed(0)}s`);

    const start = Date.now();
    try {
      const response = await client.httpRequest(
        "GET",
        target.url,
        [],
        new Uint8Array(0),
        {
          timeoutMs: target.timeoutMs,
          expectedResponseBytes: target.expectMaxBytes,
        },
      );
      const elapsed = Date.now() - start;

      log(`  Response: ${formatBytes(response.length)} in ${elapsed}ms`);

      if (response.length >= target.expectMinBytes && response.length <= target.expectMaxBytes) {
        log(`  PASS`);
        passed++;
      } else {
        log(`  FAIL — unexpected response size`);
        failed++;
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      log(`  FAIL — ${String(err)} (after ${elapsed}ms)`);
      failed++;
    }
  }

  // 9. Disconnect
  client.disconnect();

  // 10. Summary
  log(`\n========================================`);
  log(`RESULTS: ${passed} passed, ${failed} failed out of ${TEST_TARGETS.length} tests`);
  log(`========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
