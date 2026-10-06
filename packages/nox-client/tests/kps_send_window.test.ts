import { describe, expect, it } from "vitest";
import {
  KPS_WARMUP_TARGET,
  KpsHttpTransport,
  kpsWarmupRounds,
  resolveKpsTransportSettings,
  type KpsTransportSettings,
} from "../src/kps/transport.js";
import { NoxClientError } from "../src/types.js";
import type { KpsConnLike, KpsDial, KpsStreamLike } from "../src/types.js";
import { FakeKpsNetwork, kpsAddressFor, type FakeRequest } from "./helpers/fake_kps.js";

const A = kpsAddressFor(1);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wrap a dialer so every stream write's size is recorded. */
function recordingDial(network: FakeKpsNetwork, writes: number[]): KpsDial {
  return async (address, opts) => {
    const conn = await network.dial(address, opts);
    const wrapped: KpsConnLike = {
      closed: conn.closed,
      close: (reason) => conn.close(reason),
      openStream: async (streamOpts) => {
        const stream: KpsStreamLike = await conn.openStream(streamOpts);
        const inner = stream.writable.getWriter();
        const writable = new WritableStream<Uint8Array>({
          write: (chunk) => {
            writes.push(chunk.length);
            return inner.write(chunk);
          },
          close: () => inner.close(),
          abort: (reason: unknown) => inner.abort(reason),
        });
        return { ...stream, readable: stream.readable, writable, close: stream.close.bind(stream), resetWrite: stream.resetWrite.bind(stream) };
      },
    };
    return wrapped;
  };
}

function transport(dial: KpsDial, overrides: Partial<KpsTransportSettings> = {}): KpsHttpTransport {
  return new KpsHttpTransport(dial, resolveKpsTransportSettings(overrides), undefined, () => 1);
}

function warmupClaims(requests: readonly FakeRequest[]): FakeRequest[] {
  return requests.filter((request) => {
    if (request.path !== KPS_WARMUP_TARGET) return false;
    const parsed = JSON.parse(new TextDecoder().decode(request.body)) as { surb_ids: unknown[] };
    return parsed.surb_ids.length === 0;
  });
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await sleep(5);
  }
}

describe("chunked request writes", () => {
  it("writes a 32 KB packet as writes of at most writeChunkBytes, byte for byte", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 202, body: "" }));
    const writes: number[] = [];
    const kps = transport(recordingDial(network, writes), { warmupBytes: 0 });
    const packet = new Uint8Array(32_768).map((_, i) => (i * 31) & 0xff);
    const response = await kps.fetch(`kps:${A}/api/v1/packets`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: packet,
    });
    expect(response.status).toBe(202);
    expect(Math.max(...writes)).toBeLessThanOrEqual(4_600);
    expect(writes.length).toBeGreaterThanOrEqual(8);
    expect(network.requests[0]?.body).toEqual(packet);
    await kps.close();
  });

  it("writes a small request in one write", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 200, body: "ok" }));
    const writes: number[] = [];
    const kps = transport(recordingDial(network, writes), { warmupBytes: 0 });
    await (await kps.fetch(`kps:${A}/health`)).text();
    expect(writes).toHaveLength(1);
    await kps.close();
  });
});

describe("send-window warm-up", () => {
  it("plans growing rounds that add up to warmupBytes", () => {
    expect(kpsWarmupRounds(0)).toEqual([]);
    expect(kpsWarmupRounds(96_000)).toEqual([12_000, 18_000, 27_000, 39_000]);
    const big = kpsWarmupRounds(400_000);
    expect(big.reduce((sum, size) => sum + size, 0)).toBe(400_000);
    expect(Math.max(...big)).toBeLessThanOrEqual(60_000);
  });

  it("accepts warmupBytes 0 and refuses a zero write size", () => {
    expect(resolveKpsTransportSettings({ warmupBytes: 0 }).warmupBytes).toBe(0);
    expect(() => resolveKpsTransportSettings({ writeChunkBytes: 0 })).toThrow(NoxClientError);
  });

  it("pads the connection with claims that name no reply, once per connection", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 204 }));
    const kps = transport(network.dial, { warmupRoundGapMs: 5 });
    kps.warmUp([A]);
    await kps.warm(A);
    await until(() => warmupClaims(network.requests).length === 4);
    const claims = warmupClaims(network.requests);
    expect(claims.map((claim) => claim.body.length)).toEqual([12_000, 18_000, 27_000, 39_000]);
    expect(claims.every((claim) => claim.headers.some(([name, value]) => name === "content-type" && value === "application/json"))).toBe(true);
    kps.warmUp([A]);
    await sleep(50);
    expect(warmupClaims(network.requests)).toHaveLength(4);
    await kps.close();
  });

  it("yields to an exchange already in flight", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, (request) => (request.path === "/api/v1/packets" ? { hang: true } : { status: 204 }));
    const kps = transport(network.dial, { warmupRoundGapMs: 5, exchangeTimeoutMs: 1_000 });
    await kps.warm(A);
    const held = kps.fetch(`kps:${A}/api/v1/packets`, { method: "POST", body: new Uint8Array(10) }).catch(() => undefined);
    await sleep(10);
    kps.warmUp([A]);
    await sleep(60);
    expect(warmupClaims(network.requests)).toHaveLength(0);
    await kps.close();
    await held;
  });

  it("stops at warmupMaxBytesPerMinute", async () => {
    const network = new FakeKpsNetwork();
    network.route(A, () => ({ status: 204 }));
    const kps = transport(network.dial, { warmupRoundGapMs: 5, warmupMaxBytesPerMinute: 20_000 });
    kps.warmUp([A]);
    await kps.warm(A);
    await sleep(80);
    expect(warmupClaims(network.requests).map((claim) => claim.body.length)).toEqual([12_000]);
    await kps.close();
  });

  it("sends nothing when warmupBytes is 0 or the address is no longer a target", async () => {
    const network = new FakeKpsNetwork();
    network.route(undefined, () => ({ status: 204 }));
    const off = transport(network.dial, { warmupBytes: 0, warmupRoundGapMs: 5 });
    off.warmUp([A]);
    await off.warm(A);
    await sleep(40);
    expect(warmupClaims(network.requests)).toHaveLength(0);
    await off.close();

    const B = kpsAddressFor(2);
    const kps = transport(network.dial, { warmupRoundGapMs: 5 });
    kps.warmUp([A]);
    kps.warmUp([B]);
    await kps.warm(A);
    await sleep(40);
    expect(warmupClaims(network.requests).filter((claim) => claim.address === A)).toHaveLength(0);
    await kps.close();
  });
});
