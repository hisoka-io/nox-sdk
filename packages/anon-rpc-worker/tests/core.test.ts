import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NoxClientConfig } from "@hisoka-io/nox-client";
import { bootBackoffMs, installUnhandledRejectionLog, runNoxWorker, snapshotIdentity, UNHANDLED_REJECTION_EVENT, type WorkerDeps } from "../src/core.js";
import { REMOVAL_CACHE_KEY } from "../src/storage.js";
import type { KpsApi } from "../src/spec-types.js";
import { FakeHarness, idleKps } from "./helpers/fake-harness.js";
import { FakeClient, deferred, exitReply, kpsAddressFor, makePinned, scriptedConnect } from "./helpers/fixtures.js";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on("unhandledRejection", onUnhandled);
});
afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

const RPC_BODY = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}');
const fastSleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

function setup(options: {
  config?: unknown;
  kps?: KpsApi | undefined;
  failures?: { code: string; message?: string }[];
  deps?: Partial<WorkerDeps>;
} = {}) {
  const pinned = makePinned();
  const harness = new FakeHarness(options.config, "kps" in options ? options.kps : idleKps());
  const client = new FakeClient(pinned);
  const scripted = scriptedConnect(client, options.failures);
  const deps: WorkerDeps = {
    snapshot: pinned,
    loadWasm: async () => ({ marker: true }),
    connect: scripted.connect,
    sleep: fastSleep,
    ...options.deps,
  };
  const run = runNoxWorker(harness.api, deps);
  return { pinned, harness, client, configs: scripted.configs, run };
}

function rpcCall(harness: FakeHarness, init: Record<string, unknown> = {}) {
  return harness.fetch("https://rpc.example.test/", {
    method: "POST",
    headers: [["content-type", "application/json"]],
    body: RPC_BODY,
    ...init,
  });
}

