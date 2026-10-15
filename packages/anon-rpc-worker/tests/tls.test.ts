import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DEFAULTS, type TlsSetting } from "../src/config.js";
import { CALL_CODES } from "../src/errors.js";
import type { PreparedRequest } from "../src/fetch-map.js";
import { profileRequest } from "../src/jsonrpc.js";
import { createLogger } from "../src/log.js";
import { TlsChannel } from "../src/tls/channel.js";
import {
  EXIT_SKIP_MS,
  LATENCY_MIN_SAMPLES,
  NoTunnelExitError,
  SPARE_DELAY_MEAN_MS,
  SPARE_REFILL_JITTER_MS,
  SPARE_REFILL_LEAD_MS,
  SPARE_REFILL_WINDOW_MS,
  TlsPool,
  type PoolSettings,
} from "../src/tls/pool.js";
import { chooseTransport, mapTlsError, requestSurbs, TlsTransport } from "../src/tls/transport.js";
import {
  Tunnel,
  TunnelOpenTimeoutError,
  TunnelProtocolError,
  TunnelRejectedError,
  TunnelTimeoutError,
  type CopyPolicy,
} from "../src/tls/tunnel.js";
import { data, exitNode, FakeTunnelPort, fakeTls, type SentCopy } from "./helpers/fake-tunnel.js";

const text = new TextDecoder();
const POLICY: CopyPolicy = { copyAfterMs: () => 2_500, gapMs: 800, maxCopies: 2 };
const deps = { now: () => Date.now(), randomBytes: (length: number) => new Uint8Array(length).fill(7) };
const log = createLogger(undefined, "error");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function tunnelUnderTest(port = new FakeTunnelPort()) {
  const delivered: string[] = [];
  const tunnel = new Tunnel(port, exitNode("exit-1"), "rpc.example", 443, POLICY, deps, (bytes) => delivered.push(text.decode(bytes)));
  return { port, tunnel, delivered: () => delivered.join("") };
}

describe("tunnel exchanges", () => {
  it("reorders parts, acks the contiguous point and copies the same seq when a gap stays open", async () => {
    const { port, tunnel, delivered } = tunnelUnderTest();
    const done = tunnel.exchange({
      data: new TextEncoder().encode("HELLO"),
      surbs: 4,
      deadlineAt: Date.now() + 20_000,
      background: false,
      satisfied: () => delivered() === "abcdef",
    });
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]!.request).toMatchObject({ seq: 0, open: { host: "rpc.example", port: 443 }, ackOffset: 0n });
    port.sent[0]!.reply(data(0, 3, "def"));
    expect(delivered()).toBe("");
    await vi.advanceTimersByTimeAsync(800);
    expect(port.sent).toHaveLength(2);
    const copy = port.sent[1]!;
    expect(copy.request.seq).toBe(0);
    expect(copy.request.data).toEqual(port.sent[0]!.request.data);
    expect(copy.exit.id).toBe("exit-1");
    expect([...(copy.options.avoid ?? [])]).toEqual(["entry-1", "mix-1"]);
    copy.reply(data(0, 0, "abc"));
    await expect(done).resolves.toBe("satisfied");
    expect(delivered()).toBe("abcdef");
  });

  it("copies at once on NeedSurbs and Expired, at most maxCopies times on silence, then fails at the deadline", async () => {
    const { port, tunnel } = tunnelUnderTest();
    const done = tunnel.exchange({ data: new Uint8Array([1]), surbs: 2, deadlineAt: Date.now() + 15_000, background: false, satisfied: () => false });
    const rejection = expect(done).rejects.toBeInstanceOf(TunnelTimeoutError);
    port.sent[0]!.reply(data(0, 0, "ab", "NeedSurbs"));
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]!.request.ackOffset).toBe(2n);
    port.sent[1]!.reply(data(0, 2, "", "Expired"));
    expect(port.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2_500 * 4);
    expect(port.sent).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(new Set(port.sent.map((copy) => copy.request.seq))).toEqual(new Set([0]));
  });

  it("keeps one seq in flight: later seqs count up, stale parts are ignored, rejections say whether the only copy was refused", async () => {
    const { port, tunnel, delivered } = tunnelUnderTest();
    const first = tunnel.exchange({ data: new Uint8Array([1]), surbs: 2, deadlineAt: Date.now() + 20_000, background: false, satisfied: () => delivered() === "x" });
    port.sent[0]!.reply(data(0, 0, "x"));
    await first;
    const second = tunnel.exchange({ data: new Uint8Array([2]), surbs: 2, deadlineAt: Date.now() + 20_000, background: false, satisfied: () => false });
    expect(port.sent[1]!.request).toMatchObject({ seq: 1, open: null, ackOffset: 1n });
    expect(port.sent[0]!.reply(data(0, 1, "late"))).toBe("closed");
    port.sent[1]!.reply({ kind: "Rejected", seq: 1, code: "Expired", retryable: false, detail: "tunnel is closed" });
    await expect(second).rejects.toMatchObject({ name: "TunnelRejectedError", code: "Expired", seq: 1, soleCopy: true });
  });

  it("fails an open that gets no answer within the open timeout, and a part that does not decode", async () => {
    const { port, tunnel } = tunnelUnderTest();
    const open = tunnel.exchange({ data: new Uint8Array([1]), surbs: 2, deadlineAt: Date.now() + 25_000, background: false, openTimeoutMs: 5_000, satisfied: () => false });
    const rejection = expect(open).rejects.toBeInstanceOf(TunnelOpenTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;

    const other = tunnelUnderTest(port);
    const broken = other.tunnel.exchange({ data: new Uint8Array([1]), surbs: 2, deadlineAt: Date.now() + 25_000, background: false, satisfied: () => false });
    port.sent.at(-1)!.options.onReply?.(new Uint8Array([1, 9, 9]));
    await expect(broken).rejects.toBeInstanceOf(TunnelProtocolError);
  });
});

