import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoxClientConfig } from "@hisoka-io/nox-client";
import { runNoxWorker, type NoxClientPort, type WorkerDeps } from "../src/core.js";
import { isolationKeyOf, MAX_ISOLATION_KEY_LENGTH } from "../src/isolation.js";
import { FakeHarness, idleKps } from "./helpers/fake-harness.js";
import { FakeClient, deferred, exitReply, fakeTlsBindings, makeBootstrap, makePinned, tlsOff } from "./helpers/fixtures.js";

const RPC_BODY = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}');

/** A worker whose every `connect` returns a new client, so each lane is visible. */
function setup(config: Record<string, unknown> = {}, extra: Partial<WorkerDeps> = {}) {
  const pinned = makePinned();
  const harness = new FakeHarness(tlsOff(config), idleKps());
  const clients: FakeClient[] = [];
  const configs: NoxClientConfig[] = [];
  const failNext: { count: number } = { count: 0 };
  const deps: WorkerDeps = {
    snapshot: pinned,
    bootstrap: makeBootstrap(pinned),
    loadWasm: async () => ({ marker: true }),
    loadTls: async () => fakeTlsBindings(),
    connect: async (cfg): Promise<NoxClientPort> => {
      configs.push(cfg);
      if (failNext.count > 0) {
        failNext.count -= 1;
        throw Object.assign(new Error("No KPS entry answered"), { code: "KPS_UNAVAILABLE" });
      }
      const client = new FakeClient(pinned);
      clients.push(client);
      return client;
    },
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    ...extra,
  };
  void runNoxWorker(harness.api, deps);
  return { harness, clients, configs, failNext };
}

function call(harness: FakeHarness, init: Record<string, unknown> = {}) {
  return harness.fetch("https://rpc.example.test/", {
    method: "POST",
    headers: [["content-type", "application/json"]],
    body: RPC_BODY,
    ...init,
  });
}

function keyed(key: string, init: Record<string, unknown> = {}) {
  return { anonOptions: { isolationKey: key }, ...init };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isolationKeyOf", () => {
  it("reads the key and ignores options it does not know", () => {
    expect(isolationKeyOf(undefined)).toBeUndefined();
    expect(isolationKeyOf({})).toBeUndefined();
    expect(isolationKeyOf({ anonOptions: {} })).toBeUndefined();
    expect(isolationKeyOf({ anonOptions: { isolationKey: "a", later: 1 } })).toBe("a");
    expect(isolationKeyOf({ anonOptions: { isolationKey: "" } })).toBe("");
  });

  it("refuses a malformed key with unsupported", () => {
    for (const init of [
      { anonOptions: null },
      { anonOptions: [] },
      { anonOptions: "a" },
      { anonOptions: { isolationKey: 1 } },
      { anonOptions: { isolationKey: "x".repeat(MAX_ISOLATION_KEY_LENGTH + 1) } },
    ]) {
      expect(() => isolationKeyOf(init as never)).toThrow(expect.objectContaining({ code: "unsupported" }));
    }
  });
});

