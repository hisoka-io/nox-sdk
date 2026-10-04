// nox-kps in front of every mesh node, reached the way the worker reaches it:
// a hash-pinned probe worker in the reference harness opens KPS streams with
// anonRpcWorker.kps and speaks KPS-HTTP/1 (shared/kps-http.ts). Checks the
// node-backed routes (topology, health) and the sidecar's own routes against
// the node's loopback endpoints. Runs when NOX_KPS_CMD is set.

import type { Page } from "@playwright/test";
import { buildProbeWorker } from "../../src/bundles.js";
import { loadConfig } from "../../src/config.js";
import { writeReport } from "../../src/report.js";
import { publishWorker, type PublishedWorker } from "../../src/testbed.js";
import { expect, test } from "./fixtures.js";

const PROBE_ID = "kps-probe";
const early = loadConfig();

interface KpsHttpOutcome {
  readonly status: number | undefined;
  readonly body: string | undefined;
  readonly kpsMs: number | undefined;
  readonly error: string | undefined;
}

async function kpsGet(page: Page, address: string, path: string, timeoutMs: number): Promise<KpsHttpOutcome> {
  const result = await page.evaluate((request) => window.e2e.fetch(request), {
    id: PROBE_ID,
    url: `kps-http://${address}${path}`,
    method: "GET",
    timeoutMs,
  });
  const kpsMs = result.headers?.find(([name]) => name === "x-kps-ms")?.[1];
  return {
    status: result.status,
    body: result.bodyText,
    kpsMs: kpsMs === undefined ? undefined : Number(kpsMs),
    error: result.error === undefined ? undefined : `${result.error.name}: ${result.error.message}`,
  };
}

test.describe("nox-kps sidecars in front of the local mesh", () => {
  test.skip(early.kps.sidecarCommand === undefined, "NOX_KPS_CMD is unset (one nox-kps sidecar per mesh node)");

  let probe: PublishedWorker | undefined;

  test("every sidecar serves topology, health and metadata over KPS from the harness", async ({
    cfg,
    runPaths,
    chains,
    resolver,
    meshBed,
    openHost,
  }) => {
    probe ??= await publishWorker(chains, resolver, await buildProbeWorker(cfg.e2eRoot));
    const page = await openHost("0.3.2");
    const boot = await page.evaluate((request) => window.e2e.boot(request), {
      id: PROBE_ID,
      address: probe.address,
      specifierRpcUrl: chains.specifier.url,
      readyTimeoutMs: cfg.worker.readyTimeoutMs,
    });
    expect(boot.ok, JSON.stringify(boot.error)).toBe(true);

    const rows: Record<string, unknown>[] = [];
    for (const node of meshBed.mesh.info.nodes) {
      const sidecar = meshBed.sidecars.get(node.id);
      expect(sidecar, `node ${node.id} has no sidecar`).toBeDefined();
      if (sidecar === undefined) continue;
      const timeout = cfg.worker.callTimeoutMs;

      const topology = await kpsGet(page, sidecar.address, "/topology", timeout);
      expect(topology.status, `node ${node.id} /topology: ${topology.error ?? ""}`).toBe(200);
      const viaKps = JSON.parse(topology.body ?? "null") as { fingerprint?: unknown; nodes?: unknown[] };
      const direct = (await (await fetch(node.topologyUrl)).json()) as { fingerprint?: unknown; nodes?: unknown[] };
      expect(viaKps.fingerprint).toBe(direct.fingerprint);
      expect(viaKps.nodes?.length).toBe(direct.nodes?.length);

      const health = await kpsGet(page, sidecar.address, "/health", timeout);
      expect(health.status, `node ${node.id} /health: ${health.error ?? health.body ?? ""}`).toBe(200);

      const metadata = await kpsGet(page, sidecar.address, "/metadata.json", timeout);
      expect(metadata.status, `node ${node.id} /metadata.json`).toBe(200);
      const document = JSON.parse(metadata.body ?? "null") as { addresses?: unknown };
      expect(document.addresses).toContain(sidecar.address);

      const unknownPath = await kpsGet(page, sidecar.address, "/api/v1/ws", timeout);
      expect(unknownPath.status, `node ${node.id} /api/v1/ws must stay unexposed`).toBe(404);

      rows.push({
        node: node.id,
        address: sidecar.address,
        topologyMs: topology.kpsMs,
        healthMs: health.kpsMs,
        metadataMs: metadata.kpsMs,
      });
    }
    await page.evaluate((id) => window.e2e.close(id), PROBE_ID);
    writeReport(cfg, runPaths, "nox-kps-sidecars", { rows });
  });
});