describe("TLS channel", () => {
  it("sends the request with the held Finished, and an EOF before the response completes is a truncation", async () => {
    const port = new FakeTunnelPort();
    const tls = fakeTls();
    const channel = new TlsChannel(port, exitNode("exit-1"), "rpc.example", POLICY, deps, tls);
    const handshake = channel.handshake({ deadlineAt: Date.now() + 20_000, background: false, openTimeoutMs: 5_000 });
    expect(text.decode(port.sent[0]!.request.data)).toBe("HELLO");
    port.sent[0]!.reply(data(0, 0, "FLIGHT"));
    await handshake;
    const request = channel.request({
      http: new TextEncoder().encode("GET /\n"),
      headRequest: false,
      maxHeadBytes: 65_536,
      maxBodyBytes: 1_000,
      surbs: 3,
      deadlineAt: Date.now() + 20_000,
      background: false,
    });
    expect(port.sent[1]!.request.seq).toBe(1);
    expect(port.sent[1]!.options.surbs).toBe(3);
    expect(text.decode(port.sent[1]!.request.data)).toBe("FINGET /\n");
    port.sent[1]!.reply(data(1, 6, "partial", "Eof"));
    await expect(request).rejects.toMatchObject({ code: "HTTP_RESPONSE_TRUNCATED" });
  });
});

const POOL: PoolSettings = {
  tlsSession: "per-call",
  tlsSpares: 1,
  tlsSpareTtlMs: 20_000,
  tlsKeepAliveMs: 30_000,
  tlsMaxCallsPerSession: 100,
  tlsOpenTimeoutMs: 5_000,
  tlsCopyAfterMs: 2_500,
  tlsGapMs: 800,
  tlsMaxCopies: 2,
};

function answerOpens(port: FakeTunnelPort, answer: (copy: SentCopy) => void = (copy) => copy.reply(data(0, 0, "FLIGHT"))): void {
  port.onSend = (copy) => {
    if (copy.request.seq === 0) queueMicrotask(() => answer(copy));
  };
}

