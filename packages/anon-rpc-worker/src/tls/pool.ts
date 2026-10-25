/**
 * TLS sessions per host (E2E TLS design §4.2, §5): which tunnel exit opens a
 * session, the handshaken spares of per-call mode, the shared sessions of
 * keep-alive mode, and the exits skipped after a failed open.
 *
 * - Exit choice: uniformly random among exits advertising `tunnel_v1` that are
 *   not skipped. An exit that answers `Disabled`, or nothing within
 *   `tlsOpenTimeoutMs`, is skipped for `EXIT_SKIP_MS`; the open moves to
 *   another exit with a fresh tunnel id and ClientHello (only a ClientHello
 *   was sent, so that is always safe). `SessionLimit`, `RateLimited` and the
 *   other retryable refusals move the open at once.
 * - Per-call spares: after a call to a host (once the first wallet call has
 *   settled), a replacement spare opens on a random exit after an
 *   exponential delay with mean `SPARE_DELAY_MEAN_MS`, up to `tlsSpares` per
 *   host. A spare serves one call; unused, it is torn down `tlsSpareTtlMs`
 *   after its handshake. While the host was called within
 *   `SPARE_REFILL_WINDOW_MS`, a replacement opens at once
 *   `SPARE_REFILL_LEAD_MS` plus up to `SPARE_REFILL_JITTER_MS` before that
 *   teardown (one replacement per host at a time, so a host holds at most
 *   `tlsSpares` spares plus the one being replaced); after the window an
 *   expired spare is not replaced. Hosts live in memory only.
 * - A call that finds no spare while a spare's open for its host has run for
 *   at least half the handshake median (and at most its p95) waits for that
 *   open instead of starting another, and opens its own session when that
 *   open fails.
 * - Keep-alive: up to `MAX_KEEP_ALIVE_SESSIONS` sessions per host, each
 *   reused for `tlsKeepAliveMs` from its open or `tlsMaxCallsPerSession`
 *   calls; a call beyond that runs on a session of its own.
 */
import type { TopologyNode } from "@hisoka-io/nox-client";
import type { TlsSessionSetting } from "../config.js";
import type { WorkerLogger } from "../log.js";
import { TlsChannel, type ExchangeTiming } from "./channel.js";
import type { NoxTlsBindings } from "./module.js";
import {
  TunnelOpenTimeoutError,
  TunnelRejectedError,
  type CopyPolicy,
  type TunnelDeps,
  type TunnelPort,
} from "./tunnel.js";

/** How long an exit stays skipped after `Disabled` or an open timeout. */
export const EXIT_SKIP_MS = 10 * 60_000;
/** Mean delay before a replacement spare opens (exponential). */
export const SPARE_DELAY_MEAN_MS = 2_000;
/** Keep-alive sessions per host. */
export const MAX_KEEP_ALIVE_SESSIONS = 4;
/** Hosts with spares kept at once; the least recently used host loses its spares. */
export const MAX_SPARE_HOSTS = 8;
/**
 * A spare is refreshed before its TTL only while its host was called within
 * this long. Bounds how far apart the refresh chain can link a wallet's calls
 * to one host at low traffic.
 */
export const SPARE_REFILL_WINDOW_MS = 60_000;
/**
 * How long before a spare's TTL its replacement opens: about the handshake
 * p95 measured from India on 2026-10-15 (1.45 s), so the replacement is ready
 * before the old spare goes.
 */
export const SPARE_REFILL_LEAD_MS = 1_500;
/** Uniform jitter added to `SPARE_REFILL_LEAD_MS`, so refreshes do not tick at a fixed period. */
export const SPARE_REFILL_JITTER_MS = 500;
/** Exits tried for one open. */
export const MAX_OPEN_ATTEMPTS = 3;
/** Handshake times kept for the copy timer's p95. */
export const LATENCY_SAMPLES = 64;
/** Samples needed before the p95 can raise the copy timer. */
export const LATENCY_MIN_SAMPLES = 5;

