import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KPS_TRANSPORT_DEFAULTS,
  KpsHttpTransport,
  resolveKpsTransportSettings,
} from "../src/kps/transport.js";
import { NoxKpsError } from "../src/kps/errors.js";
import { NoxClientError, NoxClientErrorCode } from "../src/types.js";
import type { NoxKpsTransportEvent, NoxKpsTransportSettings } from "../src/kps/types.js";
import { FakeKpsNetwork, json, kpsAddressFor } from "./helpers/fake_kps.js";

const A = kpsAddressFor(1);
const B = kpsAddressFor(2);

function transport(
  network: FakeKpsNetwork,
  overrides: Partial<NoxKpsTransportSettings> = {},
  events?: NoxKpsTransportEvent[],
): KpsHttpTransport {
  return new KpsHttpTransport(
    network.dialer,
    resolveKpsTransportSettings(overrides),
    events === undefined ? undefined : (event) => events.push(event),
  );
}

async function expectKpsFailure(promise: Promise<unknown>, code: string): Promise<NoxKpsError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NoxKpsError);
    expect((error as NoxKpsError).code).toBe(code);
    return error as NoxKpsError;
  }
  throw new Error(`expected NoxKpsError(${code})`);
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
      headers: { "Content-Type": "application/octet-stream" },
      body: packet,
    });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(202);
    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("got 32768");
    const [request] = network.requests;
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/api/v1/packets");
    expect(request?.headers).toContainEqual(["host", A.slice(A.lastIndexOf(":") + 1)]);
    expect(request?.headers).toContainEqual(["content-length", "32768"]);
    expect(request?.body).toEqual(packet);
    kps.close();
  });

  it("reuses one connection and opens one stream per request", async () => {
    const network = new FakeKpsNetwork();
    network.route(undefined, () => json(200, []));
    const kps = transport(network);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        kps.fetch(`kps:${A}/api/v1/responses/claim`, { method: "POST", body: JSON.stringify({ surb_ids: [] }) })
      ),
    );
    expect(results.every((response) => response.status === 200)).toBe(true);
    expect(network.dials).toEqual([A]);
    expect(network.streamsOpened).toBe(6);
    await sleep(0);
    expect(network.streamsClosed).toBe(6);
    await kps.fetch(`kps:${B}/topology`);
    expect(network.dials).toEqual([A, B]);
    kps.close();
  });

  it("maps 204 to a null-body Response and keeps response headers", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 204, reason: "No Content", headers: [["x-a", "1"], ["x-a", "2"]], contentLength: false }));
    const kps = transport(network);
    const response = await kps.fetch(`kps:${A}/api/v1/responses/claim`, { method: "POST", body: "{}" });
    expect(response.status).toBe(204);
    expect(response.headers.get("x-a")).toBe("1, 2");
    expect(await response.text()).toBe("");
    kps.close();
  });

  it("refuses non-kps targets without dialing or touching the global fetch", async () => {
    const network = new FakeKpsNetwork();
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const kps = transport(network);
    await expectKpsFailure(kps.fetch("https://nox-1.hisoka.io/api/v1/packets", { method: "POST" }), "unsupported");
    await expectKpsFailure(kps.fetch("http://127.0.0.1:15002/topology"), "unsupported");
    expect(network.dials).toEqual([]);
    expect(globalFetch).not.toHaveBeenCalled();
    kps.close();
  });

  it("refuses request bodies it cannot carry", async () => {
    const network = new FakeKpsNetwork();
    const kps = transport(network);
    await expectKpsFailure(
      kps.fetch(`kps:${A}/x`, { method: "POST", body: new Blob(["x"]) }),
      "unsupported",
    );
    kps.close();
  });

  it("re-dials after the connection closes", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => json(200, { ok: true }));
    const kps = transport(network);
    await kps.fetch(`kps:${A}/topology`);
    network.connections[0]!.kill();
    await sleep(0);
    expect(kps.isConnected(A)).toBe(false);
    await kps.fetch(`kps:${A}/topology`);
    expect(network.dials).toEqual([A, A]);
    kps.close();
  });

  it("fails in-flight exchanges when their connection dies", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ hang: true }));
    const kps = transport(network);
    const pending = kps.fetch(`kps:${A}/api/v1/responses/claim`, { method: "POST", body: "{}" });
    await sleep(5);
    network.connections[0]!.kill();
    await expectKpsFailure(pending, "closed");
    kps.close();
  });

  it("shares one in-flight dial between concurrent callers", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => json(200, {}));
    const dial = vi.spyOn(network.dialer, "dial");
    const kps = transport(network);
    await Promise.all([kps.warm(A), kps.warm(A), kps.fetch(`kps:${A}/topology`)]);
    expect(dial).toHaveBeenCalledTimes(1);
    kps.close();
  });

  it("bounds the dial and cools the address down after a failure", async () => {
    const network = new FakeKpsNetwork();
    network.hangDial.add(A);
    const events: NoxKpsTransportEvent[] = [];
    const kps = transport(network, { dialTimeoutMs: 30, redialBaseMs: 200, redialMaxMs: 400 }, events);
    await expectKpsFailure(kps.warm(A), "timeout");
    expect(kps.isCoolingDown(A)).toBe(true);
    // During the cooldown the address fails fast without another dial.
    const fast = await expectKpsFailure(kps.fetch(`kps:${A}/topology`), "network-error");
    expect(fast.message).toMatch(/cooling down/u);
    expect(network.dials).toEqual([A]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "dial-failed", code: "timeout", failures: 1, retryInMs: 200 }),
    );
    kps.close();
  });

  it("doubles the cooldown per consecutive failure up to the cap", async () => {
    const network = new FakeKpsNetwork();
    network.refuse.add(A);
    const events: NoxKpsTransportEvent[] = [];
    const kps = transport(network, { redialBaseMs: 10, redialMaxMs: 25 }, events);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expectKpsFailure(kps.warm(A), "network-error");
      await sleep(30);
    }
    const waits = events.flatMap((event) => (event.type === "dial-failed" ? [event.retryInMs] : []));
    expect(waits).toEqual([10, 20, 25]);
    network.refuse.delete(A);
    network.route(A, () => json(200, {}));
    await kps.fetch(`kps:${A}/topology`);
    expect(kps.isConnected(A)).toBe(true);
    kps.close();
  });

  it("closes a connection that finishes dialing after its deadline", async () => {
    const network = new FakeKpsNetwork();
    let release!: () => void;
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = network.dialer.dial;
    vi.spyOn(network.dialer, "dial").mockImplementation(async (address, opts) => {
      await late;
      return original(address, opts);
    });
    const kps = transport(network, { dialTimeoutMs: 20 });
    await expectKpsFailure(kps.warm(A), "timeout");
    release();
    await sleep(5);
    expect(network.connections[0]?.open).toBe(false);
    kps.close();
  });

  it("bounds openStream and drops a wedged connection", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => json(200, {}));
    const kps = transport(network, { openStreamTimeoutMs: 20 });
    await kps.warm(A);
    network.connections[0]!.hangOpenStream = true;
    await expectKpsFailure(kps.fetch(`kps:${A}/topology`), "timeout");
    expect(network.connections[0]!.open).toBe(false);
    await kps.fetch(`kps:${A}/topology`);
    expect(network.dials).toEqual([A, A]);
    kps.close();
  });

  it("bounds the wait for the response head", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ hang: true }));
    const kps = transport(network, { headTimeoutMs: 25 });
    const error = await expectKpsFailure(kps.fetch(`kps:${A}/topology`), "timeout");
    expect(error.message).toMatch(/no response head within 25 ms/u);
    kps.close();
  });

  it("bounds the whole exchange", async () => {
    const network = new FakeKpsNetwork();
    network.hangDial.add(A);
    const kps = transport(network, { exchangeTimeoutMs: 20, dialTimeoutMs: 10_000 });
    await expectKpsFailure(kps.fetch(`kps:${A}/topology`), "timeout");
    kps.close();
  });

  it("rejects with the caller's abort reason and releases the stream", async () => {
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
    kps.close();
  });

  it("caps concurrent streams per connection and queues the rest in order", async () => {
    const network = new FakeKpsNetwork();
    const gates: (() => void)[] = [];
    network.route(A, () => new Promise((resolve) => gates.push(() => resolve(json(200, {})))));
    const kps = transport(network, { maxConcurrentStreams: 2 });
    const all = Array.from({ length: 5 }, () => kps.fetch(`kps:${A}/topology`));
    await sleep(10);
    expect(network.streamsOpened).toBe(2);
    while (network.streamsOpened < 5 || gates.length > 0) {
      gates.shift()?.();
      await sleep(5);
    }
    const responses = await Promise.all(all);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    kps.close();
  });

  it("reports protocol violations from the peer", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ raw: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n" }));
    const events: NoxKpsTransportEvent[] = [];
    const kps = transport(network, {}, events);
    await expectKpsFailure(kps.fetch(`kps:${A}/topology`), "protocol-error");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "exchange-failed", code: "protocol-error", route: "/topology" }),
    );
    kps.close();
  });

  it("caps response bodies", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 200, body: "x".repeat(2048), contentLength: false }));
    const kps = transport(network, { maxResponseBytes: 1024 });
    await expectKpsFailure(kps.fetch(`kps:${A}/topology`), "too-large");
    kps.close();
  });

  it("fails waiting and new exchanges once closed", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ hang: true }));
    const kps = transport(network);
    const pending = kps.fetch(`kps:${A}/topology`);
    await sleep(5);
    kps.close();
    await expectKpsFailure(pending, "closed");
    await expectKpsFailure(kps.fetch(`kps:${A}/topology`), "closed");
    expect(network.connections[0]!.open).toBe(false);
  });

  it("never lets a throwing event hook break an exchange", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => json(200, {}));
    const kps = new KpsHttpTransport(network.dialer, resolveKpsTransportSettings({}), () => {
      throw new Error("hook");
    });
    expect((await kps.fetch(`kps:${A}/topology`)).status).toBe(200);
    kps.close();
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
      expect(() => resolveKpsTransportSettings(bad as Partial<NoxKpsTransportSettings>)).toThrow(
        expect.objectContaining({ code: NoxClientErrorCode.InvalidConfig }),
      );
    }
  });

  it("requires a dialer with dial()", () => {
    expect(() => new KpsHttpTransport({} as never)).toThrow(NoxClientError);
  });
});