describe("TLS pool", () => {
  it("opens spares only after the first call settled, after an exponential delay; a spare serves one call and is replaced before its TTL", async () => {
    const port = new FakeTunnelPort();
    answerOpens(port);
    const pool = new TlsPool(port, fakeTls(), POOL, { ...deps, random: () => 0.5, log });
    const timing = { deadlineAt: Date.now() + 25_000 };
    await pool.acquire("rpc.example", timing);
    expect(port.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * SPARE_DELAY_MEAN_MS);
    expect(port.sent).toHaveLength(1);

    pool.enableBackground();
    const delay = Math.round(-Math.log(0.5) * SPARE_DELAY_MEAN_MS);
    await vi.advanceTimersByTimeAsync(delay);
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]!.options.background).toBe(true);

    const spare = await pool.acquire("rpc.example", timing);
    expect(port.sent).toHaveLength(2);
    expect(spare.tunnel.id).toBe(port.sent[1]!.request.tunnelId);

    await vi.advanceTimersByTimeAsync(delay);
    expect(port.sent).toHaveLength(3);
    // The host is recent: the replacement opens at once, LEAD plus jitter before the TTL.
    const refreshAt = POOL.tlsSpareTtlMs - SPARE_REFILL_LEAD_MS - 0.5 * SPARE_REFILL_JITTER_MS;
    await vi.advanceTimersByTimeAsync(refreshAt - 1);
    expect(port.sent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(port.sent[3]!.request).toMatchObject({ seq: 0, close: false });
    expect(port.sent[3]!.options.background).toBe(true);
    await vi.advanceTimersByTimeAsync(POOL.tlsSpareTtlMs - refreshAt);
    const teardown = port.sent[4]!;
    expect(teardown.request).toMatchObject({ seq: 1, close: true, tunnelId: port.sent[2]!.request.tunnelId });
    expect(teardown.options.surbs).toBe(0);
    expect(port.sent).toHaveLength(5);
    pool.close();
  });

  it("skips an exit that answers Disabled or nothing, moves retryable refusals at once and stops at a refusal of the destination", async () => {
    const port = new FakeTunnelPort();
    answerOpens(port, (copy) => {
      if (copy.exit.id === "exit-1") copy.reply({ kind: "Rejected", seq: 0, code: "Disabled", retryable: false, detail: "" });
      if (copy.exit.id === "exit-3") copy.reply(data(0, 0, "FLIGHT"));
    });
    let pick = 0;
    const pool = new TlsPool(port, fakeTls(), { ...POOL, tlsSpares: 0 }, { ...deps, random: () => [0, 0, 0][pick++] ?? 0, log });
    const opened = pool.acquire("rpc.example", { deadlineAt: Date.now() + 25_000 });
    await vi.advanceTimersByTimeAsync(POOL.tlsOpenTimeoutMs);
    expect((await opened).exit.id).toBe("exit-3");
    // exit-2 stays silent: one copy after tlsCopyAfterMs, then the open moves on.
    expect(port.sent.map((copy) => copy.exit.id)).toEqual(["exit-1", "exit-2", "exit-2", "exit-3"]);
    expect(pool.offersTunnels()).toBe(true);
    await pool.acquire("rpc.example", { deadlineAt: Date.now() + 25_000 });
    expect(port.sent.at(-1)!.exit.id).toBe("exit-3");
    vi.setSystemTime(Date.now() + EXIT_SKIP_MS);
    port.exits = [exitNode("exit-1")];
    expect(pool.offersTunnels()).toBe(true);

    const busy = new FakeTunnelPort();
    answerOpens(busy, (copy) =>
      copy.reply(copy.exit.id === "exit-1"
        ? { kind: "Rejected", seq: 0, code: "SessionLimit", retryable: true, detail: "" }
        : { kind: "Rejected", seq: 0, code: "HostNotAllowed", retryable: false, detail: "" }));
    const refused = new TlsPool(busy, fakeTls(), POOL, { ...deps, random: () => 0, log });
    await expect(refused.acquire("rpc.example", { deadlineAt: Date.now() + 25_000 })).rejects.toMatchObject({ code: "HostNotAllowed" });
    expect(busy.sent.map((copy) => copy.exit.id)).toEqual(["exit-1", "exit-2"]);

    busy.exits = [];
    await expect(refused.acquire("rpc.example", { deadlineAt: Date.now() + 25_000 })).rejects.toBeInstanceOf(NoTunnelExitError);
  });
});

/** Live sessions the pool holds: tunnels opened and not closed (every acquired session is released at once). */
function liveTunnels(port: FakeTunnelPort): number {
  const opened = new Set(port.sent.filter((copy) => copy.request.seq === 0 && !copy.request.close).map((copy) => copy.request.tunnelId));
  for (const copy of port.sent) if (copy.request.close) opened.delete(copy.request.tunnelId);
  return opened.size;
}

function opens(port: FakeTunnelPort): number {
  return port.sent.filter((copy) => copy.request.seq === 0 && !copy.request.close).length;
}

