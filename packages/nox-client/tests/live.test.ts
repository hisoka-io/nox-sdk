import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined")
  (globalThis as any).crypto = webcrypto;
import { NoxClient, encodeServiceRequest } from "../src/index.js";

const SEED = process.env["SEED"] || "https://api.hisoka.io/seed/topology";
const TIMEOUT = 60_000;
const SURBS = 10;

const skipUnless = !process.env["LIVE_TESTS"];

describe.skipIf(skipUnless)("live testnet", () => {
  let client: NoxClient;

  beforeAll(async () => {
    client = await NoxClient.connect({
      seeds: [SEED],
      powDifficulty: 3,
      timeoutMs: TIMEOUT,
      surbsPerRequest: SURBS,
      dangerouslySkipFingerprintCheck: true,
    });
  }, 30_000);

  afterAll(() => client?.disconnect());

  // -- Echo --

  describe("echo", () => {
    it("32 bytes", async () => {
      const data = new Uint8Array(32);
      crypto.getRandomValues(data);
      const inner = encodeServiceRequest({ tag: "Echo", data });
      const resp = await client.send({ tag: "AnonymousRequest", inner, replySurbs: [] });
      expect(resp.length).toBe(32);
      expect(Array.from(resp)).toEqual(Array.from(data));
    }, TIMEOUT);

    it("1 KB", async () => {
      const data = new Uint8Array(1024);
      crypto.getRandomValues(data);
      const inner = encodeServiceRequest({ tag: "Echo", data });
      const resp = await client.send({ tag: "AnonymousRequest", inner, replySurbs: [] });
      expect(resp.length).toBe(1024);
      expect(Array.from(resp)).toEqual(Array.from(data));
    }, TIMEOUT);
  });

  // -- HTTP Downloads --

  describe("http downloads", () => {
    it("1 KB", async () => {
      const resp = await client.httpRequest(
        "GET", "https://httpbin.org/bytes/1024", [], new Uint8Array(0),
      );
      expect(resp.length).toBeGreaterThan(500);
    }, TIMEOUT);

    it("1 MB", async () => {
      const resp = await client.httpRequest(
        "GET", "https://speed.cloudflare.com/__down?bytes=1048576", [], new Uint8Array(0),
        { expectedResponseBytes: 1_200_000 },
      );
      expect(resp.length).toBeGreaterThan(500_000);
    }, TIMEOUT);

    it("10 MB", async () => {
      const resp = await client.httpRequest(
        "GET", "https://speed.cloudflare.com/__down?bytes=10485760", [], new Uint8Array(0),
        { timeoutMs: 120_000 },
      );
      expect(resp.length).toBeGreaterThan(5_000_000);
    }, 120_000);
  });

  // -- Public Websites --

  describe("public websites", () => {
    it("wikipedia", async () => {
      const resp = await client.httpRequest(
        "GET", "https://en.wikipedia.org/wiki/Tor_(network)", [], new Uint8Array(0),
      );
      expect(resp.length).toBeGreaterThan(10_000);
    }, TIMEOUT);

    it("github api", async () => {
      const resp = await client.httpRequest(
        "GET", "https://api.github.com",
        [["User-Agent", "nox-sdk-test"]], new Uint8Array(0),
      );
      expect(resp.length).toBeGreaterThan(100);
    }, TIMEOUT);

    it("httpbin ip", async () => {
      const resp = await client.httpRequest(
        "GET", "https://httpbin.org/ip", [], new Uint8Array(0),
      );
      expect(resp.length).toBeGreaterThan(10);
    }, TIMEOUT);
  });

  // -- Web3 RPC (Arbitrum Sepolia) --

  describe("web3 rpc", () => {
    it("eth_chainId", async () => {
      const r = await client.rpcCall("eth_chainId", []);
      expect(r).toBe("0x66eee");
    }, TIMEOUT);

    it("eth_blockNumber", async () => {
      const r = await client.rpcCall("eth_blockNumber", []);
      expect(typeof r).toBe("string");
      expect((r as string).startsWith("0x")).toBe(true);
    }, TIMEOUT);

    it("eth_gasPrice", async () => {
      const r = await client.rpcCall("eth_gasPrice", []);
      expect(typeof r).toBe("string");
      expect((r as string).startsWith("0x")).toBe(true);
    }, TIMEOUT);

    it("eth_getBlockByNumber", async () => {
      const r = await client.rpcCall("eth_getBlockByNumber", ["latest", false]);
      expect(r).toBeTruthy();
      expect(typeof r).toBe("object");
    }, TIMEOUT);
  });
});