describe("boot", () => {
  it("boots with no config from the pinned snapshot in KPS mode and signals ready once", async () => {
    const { harness, configs, pinned } = setup();
    await harness.ready;
    expect(harness.readyCount).toBe(1);
    expect(harness.failures).toEqual([]);
    const config = configs[0] as NoxClientConfig;
    expect(config.mode).toBe("kps");
    expect(config.seeds).toBeUndefined();
    expect(config.ethRpcUrl).toBeUndefined();
    expect(config.transport).toBeUndefined();
    expect(config.wasm).toEqual({ marker: true });
    expect(config.kps?.pinned).toBe(pinned);
    expect(config.kps?.entries).toBeUndefined();
    expect(harness.events("ready")).toHaveLength(1);
  });

  it("passes configured gateways, timeouts and tuning to the client", async () => {
    const gateways = [kpsAddressFor(2), kpsAddressFor(6)];
    const { harness, configs } = setup({
      config: { gateways, attemptTimeoutMs: 5_000, surbFormat: "v1", claimIntervalMs: 100, topologySources: 1 },
    });
    await harness.ready;
    const config = configs[0] as NoxClientConfig;
    expect(config.kps?.entries).toEqual(gateways);
    expect(config.timeoutMs).toBe(5_000);
    expect(config.surbFormat).toBe("v1");
    expect(config.kps?.claimIntervalMs).toBe(100);
    expect(config.kps?.topologySources).toBe(1);
  });

  it("retries transient connect failures with back-off and never signals failure for them", async () => {
    const { harness, configs } = setup({
      failures: [{ code: "KPS_UNAVAILABLE" }, { code: "TRANSPORT_FAILED" }, { code: "TOPOLOGY_FETCH_FAILED" }],
    });
    await harness.ready;
    expect(configs).toHaveLength(4);
    expect(harness.failures).toEqual([]);
    const retries = harness.events("boot.retry").map((entry) => (entry.args[2] as { code: string }).code);
    expect(retries).toEqual(["no-anchor-reachable", "kps-dial-failed", "topology-fetch-failed"]);
  });

  it.each([
    ["a non-object config", "nope", /plain object/u],
    ["an unknown key", { gateway: [] }, /config\.gateway is not a known field/u],
    ["a wrong type", { logLevel: 3 }, /logLevel/u],
    ["an out-of-range value", { callDeadlineMs: 500_000 }, /callDeadlineMs/u],
    ["a gateway outside the pinned set", { gateways: [kpsAddressFor(77)] }, /not the KPS address of a node pinned/u],
  ])("fails with bad-config for %s, before any network use", async (_name, config, message) => {
    const { harness, configs, run } = setup({ config });
    await run;
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]?.code).toBe("bad-config");
    expect(harness.failures[0]?.message).toMatch(message);
    expect(configs).toHaveLength(0);
    expect(harness.readyCount).toBe(0);
    // The cause is logged before signalFailed.
    expect(harness.events("worker.failed")).toHaveLength(1);
  });

  it("fails with snapshot-invalid when the embedded snapshot does not verify", async () => {
    const pinned = makePinned();
    pinned.members[0]!.sphinxKey = "zz";
    const { harness, run } = setup({ deps: { snapshot: pinned } });
    await run;
    expect(harness.failures.map((failure) => failure.code)).toEqual(["snapshot-invalid"]);
  });

  it("fails with unsupported-platform without anonRpcWorker.kps", async () => {
    const { harness, run, configs } = setup({ kps: undefined });
    await run;
    expect(harness.failures.map((failure) => failure.code)).toEqual(["unsupported-platform"]);
    expect(configs).toHaveLength(0);
  });

  it("fails with unsupported-platform when the harness KPS dial is unsupported", async () => {
    const kps: KpsApi = {
      dial: async () => {
        throw Object.assign(new Error("KPS is not available in this harness"), { code: "unsupported" });
      },
      openStream: async () => {
        throw Object.assign(new Error("KPS is not available in this harness"), { code: "unsupported" });
      },
    };
    const { harness, run } = setup({
      kps,
      deps: {
        connect: async (config) => {
          await config.kps?.dial(kpsAddressFor(1)).catch(() => undefined);
          throw Object.assign(new Error("no anchor"), { code: "KPS_UNAVAILABLE" });
        },
      },
    });
    await run;
    expect(harness.failures.map((failure) => failure.code)).toEqual(["unsupported-platform"]);
  });

  it("fails with wasm-blocked when WebAssembly cannot be compiled", async () => {
    const { harness, run } = setup({
      deps: {
        loadWasm: async () => {
          throw new Error("CompileError: WebAssembly.Module(): Refused to compile");
        },
      },
    });
    await run;
    expect(harness.failures[0]?.code).toBe("wasm-blocked");
    expect(harness.failures[0]?.message).toMatch(/wasm-unsafe-eval/u);
  });

  it("fails with snapshot-stale when the pinned set no longer forms a route", async () => {
    const { harness, run } = setup({ failures: [{ code: "TOPOLOGY_STALE" }] });
    await run;
    expect(harness.failures.map((failure) => failure.code)).toEqual(["snapshot-stale"]);
  });

  it("fails with snapshot-stale when a refresh after ready finds the set stale", async () => {
    let sink: NoxClientConfig["log"];
    const pinned = makePinned();
    const client = new FakeClient(pinned);
    const { harness } = setup({
      deps: {
        snapshot: pinned,
        connect: async (config) => {
          sink = config.log;
          return client;
        },
      },
    });
    await harness.ready;
    sink?.("error", "topology.stale", { sources: 2 });
    expect(harness.failures.map((failure) => failure.code)).toEqual(["snapshot-stale"]);
    expect(client.disconnected).toBe(1);
  });

  it("runs the warm-up echo before ready when configured", async () => {
    const echoed = deferred<void>();
    const pinned = makePinned();
    const client = new FakeClient(pinned);
    client.echo = async (data) => {
      echoed.resolve();
      return data;
    };
    const { harness } = setup({ config: { warmup: true }, deps: { snapshot: pinned, connect: async () => client } });
    await harness.ready;
    await echoed.promise;
    expect((harness.events("boot.warmup")[0]?.args[2] as { ok: boolean }).ok).toBe(true);
  });

  it("orders anchors with the stored removal cache and ignores another snapshot's cache", async () => {
    const pinned = makePinned();
    const removed = [pinned.members[3]!.address];
    const fresh = Math.floor(Date.now() / 1000);
    for (const [snapshot, expected] of [[snapshotIdentity(pinned), removed], ["other", undefined]] as const) {
      const harness = new FakeHarness(undefined, idleKps());
      harness.store.set(
        REMOVAL_CACHE_KEY,
        new TextEncoder().encode(JSON.stringify({ snapshot, block: 1, removed, at: fresh })),
      );
      const scripted = scriptedConnect(new FakeClient(pinned));
      void runNoxWorker(harness.api, { snapshot: pinned, loadWasm: async () => ({}), connect: scripted.connect });
      await harness.ready;
      expect(scripted.configs[0]?.kps?.deprioritize).toEqual(expected);
    }
  });

  it("computes boot back-off within [0.5, 1] of a doubling ceiling", () => {
    expect(bootBackoffMs(1, 60_000, () => 0)).toBe(500);
    expect(bootBackoffMs(1, 60_000, () => 0.999_999)).toBe(1_000);
    expect(bootBackoffMs(4, 60_000, () => 0.999_999)).toBe(8_000);
    expect(bootBackoffMs(20, 60_000, () => 0.999_999)).toBe(60_000);
  });
});

