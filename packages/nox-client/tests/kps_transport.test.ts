import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KPS_TRANSPORT_DEFAULTS,
  KpsHttpTransport,
  kpsFailurePhase,
  resolveKpsTransportSettings,
  type KpsFailureCause,
  type KpsTransportSettings,
} from "../src/kps/transport.js";
import { createKpsFetch } from "../src/kps/fetch.js";
import { NoxClientError, NoxClientErrorCode, type NoxLogLevel, type PinnedSnapshot } from "../src/types.js";
import { FakeKpsNetwork, json, kpsAddressFor } from "./helpers/fake_kps.js";

const A = kpsAddressFor(1);
const B = kpsAddressFor(2);

interface LoggedEvent {
  level: NoxLogLevel;
  event: string;
  fields: Readonly<Record<string, string | number | boolean>> | undefined;
}

function transport(
  network: FakeKpsNetwork,
  overrides: Partial<KpsTransportSettings> = {},
  events?: LoggedEvent[],
): KpsHttpTransport {
  return new KpsHttpTransport(
    network.dial,
    resolveKpsTransportSettings(overrides),
    events === undefined ? undefined : (level, event, fields) => events.push({ level, event, fields }),
    () => 1,
  );
}

async function expectTransportFailure(
  promise: Promise<unknown>,
  phase: KpsFailureCause["phase"],
  kpsCode?: string,
): Promise<NoxClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NoxClientError);
    expect((error as NoxClientError).name).toBe("NoxClientError");
    expect((error as NoxClientError).code).toBe(NoxClientErrorCode.TransportFailed);
    const cause = (error as NoxClientError).cause as KpsFailureCause;
    expect(cause.phase).toBe(phase);
    if (kpsCode !== undefined) expect(cause.kpsCode).toBe(kpsCode);
    return error as NoxClientError;
  }
  throw new Error(`expected TRANSPORT_FAILED during ${phase}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("KpsHttpTransport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries a POST over one KPS stream and returns a real Response", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, (request) => ({ status: 202, reason: "Accepted", body: `got ${request.body.length}` }));
    const kps = transport(network);
    const packet = new Uint8Array(32_768).fill(7);
    const response = await kps.fetch(`kps:${A}/api/v1/packets`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Ignored": "1" },
      body: packet,
    });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("got 32768");
    const [request] = network.requests;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/api/v1/packets");
    // Exactly Host, Content-Type and Content-Length (ARCHITECTURE §3.5).
    expect(request?.headers).toEqual([
      ["host", A.slice(A.lastIndexOf(":") + 1)],
      ["content-type", "application/octet-stream"],
      ["content-length", "32768"],
    ]);
    expect(request?.body).toEqual(packet);
    expect(kps.stats()).toMatchObject({ dialsOk: 1, dialsFailed: 0, streamsOpened: 1 });
    expect(kps.stats().bytesOut).toBeGreaterThan(32_768);
    await kps.close();
  });

  it("carries Accept next to Content-Type (claims ask for the binary batch) and nothing else", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 204, contentLength: false }));
    const kps = transport(network);
    await kps.fetch(`kps:${A}/api/v1/responses/claim`, {
      method: "POST",
      headers: [["accept", "application/vnd.nox.claim-batch"], ["Content-Type", "application/json"], ["Cookie", "x"]],
      body: "{}",
    });
    expect(network.requests[0]?.headers).toEqual([
      ["host", A.slice(A.lastIndexOf(":") + 1)],
      ["content-type", "application/json"],
      ["accept", "application/vnd.nox.claim-batch"],
      ["content-length", "2"],
    ]);
    await kps.close();
  });

  it("measures the round trip of small exchanges and reports dial time", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 200, body: "ok" }));
    const kps = transport(network);
    expect(kps.rttMs(A)).toBeUndefined();
    await kps.fetch(`kps:${A}/health`);
    expect(kps.rttMs(A)).toBeGreaterThanOrEqual(0);
    expect(kps.dialMs(A)).toBeGreaterThanOrEqual(0);
    await kps.close();
  });

  it("dials a claims-lane connection in the background and uses it once up", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 204, contentLength: false }));
    const kps = transport(network);
    const claims = kps.fetchOn("claims");
    // The first claim dials and rides the primary connection; the lane is dialled
    // only once the primary is up (never two dials at once to one address).
    await claims(`kps:${A}/api/v1/responses/claim`, { method: "POST", body: "{}" });
    expect(network.dials).toEqual([A]);
    await claims(`kps:${A}/api/v1/responses/claim`, { method: "POST", body: "{}" });
    await vi.waitFor(() => expect(network.dials).toEqual([A, A]));
    await vi.waitFor(() => expect(kps.isConnected(A)).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await claims(`kps:${A}/api/v1/responses/claim`, { method: "POST", body: "{}" });
    expect(network.connections[0]!.streamsOpened).toBe(2);
    expect(network.connections[1]!.streamsOpened).toBe(1);
    await kps.close();
  });

  it("notifies connection listeners when a connection closes", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 200, body: "ok" }));
    const kps = transport(network);
    const closed: [string, string, boolean][] = [];
    kps.onConnectionClosed((address, lane, clean) => closed.push([address, lane, clean]));
    await kps.fetch(`kps:${A}/health`);
    network.connections[0]!.kill();
    await vi.waitFor(() => expect(closed).toEqual([[A, "primary", false]]));
    await kps.close();
  });

  it("reuses one connection and opens one stream per request", async () => {
    const network = new FakeKpsNetwork();
    network.route(undefined, () => json(200, []));
    const kps = transport(network);
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        kps.fetch(`kps:${A}/api/v1/responses/claim`, { method: "POST", body: JSON.stringify({ surb_ids: [] }) })
      ),
    );
    expect(results.every((response) => response.status === 200)).toBe(true);
    expect(network.dials).toEqual([A]);
    expect(network.streamsOpened).toBe(100);
    await kps.fetch(`kps:${B}/topology`);
    expect(network.dials).toEqual([A, B]);
    await kps.close();
  });

  it("maps 204 to a null-body Response and keeps response headers", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 204, reason: "No Content", headers: [["x-a", "1"], ["x-a", "2"]], contentLength: false }));
    const kps = transport(network);
    const response = await kps.fetch(`kps:${A}/api/v1/responses/claim`, { method: "POST", body: "{}" });
    expect(response.status).toBe(204);
    expect(response.headers.get("x-a")).toBe("1, 2");
    expect(await response.text()).toBe("");
    await kps.close();
  });

  it("refuses non-kps endpoints with MODE_VIOLATION, without dialing or the global fetch", async () => {
    const network = new FakeKpsNetwork();
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const kps = transport(network);
    for (const input of ["https://nox-1.hisoka.io/api/v1/packets", "http://127.0.0.1:15002/topology", "kps:bad/x"]) {
      const error = await kps.fetch(input, { method: "POST" }).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ code: NoxClientErrorCode.ModeViolation });
      // The message names the scheme, never the full endpoint.
      expect((error as Error).message).not.toContain("nox-1.hisoka.io");
    }
    expect(network.dials).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
    await kps.close();
  });

  it("refuses request bodies it cannot carry", async () => {
    const network = new FakeKpsNetwork();
    const kps = transport(network);
    await expect(kps.fetch(`kps:${A}/x`, { method: "POST", body: new Blob(["x"]) })).rejects.toMatchObject({
      code: "unsupported",
    });
    await kps.close();
  });

  it("redials after the connection closes", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => json(200, { ok: true }));
    const kps = transport(network);
    await kps.fetch(`kps:${A}/topology`);
    network.connections[0]!.kill();
    await sleep(0);
    expect(kps.isConnected(A)).toBe(false);
    await kps.fetch(`kps:${A}/topology`);
    expect(network.dials).toEqual([A, A]);
    await kps.close();
  });

  it("fails in-flight exchanges when their connection dies, without throwing on closed {ok:false}", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ hang: true }));
    const events: LoggedEvent[] = [];
    const kps = transport(network, {}, events);
    const pending = kps.fetch(`kps:${A}/api/v1/responses/claim`, { method: "POST", body: "{}" });
    await sleep(5);
    network.connections[0]!.kill();
    await expectTransportFailure(pending, "read", "closed");
    expect(events).toContainEqual(expect.objectContaining({ event: "kps.conn.closed", fields: expect.objectContaining({ clean: false }) }));
    await kps.close();
  });

  it("shares one in-flight dial between concurrent callers", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => json(200, {}));
    const dial = vi.fn(network.dial);
    const kps = new KpsHttpTransport(dial, resolveKpsTransportSettings({}));
    await Promise.all([kps.warm(A), kps.warm(A), kps.fetch(`kps:${A}/topology`)]);
    expect(dial).toHaveBeenCalledTimes(1);
    await kps.close();
  });

  it("bounds the dial and cools the address down after a failure (phase dial)", async () => {
    const network = new FakeKpsNetwork();
    network.hangDial.add(A);
    const events: LoggedEvent[] = [];
    const kps = transport(network, { dialTimeoutMs: 30, redialBaseMs: 200, redialMaxMs: 400 }, events);
    await expectTransportFailure(kps.warm(A), "dial", "timeout");
    expect(kps.isCoolingDown(A)).toBe(true);
    // During the cooldown the address fails fast without another dial.
    const fast = await expectTransportFailure(kps.fetch(`kps:${A}/topology`), "dial", "network-error");
    expect(fast.message).toMatch(/cooling down/u);
    expect(network.dials).toEqual([A]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "kps.dial.failed",
        fields: expect.objectContaining({ code: "timeout", failures: 1, retryInMs: 200 }),
      }),
    );
    expect(kps.stats().dialsFailed).toBe(1);
    await kps.close();
  });

  it("doubles the cooldown per failure up to the cap, with jitter in [0.5, 1]", async () => {
    const network = new FakeKpsNetwork();
    network.refuse.add(A);
    const events: LoggedEvent[] = [];
    const kps = transport(network, { redialBaseMs: 10, redialMaxMs: 25 }, events);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expectTransportFailure(kps.warm(A), "dial", "network-error");
      await sleep(30);
    }
    const waits = events.flatMap((entry) => (entry.event === "kps.dial.failed" ? [entry.fields?.["retryInMs"]] : []));
    expect(waits).toEqual([10, 20, 25]);
    network.refuse.delete(A);
    network.route(A, () => json(200, {}));
    await kps.fetch(`kps:${A}/topology`);
    expect(kps.isConnected(A)).toBe(true);
    await kps.close();

    const jittered = new KpsHttpTransport(network.dial, resolveKpsTransportSettings({ redialBaseMs: 100 }), undefined, () => 0);
    network.refuse.add(B);
    await expect(jittered.warm(B)).rejects.toBeInstanceOf(NoxClientError);
    expect(jittered.isCoolingDown(B)).toBe(true);
    await jittered.close();
  });

  it("closes a connection that finishes dialing after its deadline", async () => {
    const network = new FakeKpsNetwork();
    let release!: () => void;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dial = async (address: string, opts?: { signal?: AbortSignal }) => {
      await late;
      return network.dial(address, opts);
    };
    const kps = new KpsHttpTransport(dial, resolveKpsTransportSettings({ dialTimeoutMs: 20 }));
    await expectTransportFailure(kps.warm(A), "dial", "timeout");
    release();
    await sleep(5);
    expect(network.connections[0]?.open).toBe(false);
    await kps.close();
  });

  it("bounds openStream (phase open) and evicts a wedged connection", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => json(200, {}));
    const kps = transport(network, { openStreamTimeoutMs: 20 });
    await kps.warm(A);
    network.connections[0]!.hangOpenStream = true;
    await expectTransportFailure(kps.fetch(`kps:${A}/topology`), "open", "timeout");
    expect(network.connections[0]!.open).toBe(false);
    await kps.fetch(`kps:${A}/topology`);
    expect(network.dials).toEqual([A, A]);
    await kps.close();
  });

  it("bounds the whole exchange (phase read when the reply never comes)", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ hang: true }));
    const kps = transport(network, { exchangeTimeoutMs: 25 });
    const error = await expectTransportFailure(kps.fetch(`kps:${A}/topology`), "read", "timeout");
    expect(error.message).toMatch(/timed out after 25 ms/u);
    expect(kpsFailurePhase(error)).toBe("read");
    await kps.close();
  });

  it("rejects with the caller's abort reason and resets the stream", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ hang: true }));
    const kps = transport(network);
    const controller = new AbortController();
    const pending = kps.fetch(`kps:${A}/api/v1/responses/claim`, {
      method: "POST",
      body: "{}",
      signal: controller.signal,
    });
    await sleep(5);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await sleep(0);
    expect(network.streamsClosed).toBe(1);
    const already = new AbortController();
    already.abort(new Error("stop"));
    await expect(kps.fetch(`kps:${A}/topology`, { signal: already.signal })).rejects.toThrow("stop");
    await kps.close();
  });

  it("caps concurrent streams per connection and queues the rest in order", async () => {
    const network = new FakeKpsNetwork();
    const gates: (() => void)[] = [];
    network.route(A, () => new Promise((resolve) => gates.push(() => resolve(json(200, {})))));
    const kps = transport(network, { maxStreamsPerConnection: 2 });
    const all = Array.from({ length: 5 }, () => kps.fetch(`kps:${A}/topology`));
    await sleep(10);
    expect(network.streamsOpened).toBe(2);
    while (network.streamsOpened < 5 || gates.length > 0) {
      gates.shift()?.();
      await sleep(5);
    }
    const responses = await Promise.all(all);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    await kps.close();
  });

  it("reports peer protocol violations as phase parse", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ raw: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n" }));
    const events: LoggedEvent[] = [];
    const kps = transport(network, {}, events);
    await expectTransportFailure(kps.fetch(`kps:${A}/topology`), "parse", "protocol-error");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "kps.exchange.failed",
        fields: expect.objectContaining({ code: "protocol-error", route: "/topology", phase: "parse" }),
      }),
    );
    await kps.close();
  });

  it("caps response bodies", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 200, body: "x".repeat(2048), contentLength: false }));
    const kps = transport(network, { maxBodyBytes: 1024 });
    await expectTransportFailure(kps.fetch(`kps:${A}/topology`), "parse", "too-large");
    await kps.close();
  });

  it("fails waiting and new exchanges once closed", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ hang: true }));
    const kps = transport(network);
    const pending = kps.fetch(`kps:${A}/topology`);
    await sleep(5);
    await kps.close();
    await expectTransportFailure(pending, "read", "closed");
    await expectTransportFailure(kps.fetch(`kps:${A}/topology`), "dial", "closed");
    expect(network.connections[0]!.open).toBe(false);
  });

  it("never lets a throwing log sink break an exchange", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => json(200, {}));
    const kps = new KpsHttpTransport(network.dial, resolveKpsTransportSettings({}), () => {
      throw new Error("sink");
    });
    expect((await kps.fetch(`kps:${A}/topology`)).status).toBe(200);
    await kps.close();
  });

  it("sends keepalives on kept idle connections and closes extra idle ones", async () => {
    const network = new FakeKpsNetwork();
    network.route(undefined, (request) => json(200, { path: request.path }));
    const C = kpsAddressFor(3);
    const kps = transport(network, {
      maintenanceIntervalMs: 10,
      keepaliveMs: 30,
      idleCloseMs: 30,
      idleConnectionsKept: 2,
    });
    await kps.fetch(`kps:${C}/topology`);
    await sleep(2);
    await kps.fetch(`kps:${B}/topology`);
    await sleep(2);
    await kps.fetch(`kps:${A}/topology`);
    await sleep(120);
    // C is the least recently used of three idle connections: closed.
    expect(kps.isConnected(C)).toBe(false);
    expect(kps.isConnected(A)).toBe(true);
    expect(kps.isConnected(B)).toBe(true);
    const keepalives = network.requests.filter((request) => request.path === "/health");
    expect(keepalives.length).toBeGreaterThan(0);
    expect(new Set(keepalives.map((request) => request.address))).toEqual(new Set([A, B]));
    await kps.close();
  });
});

describe("resolveKpsTransportSettings", () => {
  it("fills defaults and accepts overrides", () => {
    expect(resolveKpsTransportSettings(undefined)).toEqual(KPS_TRANSPORT_DEFAULTS);
    expect(resolveKpsTransportSettings({ dialTimeoutMs: 5 }).dialTimeoutMs).toBe(5);
  });

  it("rejects unknown keys and non-positive values", () => {
    for (const bad of [
      { dialTimeout: 5 },
      { dialTimeoutMs: 0 },
      { dialTimeoutMs: -1 },
      { dialTimeoutMs: 1.5 },
      { dialTimeoutMs: "5" },
      { redialBaseMs: 100, redialMaxMs: 50 },
    ]) {
      expect(() => resolveKpsTransportSettings(bad as Partial<KpsTransportSettings>)).toThrow(
        expect.objectContaining({ code: NoxClientErrorCode.InvalidConfig }),
      );
    }
  });

  it("requires a dial function", () => {
    expect(() => new KpsHttpTransport({} as never)).toThrow(NoxClientError);
  });
});

describe("createKpsFetch", () => {
  it("is a callable fetch with close() and stats()", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => json(200, { ok: true }));
    const kpsFetch = createKpsFetch({
      dial: network.dial,
      pinned: {} as PinnedSnapshot,
      exchangeTimeoutMs: 1_000,
    });
    const response = await kpsFetch(`kps:${A}/topology`);
    expect(await response.json()).toEqual({ ok: true });
    expect(kpsFetch.stats()).toMatchObject({ dialsOk: 1, streamsOpened: 1 });
    await kpsFetch.close();
    await expect(kpsFetch(`kps:${A}/topology`)).rejects.toMatchObject({ code: NoxClientErrorCode.TransportFailed });
  });
});
