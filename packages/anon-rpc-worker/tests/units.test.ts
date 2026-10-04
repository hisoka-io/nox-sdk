/** Config, JSON-RPC profiling, error codes, logging and storage. */
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, parseConfig } from "../src/config.js";
import { CALL_CODES, FAILED_CODES, NoxWorkerError, abortedByHost, callError } from "../src/errors.js";
import { CLASS_REPLY_BYTES, classifyCall, profileRequest } from "../src/jsonrpc.js";
import { createLogger, redact } from "../src/log.js";
import type { LogArg, StorageApi } from "../src/spec-types.js";
import {
  REMOVAL_CACHE_KEY,
  REMOVAL_CACHE_MAX_AGE_SECONDS,
  RemovalCacheWriter,
  readRemovalCache,
} from "../src/storage.js";
import { kpsAddressFor } from "./helpers/fixtures.js";

const PINNED = new Set([kpsAddressFor(1), kpsAddressFor(2)]);
const encoder = new TextEncoder();

describe("config", () => {
  it("uses defaults for undefined, null and {}", () => {
    expect(parseConfig(undefined, PINNED)).toBe(CONFIG_DEFAULTS);
    expect(parseConfig(null, PINNED)).toBe(CONFIG_DEFAULTS);
    expect(parseConfig({}, PINNED)).toEqual(CONFIG_DEFAULTS);
  });

  it("accepts a full valid config, including a JSON5-parsed object, without mutating it", () => {
    const raw = JSON.parse(
      '{"v":1,"gateways":["' + kpsAddressFor(2) + '"],"logLevel":"warn","attemptTimeoutMs":5000,' +
        '"callDeadlineMs":20000,"maxConcurrentCalls":8,"maxRequestBytes":2048,"maxResponseBytes":100000,' +
        '"surbFormat":"v2","claimIntervalMs":100,"bootRetryMaxMs":10000,"topologySources":3,"warmup":true}',
    ) as Record<string, unknown>;
    const snapshot = JSON.stringify(raw);
    const config = parseConfig(raw, PINNED);
    expect(config).toMatchObject({ gateways: [kpsAddressFor(2)], logLevel: "warn", surbFormat: "v2", warmup: true, topologySources: 3 });
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
    ["gateways empty", { gateways: [] }, /gateways must be a list of 1\.\.16/u],
    ["gateway malformed", { gateways: ["1.2.3.4:15005"] }, /not a KPS address/u],
    ["gateway not pinned", { gateways: [kpsAddressFor(3)] }, /not the KPS address of a node pinned/u],
    ["gateway repeated", { gateways: [kpsAddressFor(1), kpsAddressFor(1)] }, /repeats/u],
  ])("rejects %s with bad-config", (_name, raw, message) => {
    expect(() => parseConfig(raw, PINNED)).toThrow(expect.objectContaining({ code: "bad-config", message: expect.stringMatching(message) }));
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
});