export interface PoolSettings {
  readonly tlsSession: TlsSessionSetting;
  readonly tlsSpares: number;
  readonly tlsSpareTtlMs: number;
  readonly tlsKeepAliveMs: number;
  readonly tlsMaxCallsPerSession: number;
  readonly tlsOpenTimeoutMs: number;
  readonly tlsCopyAfterMs: number;
  readonly tlsGapMs: number;
  readonly tlsMaxCopies: number;
}

export interface PoolDeps extends TunnelDeps {
  /** Uniform in [0, 1). */
  readonly random: () => number;
  readonly log: WorkerLogger;
}

/** No exit in the topology relays TLS tunnels, or every one is skipped. */
export class NoTunnelExitError extends Error {
  constructor() {
    super("No exit offers TLS tunnels");
    this.name = "NoTunnelExitError";
  }
}

interface Spare {
  readonly channel: TlsChannel;
  /** When the handshake finished: the TTL and the logged age count from here. */
  readonly readyAt: number;
  readonly timers: ReturnType<typeof setTimeout>[];
  /** A replacement is opening; this spare still serves a call until its TTL. */
  superseded: boolean;
  /** The TTL leaves room for a refresh (longer than LEAD plus jitter). */
  refreshable: boolean;
}

/** A background spare open in flight, which a call may wait for. */
interface PendingOpen {
  readonly startedAt: number;
  /** A call waits for this open: it is handed to the call, not kept as a spare. */
  claimed: boolean;
  /** Set once the open succeeded. */
  channel: TlsChannel | undefined;
  readyAt: number;
  readonly promise: Promise<TlsChannel>;
}

/** How `acquire` obtained a session, for the `tls.call` log line. */
export type AcquirePath = "spare" | "inline" | "waited" | "reused";

export interface AcquireInfo {
  readonly path: AcquirePath;
  /** Time `acquire` spent waiting for a handshake (0 for a spare or a reused session). */
  readonly openMs: number;
  /** Age of the spare since its handshake, for `path: "spare"`. */
  readonly spareAgeMs: number | undefined;
}

interface Pooled {
  readonly channel: TlsChannel;
  idle: boolean;
}

export class TlsPool {
  readonly policy: CopyPolicy;
  private readonly skipped = new Map<string, number>();
  private readonly spares = new Map<string, Spare[]>();
  /** Spare opens per host, scheduled or in flight. */
  private readonly opening = new Map<string, number>();
  /** Spare opens per host that have started their handshake. */
  private readonly pending = new Map<string, PendingOpen[]>();
  /** When each host was last called (per-call mode), least recent first. */
  private readonly lastCallAt = new Map<string, number>();
  private readonly acquired = new WeakMap<TlsChannel, AcquireInfo>();
  private readonly sessions = new Map<string, Pooled[]>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly samples: number[] = [];
  /** Hosts called before background work was allowed: they get their spares then. */
  private readonly deferredHosts = new Set<string>();
  private background = false;
  private closed = false;

  constructor(
    private readonly port: TunnelPort,
    private readonly bindings: NoxTlsBindings,
    private readonly settings: PoolSettings,
    private readonly deps: PoolDeps,
  ) {
    const samples = this.samples;
    this.policy = {
      copyAfterMs: () => Math.max(settings.tlsCopyAfterMs, percentile95(samples)),
      gapMs: settings.tlsGapMs,
      maxCopies: settings.tlsMaxCopies,
    };
  }

  /**
   * True when at least one exit advertises `tunnel_v1`, skipped or not, so
   * exits that time out or refuse opens cause a `network-error`, never plaintext.
   */
  offersTunnels(): boolean {
    return this.port.tunnelExits().length > 0;
  }

  /** The first wallet call settled: spares may open from now on. */
  enableBackground(): void {
    if (this.background) return;
    this.background = true;
    for (const host of this.deferredHosts) this.replenish(host);
    this.deferredHosts.clear();
  }

