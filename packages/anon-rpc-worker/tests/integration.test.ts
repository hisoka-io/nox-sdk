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
import { exitReply, kpsAddressFor, makePinned } from "./helpers/fixtures.js";

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
  const harness = new FakeHarness(config, network.kps);
  void runNoxWorker(harness.api, {
    snapshot: pinned,
    loadWasm: async () => fakeWasm(),
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
      ["accept-encoding", "identity"],
    ]);
    expect(ambientFetch).not.toHaveBeenCalled();
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
    const harness = new FakeHarness({ topologySources: 1 }, network.kps);
    void runNoxWorker(harness.api, {
      snapshot: pinned,
      loadWasm: async () => fakeWasm(),
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