describe("TLS spare refill", () => {
  const SPARES: PoolSettings = { ...POOL, tlsSpares: CONFIG_DEFAULTS.tlsSpares, tlsSpareTtlMs: CONFIG_DEFAULTS.tlsSpareTtlMs };
  const timing = () => ({ deadlineAt: Date.now() + 25_000 });

  async function call(pool: TlsPool) {
    const channel = await pool.acquire("rpc.example", timing());
    const info = pool.acquireInfo(channel);
    pool.release(channel, true);
    return info;
  }

  it("never hands out a spare older than its TTL and never holds more than tlsSpares plus the one being replaced", async () => {
    expect(SPARES).toMatchObject({ tlsSpares: 2, tlsSpareTtlMs: 12_000 });
    const port = new FakeTunnelPort();
    answerOpens(port);
    let seed = 7;
    const random = () => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const pool = new TlsPool(port, fakeTls(), SPARES, { ...deps, random, log });
    await call(pool);
    pool.enableBackground();
    const gaps = [1_000, 300, 5_000, 11_000, 11_900, 12_100, 13_000, 15_000, 25_000, 30_000, 60_000, 130_000, 2_000, 15_000, 140_000, 900];
    const paths: [number, string][] = [];
    let maxLive = 0;
    for (const gap of [...gaps, ...gaps]) {
      for (let step = 0; step < gap; step += 100) {
        await vi.advanceTimersByTimeAsync(Math.min(100, gap - step));
        maxLive = Math.max(maxLive, liveTunnels(port));
      }
      const info = await call(pool);
      paths.push([gap, info!.path]);
      if (info!.path === "spare") expect(info!.spareAgeMs!).toBeLessThan(SPARES.tlsSpareTtlMs);
    }
    expect(maxLive).toBeLessThanOrEqual(SPARES.tlsSpares + 1);
    // A recent host keeps a live spare across gaps longer than the TTL; past the window it has none.
    for (const [gap, path] of paths) {
      if (gap >= 5_000 && gap < SPARE_REFILL_WINDOW_MS) expect(path).toBe("spare");
      if (gap > SPARE_REFILL_WINDOW_MS) expect(path).toBe("inline");
    }
    pool.close();
  });

  it("refills before expiry while the host was called within the window, then lets the spare expire unreplaced", async () => {
    const port = new FakeTunnelPort();
    answerOpens(port);
    const pool = new TlsPool(port, fakeTls(), { ...SPARES, tlsSpares: 1 }, { ...deps, random: () => 0.5, log });
    await call(pool);
    pool.enableBackground();
    const delay = Math.round(-Math.log(0.5) * SPARE_DELAY_MEAN_MS);
    await vi.advanceTimersByTimeAsync(delay);
    expect(opens(port)).toBe(2);
    const lastCallAt = Date.now() - delay;
    // About one refresh per (TTL - LEAD - jitter) while the host is recent, each before the old spare's TTL.
    const period = SPARES.tlsSpareTtlMs - SPARE_REFILL_LEAD_MS - 0.5 * SPARE_REFILL_JITTER_MS;
    for (let step = 0; Date.now() < lastCallAt + SPARE_REFILL_WINDOW_MS - 2 * period; step++) {
      await vi.advanceTimersByTimeAsync(period);
      expect(opens(port)).toBe(3 + step);
      expect(liveTunnels(port)).toBeLessThanOrEqual(2);
    }
    await vi.advanceTimersByTimeAsync(2 * period + SPARE_REFILL_WINDOW_MS);
    const settled = opens(port);
    expect(liveTunnels(port)).toBe(0);
    await vi.advanceTimersByTimeAsync(5 * SPARE_REFILL_WINDOW_MS);
    expect(opens(port)).toBe(settled);
    // The window passed: the next call opens inline, as before the refill existed.
    expect(await call(pool)).toMatchObject({ path: "inline", spareAgeMs: undefined });
    pool.close();
  });

  it("does not refill a spare whose TTL is too short for a refresh", async () => {
    const port = new FakeTunnelPort();
    answerOpens(port);
    const pool = new TlsPool(port, fakeTls(), { ...SPARES, tlsSpares: 1, tlsSpareTtlMs: 1_000 }, { ...deps, random: () => 0.5, log });
    await call(pool);
    pool.enableBackground();
    await vi.advanceTimersByTimeAsync(SPARE_REFILL_WINDOW_MS / 2);
    expect(opens(port)).toBe(2);
    expect(liveTunnels(port)).toBe(0);
    pool.close();
  });

  it("waits for a spare open already halfway through its handshake, and opens its own when that open fails", async () => {
    const port = new FakeTunnelPort();
    const HANDSHAKE_MS = 800;
    let refuse = false;
    port.onSend = (copy) => {
      if (copy.request.seq !== 0 || copy.request.close) return;
      const refused = refuse && copy.options.background === true;
      setTimeout(() => copy.reply(refused
        ? { kind: "Rejected", seq: 0, code: "HostNotAllowed", retryable: false, detail: "" }
        : data(0, 0, "FLIGHT")), HANDSHAKE_MS);
    };
    const pool = new TlsPool(port, fakeTls(), { ...SPARES, tlsSpares: 1 }, { ...deps, random: () => 0.5, log });
    const first = pool.acquire("rpc.example", timing());
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS);
    pool.release(await first, true);
    pool.enableBackground();
    const delay = Math.round(-Math.log(0.5) * SPARE_DELAY_MEAN_MS);

    // 500 ms into an 800 ms median handshake: the call takes that open.
    await vi.advanceTimersByTimeAsync(delay + 500);
    expect(opens(port)).toBe(2);
    const waited = pool.acquire("rpc.example", timing());
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS - 500);
    const channel = await waited;
    expect(channel.tunnel.id).toBe(port.sent.filter((copy) => copy.request.seq === 0).at(-1)!.request.tunnelId);
    expect(pool.acquireInfo(channel)).toMatchObject({ path: "waited", openMs: HANDSHAKE_MS - 500 });
    expect(opens(port)).toBe(2);
    pool.release(channel, true);

    // 100 ms in is too early: the call opens its own session.
    await vi.advanceTimersByTimeAsync(delay + 100);
    expect(opens(port)).toBe(3);
    const early = pool.acquire("rpc.example", timing());
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS);
    const own = await early;
    expect(pool.acquireInfo(own)).toMatchObject({ path: "inline" });
    expect(opens(port)).toBe(4);
    pool.release(own, true);
    pool.close();

    // The awaited open fails: the call opens inline.
    const failing = new TlsPool(port, fakeTls(), { ...SPARES, tlsSpares: 1 }, { ...deps, random: () => 0.5, log });
    const seedCall = failing.acquire("rpc.example", timing());
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS);
    failing.release(await seedCall, true);
    refuse = true;
    failing.enableBackground();
    await vi.advanceTimersByTimeAsync(delay + 500);
    const before = opens(port);
    const fallback = failing.acquire("rpc.example", timing());
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS - 500 + HANDSHAKE_MS);
    const inline = await fallback;
    expect(failing.acquireInfo(inline)).toMatchObject({ path: "inline" });
    expect(opens(port)).toBe(before + 1);
    failing.release(inline, true);
    failing.close();
  });

  it("keeps a waited open as a spare when the waiting call aborts", async () => {
    const port = new FakeTunnelPort();
    port.onSend = (copy) => {
      if (copy.request.seq === 0 && !copy.request.close) setTimeout(() => copy.reply(data(0, 0, "FLIGHT")), 800);
    };
    const pool = new TlsPool(port, fakeTls(), { ...SPARES, tlsSpares: 1 }, { ...deps, random: () => 0.5, log });
    const first = pool.acquire("rpc.example", timing());
    await vi.advanceTimersByTimeAsync(800);
    pool.release(await first, true);
    pool.enableBackground();
    await vi.advanceTimersByTimeAsync(Math.round(-Math.log(0.5) * SPARE_DELAY_MEAN_MS) + 500);
    const controller = new AbortController();
    const aborted = pool.acquire("rpc.example", { ...timing(), signal: controller.signal });
    const rejection = expect(aborted).rejects.toBe("caller gave up");
    controller.abort("caller gave up");
    await rejection;
    await vi.advanceTimersByTimeAsync(300);
    const next = await pool.acquire("rpc.example", timing());
    expect(pool.acquireInfo(next)).toMatchObject({ path: "spare" });
    expect(opens(port)).toBe(2);
    pool.close();
  });

  it("does not wait for a spare open that has run past the handshake p95; that open stays a spare", async () => {
    const port = new FakeTunnelPort();
    const HANDSHAKE_MS = 800;
    const STUCK_MS = 4_000;
    port.onSend = (copy) => {
      if (copy.request.seq !== 0 || copy.request.close) return;
      setTimeout(() => copy.reply(data(0, 0, "FLIGHT")), copy.options.background === true ? STUCK_MS : HANDSHAKE_MS);
    };
    const pool = new TlsPool(port, fakeTls(), { ...SPARES, tlsSpares: 1 }, { ...deps, random: () => 0.5, log });
    // Enough inline handshakes for a p95 (800 ms) before background work starts.
    for (let index = 0; index < LATENCY_MIN_SAMPLES; index++) {
      const pending = pool.acquire("rpc.example", timing());
      await vi.advanceTimersByTimeAsync(HANDSHAKE_MS);
      pool.release(await pending, true);
    }
    pool.enableBackground();
    const delay = Math.round(-Math.log(0.5) * SPARE_DELAY_MEAN_MS);
    await vi.advanceTimersByTimeAsync(delay + 2 * HANDSHAKE_MS);
    const before = opens(port);
    const call = pool.acquire("rpc.example", timing());
    await vi.advanceTimersByTimeAsync(HANDSHAKE_MS);
    const own = await call;
    expect(pool.acquireInfo(own)).toMatchObject({ path: "inline", openMs: HANDSHAKE_MS });
    expect(opens(port)).toBe(before + 1);
    pool.release(own, true);
    // The slow open lands and serves the next call as a spare.
    await vi.advanceTimersByTimeAsync(STUCK_MS - 3 * HANDSHAKE_MS);
    const next = await pool.acquire("rpc.example", timing());
    expect(pool.acquireInfo(next)).toMatchObject({ path: "spare" });
    pool.close();
  });
});

