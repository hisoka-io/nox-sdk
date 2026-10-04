// Classic-path regression (TEST-PLAN TST-595): the existing SDK transport
// (HTTP ingress, seed topology, SURB replies) against the local 10-node mesh,
// with the upstream anvil as the exit's HttpRequest target. This is the same
// exit path the Nox anon-rpc worker uses (D-03), driven without KPS, so a
// failure here points at the mesh or the exits rather than at KPS.

import { existsSync } from "node:fs";
import { decodeExitHttpResponse } from "../../src/bincode-http.js";
import { isZeroFingerprint, loadClassicSdk, type ClassicClient } from "../../src/classic-sdk.js";
import { jsonRpc } from "../../src/jsonrpc.js";
import { writeReport } from "../../src/report.js";
import { expect, test } from "./fixtures.js";
import { rpcCall } from "./helpers.js";

/** Reply blocks per request; small JSON-RPC replies fit in one. */
const SURBS_PER_REQUEST = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function rpcViaExit(
  client: ClassicClient,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown; ms: number }> {
  const started = performance.now();
  const raw = await client.httpRequest(
    "POST",
    url,
    [["content-type", "application/json"]],
    encoder.encode(JSON.stringify(body)),
    { timeoutMs },
  );
  const reply = decodeExitHttpResponse(raw);
  expect(reply.truncated, "exit truncated the reply").toBe(false);
  return {
    status: reply.status,
    json: JSON.parse(decoder.decode(reply.body)) as unknown,
    ms: Math.round(performance.now() - started),
  };
}

test.describe("classic SDK path through the local mesh", () => {
  test("echo, then JSON-RPC to the upstream anvil through an exit", async ({ cfg, runPaths, chains, meshBed }) => {
    test.skip(
      !existsSync(cfg.classic.clientEntry),
      `${cfg.classic.clientEntry} is missing: build @hisoka-io/nox-client (see README) or set NOX_CLIENT_ENTRY`,
    );
    const sdk = await loadClassicSdk(cfg.classic.clientEntry);
    const seed = meshBed.mesh.seedUrl;
    // The mesh has no registry behind it, so there is no chain to verify the
    // topology against; the served list must still hash to its fingerprint.
    const topology = await sdk.fetchTopology(seed, cfg.classic.callTimeoutMs);
    if (!isZeroFingerprint(topology.fingerprint)) sdk.verifySelfConsistency(topology);
    const client = await sdk.NoxClient.connect({
      seeds: [seed],
      timeoutMs: cfg.classic.callTimeoutMs,
      powDifficulty: 0,
      surbsPerRequest: SURBS_PER_REQUEST,
      // Accepted by the SDK only when every seed is a loopback URL.
      dangerouslySkipFingerprintCheck: true,
    });
    const timings: Record<string, number> = {};
    try {
      const payload = encoder.encode(`classic-path ${Date.now()}`);
      const echoStarted = performance.now();
      expect(decoder.decode(await client.sendEcho(payload))).toBe(decoder.decode(payload));
      timings["echo"] = Math.round(performance.now() - echoStarted);

      const upstream = chains.upstream;
      const timeout = cfg.classic.callTimeoutMs;
      const chainId = await rpcViaExit(client, upstream.url, rpcCall("eth_chainId"), timeout);
      expect(chainId.status).toBe(200);
      expect((chainId.json as { result?: unknown }).result).toBe(`0x${upstream.chainId.toString(16)}`);
      timings["eth_chainId"] = chainId.ms;

      const balanceCall = rpcCall("eth_getBalance", [upstream.account, "latest"], 7);
      const balance = await rpcViaExit(client, upstream.url, balanceCall, timeout);
      expect((balance.json as { id?: unknown }).id).toBe(7);
      expect((balance.json as { result?: unknown }).result).toBe(
        await jsonRpc(upstream.url, "eth_getBalance", [upstream.account, "latest"]),
      );
      timings["eth_getBalance"] = balance.ms;

      const batch = await rpcViaExit(
        client,
        upstream.url,
        [rpcCall("eth_chainId", [], 1), rpcCall("eth_blockNumber", [], 2), rpcCall("net_version", [], 3)],
        timeout,
      );
      expect(Array.isArray(batch.json) ? batch.json.map((item: { id?: unknown }) => item.id).sort() : []).toEqual([
        1, 2, 3,
      ]);
      timings["batch3"] = batch.ms;

      // A JSON-RPC error travels back intact (status 200, error object).
      const missing = await rpcViaExit(client, upstream.url, rpcCall("eth_noSuchMethod"), timeout);
      expect((missing.json as { error?: { code?: unknown } }).error?.code).toBe(-32601);
    } finally {
      client.disconnect();
      writeReport(cfg, runPaths, "classic-sdk", { mixDelayMs: cfg.mesh.mixDelayMs, timings });
    }
  });
});
