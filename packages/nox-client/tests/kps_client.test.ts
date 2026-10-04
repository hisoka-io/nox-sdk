/**
 * `NoxClient` in KPS mode, end to end over an in-memory KPS network: pinned
 * bootstrap, entry filter, packets and claims over KPS streams, refresh,
 * failover, abort, size caps, logging and mode validation. Global `fetch` and
 * `WebSocket` throw in every test: KPS mode must never reach them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoxClient } from "../src/client.js";
import { decodeHttpResponse } from "../src/http_response.js";
import {
  NoxClientError,
  NoxClientErrorCode,
  type NoxClientConfig,
  type NoxLogLevel,
  type PinnedSnapshot,
  type TopologyNode,
} from "../src/types.js";
import { FakeKpsNetwork, kpsAddressFor } from "./helpers/fake_kps.js";
import { FakeMixnet, encodeExitHttpResponse, fakeWasmBindings } from "./helpers/fake_mixnet.js";
import { DEFAULT_MEMBERS, makePinned, served, type ServedSpec } from "./helpers/pinned_fixture.js";

const SECRET_URL = "https://rpc.secret-provider.test/v3/SECRET-API-KEY";
const SECRET_BODY = '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0xSECRETTX"]}';

interface LogEntry {
  level: NoxLogLevel;
  event: string;
  fields: Readonly<Record<string, string | number | boolean>> | undefined;
}

interface Bed {
  pinned: PinnedSnapshot;
  network: FakeKpsNetwork;
  mixnet: FakeMixnet;
  logs: LogEntry[];
  servedSpec: ServedSpec;
  config(extra?: Partial<NoxClientConfig>, kps?: Record<string, unknown>): NoxClientConfig;
}

function bed(pinned: PinnedSnapshot = makePinned()): Bed {
  const network = new FakeKpsNetwork();
  const logs: LogEntry[] = [];
  const result: Bed = {
    pinned,
    network,
    logs,
    servedSpec: {},
    mixnet: new FakeMixnet(
      () => served(pinned, Math.floor(Date.now() / 1000), result.servedSpec),
      () => encodeExitHttpResponse(200, [["content-type", "application/json"]], '{"jsonrpc":"2.0","id":1,"result":"0x10"}'),
    ),
    config: (extra = {}, kps = {}) => ({
      mode: "kps",
      wasm: fakeWasmBindings(),
      timeoutMs: 2_000,
      log: (level, event, fields) => logs.push({ level, event, fields }),
      kps: { dial: network.dial, pinned, topologySources: 1, ...kps },
      ...extra,
    }),
  };
  network.route(undefined, result.mixnet.handler);
  return result;
}

const clients: NoxClient[] = [];

async function connect(config: NoxClientConfig): Promise<NoxClient> {
  const client = await NoxClient.connect(config);
  clients.push(client);
  return client;
}

function entryNodes(client: NoxClient): TopologyNode[] {
  return client.nodes.filter((node) => node.address.length > 0);
}

const ambientFetch = vi.fn(() => {
  throw new Error("KPS mode must never call the global fetch");
});

class AmbientWebSocket {
  constructor() {
    throw new Error("KPS mode must never open a WebSocket");
  }
}

beforeEach(() => {
  ambientFetch.mockClear();
  vi.stubGlobal("fetch", ambientFetch);
  vi.stubGlobal("WebSocket", AmbientWebSocket);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("KPS mode connect", () => {
  it("boots from the pinned snapshot over KPS and serves httpRequest through the mixnet", async () => {
    const t = bed();
    const client = await connect(t.config());

    expect(client.entryUrl.startsWith("kps:")).toBe(true);
    expect(t.network.dials.length).toBeGreaterThanOrEqual(1);
    expect(t.network.requests.some((request) => request.path === "/topology")).toBe(true);

    const reply = await client.httpRequest(
      "POST",
      "https://rpc.example.test/",
      [["content-type", "application/json"]],
      new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'),
    );
    const decoded = decodeHttpResponse(reply);
    expect(decoded.status).toBe(200);
    expect(new TextDecoder().decode(decoded.body)).toContain('"result":"0x10"');

    const request = t.mixnet.served[0];
    expect(request).toMatchObject({ tag: "HttpRequest", method: "POST", url: "https://rpc.example.test/" });
    expect(t.network.requests.some((r) => r.path === "/api/v1/packets")).toBe(true);
    expect(t.network.requests.some((r) => r.path === "/api/v1/responses/claim")).toBe(true);
    // One connection to the entry carried topology, packet and claims.
    const entryAddress = client.entryUrl.slice("kps:".length);
    expect(t.network.dials.filter((address) => address === entryAddress)).toHaveLength(1);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("routes only through pinned members and uses only KPS-capable ones as entries", async () => {
    const t = bed(makePinned([...DEFAULT_MEMBERS.slice(0, 3), { role: 1, kps: false }, { role: 1, kps: false }, ...DEFAULT_MEMBERS.slice(5)]));
    const client = await connect(t.config());
    const plan = Reflect.get(client, "_planRoute") as (exit: undefined, avoid: Set<string>) => { route: { entry: TopologyNode } };
    const allowed = new Set([1, 2, 3, 6, 7, 8].map((index) => `kps:${kpsAddressFor(index)}`));
    for (let i = 0; i < 300; i++) {
      const { route } = plan.call(client, undefined, new Set());
      expect(allowed.has(route.entry.address)).toBe(true);
    }
    expect(client.nodes.map((node) => node.id).sort()).toEqual(t.pinned.members.map((member) => member.address));
    const ids = new Set(t.pinned.members.map((member) => member.address));
    expect(client.nodes.every((node) => ids.has(node.id))).toBe(true);
  });

  it("restricts entries and anchors to kps.entries", async () => {
    const t = bed();
    const only = [kpsAddressFor(2), kpsAddressFor(7)];
    const client = await connect(t.config({}, { entries: only, topologySources: 2 }));
    expect(new Set(t.network.dials).size).toBeLessThanOrEqual(2);
    expect(t.network.dials.every((address) => only.includes(address))).toBe(true);
    expect(entryNodes(client).map((node) => node.address).sort()).toEqual(only.map((a) => `kps:${a}`).sort());
  });

  it("dials deprioritised members last as boot anchors", async () => {
    for (let round = 0; round < 5; round++) {
      const t = bed();
      const others = t.pinned.members.slice(1).map((member) => member.address);
      await connect(t.config({}, { deprioritize: others, anchorParallelism: 1 }));
      expect(t.network.dials[0]).toBe(kpsAddressFor(1));
    }
    const t = bed();
    await expect(connect(t.config({}, { deprioritize: ["0xABC"] }))).rejects.toMatchObject({
      code: NoxClientErrorCode.InvalidConfig,
    });
  });

  it("ignores members a served topology adds and drops members every source omits", async () => {
    const t = bed();
    t.servedSpec = {
      omit: [4],
      add: [{
        address: "0x00000000000000000000000000000000000000ff",
        sphinx_key: "ff".repeat(32),
        url: "/ip4/10.9.9.9/tcp/15000/p2p/x",
        stake: "0",
        last_seen: 0,
        is_privileged: true,
        layer: 0,
        role: 1,
        ingress_url: "",
        metadata_url: "",
      }],
    };
    const client = await connect(t.config({}, { entries: [kpsAddressFor(1)] }));
    const ids = client.nodes.map((node) => node.id);
    expect(ids).not.toContain("0x00000000000000000000000000000000000000ff");
    expect(ids).not.toContain(t.pinned.members[3]!.address);
    expect(ids).toHaveLength(t.pinned.members.length - 1);
    expect(t.logs.find((entry) => entry.event === "topology.accepted")?.fields).toMatchObject({ ignoredAdditions: 1, removed: 1 });
  });

  it("fails with KPS_UNAVAILABLE when no anchor answers, and never falls back to HTTPS", async () => {
    const t = bed();
    for (let index = 1; index <= t.pinned.members.length; index++) t.network.refuse.add(kpsAddressFor(index));
    await expect(connect(t.config({}, { dialTimeoutMs: 500 }))).rejects.toMatchObject({
      code: NoxClientErrorCode.KpsUnavailable,
    });
    expect(new Set(t.network.dials).size).toBe(t.pinned.members.length);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("declares the snapshot stale when two sources agree the pinned set has no route", async () => {
    const t = bed();
    t.servedSpec = { offline: [6, 7, 8] };
    await expect(connect(t.config({}, { topologySources: 2 }))).rejects.toMatchObject({
      code: NoxClientErrorCode.TopologyStale,
    });
  });

  it("verifies the pinned snapshot before any dial", async () => {
    const t = bed();
    const tampered = structuredClone(t.pinned);
    tampered.members[2]!.sphinxKey = "00".repeat(32);
    tampered.members[0]!.address = "0x0000000000000000000000000000000000000000";
    await expect(connect(t.config({}, { pinned: tampered }))).rejects.toMatchObject({
      code: NoxClientErrorCode.TopologyVerificationFailed,
    });
    expect(t.network.dials).toHaveLength(0);
  });
});

describe("KPS mode validation (no silent fallback)", () => {
  it.each([
    ["seeds", { seeds: ["https://seed.test"] }],
    ["ethRpcUrl", { ethRpcUrl: "https://rpc.test" }],
    ["transport", { transport: { WebSocket: null } }],
    ["dangerouslySkipFingerprintCheck", { dangerouslySkipFingerprintCheck: true }],
  ])("refuses the classic-only field %s", async (_name, extra) => {
    const t = bed();
    await expect(connect(t.config(extra as Partial<NoxClientConfig>))).rejects.toMatchObject({
      code: NoxClientErrorCode.ModeViolation,
    });
    expect(t.network.dials).toHaveLength(0);
  });

  it("refuses kps options in classic mode", async () => {
    const t = bed();
    await expect(connect({ kps: t.config().kps })).rejects.toMatchObject({ code: NoxClientErrorCode.ModeViolation });
  });

  it("refuses an unknown mode, a missing dialer, unknown kps keys and out-of-range values", async () => {
    const t = bed();
    await expect(connect({ ...t.config(), mode: "https" as "kps" })).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
    await expect(connect(t.config({}, { dial: undefined }))).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
    await expect(connect(t.config({}, { gateway: "x" }))).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
    await expect(connect(t.config({}, { topologySources: 5 }))).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
    await expect(connect(t.config({}, { dialTimeoutMs: 0 }))).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
  });

  it("refuses entries that are not pinned members' KPS addresses", async () => {
    const t = bed();
    const stranger = kpsAddressFor(99);
    await expect(connect(t.config({}, { entries: [stranger] }))).rejects.toMatchObject({
      code: NoxClientErrorCode.InvalidConfig,
    });
    await expect(connect(t.config({}, { entries: [] }))).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
    await expect(connect(t.config({}, { entries: [kpsAddressFor(1), kpsAddressFor(1)] }))).rejects.toMatchObject({
      code: NoxClientErrorCode.InvalidConfig,
    });
  });

  it("requires injected WASM with the exports the client calls", async () => {
    const t = bed();
    const noWasm = t.config();
    delete noWasm.wasm;
    await expect(connect(noWasm)).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
    const partial = fakeWasmBindings();
    delete partial["create_surb"];
    await expect(connect(t.config({ wasm: partial }))).rejects.toMatchObject({
      code: NoxClientErrorCode.WasmNotInitialized,
    });
    await expect(connect(t.config({ wasm: () => { throw new Error("CompileError: blocked by CSP"); } }))).rejects.toMatchObject({
      code: NoxClientErrorCode.WasmNotInitialized,
    });
    expect(t.network.dials).toHaveLength(0);
  });

  it("accepts a registryAddress equal to the pinned registry and refuses another", async () => {
    const t = bed();
    await expect(connect(t.config({ registryAddress: "0x0000000000000000000000000000000000000001" }))).rejects.toMatchObject({
      code: NoxClientErrorCode.InvalidConfig,
    });
    const client = await connect(t.config({ registryAddress: t.pinned.registry.toUpperCase().replace("0X", "0x") }));
    expect(client.entryUrl.startsWith("kps:")).toBe(true);
  });

  it("refuses non-kps endpoints on the client's transport", async () => {
    const t = bed();
    const client = await connect(t.config());
    await expect(client.fetch("https://nox-1.test/api/v1/packets", { method: "POST" })).rejects.toMatchObject({
      code: NoxClientErrorCode.ModeViolation,
    });
    expect(ambientFetch).not.toHaveBeenCalled();
  });
});

describe("KPS mode requests", () => {
  it("rejects at once with ABORTED when the caller aborts, and discards the late reply", async () => {
    const t = bed();
    t.mixnet.replyDelayMs = 300;
    const client = await connect(t.config());
    const controller = new AbortController();
    const started = Date.now();
    const pending = client.httpRequest("GET", "https://example.test/", [], new Uint8Array(0), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: NoxClientErrorCode.Aborted });
    expect(Date.now() - started).toBeLessThan(250);
    expect((Reflect.get(client, "pending") as Map<bigint, unknown>).size).toBe(0);
  });

  it("rejects before sending when the signal is already aborted", async () => {
    const t = bed();
    const client = await connect(t.config());
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.httpRequest("GET", "https://example.test/", [], new Uint8Array(0), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: NoxClientErrorCode.Aborted });
    expect(t.mixnet.served).toHaveLength(0);
  });

  it("fails with RESPONSE_TOO_LARGE above maxResponseBytes", async () => {
    const t = bed();
    t.mixnet.exit = () => encodeExitHttpResponse(200, [], "x".repeat(5_000));
    const client = await connect(t.config());
    await expect(
      client.httpRequest("GET", "https://example.test/", [], new Uint8Array(0), { maxResponseBytes: 1_000 }),
    ).rejects.toMatchObject({ code: NoxClientErrorCode.ResponseTooLarge });
  });

  it("raises the reply-block count to minSurbs", async () => {
    const t = bed();
    const client = await connect(t.config());
    await client.httpRequest("GET", "https://example.test/", [], new Uint8Array(0), {
      minSurbs: 4,
      expectedResponseBytes: 10,
      opKey: "http:jsonrpc:eth_chainId",
    });
    await client.httpRequest("GET", "https://example.test/", [], new Uint8Array(0), { expectedResponseBytes: 10 });
    expect(t.mixnet.surbCounts).toEqual([4, 1]);
  });

  it("validates httpRequest options", async () => {
    const t = bed();
    const client = await connect(t.config());
    await expect(
      client.httpRequest("GET", "https://example.test/", [], new Uint8Array(0), { retry: "always" as "none" }),
    ).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
    await expect(
      client.httpRequest("GET", "https://example.test/", [], new Uint8Array(0), { maxResponseBytes: -1 }),
    ).rejects.toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
  });

  it("resends a request that was never sent through another entry, then moves the pinned entry", async () => {
    const t = bed();
    const client = await connect(t.config());
    const first = client.entryUrl;
    const firstAddress = first.slice("kps:".length);
    // The entry dies and refuses redials: phase "dial", the packet was never sent.
    t.network.refuse.add(firstAddress);
    for (const conn of t.network.connections) if (conn.address === firstAddress) conn.kill();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const body = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}');
    const reply = await client.httpRequest("POST", "https://example.test/", [], body);
    expect(decodeHttpResponse(reply).status).toBe(200);
    expect(t.mixnet.served).toHaveLength(1);
    expect(t.logs.some((entry) => entry.event === "kps.resend" && entry.fields?.["reason"] === "not-sent")).toBe(true);

    await client.httpRequest("POST", "https://example.test/", [], body);
    expect(t.mixnet.served).toHaveLength(2);
    expect(client.entryUrl).not.toBe(first);
    expect(t.logs.some((entry) => entry.event === "entry.switch")).toBe(true);
  });

  it("never resends a POST whose packet may have reached the entry", async () => {
    const t = bed();
    const client = await connect(t.config());
    const entryAddress = client.entryUrl.slice("kps:".length);
    t.network.route(entryAddress, (request) =>
      request.path === "/api/v1/packets" ? { status: 503, body: "busy" } : t.mixnet.handler(request)
    );
    await expect(
      client.httpRequest("POST", "https://example.test/", [], new TextEncoder().encode("{}")),
    ).rejects.toMatchObject({ code: NoxClientErrorCode.TransportFailed });
    const packets = t.network.requests.filter((request) => request.path === "/api/v1/packets");
    expect(packets).toHaveLength(1);
  });

  it("resends a GET through another entry after the entry refuses the packet", async () => {
    const t = bed();
    const client = await connect(t.config());
    const entryAddress = client.entryUrl.slice("kps:".length);
    t.network.route(entryAddress, (request) =>
      request.path === "/api/v1/packets" ? { status: 503, body: "busy" } : t.mixnet.handler(request)
    );
    const reply = await client.httpRequest("GET", "https://example.test/", [], new Uint8Array(0));
    expect(decodeHttpResponse(reply).status).toBe(200);
    const packets = t.network.requests.filter((request) => request.path === "/api/v1/packets");
    expect(packets).toHaveLength(2);
    expect(packets[1]!.address).not.toBe(entryAddress);
  });
});

describe("KPS mode background work", () => {
  it("claims replies with at most one claim in flight per entry", async () => {
    const t = bed();
    const client = await connect(t.config({}, { claimIntervalMs: 10 }));
    const entryAddress = client.entryUrl.slice("kps:".length);
    let claims = 0;
    t.network.route(entryAddress, (request) => {
      if (request.path === "/api/v1/responses/claim") {
        claims += 1;
        return { hang: true };
      }
      return t.mixnet.handler(request);
    });
    const pending = client.httpRequest("GET", "https://example.test/", [], new Uint8Array(0), { timeoutMs: 300 });
    await expect(pending).rejects.toMatchObject({ code: NoxClientErrorCode.ResponseTimeout });
    expect(claims).toBe(1);
  });

  it("refreshes over KPS with the removals-only rule and brings recovered members back", async () => {
    const t = bed();
    const client = await connect(t.config({ topologyRefreshMs: 40 }, { entries: [kpsAddressFor(1), kpsAddressFor(2)], topologySources: 2 }));
    expect(client.nodes).toHaveLength(8);

    t.servedSpec = { offline: [5] };
    await vi.waitFor(() => expect(client.nodes.map((node) => node.id)).not.toContain(t.pinned.members[4]!.address), {
      timeout: 2_000,
      interval: 20,
    });

    t.servedSpec = {};
    await vi.waitFor(() => expect(client.nodes).toHaveLength(8), { timeout: 2_000, interval: 20 });
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("logs topology.stale and keeps routing when refresh sources agree the set is gone", async () => {
    const t = bed();
    const client = await connect(t.config({ topologyRefreshMs: 40 }, { entries: [kpsAddressFor(1), kpsAddressFor(2)], topologySources: 2 }));
    t.servedSpec = { offline: [6, 7, 8] };
    await vi.waitFor(() => expect(t.logs.some((entry) => entry.event === "topology.stale")).toBe(true), {
      timeout: 2_000,
      interval: 20,
    });
    expect(client.topologyRefreshError?.code).toBe(NoxClientErrorCode.TopologyStale);
    expect(client.nodes).toHaveLength(8);
  });

  it("closes every KPS connection on disconnect", async () => {
    const t = bed();
    const client = await connect(t.config());
    expect(t.network.connections.some((conn) => conn.open)).toBe(true);
    client.disconnect();
    await vi.waitFor(() => expect(t.network.connections.every((conn) => !conn.open)).toBe(true));
  });

  it("never logs request URLs, bodies or full KPS addresses", async () => {
    const t = bed();
    const client = await connect(t.config());
    await client.httpRequest("POST", SECRET_URL, [["authorization", "Bearer SECRET"]], new TextEncoder().encode(SECRET_BODY));
    t.network.route(client.entryUrl.slice("kps:".length), () => ({ status: 500, body: SECRET_BODY }));
    await expect(
      client.httpRequest("POST", SECRET_URL, [], new TextEncoder().encode(SECRET_BODY), { timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(NoxClientError);
    const text = JSON.stringify(t.logs);
    expect(t.logs.length).toBeGreaterThan(0);
    for (const secret of ["SECRET", "secret-provider", "https://", kpsAddressFor(1), "10.0.0."]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("WASM injection in classic mode", () => {
  it("uses the injected bindings instead of importing @hisoka-io/nox-wasm", async () => {
    const client = Object.create(NoxClient.prototype) as NoxClient;
    const bindings = fakeWasmBindings();
    Reflect.set(client, "_wasm", null);
    Reflect.set(client, "_wasmProvider", () => bindings);
    await (Reflect.get(client, "_initWasm") as () => Promise<void>).call(client);
    expect(client.wasm).toBe(bindings);
  });
});