  /** A session ready for a request to `host`: a spare, an idle shared session, or a new one. */
  async acquire(host: string, timing: Omit<ExchangeTiming, "background">): Promise<TlsChannel> {
    const startedAt = this.deps.now();
    if (this.settings.tlsSession === "per-call") {
      this.noteCall(host, startedAt);
      const spare = this.takeSpare(host);
      if (spare !== undefined) {
        this.acquired.set(spare.channel, { path: "spare", openMs: 0, spareAgeMs: startedAt - spare.readyAt });
        this.replenish(host);
        return spare.channel;
      }
      const inFlight = this.waitableOpen(host, startedAt);
      const waited = inFlight === undefined ? undefined : await this.waitFor(host, inFlight, timing);
      const channel = waited ?? (await this.open(host, { ...timing, background: false }));
      this.acquired.set(channel, {
        path: waited === undefined ? "inline" : "waited",
        openMs: this.deps.now() - startedAt,
        spareAgeMs: undefined,
      });
      this.replenish(host);
      return channel;
    }
    const pooled = this.sessions.get(host) ?? [];
    const now = this.deps.now();
    const ready = pooled.find((entry) => entry.idle && this.keepAliveUsable(entry.channel, now));
    if (ready !== undefined) {
      ready.idle = false;
      this.acquired.set(ready.channel, { path: "reused", openMs: 0, spareAgeMs: undefined });
      return ready.channel;
    }
    const channel = await this.open(host, { ...timing, background: false });
    this.acquired.set(channel, { path: "inline", openMs: this.deps.now() - startedAt, spareAgeMs: undefined });
    const live = this.sessions.get(host) ?? [];
    if (live.length < MAX_KEEP_ALIVE_SESSIONS) {
      live.push({ channel, idle: false });
      this.sessions.set(host, live);
    }
    return channel;
  }

  /**
   * The call on `channel` finished; `ok` when it got a complete response. A
   * per-call session is torn down at once, which also acknowledges the last
   * bytes, so the exit releases the session's window.
   */
  release(channel: TlsChannel, ok: boolean): void {
    if (this.settings.tlsSession === "per-call") {
      this.teardown(channel);
      return;
    }
    const pooled = this.sessions.get(channel.host);
    const entry = pooled?.find((candidate) => candidate.channel === channel);
    if (ok && entry !== undefined && this.keepAliveUsable(channel, this.deps.now())) {
      entry.idle = true;
      const left = channel.openedAt + this.settings.tlsKeepAliveMs - this.deps.now();
      this.later(left, () => {
        if (entry.idle) this.retire(channel);
      });
      return;
    }
    this.retire(channel);
  }

  /** How the last `acquire` that returned `channel` obtained it. */
  acquireInfo(channel: TlsChannel): AcquireInfo | undefined {
    return this.acquired.get(channel);
  }