describe("transport choice (E2E TLS design §5)", () => {
  const cases: [TlsSetting, string, boolean, "tunnel" | "http" | string][] = [
    ["required", "https://rpc.example/key", true, "tunnel"],
    ["required", "https://rpc.example:443/", true, "tunnel"],
    ["required", "http://rpc.example/", true, "unsupported"],
    ["required", "https://rpc.example:8545/", true, "unsupported"],
    ["required", "https://127.0.0.1/", true, "unsupported"],
    ["required", "https://[::1]/", true, "unsupported"],
    ["required", "https://rpc.example/", false, "network-error"],
    ["preferred", "https://rpc.example/", true, "tunnel"],
    ["preferred", "http://rpc.example/", true, "http"],
    ["preferred", "https://10.0.0.1/", true, "http"],
    ["preferred", "https://rpc.example/", false, "http"],
    ["off", "https://rpc.example/", true, "http"],
  ];
  it.each(cases)("tls %s, %s, tunnel exit known %s: %s", (setting, url, known, expected) => {
    const run = () => chooseTransport(setting, new URL(url), known, 0, false).via;
    if (expected === "tunnel" || expected === "http") expect(run()).toBe(expected);
    else expect(run).toThrow(expect.objectContaining({ code: expected }));
  });

  it("never moves a call that started on a tunnel to plaintext, and refuses a redirect off tunnels as a network error", () => {
    expect(() => chooseTransport("preferred", new URL("http://rpc.example/"), true, 1, true)).toThrow(expect.objectContaining({ code: "network-error" }));
    expect(() => chooseTransport("required", new URL("http://rpc.example/"), true, 1, false)).toThrow(expect.objectContaining({ code: "network-error" }));
  });

  it("sizes the request exchange from the expected reply, within the exit's window", () => {
    expect([undefined, 1, 30_656, 30_657, 120_000, 8_000_000].map(requestSurbs)).toEqual([2, 2, 2, 3, 5, 32]);
  });
});

