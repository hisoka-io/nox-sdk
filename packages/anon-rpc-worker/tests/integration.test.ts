/**
 * The worker core on the real SDK: `NoxClient.connect({ mode: "kps" })` over
 * an in-memory KPS network (SPEC §10 capability), fake WASM, and a fake exit.
 * Global `fetch` and `WebSocket` throw: the worker must never use them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoxClient, type ServiceRequest } from "@hisoka-io/nox-client";
import { runNoxWorker } from "../src/core.js";
import { FakeHarness } from "./helpers/fake-harness.js";
import { FakeNoxNetwork, fakeWasm } from "./helpers/fake-nox-network.js";
import { exitReply, fakeTlsBindings, kpsAddressFor, makeBootstrap, makePinned, tlsOff } from "./helpers/fixtures.js";

const ambientFetch = vi.fn(() => {
  throw new Error("the worker must never call the global fetch");
});

beforeEach(() => {
  ambientFetch.mockClear();
  vi.stubGlobal("fetch", ambientFetch);
  vi.stubGlobal("WebSocket", class {
    constructor() {
      throw new Error("the worker must never open a WebSocket");
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const disconnects: (() => void)[] = [];
afterEach(() => {
  for (const disconnect of disconnects.splice(0)) disconnect();
});

function boot(config: unknown, exit: (request: ServiceRequest) => Uint8Array) {
  const pinned = makePinned();
  const network = new FakeNoxNetwork(pinned, exit);
  const harness = new FakeHarness(tlsOff(config), network.kps);
  void runNoxWorker(harness.api, {
    snapshot: pinned,
    bootstrap: makeBootstrap(pinned),
    loadWasm: async () => fakeWasm(),
    loadTls: async () => fakeTlsBindings(),
    connect: async (clientConfig) => {
      const client = await NoxClient.connect(clientConfig);
      disconnects.push(() => client.disconnect());
      return client;
    },
  });
  return { pinned, network, harness };
}

describe("worker on the real SDK in KPS mode", () => {
  it("boots over KPS and answers JSON-RPC calls through an exit", async () => {
    const { network, harness } = boot({ topologySources: 1 }, (request) => {
      if (request.tag !== "HttpRequest") throw new Error("unexpected request");
      const call = JSON.parse(new TextDecoder().decode(request.body)) as { id: number; method: string };
      return exitReply(
        200,
        [["content-type", "application/json"], ["content-length", "99"]],
        JSON.stringify({ jsonrpc: "2.0", id: call.id, result: call.method === "eth_chainId" ? "0x1" : "0x10" }),
      );
    });
    await harness.ready;
    expect(network.dials.length).toBeGreaterThanOrEqual(1);

    const response = await harness.fetch("https://rpc.example.test/v1", {
      method: "POST",
      headers: [["Content-Type", "application/json"], ["X-Trace", "a"], ["x-trace", "b"]],
      body: new TextEncoder().encode('{"jsonrpc":"2.0","id":7,"method":"eth_chainId","params":[]}'),
    });
    expect(response.status).toBe(200);
    expect(response.headers).toEqual([["content-type", "application/json"]]);
    expect(JSON.parse(new TextDecoder().decode(response.body as Uint8Array))).toEqual({ jsonrpc: "2.0", id: 7, result: "0x1" });

    const sent = network.served[0];
    expect(sent).toMatchObject({ tag: "HttpRequest", method: "POST", url: "https://rpc.example.test/v1" });
    if (sent?.tag !== "HttpRequest") throw new Error("unreachable");
    expect(sent.headers).toEqual([
      ["Content-Type", "application/json"],
      ["X-Trace", "a"],
      ["x-trace", "b"],
      ["accept-encoding", "gzip"],
    ]);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("answers 5 concurrent eth_getBalance calls", async () => {
    const { harness } = boot({ topologySources: 1 }, (request) => {
      if (request.tag !== "HttpRequest") throw new Error("unexpected request");
      const call = JSON.parse(new TextDecoder().decode(request.body)) as { id: number };
      return exitReply(200, [["content-type", "application/json"]], JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "0x2a" }));
    });
    await harness.ready;
    const responses = await Promise.all([1, 2, 3, 4, 5].map((id) =>
      harness.fetch("https://rpc.example.test/", {
        method: "POST",
        headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode(
          JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getBalance", params: ["0x" + "11".repeat(20), "latest"] }),
        ),
      })
    ));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    const ids = responses.map((response) => (JSON.parse(new TextDecoder().decode(response.body as Uint8Array)) as { id: number }).id);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it("restricts entries to configured gateways", async () => {
    const gateways = [kpsAddressFor(3)];
    const { network, harness } = boot({ gateways, topologySources: 1 }, () => exitReply(200, [], "{}"));
    await harness.ready;
    await harness.fetch("https://rpc.example.test/", { method: "POST", body: new TextEncoder().encode("{}") });
    expect(new Set(network.dials)).toEqual(new Set(gateways));
  });

  it("keeps ready pending while no entry answers, then becomes ready when one does", async () => {
    const pinned = makePinned();
    const network = new FakeNoxNetwork(pinned, () => exitReply(200, [], "{}"));
    for (let index = 1; index <= pinned.members.length; index++) network.refused.add(kpsAddressFor(index));
    const harness = new FakeHarness(tlsOff({ topologySources: 1 }), network.kps);
    void runNoxWorker(harness.api, {
      snapshot: pinned,
      bootstrap: makeBootstrap(pinned),
      loadWasm: async () => fakeWasm(),
      loadTls: async () => fakeTlsBindings(),
      connect: async (config) => {
        const client = await NoxClient.connect(config);
        disconnects.push(() => client.disconnect());
        return client;
      },
      sleep: async () => {
        network.refused.clear();
      },
    });
    await harness.ready;
    expect(harness.failures).toEqual([]);
    expect(harness.events("boot.retry").length).toBeGreaterThanOrEqual(1);
  });
});

describe("worker liveness versus registry evidence (real SDK, two anchors)", () => {
  const anchors = { gateways: [kpsAddressFor(1), kpsAddressFor(2)], topologySources: 2 };
  const ok = () => exitReply(200, [["content-type", "application/json"]], '{"jsonrpc":"2.0","id":1,"result":"0x10"}');
  const call = (harness: FakeHarness) =>
    harness.fetch("https://rpc.example.test/", {
      method: "POST",
      headers: [["content-type", "application/json"]],
      body: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'),
    });

  function start(prepare: (network: FakeNoxNetwork, pinned: ReturnType<typeof makePinned>) => void) {
    const pinned = makePinned();
    const network = new FakeNoxNetwork(pinned, ok);
    prepare(network, pinned);
    const harness = new FakeHarness(tlsOff(anchors), network.kps);
    void runNoxWorker(harness.api, {
      snapshot: pinned,
      bootstrap: makeBootstrap(pinned),
      loadWasm: async () => fakeWasm(),
      loadTls: async () => fakeTlsBindings(),
      connect: async (clientConfig) => {
        const client = await NoxClient.connect({ ...clientConfig, topologyRefreshMs: 40 });
        disconnects.push(() => client.disconnect());
        return client;
      },
    });
    const exits = pinned.members.filter((member) => member.role === 2).map((member) => member.address);
    return { pinned, network, harness, exits };
  }

  it("boots and stays up when two anchors list every exit but report them offline", async () => {
    const { harness } = start((network, pinned) => {
      for (const member of pinned.members) if (member.role === 2) network.offline.add(member.address);
    });
    await harness.ready;
    expect(harness.failures).toEqual([]);
    expect(harness.events("topology.offline")).not.toHaveLength(0);
    // The exits keep their pinned place in the working set, so routing goes on.
    const response = await call(harness);
    expect(response.status).toBe(200);
    expect(harness.failures).toEqual([]);
  });

  it("keeps running after ready when a refresh sees every exit offline, then serves calls again", async () => {
    const { network, harness, exits } = start(() => undefined);
    await harness.ready;
    for (const exit of exits) network.offline.add(exit);
    await vi.waitFor(() => expect(harness.events("topology.offline")).not.toHaveLength(0), { timeout: 3_000, interval: 20 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.failures).toEqual([]);
    network.offline.clear();
    const response = await call(harness);
    expect(response.status).toBe(200);
    expect(harness.failures).toEqual([]);
  });

  it("fails with snapshot-stale at boot when two anchors agree every exit left the registry", async () => {
    const { harness } = start((network, pinned) => {
      for (const member of pinned.members) if (member.role === 2) network.omitted.add(member.address);
    });
    await harness.failed;
    expect(harness.failures.map((failure) => failure.code)).toEqual(["snapshot-stale"]);
    expect(harness.readyCount).toBe(0);
  });

  it("fails with snapshot-stale after ready when a refresh finds every exit gone from the registry", async () => {
    const { network, harness, exits } = start(() => undefined);
    await harness.ready;
    for (const exit of exits) network.omitted.add(exit);
    await harness.failed;
    expect(harness.failures.map((failure) => failure.code)).toEqual(["snapshot-stale"]);
  });
});