describe("isolation lanes", () => {
  it("serves each key on its own client and calls without a key on the boot client", async () => {
    const { harness, clients, configs } = setup();
    await harness.ready;
    expect(clients).toHaveLength(1);
    const boot = clients[0]!;

    await call(harness);
    await call(harness, keyed("site-a"));
    await call(harness, keyed("site-a"));
    await call(harness, keyed("site-b"));
    await call(harness, keyed(""));

    expect(clients).toHaveLength(4);
    expect(boot.requests).toHaveLength(1);
    expect(clients[1]!.requests).toHaveLength(2);
    expect(clients[2]!.requests).toHaveLength(1);
    expect(clients[3]!.requests).toHaveLength(1);
    // Every lane connects with the boot client's settings.
    for (const config of configs) expect(config).toBe(configs[0]);
  });

  it("never logs the key", async () => {
    const { harness } = setup({ logLevel: "debug" });
    await harness.ready;
    await call(harness, keyed("secret-origin-0x1234"));
    expect(JSON.stringify(harness.logs)).not.toContain("secret-origin-0x1234");
    expect(harness.events("isolation.ready")).toHaveLength(1);
  });

  it("ignores forwarded fetch init entries", async () => {
    const { harness, clients } = setup();
    await harness.ready;
    const response = await call(harness, { cache: "no-store", priority: "high", custom: { bytes: new Uint8Array([1]) } });
    expect(response.status).toBe(200);
    expect(clients).toHaveLength(1);
  });

  it("refuses a malformed key before anything enters the mixnet", async () => {
    const { harness, clients } = setup();
    await harness.ready;
    await expect(call(harness, { anonOptions: { isolationKey: 7 } })).rejects.toMatchObject({ code: "unsupported" });
    expect(clients).toHaveLength(1);
    expect(clients[0]!.requests).toHaveLength(0);
  });

  it("closes the least recently used idle lane when the slots are full", async () => {
    let tick = 0;
    const { harness, clients } = setup({ maxIsolationKeys: 2 }, { now: () => (tick += 1) });
    await harness.ready;
    await call(harness, keyed("a"));
    await call(harness, keyed("b"));
    await call(harness, keyed("a"));
    await call(harness, keyed("c"));
    const [, a, b, c] = clients;
    expect(b!.disconnected).toBe(1);
    expect(a!.disconnected).toBe(0);
    expect(c!.requests).toHaveLength(1);
    // "b" comes back on a new client, never on another key's.
    await call(harness, keyed("b"));
    expect(clients).toHaveLength(5);
    expect(clients[4]!.requests).toHaveLength(1);
  });

  it("refuses a new key while every slot has a call in flight, instead of sharing a lane", async () => {
    const pinned = makePinned();
    const gate = deferred<void>();
    const harness = new FakeHarness(tlsOff({ maxIsolationKeys: 1 }), idleKps());
    const clients: FakeClient[] = [];
    void runNoxWorker(harness.api, {
      snapshot: pinned,
      bootstrap: makeBootstrap(pinned),
      loadWasm: async () => ({}),
      loadTls: async () => fakeTlsBindings(),
      connect: async () => {
        const client = new FakeClient(pinned, async () => {
          if (clients.length > 1) await gate.promise;
          return exitReply(200, [], "{}");
        });
        clients.push(client);
        return client;
      },
    });
    await harness.ready;
    const held = call(harness, keyed("a"));
    await vi.waitFor(() => expect(clients[1]?.inFlight).toBe(1));
    await expect(call(harness, keyed("b"))).rejects.toMatchObject({ code: "network-error" });
    expect(clients).toHaveLength(2);
    expect(clients[1]!.requests).toHaveLength(1);
    gate.resolve();
    expect((await held).status).toBe(200);
  });

  it("fails the call when a lane cannot connect, and connects again on the next call", async () => {
    const { harness, clients, failNext } = setup();
    await harness.ready;
    failNext.count = 1;
    await expect(call(harness, keyed("a"))).rejects.toMatchObject({ code: "network-error" });
    expect(clients).toHaveLength(1);
    const response = await call(harness, keyed("a"));
    expect(response.status).toBe(200);
    expect(clients).toHaveLength(2);
  });

  it("closes a lane after isolationIdleMs without calls", async () => {
    let now = 1_000_000;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { harness, clients } = setup({ isolationIdleMs: 10_000 }, { now: () => now });
    await harness.ready;
    await call(harness, keyed("a"));
    const lane = clients[1]!;
    now += 4_000;
    vi.advanceTimersByTime(5_000);
    expect(lane.disconnected).toBe(0);
    now += 10_000;
    vi.advanceTimersByTime(5_000);
    expect(lane.disconnected).toBe(1);
    expect(clients[0]!.disconnected).toBe(0);
  });

  it("disconnects every lane when the worker fails", async () => {
    const { harness, clients } = setup();
    await harness.ready;
    await call(harness, keyed("a"));
    await call(harness, keyed("b"));
    harness.breakAccept(new Error("harness gone"));
    await harness.failed;
    expect(clients.map((client) => client.disconnected)).toEqual([1, 1, 1]);
  });
});