  /** Drop every session; spares and shared sessions are torn down. */
  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const list of this.spares.values()) for (const spare of list) this.teardown(spare.channel);
    this.spares.clear();
    for (const list of this.sessions.values()) for (const entry of list) this.teardown(entry.channel);
    this.sessions.clear();
  }

  private keepAliveUsable(channel: TlsChannel, now: number): boolean {
    return channel.reusable &&
      channel.calls < this.settings.tlsMaxCallsPerSession &&
      now - channel.openedAt < this.settings.tlsKeepAliveMs;
  }

  private retire(channel: TlsChannel): void {
    const pooled = this.sessions.get(channel.host);
    if (pooled !== undefined) {
      const left = pooled.filter((entry) => entry.channel !== channel);
      if (left.length === 0) this.sessions.delete(channel.host);
      else this.sessions.set(channel.host, left);
    }
    this.teardown(channel);
  }

  /** Open a session to `host`, moving to another exit when one fails as described above. */
  private async open(host: string, timing: ExchangeTiming): Promise<TlsChannel> {
    const tried = new Set<string>();
    let lastError: unknown = new NoTunnelExitError();
    for (let attempt = 0; attempt < MAX_OPEN_ATTEMPTS; attempt++) {
      const exit = this.pickExit(tried);
      if (exit === undefined) break;
      tried.add(exit.id);
      const channel = new TlsChannel(this.port, exit, host, this.policy, this.deps, this.bindings);
      const startedAt = this.deps.now();
      try {
        await channel.handshake({ ...timing, openTimeoutMs: this.settings.tlsOpenTimeoutMs });
      } catch (error) {
        channel.free();
        lastError = error;
        if (error instanceof TunnelOpenTimeoutError) {
          this.skip(exit, "open-timeout");
          continue;
        }
        if (error instanceof TunnelRejectedError) {
          this.deps.log.info("tls.reject", { code: error.code, seq: error.seq, retryable: error.retryable });
          if (error.code === "Disabled") {
            this.skip(exit, "disabled");
            continue;
          }
          if (error.retryable) continue;
        }
        throw error;
      }
      this.sample(this.deps.now() - startedAt);
      this.deps.log.debug("tls.open", {
        tunnel: channel.tunnel.label,
        ms: this.deps.now() - startedAt,
        cpuMs: Math.round(channel.handshakeCpuMs * 10) / 10,
        protocol: channel.protocol,
        spare: timing.background,
      });
      return channel;
    }
    throw lastError;
  }

  private pickExit(tried: ReadonlySet<string>): TopologyNode | undefined {
    const pool = this.candidates(tried);
    if (pool.length === 0) return undefined;
    return pool[Math.min(pool.length - 1, Math.floor(this.deps.random() * pool.length))];
  }

  private candidates(exclude: ReadonlySet<string>): TopologyNode[] {
    const now = this.deps.now();
    return this.port.tunnelExits().filter((node) => {
      if (exclude.has(node.id)) return false;
      const until = this.skipped.get(node.id);
      if (until === undefined) return true;
      if (until > now) return false;
      this.skipped.delete(node.id);
      return true;
    });
  }

  private skip(exit: TopologyNode, reason: string): void {
    this.skipped.set(exit.id, this.deps.now() + EXIT_SKIP_MS);
    this.deps.log.info("tls.exit.skipped", { reason, minutes: EXIT_SKIP_MS / 60_000 });
  }

  private takeSpare(host: string): Spare | undefined {
    const list = this.spares.get(host);
    const spare = list?.shift();
    if (spare === undefined) return undefined;
    this.clearSpareTimers(spare);
    // Most recently used host last (see MAX_SPARE_HOSTS).
    this.spares.delete(host);
    this.spares.set(host, list ?? []);
    return spare;
  }

  private noteCall(host: string, at: number): void {
    this.lastCallAt.delete(host);
    this.lastCallAt.set(host, at);
    while (this.lastCallAt.size > MAX_SPARE_HOSTS) {
      const oldest = this.lastCallAt.keys().next().value as string;
      this.lastCallAt.delete(oldest);
    }
  }

  /** `host` was called within `SPARE_REFILL_WINDOW_MS`. */
  private recentlyCalled(host: string): boolean {
    const at = this.lastCallAt.get(host);
    return at !== undefined && this.deps.now() - at < SPARE_REFILL_WINDOW_MS;
  }

  /**
   * The oldest unclaimed spare open for `host` that started at least half the
   * handshake median ago and no longer ago than the handshake p95 (once there
   * are `LATENCY_MIN_SAMPLES`): an open past the p95 is likely stuck on a slow
   * exit, so the call opens its own and that open stays a spare if it lands.
   */
  private waitableOpen(host: string, now: number): PendingOpen | undefined {
    const minAgeMs = percentile(this.samples, 0.5, 1) / 2;
    const maxAgeMs = percentile95(this.samples) || Number.POSITIVE_INFINITY;
    return this.pending.get(host)?.find((entry) => {
      const ageMs = now - entry.startedAt;
      return !entry.claimed && ageMs >= minAgeMs && ageMs <= maxAgeMs;
    });
  }

  /**
   * Wait for the spare open `entry` and take its session. Undefined when that
   * open fails or the call's deadline passes first (the call then opens its
   * own); the call's abort rejects. A session the call gave up on stays a spare.
   */
  private async waitFor(host: string, entry: PendingOpen, timing: Omit<ExchangeTiming, "background">): Promise<TlsChannel | undefined> {
    entry.claimed = true;
    const outcome = await settleFirst(entry.promise, timing.signal, timing.deadlineAt - this.deps.now());
    if (outcome.kind === "opened") return outcome.channel;
    if (outcome.kind === "failed") return undefined;
    entry.claimed = false;
    if (entry.channel !== undefined) this.keepSpare(host, entry.channel, entry.readyAt);
    if (outcome.kind === "aborted") throw outcome.reason;
    return undefined;
  }

  /** Per-call mode: open a replacement spare for `host` after an exponential delay. */
  private replenish(host: string): void {
    if (this.settings.tlsSession !== "per-call" || this.settings.tlsSpares === 0 || this.closed) return;
    if (!this.background) {
      if (this.deferredHosts.size < MAX_SPARE_HOSTS) this.deferredHosts.add(host);
      return;
    }
    if (this.spareCount(host) >= this.settings.tlsSpares) return;
    this.openSpare(host, Math.round(-Math.log(1 - this.deps.random()) * SPARE_DELAY_MEAN_MS));
  }

  /** Spares of `host` that count against `tlsSpares`: those not being replaced, and opens scheduled or in flight. */
  private spareCount(host: string): number {
    const live = (this.spares.get(host) ?? []).filter((spare) => !spare.superseded).length;
    return live + (this.opening.get(host) ?? 0);
  }

  /** Open a spare for `host` after `delayMs` (at once for 0); it becomes a spare unless a call claims it first. */
  private openSpare(host: string, delayMs: number): void {
    this.opening.set(host, (this.opening.get(host) ?? 0) + 1);
    const start = (): void => {
      const settled = (entry: PendingOpen): void => {
        const left = (this.opening.get(host) ?? 1) - 1;
        if (left <= 0) this.opening.delete(host);
        else this.opening.set(host, left);
        const rest = (this.pending.get(host) ?? []).filter((candidate) => candidate !== entry);
        if (rest.length === 0) this.pending.delete(host);
        else this.pending.set(host, rest);
      };
      const startedAt = this.deps.now();
      const deadlineAt = startedAt + this.settings.tlsOpenTimeoutMs * MAX_OPEN_ATTEMPTS;
      // The handlers run after `entry` below is assigned: `open` settles asynchronously.
      const promise: Promise<TlsChannel> = this.open(host, { deadlineAt, background: true }).then(
        (channel) => {
          settled(entry);
          entry.channel = channel;
          entry.readyAt = this.deps.now();
          if (!entry.claimed) this.keepSpare(host, channel, entry.readyAt);
          return channel;
        },
        (error: unknown) => {
          settled(entry);
          this.deps.log.debug("tls.spare.failed", { reason: error instanceof Error ? error.name : "error" });
          throw error;
        },
      );
      promise.catch(() => undefined);
      const entry: PendingOpen = { startedAt, claimed: false, channel: undefined, readyAt: 0, promise };
      const list = this.pending.get(host) ?? [];
      list.push(entry);
      this.pending.set(host, list);
    };
    if (delayMs <= 0) start();
    else this.later(delayMs, start);
  }

  private keepSpare(host: string, channel: TlsChannel, readyAt: number): void {
    if (this.closed) {
      this.teardown(channel);
      return;
    }
    const list = this.spares.get(host) ?? [];
    const spare: Spare = { channel, readyAt, timers: [], superseded: false, refreshable: false };
    const ttlMs = this.settings.tlsSpareTtlMs;
    const ageMs = this.deps.now() - readyAt;
    spare.timers.push(this.later(ttlMs - ageMs, () => this.expire(host, spare)));
    const refreshMs = ttlMs - SPARE_REFILL_LEAD_MS - this.deps.random() * SPARE_REFILL_JITTER_MS - ageMs;
    if (refreshMs > 0) {
      spare.refreshable = true;
      spare.timers.push(this.later(refreshMs, () => this.refresh(host, spare)));
    }
    list.push(spare);
    this.spares.delete(host);
    this.spares.set(host, list);
    while (this.spares.size > MAX_SPARE_HOSTS) {
      const [oldest, spares] = this.spares.entries().next().value as [string, Spare[]];
      this.spares.delete(oldest);
      for (const evicted of spares) {
        this.clearSpareTimers(evicted);
        this.teardown(evicted.channel);
      }
    }
  }

  /** Before a spare's TTL: open its replacement at once while the host is recent. */
  private refresh(host: string, spare: Spare): void {
    if (this.closed || !this.background || !this.recentlyCalled(host)) return;
    const list = this.spares.get(host);
    if (list === undefined || !list.includes(spare)) return;
    if (list.some((other) => other.superseded)) return;
    spare.superseded = true;
    this.openSpare(host, 0);
  }

  /**
   * A spare's TTL: tear it down. A spare whose refresh could not run (another
   * spare of the host was being replaced, or the replacement failed) is
   * replaced at once while the host is recent, up to `tlsSpares`.
   */
  private expire(host: string, spare: Spare): void {
    const current = this.spares.get(host);
    const index = current?.indexOf(spare) ?? -1;
    if (current === undefined || index < 0) return;
    current.splice(index, 1);
    if (current.length === 0) this.spares.delete(host);
    this.clearSpareTimers(spare);
    this.teardown(spare.channel);
    if (!spare.refreshable || this.closed || !this.background || !this.recentlyCalled(host)) return;
    if (this.spareCount(host) < this.settings.tlsSpares) this.openSpare(host, 0);
  }

  private clearSpareTimers(spare: Spare): void {
    for (const timer of spare.timers) {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
  }

  private teardown(channel: TlsChannel): void {
    const deadlineAt = this.deps.now() + this.settings.tlsOpenTimeoutMs;
    channel.teardown(deadlineAt).catch((error: unknown) =>
      this.deps.log.debug("tls.teardown.failed", { reason: error instanceof Error ? error.name : "error" }),
    );
  }

  private sample(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > LATENCY_SAMPLES) this.samples.shift();
  }

  private later(ms: number, run: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, Math.max(0, ms));
    this.timers.add(timer);
    return timer;
  }
}