describe("accept loop", () => {
  it("serves calls made before ready once the worker is ready", async () => {
    const gate = deferred<void>();
    const pinned = makePinned();
    const client = new FakeClient(pinned);
    const { harness } = setup({
      deps: {
        snapshot: pinned,
        connect: async () => {
          await gate.promise;
          return client;
        },
      },
    });
    const early = rpcCall(harness);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.requests).toHaveLength(0);
    gate.resolve();
    const response = await early;
    expect(response.status).toBe(200);
    expect(harness.readyCount).toBe(1);
  });

  it("ignores call kinds it does not know and keeps serving", async () => {
    const { harness } = setup();
    await harness.ready;
    harness.pushUnknownKind("subscribe");
    const response = await rpcCall(harness);
    expect(response.status).toBe(200);
  });

  it("answers 50 concurrent calls exactly once each within maxConcurrentCalls", async () => {
    const pinned = makePinned();
    const client = new FakeClient(pinned, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return exitReply(200, [], "{}");
    });
    const { harness } = setup({ config: { maxConcurrentCalls: 4 }, deps: { snapshot: pinned, connect: async () => client } });
    await harness.ready;
    const results = await Promise.all(Array.from({ length: 50 }, () => rpcCall(harness)));
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(harness.respondCounts.every((count) => count === 1)).toBe(true);
    expect(client.maxInFlight).toBeLessThanOrEqual(4);
    expect(client.requests).toHaveLength(50);
  });

  it("signals internal-error and disconnects when acceptCall rejects", async () => {
    const { harness, client } = setup();
    await harness.ready;
    harness.breakAccept(new Error("harness closed"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.events("accept.failed")).toHaveLength(1);
    expect(client.disconnected).toBe(1);
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]).toMatchObject({ code: "internal-error" });
    expect(harness.failures[0]?.message).toContain("acceptCall rejected");
  });

  it("signals internal-error before ready when acceptCall rejects during boot", async () => {
    const gate = deferred<void>();
    const pinned = makePinned();
    const client = new FakeClient(pinned);
    const { harness } = setup({
      deps: {
        snapshot: pinned,
        connect: async () => {
          await gate.promise;
          return client;
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    harness.breakAccept(new Error("harness closed"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]).toMatchObject({ code: "internal-error" });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.readyCount).toBe(0);
    expect(client.disconnected).toBe(1);
  });

  it("rejects an aborted call promptly with AbortError / cancelled", async () => {
    const pinned = makePinned();
    const client = new FakeClient(pinned, () => new Promise<Uint8Array>(() => undefined));
    const { harness } = setup({ deps: { snapshot: pinned, connect: async () => client } });
    await harness.ready;
    const controller = new AbortController();
    const started = Date.now();
    const call = rpcCall(harness, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(call).rejects.toMatchObject({ name: "AbortError", code: "cancelled" });
    expect(Date.now() - started).toBeLessThan(60);
  });

  it("rejects with timeout at the call deadline, including time spent waiting for ready", async () => {
    // Fake timers make the deadline exact: wall-clock bounds flake when the
    // host stalls the event loop (observed stalls of 400-650 ms).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pinned = makePinned();
      const { harness } = setup({
        config: { callDeadlineMs: 3_000, attemptTimeoutMs: 3_000 },
        deps: { snapshot: pinned, connect: () => new Promise(() => undefined) },
      });
      let outcome: unknown;
      rpcCall(harness).then(
        () => (outcome = "resolved"),
        (error: unknown) => (outcome = error),
      );
      // Boot reaches acceptCall through promise jobs only; no timer has to run
      // (vi.waitFor would advance the fake clock while it polls).
      for (let turn = 0; turn < 1_000 && harness.acceptedAt[0] === undefined; turn++) await Promise.resolve();
      expect(harness.acceptedAt[0]).toBeDefined();
      await vi.advanceTimersByTimeAsync(2_999);
      expect(outcome).toBeUndefined();
      expect(harness.readyCount).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toMatchObject({ code: "timeout" });
      expect(harness.readyCount).toBe(0);
      expect(harness.failures).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps client failures to per-call codes without failing the worker", async () => {
    const pinned = makePinned();
    const codes = ["RESPONSE_TIMEOUT", "TRANSPORT_FAILED", "RESPONSE_TOO_LARGE", "DECRYPTION_FAILED", "PACKET_BUILD_FAILED"];
    let next = 0;
    const client = new FakeClient(pinned, () => {
      throw Object.assign(new Error("client failure"), { code: codes[next++] });
    });
    const { harness } = setup({ deps: { snapshot: pinned, connect: async () => client } });
    await harness.ready;
    const seen: string[] = [];
    for (let index = 0; index < codes.length; index++) {
      await rpcCall(harness).catch((error: { code: string }) => seen.push(error.code));
    }
    expect(seen).toEqual(["timeout", "network-error", "too-large", "protocol-error", "internal-error"]);
    expect(harness.failures).toEqual([]);
  });

  it("fails with internal-error after repeated WebAssembly traps", async () => {
    const pinned = makePinned();
    const client = new FakeClient(pinned, () => {
      const trap = Object.assign(new Error("unreachable"), { name: "RuntimeError" });
      throw Object.assign(new Error("Sphinx packet build failed"), { code: "PACKET_BUILD_FAILED", cause: trap });
    });
    const { harness } = setup({ deps: { snapshot: pinned, connect: async () => client } });
    await harness.ready;
    for (let index = 0; index < 3; index++) await rpcCall(harness).catch(() => undefined);
    expect(harness.failures.map((failure) => failure.code)).toEqual(["internal-error"]);
  });

  it("rejects calls after the worker failed", async () => {
    const { harness, run } = setup({ failures: [{ code: "TOPOLOGY_STALE" }] });
    await run;
    await expect(rpcCall(harness)).rejects.toMatchObject({ code: "network-error" });
  });
});

describe("logging policy", () => {
  it("never logs URLs, headers, bodies or signed transactions", async () => {
    const pinned = makePinned();
    const client = new FakeClient(pinned, () => {
      throw Object.assign(new Error("failed for https://rpc.secret.test/KEY 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), {
        code: "TRANSPORT_FAILED",
      });
    });
    const { harness } = setup({ config: { logLevel: "debug" }, deps: { snapshot: pinned, connect: async () => client } });
    await harness.ready;
    const secretTx = `0x${"5ec7e7".repeat(30)}`;
    await harness.fetch("https://rpc.secret.test/v3/SECRET-KEY", {
      method: "POST",
      headers: [["authorization", "Bearer SECRET-TOKEN"]],
      body: new TextEncoder().encode(`{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["${secretTx}"]}`),
    }).catch(() => undefined);
    const text = JSON.stringify(harness.logs);
    expect(harness.events("call.done")).toHaveLength(1);
    for (const secret of ["secret.test", "SECRET", secretTx.slice(2, 40), "deadbeef"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("filters below the configured level", async () => {
    const { harness } = setup({ config: { logLevel: "warn" }, failures: [{ code: "KPS_UNAVAILABLE" }] });
    await harness.ready;
    expect(harness.logs.length).toBeGreaterThan(0);
    expect(harness.logs.every((entry) => entry.level === "warn" || entry.level === "error")).toBe(true);
  });

  it("keeps working when the host log throws", async () => {
    const pinned = makePinned();
    const harness = new FakeHarness(undefined, idleKps());
    const throwing = () => {
      throw new Error("log sink down");
    };
    const api = { ...harness.api, log: { debug: throwing, info: throwing, warn: throwing, error: throwing } };
    void runNoxWorker(api, { snapshot: pinned, loadWasm: async () => ({}), connect: scriptedConnect(new FakeClient(pinned)).connect });
    await harness.ready;
    expect(harness.readyCount).toBe(1);
  });
});

describe("unhandled rejections", () => {
  it("are logged with a code and kept from the default handler", () => {
    const harness = new FakeHarness(undefined, idleKps());
    let listener: ((event: { reason?: unknown; preventDefault?(): void }) => void) | undefined;
    const target = {
      addEventListener: (type: string, fn: typeof listener) => {
        expect(type).toBe("unhandledrejection");
        listener = fn;
      },
    };
    expect(installUnhandledRejectionLog(harness.api, target)).toBe(true);
    let prevented = false;
    listener?.({ reason: Object.assign(new Error("lost https://rpc.example/key"), { code: "E_LOST" }), preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    const entries = harness.events(UNHANDLED_REJECTION_EVENT);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]?.args)).toContain("E_LOST");
    expect(JSON.stringify(entries[0]?.args)).not.toContain("rpc.example");
  });

  it("are skipped on a global without addEventListener", () => {
    const harness = new FakeHarness(undefined, idleKps());
    expect(installUnhandledRejectionLog(harness.api, {})).toBe(false);
  });
});
