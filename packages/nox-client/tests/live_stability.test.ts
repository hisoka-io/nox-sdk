import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined")
  (globalThis as any).crypto = webcrypto;
import { NoxClient, encodeServiceRequest } from "../src/index.js";

// Live suites run against the public testnet with full chain verification.
// Override any of these to point at another deployment.
const SEED = process.env["SEED"] || "https://api.hisoka.io/seed";
const ETH_RPC_URL =
  process.env["NOX_ETH_RPC_URL"] || "https://sepolia-rollup.arbitrum.io/rpc";
const REGISTRY_ADDRESS =
  process.env["NOX_REGISTRY_ADDRESS"] || "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6";

describe.skipIf(!process.env["LIVE_TESTS"])("live stability - 20 rapid echoes", () => {
  let client: NoxClient;

  beforeAll(async () => {
    client = await NoxClient.connect({
      seeds: [SEED],
      ethRpcUrl: ETH_RPC_URL,
      registryAddress: REGISTRY_ADDRESS,
      timeoutMs: 15_000,
      surbsPerRequest: 3,
    });
  }, 30_000);

  afterAll(() => client?.disconnect());

  for (let i = 0; i < 20; i++) {
    it(`echo #${i}`, async () => {
      const data = new Uint8Array([i]);
      const inner = encodeServiceRequest({ tag: "Echo", data });
      const resp = await client.send({
        tag: "AnonymousRequest",
        inner,
        replySurbs: [],
      });
      expect(resp[0]).toBe(i);
    }, 20_000);
  }
});