/** p95 of `samples`, or 0 below `LATENCY_MIN_SAMPLES`. */
function percentile95(samples: readonly number[]): number {
  return percentile(samples, 0.95, LATENCY_MIN_SAMPLES);
}

/** The `q` quantile (nearest rank) of `samples`, or 0 below `minSamples`. */
function percentile(samples: readonly number[], q: number, minSamples: number): number {
  if (samples.length < Math.max(1, minSamples)) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0;
}

type Settled =
  | { readonly kind: "opened"; readonly channel: TlsChannel }
  | { readonly kind: "failed" }
  | { readonly kind: "aborted"; readonly reason: unknown }
  | { readonly kind: "deadline" };

/** Whichever comes first: `open` settling, `signal` aborting, or `withinMs` passing. */
function settleFirst(open: Promise<TlsChannel>, signal: AbortSignal | undefined, withinMs: number): Promise<Settled> {
  return new Promise<Settled>((resolve) => {
    if (signal?.aborted === true) {
      resolve({ kind: "aborted", reason: signal.reason });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => finish({ kind: "aborted", reason: signal?.reason });
    const finish = (outcome: Settled): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish({ kind: "deadline" }), Math.max(0, withinMs));
    open.then(
      (channel) => finish({ kind: "opened", channel }),
      () => finish({ kind: "failed" }),
    );
  });
}
