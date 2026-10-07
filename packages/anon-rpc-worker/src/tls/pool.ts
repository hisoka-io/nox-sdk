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
 *   host. A spare serves one call; unused, it is torn down after
 *   `tlsSpareTtlMs` and not replaced. Hosts live in memory only.
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
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Pooled {
  readonly channel: TlsChannel;
  idle: boolean;
}

export class TlsPool {
  readonly policy: CopyPolicy;
  private readonly skipped = new Map<string, number>();
  private readonly spares = new Map<string, Spare[]>();
  private readonly opening = new Map<string, number>();
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
    if (this.settings.tlsSession === "per-call") {
      const spare = this.takeSpare(host);
      const channel = spare ?? (await this.open(host, { ...timing, background: false }));
      this.replenish(host);
      return channel;
    }
    const pooled = this.sessions.get(host) ?? [];
    const now = this.deps.now();
    const ready = pooled.find((entry) => entry.idle && this.keepAliveUsable(entry.channel, now));
    if (ready !== undefined) {
      ready.idle = false;
      return ready.channel;
    }
    const channel = await this.open(host, { ...timing, background: false });
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

  private takeSpare(host: string): TlsChannel | undefined {
    const list = this.spares.get(host);
    const spare = list?.shift();
    if (spare === undefined) return undefined;
    clearTimeout(spare.timer);
    this.timers.delete(spare.timer);
    // Most recently used host last (see MAX_SPARE_HOSTS).
    this.spares.delete(host);
    this.spares.set(host, list ?? []);
    return spare.channel;
  }

  /** Per-call mode: open a replacement spare for `host` after an exponential delay. */
  private replenish(host: string): void {
    if (this.settings.tlsSession !== "per-call" || this.settings.tlsSpares === 0 || this.closed) return;
    if (!this.background) {
      if (this.deferredHosts.size < MAX_SPARE_HOSTS) this.deferredHosts.add(host);
      return;
    }
    const have = (this.spares.get(host)?.length ?? 0) + (this.opening.get(host) ?? 0);
    if (have >= this.settings.tlsSpares) return;
    this.opening.set(host, (this.opening.get(host) ?? 0) + 1);
    const delayMs = Math.round(-Math.log(1 - this.deps.random()) * SPARE_DELAY_MEAN_MS);
    this.later(delayMs, () => {
      const deadlineAt = this.deps.now() + this.settings.tlsOpenTimeoutMs * MAX_OPEN_ATTEMPTS;
      this.open(host, { deadlineAt, background: true }).then(
        (channel) => this.keepSpare(host, channel),
        (error: unknown) => this.deps.log.debug("tls.spare.failed", { reason: error instanceof Error ? error.name : "error" }),
      ).finally(() => {
        const left = (this.opening.get(host) ?? 1) - 1;
        if (left <= 0) this.opening.delete(host);
        else this.opening.set(host, left);
      });
    });
  }

  private keepSpare(host: string, channel: TlsChannel): void {
    if (this.closed) {
      this.teardown(channel);
      return;
    }
    const list = this.spares.get(host) ?? [];
    const timer = this.later(this.settings.tlsSpareTtlMs, () => {
      const current = this.spares.get(host);
      const index = current?.findIndex((spare) => spare.channel === channel) ?? -1;
      if (current === undefined || index < 0) return;
      current.splice(index, 1);
      if (current.length === 0) this.spares.delete(host);
      this.teardown(channel);
    });
    list.push({ channel, timer });
    this.spares.delete(host);
    this.spares.set(host, list);
    while (this.spares.size > MAX_SPARE_HOSTS) {
      const [oldest, spares] = this.spares.entries().next().value as [string, Spare[]];
      this.spares.delete(oldest);
      for (const spare of spares) {
        clearTimeout(spare.timer);
        this.timers.delete(spare.timer);
        this.teardown(spare.channel);
      }
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
  if (samples.length < LATENCY_MIN_SAMPLES) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}
