/** Config, JSON-RPC profiling, error codes, logging and storage. */
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, parseConfig } from "../src/config.js";
import { CALL_CODES, FAILED_CODES, NoxWorkerError, abortedByHost, callError } from "../src/errors.js";
import { CLASS_REPLY_BYTES, classifyCall, profileRequest } from "../src/jsonrpc.js";
import { createLogger, redact } from "../src/log.js";
import type { LogArg, StorageApi } from "../src/spec-types.js";
import {
  LEARNED_CACHE_KEY,
  LEARNED_CACHE_MAX_AGE_SECONDS,
  LEARNED_CACHE_MAX_ANCHORS,
  LearnedCacheWriter,
  learnedCacheFrom,
  readLearnedCache,
  REMOVAL_CACHE_KEY,
  REMOVAL_CACHE_MAX_AGE_SECONDS,
  RemovalCacheWriter,
  readRemovalCache,
} from "../src/storage.js";
import { kpsAddressFor } from "./helpers/fixtures.js";

const encoder = new TextEncoder();

describe("config", () => {
  it("uses defaults for undefined, null and {}", () => {
    expect(parseConfig(undefined)).toBe(CONFIG_DEFAULTS);
    expect(parseConfig(null)).toBe(CONFIG_DEFAULTS);
    expect(parseConfig({})).toEqual(CONFIG_DEFAULTS);
  });

  it("accepts a full valid config, including a JSON5-parsed object, without mutating it", () => {
    const raw = JSON.parse(
      '{"v":1,"gateways":["' + kpsAddressFor(2) + '"],"logLevel":"warn","attemptTimeoutMs":5000,' +
        '"callDeadlineMs":20000,"maxConcurrentCalls":8,"maxRequestBytes":2048,"maxResponseBytes":100000,' +
        '"surbFormat":"v2","claimIntervalMs":100,"bootRetryMaxMs":10000,"topologySources":3,"warmup":true,' +
        '"hedgeAfterMs":0}',
    ) as Record<string, unknown>;
    const snapshot = JSON.stringify(raw);
    const config = parseConfig(raw);
    expect(config).toMatchObject({ gateways: [kpsAddressFor(2)], logLevel: "warn", surbFormat: "v2", warmup: true, topologySources: 3, hedgeAfterMs: 0 });
    expect(Object.isFrozen(config)).toBe(true);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it.each([
    ["array", [], /plain object/u],
    ["unknown key", { gateway: [] }, /gateway is not a known field/u],
    ["v", { v: 2 }, /config\.v must be 1/u],
    ["fraction", { attemptTimeoutMs: 3000.5 }, /attemptTimeoutMs/u],
    ["below range", { maxConcurrentCalls: 0 }, /maxConcurrentCalls/u],
    ["above range", { maxResponseBytes: 2 ** 30 }, /maxResponseBytes/u],
    ["deadline below attempt", { attemptTimeoutMs: 20_000, callDeadlineMs: 10_000 }, /callDeadlineMs must be at least/u],
    ["log level", { logLevel: "trace" }, /logLevel/u],
    ["surb format", { surbFormat: "v3" }, /surbFormat/u],
    ["warmup", { warmup: "yes" }, /warmup/u],
    ["hedge above range", { hedgeAfterMs: 60_001 }, /hedgeAfterMs must be an integer in 0\.\.60000/u],
    ["hedge negative", { hedgeAfterMs: -1 }, /hedgeAfterMs/u],
    ["gateways empty", { gateways: [] }, /gateways must be a list of 1\.\.16/u],
    ["gateway malformed", { gateways: ["1.2.3.4:15005"] }, /not a KPS address/u],
    ["gateway repeated", { gateways: [kpsAddressFor(1), kpsAddressFor(1)] }, /repeats/u],
    ["17 gateways", { gateways: Array.from({ length: 17 }, (_, i) => kpsAddressFor(i + 1)) }, /1\.\.16/u],
    ["bridges empty", { bridges: [] }, /bridges must be a list of 1\.\.16/u],
    ["bridge malformed", { bridges: ["bridge.example:15005:uEiB"] }, /bridges\[0\] is not a KPS address/u],
    ["gateways with bridges", { gateways: [kpsAddressFor(1)], bridges: [kpsAddressFor(2)] }, /exclude each other/u],
    ["one RPC URL", { registryRpcUrls: ["https://a.test/"] }, /registryRpcUrls must be a list of 2\.\.8/u],
    ["plain-http RPC URL", { registryRpcUrls: ["https://a.test/", "http://b.test/"] }, /registryRpcUrls\[1\]/u],
    ["quorum 1", { chainQuorum: 1 }, /chainQuorum must be an integer in 2\.\.4/u],
    ["quorum 5", { chainQuorum: 5 }, /chainQuorum/u],
    ["discovery mode", { discovery: "dns" }, /discovery must be one of chain, snapshot/u],
    ["trust proven", { trust: "proven" }, /trust is reserved/u],
    ["checkpoint", { checkpoint: { block: 1 } }, /checkpoint is reserved/u],
  ])("rejects %s with bad-config", (_name, raw, message) => {
    expect(() => parseConfig(raw)).toThrow(expect.objectContaining({ code: "bad-config", message: expect.stringMatching(message) }));
  });

  it("accepts gateways that no pinned member publishes: they are addresses, not identities", () => {
    expect(parseConfig({ gateways: [kpsAddressFor(77)] }).gateways).toEqual([kpsAddressFor(77)]);
  });

  it("accepts the S1 discovery fields", () => {
    const config = parseConfig({
      bridges: [kpsAddressFor(9)],
      registryRpcUrls: ["https://own.wallet.test/rpc", "https://other.test/rpc"],
      chainQuorum: 3,
      discovery: "snapshot",
      trust: "auto",
    });
    expect(config).toMatchObject({
      bridges: [kpsAddressFor(9)],
      registryRpcUrls: ["https://own.wallet.test/rpc", "https://other.test/rpc"],
      chainQuorum: 3,
      discovery: "snapshot",
      trust: "auto",
    });
    expect(Object.isFrozen(config.bridges)).toBe(true);
  });

  it("keeps the adopters exampleConfig valid", () => {
    const example = { gateways: ["100.56.0.72:15005:uEiBVDwIs40bsslDkM-BYb2AOHw3PHe70_bj5U_09r7vdIQ"] };
    expect(parseConfig(example).gateways).toEqual(example.gateways);
  });
});

describe("JSON-RPC profiling", () => {
  const post = (value: unknown, contentType?: string) =>
    profileRequest("POST", contentType, encoder.encode(JSON.stringify(value)));

  it("classifies single calls", () => {
    expect(classifyCall("eth_call", [])).toBe("small");
    expect(classifyCall("eth_getTransactionReceipt", [])).toBe("medium");
    expect(classifyCall("eth_getBlockByNumber", ["latest", false])).toBe("medium");
    expect(classifyCall("eth_getBlockByNumber", ["latest", true])).toBe("large");
    expect(classifyCall("eth_getLogs", [{}])).toBe("large");
    expect(classifyCall("eth_sendRawTransaction", ["0x"])).toBe("write");
    expect(classifyCall("eth_newFilter", [{}])).toBe("other");
  });

  it("profiles single calls with size, retry and budget key", () => {
    expect(post({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" })).toEqual({
      rpcClass: "small",
      expectedResponseBytes: CLASS_REPLY_BYTES.small,
      retryable: true,
      opKey: "http:jsonrpc:eth_blockNumber",
      method: "eth_blockNumber",
    });
    expect(post({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x"] })).toMatchObject({
      rpcClass: "write",
      retryable: false,
    });
    expect(post({ jsonrpc: "2.0", id: 1, method: "eth_getFilterChanges" })).toMatchObject({
      rpcClass: "other",
      expectedResponseBytes: undefined,
      retryable: false,
    });
    expect(post({ jsonrpc: "2.0", id: 1, method: "weird method!" }).opKey).toBe("http:other");
    // Unlisted methods share one budget key, so distinct names cannot grow the SDK's map.
    const keys = new Set(Array.from({ length: 50 }, (_, i) => post({ jsonrpc: "2.0", id: i, method: `app_method${i}` }).opKey));
    expect([...keys]).toEqual(["http:other"]);
    expect(post({ jsonrpc: "2.0", id: 1, method: "eth_getFilterChanges" }).method).toBe("eth_getFilterChanges");
  });

  it("profiles batches: summed size capped at large, retried only when every call is a read", () => {
    const reads = post([
      { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
      { jsonrpc: "2.0", id: 2, method: "eth_getCode", params: [] },
    ]);
    expect(reads).toMatchObject({ rpcClass: "medium", expectedResponseBytes: 150_000, retryable: true, opKey: "http:jsonrpc:batch" });
    const mixed = post([
      { jsonrpc: "2.0", id: 1, method: "eth_getLogs" },
      { jsonrpc: "2.0", id: 2, method: "eth_getLogs" },
      { jsonrpc: "2.0", id: 3, method: "eth_chainId" },
    ]);
    expect(mixed).toMatchObject({ rpcClass: "large", expectedResponseBytes: CLASS_REPLY_BYTES.large, retryable: false });
    expect(post([{ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction" }, { jsonrpc: "2.0", id: 2, method: "eth_chainId" }]))
      .toMatchObject({ rpcClass: "write", retryable: false });
  });

  it("treats non-POST, non-JSON and non-JSON-RPC bodies as other", () => {
    expect(profileRequest("GET", undefined, new Uint8Array(0)).rpcClass).toBe("other");
    expect(profileRequest("POST", "text/plain", encoder.encode("hello")).rpcClass).toBe("other");
    expect(profileRequest("POST", undefined, encoder.encode("{broken")).rpcClass).toBe("other");
    expect(post({ hello: 1 }).rpcClass).toBe("other");
    expect(post([]).rpcClass).toBe("other");
    expect(profileRequest("POST", undefined, encoder.encode('  {"jsonrpc":"2.0","id":1,"method":"eth_chainId"}')).rpcClass).toBe("small");
  });
});

describe("errors", () => {
  it("carry stable codes, names and messages the reference harness forwards", () => {
    const error = callError(CALL_CODES.timeout, "late");
    expect(error).toBeInstanceOf(Error);
    expect({ name: error.name, message: error.message, code: error.code }).toEqual({
      name: "NoxWorkerError",
      message: "late",
      code: "timeout",
    });
    expect(abortedByHost()).toMatchObject({ name: "AbortError", code: "cancelled" });
    expect(new NoxWorkerError(FAILED_CODES.badConfig, "x").code).toBe("bad-config");
    expect(Object.values(FAILED_CODES).sort()).toEqual([
      "bad-config",
      "internal-error",
      "snapshot-invalid",
      "snapshot-stale",
      "unsupported-platform",
      "wasm-blocked",
    ]);
  });
});

describe("logging", () => {
  it("redacts URLs, long hex, credentials and control characters, bounded in length", () => {
    const text = redact(`fetch https://rpc.test/KEY?x=1 failed\nfor 0x${"ab".repeat(40)} with Bearer tok3n`);
    expect(text).toBe("fetch <url> failed for <hex> with <credential>");
    expect(redact("x".repeat(1_000)).length).toBeLessThanOrEqual(301);
  });

  it("forwards structured entries at or above the level, with redacted string fields", () => {
    const seen: { level: string; args: LogArg[] }[] = [];
    const sink = (level: string) => (...args: LogArg[]) => seen.push({ level, args });
    const log = createLogger({ debug: sink("debug"), info: sink("info"), warn: sink("warn"), error: sink("error") }, "info");
    log.debug("hidden");
    log.info("boot.start", { url: "https://x.test/", n: 1 });
    expect(seen).toEqual([{ level: "info", args: ["nox-worker", "boot.start", { url: "<url>", n: 1 }] }]);
    expect(log.enabled("debug")).toBe(false);
  });
});

describe("storage", () => {
  function memory(): StorageApi & { map: Map<string, Uint8Array>; writes: number } {
    const map = new Map<string, Uint8Array>();
    const store = {
      map,
      writes: 0,
      get: async (key: string) => map.get(key),
      set: async (key: string, value: Uint8Array) => {
        store.writes += 1;
        map.set(key, value);
      },
      delete: async (key: string) => {
        map.delete(key);
      },
      has: async (key: string) => map.has(key),
      list: () => (async function* () {})(),
      clear: async () => map.clear(),
    };
    return store;
  }
  const address = (index: number) => `0x${index.toString(16).padStart(40, "0")}`;

  it("reads a fresh cache for the same snapshot and ignores everything else", async () => {
    const store = memory();
    const put = (value: unknown) => store.map.set(REMOVAL_CACHE_KEY, encoder.encode(JSON.stringify(value)));
    put({ snapshot: "s1", block: 1, removed: [address(3)], at: 1_000 });
    expect(await readRemovalCache(store, "s1", 1_100)).toEqual([address(3)]);
    expect(await readRemovalCache(store, "s2", 1_100)).toEqual([]);
    expect(await readRemovalCache(store, "s1", 1_000 + REMOVAL_CACHE_MAX_AGE_SECONDS + 1)).toEqual([]);
    expect(await readRemovalCache(store, "s1", 999)).toEqual([]);
    put({ snapshot: "s1", block: 1, removed: ["not-an-address"], at: 1_000 });
    expect(await readRemovalCache(store, "s1", 1_100)).toEqual([]);
    store.map.set(REMOVAL_CACHE_KEY, new Uint8Array([0xff]));
    expect(await readRemovalCache(store, "s1", 1_100)).toEqual([]);
    expect(await readRemovalCache(undefined, "s1", 1_100)).toEqual([]);
    const failing = { ...store, get: async () => { throw new Error("quota"); } };
    expect(await readRemovalCache(failing, "s1", 1_100)).toEqual([]);
  });

  it("writes only under nox/v1/, only on change, at most once per interval, with no key material", async () => {
    const store = memory();
    const writer = new RemovalCacheWriter(store, "s1", 7, [], 60_000);
    expect(await writer.update([], 0)).toBe(false);
    expect(await writer.update([address(2)], 1_000)).toBe(true);
    expect(await writer.update([address(2)], 100_000)).toBe(false);
    expect(await writer.update([address(2), address(5)], 30_000)).toBe(false);
    expect(await writer.update([address(5), address(2)], 70_000)).toBe(true);
    expect(store.writes).toBe(2);
    expect([...store.map.keys()].every((key) => key.startsWith("nox/v1/"))).toBe(true);
    const saved = JSON.parse(new TextDecoder().decode(store.map.get(REMOVAL_CACHE_KEY)!)) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(["at", "block", "removed", "snapshot"]);
    expect(saved["removed"]).toEqual([address(2), address(5)]);
  });

  describe("learned-anchor cache", () => {
    const REGISTRY = "421614:0xf7bff88a1412054a001dc4b8acbddad6f9b26cb6";
    const SNAPSHOT_BLOCK = 1_000;
    const NOW = 2_000_000_000;
    const HASH = `0x${"cd".repeat(32)}`;
    const eligible = new Set([address(1), address(2), address(3)]);
    const anchor = (index: number, extra: Record<string, unknown> = {}) => ({
      address: kpsAddressFor(index),
      member: address(index),
      block: SNAPSHOT_BLOCK + 10,
      blockHash: HASH,
      at: NOW - 100,
      ...extra,
    });
    const put = (store: ReturnType<typeof memory>, value: unknown) =>
      store.map.set(LEARNED_CACHE_KEY, encoder.encode(JSON.stringify(value)));
    const read = (store: StorageApi | undefined) => readLearnedCache(store, REGISTRY, SNAPSHOT_BLOCK, eligible, NOW);

    it("returns chain-confirmed anchors of eligible snapshot members and valid first-seen records", async () => {
      const store = memory();
      put(store, {
        registry: REGISTRY,
        anchors: [anchor(1), anchor(2)],
        firstSeen: [{ address: address(9), block: SNAPSHOT_BLOCK + 5, time: NOW - 50 }],
      });
      expect(await read(store)).toEqual({
        learned: [
          { address: kpsAddressFor(1), member: address(1) },
          { address: kpsAddressFor(2), member: address(2) },
        ],
        firstSeen: [{ address: address(9), block: SNAPSHOT_BLOCK + 5, time: NOW - 50 }],
      });
    });

    it("drops stale, future, pre-snapshot and non-member anchors one by one", async () => {
      const store = memory();
      put(store, {
        registry: REGISTRY,
        anchors: [
          anchor(1, { at: NOW - LEARNED_CACHE_MAX_AGE_SECONDS - 1 }),
          anchor(2, { at: NOW + 10 }),
          anchor(3, { block: SNAPSHOT_BLOCK - 1 }),
          anchor(7),
          anchor(2),
        ],
        firstSeen: [
          { address: address(8), block: SNAPSHOT_BLOCK - 1, time: NOW - 50 },
          { address: address(9), block: SNAPSHOT_BLOCK + 1, time: NOW + 50 },
        ],
      });
      expect(await read(store)).toEqual({ learned: [{ address: kpsAddressFor(2), member: address(2) }], firstSeen: [] });
    });

    it("ignores the whole cache on poisoning attempts: other registry, oversize, malformed records, bad bytes", async () => {
      const cases: unknown[] = [
        { registry: "1:0xabc", anchors: [anchor(1)], firstSeen: [] },
        { registry: REGISTRY, anchors: Array.from({ length: LEARNED_CACHE_MAX_ANCHORS + 1 }, () => anchor(1)), firstSeen: [] },
        { registry: REGISTRY, anchors: [anchor(1), anchor(2, { address: "evil.example:15005:uEiB" })], firstSeen: [] },
        { registry: REGISTRY, anchors: [anchor(1, { member: "0xABC" })], firstSeen: [] },
        { registry: REGISTRY, anchors: [anchor(1, { blockHash: "0x12" })], firstSeen: [] },
        { registry: REGISTRY, anchors: [anchor(1)], firstSeen: [{ address: address(9), block: -1, time: 1 }] },
        { registry: REGISTRY, anchors: "nope", firstSeen: [] },
        [anchor(1)],
      ];
      for (const value of cases) {
        const store = memory();
        put(store, value);
        expect(await read(store)).toEqual({ learned: [], firstSeen: [] });
      }
      const store = memory();
      store.map.set(LEARNED_CACHE_KEY, new Uint8Array([0xff, 0xfe]));
      expect(await read(store)).toEqual({ learned: [], firstSeen: [] });
      expect(await read(undefined)).toEqual({ learned: [], firstSeen: [] });
      const failing = { ...memory(), get: async () => { throw new Error("blocked"); } };
      expect(await read(failing)).toEqual({ learned: [], firstSeen: [] });
    });

    it("stores only public chain data: addresses, members, block and first-seen times, snapshot members first, bounded", () => {
      const members = Array.from({ length: 40 }, (_, i) => ({
        address: address(i + 1),
        kpsAddress: i === 5 ? null : kpsAddressFor(i + 1),
        floor: i >= 30,
        probation: i < 30,
      }));
      const cache = learnedCacheFrom(REGISTRY, {
        blockHash: HASH,
        blockNumber: SNAPSHOT_BLOCK + 50,
        blockTimestamp: NOW - 900,
        members,
        firstSeen: [{ address: address(1), block: SNAPSHOT_BLOCK + 50, time: NOW - 900 }],
      }, NOW);
      expect(cache.anchors).toHaveLength(LEARNED_CACHE_MAX_ANCHORS);
      expect(cache.anchors.slice(0, 10).map((entry) => entry.member)).toEqual(members.slice(30).map((member) => member.address));
      expect(cache.anchors.some((entry) => entry.member === address(6))).toBe(false);
      expect(Object.keys(cache.anchors[0]!).sort()).toEqual(["address", "at", "block", "blockHash", "member"]);
    });

    it("writes on change at most once per interval and round-trips through the reader", async () => {
      const store = memory();
      const writer = new LearnedCacheWriter(store, REGISTRY, 60_000);
      const state = {
        blockHash: HASH,
        blockNumber: SNAPSHOT_BLOCK + 50,
        blockTimestamp: NOW - 900,
        members: [{ address: address(1), kpsAddress: kpsAddressFor(1), floor: true, probation: false }],
        firstSeen: [],
      };
      expect(await writer.update(state, NOW * 1000)).toBe(true);
      expect(await writer.update(state, NOW * 1000 + 120_000)).toBe(false);
      const moved = { ...state, members: [{ ...state.members[0]!, kpsAddress: kpsAddressFor(2) }] };
      expect(await writer.update(moved, NOW * 1000 + 30_000)).toBe(false);
      expect(await writer.update(moved, NOW * 1000 + 61_000)).toBe(true);
      expect(store.writes).toBe(2);
      const later = await readLearnedCache(store, REGISTRY, SNAPSHOT_BLOCK, eligible, NOW + 100);
      expect(later.learned).toEqual([{ address: kpsAddressFor(2), member: address(1) }]);
    });
  });
});