describe("tunnel error mapping (E2E TLS design §5)", () => {
  const reject = (code: TunnelRejectedError["code"]) => new TunnelRejectedError(code, false, 0, true, "");
  it.each([
    [reject("PortNotAllowed"), CALL_CODES.permissionDenied],
    [reject("HostNotAllowed"), CALL_CODES.permissionDenied],
    [reject("DestinationBlocked"), CALL_CODES.permissionDenied],
    [reject("SessionLimit"), CALL_CODES.networkError],
    [reject("RateLimited"), CALL_CODES.networkError],
    [reject("ConnectFailed"), CALL_CODES.networkError],
    [reject("DnsFailed"), CALL_CODES.networkError],
    [reject("UpstreamClosed"), CALL_CODES.networkError],
    [reject("NotTls"), CALL_CODES.protocolError],
    [reject("Malformed"), CALL_CODES.protocolError],
    [reject("OutOfOrder"), CALL_CODES.protocolError],
    [reject("ByteLimit"), CALL_CODES.tooLarge],
    [new TunnelTimeoutError(1, true), CALL_CODES.timeout],
    [new NoTunnelExitError(), CALL_CODES.networkError],
    [Object.assign(new Error("certificate expired; check the device clock"), { code: "TLS_CERTIFICATE_REJECTED" }), CALL_CODES.networkError],
    [Object.assign(new Error("alert"), { code: "TLS_ALERT_RECEIVED" }), CALL_CODES.protocolError],
    [Object.assign(new Error("mac"), { code: "TLS_DECRYPT_FAILED" }), CALL_CODES.protocolError],
    [Object.assign(new Error("cut"), { code: "HTTP_RESPONSE_TRUNCATED" }), CALL_CODES.protocolError],
    [Object.assign(new Error("big"), { code: "HTTP_RESPONSE_TOO_LARGE" }), CALL_CODES.tooLarge],
  ])("%s maps to %s", (error, code) => {
    expect(mapTlsError(error).code).toBe(code);
  });
});

