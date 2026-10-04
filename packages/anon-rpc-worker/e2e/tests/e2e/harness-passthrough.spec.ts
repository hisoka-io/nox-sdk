// Step 1 of the test bed: prove the harness setup itself with the upstream
// passthrough worker, a known-good bundle. The fixture is the exact 1,704-byte
// bundle pinned by the mainnet passthrough specifier 0x4fd77be3...8d27, served
// by our local keccak resolver and pinned by a WorkerSpecifier on anvil.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keccakHex } from "../../src/abi.js";
import { HARNESS_VERSIONS } from "../../src/bundles.js";
import { deploySpecifier } from "../../src/specifier.js";
import { publishWorker } from "../../src/testbed.js";
import { expect, test } from "./fixtures.js";
import { rpcCall, rpcResult, rpcViaWorker } from "./helpers.js";

/** workerHash() of the mainnet passthrough specifier (anon-rpc keccak branch 19/4f04bd...). */
const PASSTHROUGH_MAINNET_HASH = "0x194f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d";

function passthroughBundle(e2eRoot: string): Uint8Array {
  return new Uint8Array(readFileSync(join(e2eRoot, "fixtures", "passthrough-worker.js")));
}

test.describe("reference harness with the upstream passthrough worker", () => {
  test("the fixture is the mainnet-pinned passthrough bundle", ({ cfg }) => {
    expect(keccakHex(passthroughBundle(cfg.e2eRoot))).toBe(PASSTHROUGH_MAINNET_HASH);
  });

  for (const version of HARNESS_VERSIONS) {
    test(`harness ${version}: boots from an anvil specifier and serves JSON-RPC end to end`, async ({
      cfg,
      chains,
      resolver,
      guardedHost,
    }) => {
      const bundle = passthroughBundle(cfg.e2eRoot);
      const published = await publishWorker(chains, resolver, bundle);
      expect(published.workerHash).toBe(PASSTHROUGH_MAINNET_HASH);
      const resolverHitsBefore = resolver.server.requests.length;

      const page = await guardedHost.open(version);
      const boot = await page.evaluate((request) => window.e2e.boot(request), {
        id: "passthrough",
        address: published.address,
        specifierRpcUrl: chains.specifier.url,
        readyTimeoutMs: cfg.worker.readyTimeoutMs,
      });
      expect(boot.ok, JSON.stringify(boot.error)).toBe(true);
      expect(boot.sandbox).toBe("allow-scripts");
      expect(resolver.server.requests.slice(resolverHitsBefore)).toEqual([
        new URL(published.resolvers[0] ?? "").pathname,
      ]);

      const upstream = chains.upstream.url;
      const timeout = cfg.worker.callTimeoutMs;
      const chainId = await rpcViaWorker(page, "passthrough", upstream, rpcCall("eth_chainId"), timeout);
      expect(chainId.result.status).toBe(200);
      expect(rpcResult(chainId.json)).toBe(`0x${chains.upstream.chainId.toString(16)}`);

      const balance = await rpcViaWorker(
        page,
        "passthrough",
        upstream,
        rpcCall("eth_getBalance", [chains.upstream.account, "latest"]),
        timeout,
      );
      expect(BigInt(String(rpcResult(balance.json)))).toBeGreaterThan(0n);

      const batch = await rpcViaWorker(
        page,
        "passthrough",
        upstream,
        [rpcCall("eth_chainId", [], 1), rpcCall("eth_blockNumber", [], 2)],
        timeout,
      );
      expect(Array.isArray(batch.json) ? batch.json.length : -1).toBe(2);

      // Negative control for the egress check used on the Nox worker: the
      // passthrough worker fetches ambiently, so both the recording proxy and
      // the CDP request events must flag its calls to the upstream chain, and
      // nothing else (harness boot stays inside the allowlist).
      const { monitor } = guardedHost;
      const upstreamOrigin = new URL(upstream).origin;
      const flagged = monitor.violations();
      expect(flagged.length, monitor.describeViolations()).toBeGreaterThanOrEqual(6);
      expect(flagged.every((event) => new URL(event.target).origin === upstreamOrigin), monitor.describeViolations()).toBe(true);
      for (const layer of ["proxy", "cdp-request"] as const) {
        expect(flagged.filter((event) => event.layer === layer).length, `${layer} layer`).toBeGreaterThanOrEqual(3);
      }

      // Host abort reaches the worker: a call aborted before it settles rejects
      // with AbortError, and the worker keeps serving afterwards.
      const aborted = await page.evaluate((request) => window.e2e.fetch(request), {
        id: "passthrough",
        url: upstream,
        method: "POST",
        headers: [["content-type", "application/json"]] as [string, string][],
        body: JSON.stringify(rpcCall("eth_chainId")),
        timeoutMs: timeout,
        abortAfterMs: 0,
      });
      expect(aborted.ok).toBe(false);
      expect(aborted.error?.name).toBe("AbortError");
      const after = await rpcViaWorker(page, "passthrough", upstream, rpcCall("eth_chainId"), timeout);
      expect(rpcResult(after.json)).toBe(`0x${chains.upstream.chainId.toString(16)}`);

      await page.evaluate((id) => window.e2e.close(id), "passthrough");
    });
  }

  test("a resolver serving bytes that do not match workerHash fails the boot", async ({
    cfg,
    chains,
    resolver,
    openHost,
  }) => {
    const bundle = passthroughBundle(cfg.e2eRoot);
    const tampered = new TextEncoder().encode(`//tampered\n${new TextDecoder().decode(bundle)}`);
    // Pin the real hash, but let the resolver serve tampered bytes under it.
    const fakeHash = keccakHex(new TextEncoder().encode("hash with no bytes behind it"));
    resolver.store.putMismatched(fakeHash, tampered);
    const address = await deploySpecifier(chains.specifier.url, chains.specifier.account, {
      workerHash: fakeHash,
      resolvers: [resolver.server.urlFor(fakeHash)],
    });
    const page = await openHost("0.3.2");
    const boot = await page.evaluate((request) => window.e2e.boot(request), {
      id: "tampered",
      address,
      specifierRpcUrl: chains.specifier.url,
      readyTimeoutMs: cfg.worker.readyTimeoutMs,
    });
    expect(boot.ok).toBe(false);
    expect(boot.error?.message ?? "").toContain("no resolver yielded bytes matching workerHash");
  });
});
