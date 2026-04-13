import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined")
  (globalThis as any).crypto = webcrypto;
import { NoxClient, encodeServiceRequest } from "../src/index.js";

const SEED = process.env["SEED"] || "https://api.hisoka.io/seed/topology";

describe.skipIf(!process.env["LIVE_TESTS"])("live stability - 20 rapid echoes", () => {
  let client: NoxClient;

  beforeAll(async () => {
    client = await NoxClient.connect({
      seeds: [SEED],
      powDifficulty: 3,
      timeoutMs: 15_000,
      surbsPerRequest: 3,
      dangerouslySkipFingerprintCheck: true,
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