describe("tunnel transport", () => {
  function prepared(url: string, body: string, method = "POST"): PreparedRequest {
    const bytes = new TextEncoder().encode(body);
    return {
      method,
      url,
      headers: [["content-type", "application/json"], ["accept-encoding", "gzip"]],
      body: bytes,
      redirect: "follow",
      profile: profileRequest(method, "application/json", bytes),
    };
  }
  const budget = () => ({ signal: new AbortController().signal, remainingMs: () => 20_000 });

  it("sends a padded JSON request with URL credentials as Authorization and returns the response", async () => {
    const port = new FakeTunnelPort();
    answerOpens(port);
    port.onSend = (copy) => {
      queueMicrotask(() => copy.reply(copy.request.seq === 0 ? data(0, 0, "FLIGHT") : data(1, 6, '{"result":"0x1"}END')));
    };
    const tls = fakeTls();
    const pool = new TlsPool(port, tls, POOL, { ...deps, random: () => 0, log });
    const transport = new TlsTransport(pool, tls, CONFIG_DEFAULTS, log, deps.now);
    const reply = await transport.exchange(
      prepared("https://user:p%40ss@rpc.example/v1?k=1", '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'),
      budget(),
    );
    expect(text.decode(reply.body)).toBe('{"result":"0x1"}');
    expect(reply.truncated).toBe(false);
    expect(tls.requests[0]).toMatchObject({ target: "/v1?k=1", keepAlive: false, padJson: true });
    expect(tls.requests[0]!.headers).toContain(`Basic ${btoa("user:p@ss")}`);
    // The per-call session closes at once and acknowledges every byte, so the exit drops it.
    const close = port.sent.at(-1)!;
    expect(close.request).toMatchObject({ seq: 2, close: true, ackOffset: BigInt("FLIGHT".length + '{"result":"0x1"}END'.length) });
    expect(text.decode(close.request.data)).toBe("CLOSE");
    expect(close.options.surbs).toBe(0);
    pool.close();
  });

  it("retries a write on a new tunnel only when the exit refused its only copy before writing it", async () => {
    const port = new FakeTunnelPort();
    let refused = 0;
    port.onSend = (copy) => {
      queueMicrotask(() => {
        if (copy.request.seq === 0) copy.reply(data(0, 0, "FLIGHT"));
        else if (refused++ === 0) copy.reply({ kind: "Rejected", seq: 1, code: "Expired", retryable: false, detail: "tunnel is closed" });
        else copy.reply(data(1, 6, "okEND"));
      });
    };
    const tls = fakeTls();
    const pool = new TlsPool(port, tls, POOL, { ...deps, random: () => 0, log });
    const transport = new TlsTransport(pool, tls, CONFIG_DEFAULTS, log, deps.now);
    const write = prepared("https://rpc.example/", '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}');
    expect(text.decode((await transport.exchange(write, budget())).body)).toBe("ok");
    expect(port.sent.filter((copy) => copy.request.seq === 0)).toHaveLength(2);

    // A spare whose upstream already closed: the exit refuses the request before writing it.
    let closedUpstream = 0;
    port.onSend = (copy) => {
      queueMicrotask(() => {
        if (copy.request.seq === 0) copy.reply(data(0, 0, "FLIGHT"));
        else if (copy.request.close) return;
        else if (closedUpstream++ === 0) copy.reply({ kind: "Rejected", seq: 1, code: "UpstreamClosed", retryable: false, detail: "upstream closed" });
        else copy.reply(data(1, 6, "sentEND"));
      });
    };
    expect(text.decode((await transport.exchange(write, budget())).body)).toBe("sent");

    // Two copies went out before the refusal: one of them may have been written.
    port.onSend = (copy) => {
      if (copy.request.seq === 0) queueMicrotask(() => copy.reply(data(0, 0, "FLIGHT")));
    };
    const twice = transport.exchange(write, budget());
    twice.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(POOL.tlsCopyAfterMs);
    const copies = port.sent.filter((copy) => copy.request.seq === 1 && !copy.request.close);
    copies.at(-1)!.reply({ kind: "Rejected", seq: 1, code: "UpstreamClosed", retryable: false, detail: "upstream closed" });
    await expect(twice).rejects.toMatchObject({ code: "network-error" });
    expect(port.sent.filter((copy) => copy.request.seq === 0)).toHaveLength(5);

    // The stream ended before the response: a truncation, never resent for a write.
    port.onSend = (copy) => {
      queueMicrotask(() => {
        if (copy.request.seq === 0) copy.reply(data(0, 0, "FLIGHT"));
        else if (!copy.request.close) copy.reply(data(1, 6, "", "Eof"));
      });
    };
    await expect(transport.exchange(write, budget())).rejects.toMatchObject({ code: "protocol-error" });
    expect(port.sent.filter((copy) => copy.request.seq === 0)).toHaveLength(6);
    pool.close();
  });

  it("logs one tls.call line per hop with the session path, handshake wait and exchange time", async () => {
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const api = {
      debug: () => undefined,
      info: (_source: unknown, event: unknown, fields: unknown) => lines.push({ event: String(event), fields: fields as Record<string, unknown> }),
      warn: () => undefined,
      error: () => undefined,
    };
    const traced = createLogger(api, "info");
    const port = new FakeTunnelPort();
    let refusals = 1;
    port.onSend = (copy) => {
      setTimeout(() => {
        if (copy.request.seq === 0) copy.reply(data(0, 0, "FLIGHT"));
        else if (copy.request.close) return;
        else if (refusals-- > 0) copy.reply({ kind: "Rejected", seq: 1, code: "UpstreamClosed", retryable: false, detail: "upstream closed" });
        else copy.reply(data(1, 6, "okEND"));
      }, 300);
    };
    const tls = fakeTls();
    const pool = new TlsPool(port, tls, POOL, { ...deps, random: () => 0, log: traced });
    const transport = new TlsTransport(pool, tls, CONFIG_DEFAULTS, traced, deps.now);
    const read = prepared("https://rpc.example/", '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}');
    const retried = transport.exchange(read, budget());
    await vi.advanceTimersByTimeAsync(4 * 300);
    await retried;
    const pending = transport.exchange(read, budget());
    await vi.advanceTimersByTimeAsync(2 * 300);
    await pending;
    const calls = lines.filter((line) => line.event === "tls.call").map((line) => line.fields);
    expect(lines.filter((line) => line.event === "tls.retry")).toHaveLength(1);
    expect(calls).toEqual([
      { path: "retry", openMs: 300, exchangeMs: 300, retries: 1, ok: true },
      { path: "inline", openMs: 300, exchangeMs: 300, retries: 0, ok: true },
    ]);
    pool.close();
  });

  it("keeps a call under \"preferred\" on tunnels while every tunnel exit is skipped", async () => {
    const port = new FakeTunnelPort();
    answerOpens(port, (copy) => copy.reply({ kind: "Rejected", seq: 0, code: "Disabled", retryable: false, detail: "" }));
    const tls = fakeTls();
    const pool = new TlsPool(port, tls, POOL, { ...deps, random: () => 0, log });
    const transport = new TlsTransport(pool, tls, { ...CONFIG_DEFAULTS, tls: "preferred" }, log, deps.now);
    const read = prepared("https://rpc.example/", '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}');
    await expect(transport.exchange(read, budget())).rejects.toMatchObject({ code: "network-error" });
    expect(port.sent.map((copy) => copy.exit.id)).toEqual(["exit-1", "exit-2", "exit-3"]);
    expect(transport.route(read, 0, false)).toBe("tunnel");
    await expect(transport.exchange(read, budget())).rejects.toMatchObject({ code: "network-error" });
    expect(port.sent).toHaveLength(3);

    port.exits = [];
    expect(transport.route(read, 0, false)).toBe("http");
    pool.close();
  });
});
