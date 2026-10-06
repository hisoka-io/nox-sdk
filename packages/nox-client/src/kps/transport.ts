/**
 * `fetch` over KPS (ARCHITECTURE §3.5): each request is one `nox-kps-http/1`
 * exchange on its own stream, and streams share one reused connection per KPS
 * address, dialled through the injected `KpsDial` (never the per-stream
 * `openStream(addr)` shortcut, which hides a new connection per stream).
 *
 * Only `kps:<address><target>` endpoints are accepted; anything else fails with
 * `MODE_VIOLATION`. This module never reaches an ambient `fetch`, so a KPS
 * client cannot fall back to HTTPS.
 */
import {
  NoxClientError,
  NoxClientErrorCode,
  type KpsConnLike,
  type KpsDial,
  type KpsErrorCode,
  type KpsReason,
  type KpsStreamLike,
  type NoxFetch,
  type NoxLogSink,
} from "../types.js";
import { secureRandomUnit } from "../utils.js";
import { kpsAddressLabel, parseKpsAddress, parseKpsEndpoint } from "./address.js";
import { NoxKpsError, describeError, kpsErrorCodeOf } from "./errors.js";
import {
  encodeKpsHttpRequest,
  readKpsHttpResponseBody,
  readKpsHttpResponseHead,
  type KpsHttpReadLimits,
  type KpsHttpResponseHead,
} from "./http1.js";

/** Where an exchange failed. `dial` and `open` mean the request was certainly not sent. */
export type KpsFailurePhase = "dial" | "open" | "write" | "read" | "parse";

/** `cause` of a `TRANSPORT_FAILED` error raised by the KPS transport. */
export interface KpsFailureCause {
  readonly phase: KpsFailurePhase;
  readonly kpsCode?: KpsErrorCode;
  /** The underlying error, for diagnostics only. */
  readonly error?: unknown;
}

/** Transport counters for logs and demos; never per request. */
export interface KpsFetchStats {
  dialsOk: number;
  dialsFailed: number;
  streamsOpened: number;
  bytesIn: number;
  bytesOut: number;
  lastExchangeMs?: number;
}

/** Every tunable of the KPS transport. */
export interface KpsTransportSettings {
  dialTimeoutMs: number;
  openStreamTimeoutMs: number;
  exchangeTimeoutMs: number;
  keepaliveMs: number;
  maxHeadBytes: number;
  maxBodyBytes: number;
  /** Cooldown after the first failed dial; doubles per failure, with jitter. */
  redialBaseMs: number;
  redialMaxMs: number;
  /** Idle connections kept open (with keepalives); extras close after `idleCloseMs`. */
  idleConnectionsKept: number;
  idleCloseMs: number;
  /** Streams open at once per connection, below `nox-kps`'s 64 (ARCHITECTURE §2.6). */
  maxStreamsPerConnection: number;
  /** Period of the idle and keepalive sweep. */
  maintenanceIntervalMs: number;
  /** Claim-lane connections kept open (with keepalives) while idle; others close after `idleCloseMs`. */
  claimLaneConnectionsKept: number;
  /**
   * Largest single stream write. A browser data channel releases at most four
   * SCTP packets per send call, so a 32 KB packet written at once needs extra
   * round trips even when the congestion window has room; writes of this size
   * (about four packets each) let a warm window carry the packet in one flight.
   */
  writeChunkBytes: number;
  /**
   * Send-window warm-up per connection, in bytes (0 = off): right after a
   * warm-up target connects, the transport sends this much padding as a few
   * paced, growing `POST /api/v1/responses/claim` bodies that claim nothing,
   * so the browser's SCTP congestion window has grown before the first
   * packet. It stops as soon as any other exchange is in flight on the
   * connection, or when a round is slower than `warmupAbortRtts` round trips.
   */
  warmupBytes: number;
  /** Ceiling on warm-up bytes across all connections in any 60 s window. */
  warmupMaxBytesPerMinute: number;
  /** Gap between warm-up rounds when no round trip has been measured yet. */
  warmupRoundGapMs: number;
  /** A warm-up round still open after this many measured round trips stops the warm-up (a lossy path). */
  warmupAbortRtts: number;
}

/**
 * A connection class per KPS address. `primary` carries packets, topology and
 * keepalives; `claims` is an optional second connection to the same address
 * for reply claims, so reply downloads never sit in front of a packet's
 * answer in one association's send queue, and each direction gets its own
 * congestion window. A `claims` exchange uses the primary connection until
 * its own connection is up (it is dialled in the background).
 */
export type KpsLane = "primary" | "claims";

/** Defaults (ARCHITECTURE §3.2, §3.5). */
export const KPS_TRANSPORT_DEFAULTS: Readonly<KpsTransportSettings> = Object.freeze({
  dialTimeoutMs: 10_000,
  openStreamTimeoutMs: 10_000,
  exchangeTimeoutMs: 15_000,
  keepaliveMs: 60_000,
  maxHeadBytes: 16 * 1024,
  maxBodyBytes: 16 * 1024 * 1024,
  redialBaseMs: 500,
  redialMaxMs: 15_000,
  idleConnectionsKept: 2,
  idleCloseMs: 30_000,
  maxStreamsPerConnection: 32,
  maintenanceIntervalMs: 5_000,
  claimLaneConnectionsKept: 1,
  writeChunkBytes: 4_600,
  warmupBytes: 96_000,
  warmupMaxBytesPerMinute: 400_000,
  warmupRoundGapMs: 280,
  warmupAbortRtts: 3,
});

/** First warm-up round: about the browser's initial SCTP window (10 packets). */
export const KPS_WARMUP_FIRST_ROUND_BYTES = 12_000;

/** Each warm-up round is this much larger than the one before (slow start grows about 1.5x per round trip with delayed acks). */
export const KPS_WARMUP_GROWTH = 1.5;

/** Largest warm-up round: below the 64 KiB claim body limit of every `nox-kps` release. */
export const KPS_WARMUP_MAX_ROUND_BYTES = 60_000;

/** Smallest warm-up round worth sending. */
const KPS_WARMUP_MIN_ROUND_BYTES = 1_000;

/** Route the warm-up pads: a claim that names no reply is answered at once by every node release. */
export const KPS_WARMUP_TARGET = "/api/v1/responses/claim";

/** Settings that may be 0 (feature off). */
const ZERO_ALLOWED_SETTINGS: ReadonlySet<string> = new Set(["warmupBytes"]);

/** Window over which `warmupMaxBytesPerMinute` is counted. */
const WARMUP_BUDGET_WINDOW_MS = 60_000;

/** Warm-up round sizes for a total of `bytes` (empty when off). */
export function kpsWarmupRounds(bytes: number): number[] {
  const rounds: number[] = [];
  let left = bytes;
  let next = KPS_WARMUP_FIRST_ROUND_BYTES;
  while (left >= KPS_WARMUP_MIN_ROUND_BYTES) {
    const size = Math.min(left, Math.round(next), KPS_WARMUP_MAX_ROUND_BYTES);
    rounds.push(size);
    left -= size;
    next *= KPS_WARMUP_GROWTH;
  }
  return rounds;
}

/** Smoothing of the per-address round-trip estimate (exponential moving average weight of a new sample). */
export const KPS_RTT_EMA_ALPHA = 0.3;

/** Exchanges whose request and response are both at most this many bytes count as round-trip samples. */
export const KPS_RTT_SAMPLE_MAX_BYTES = 2_048;

/** When one KPS exchange's response head and body arrived (`Date.now()` values). */
export interface KpsExchangeTiming {
  readonly startedAt: number;
  readonly headAt: number;
  readonly bodyAt: number;
}

/**
 * Timing of the exchange behind a `Response` this transport returned (the
 * transport reads the whole body before it returns, so `fetch` resolving says
 * nothing about when the head arrived). Undefined for other responses.
 */
const EXCHANGE_TIMINGS = new WeakMap<Response, KpsExchangeTiming>();

export function kpsExchangeTiming(response: Response): KpsExchangeTiming | undefined {
  return EXCHANGE_TIMINGS.get(response);
}

/** Route `nox-kps` answers itself; used for keepalives (ARCHITECTURE §2.9). */
export const KPS_HEALTH_TARGET = "/health";

/** Validate and fill transport settings. Throws `INVALID_CONFIG` naming the field. */
export function resolveKpsTransportSettings(
  overrides: Partial<KpsTransportSettings> | undefined,
): KpsTransportSettings {
  const settings: KpsTransportSettings = { ...KPS_TRANSPORT_DEFAULTS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in KPS_TRANSPORT_DEFAULTS)) {
      throw new NoxClientError(`${key} is not a KPS transport setting`, NoxClientErrorCode.InvalidConfig);
    }
    if (value === undefined) continue;
    const min = ZERO_ALLOWED_SETTINGS.has(key) ? 0 : 1;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
      throw new NoxClientError(
        `kps.${key} must be ${min === 0 ? "a non-negative" : "a positive"} safe integer`,
        NoxClientErrorCode.InvalidConfig,
      );
    }
    (settings as unknown as Record<string, number>)[key] = value;
  }
  if (settings.redialMaxMs < settings.redialBaseMs) {
    throw new NoxClientError("kps redialMaxMs must be at least redialBaseMs", NoxClientErrorCode.InvalidConfig);
  }
  return settings;
}

interface StreamWaiter {
  grant(): void;
  fail(error: unknown): void;
}

interface PoolEntry {
  readonly address: string;
  readonly lane: KpsLane;
  readonly label: string;
  readonly certhash: string;
  dial: Promise<KpsConnLike> | null;
  conn: KpsConnLike | null;
  readonly teardowns: Set<(error: NoxKpsError) => void>;
  active: number;
  readonly waiters: StreamWaiter[];
  failures: number;
  coolUntil: number;
  lastActivity: number;
  keepaliveInFlight: boolean;
  /** Dial time of the current connection. */
  dialMs: number | undefined;
  /** Smoothed round trip of small exchanges on this address. */
  rttMs: number | undefined;
  /** Warm the send window of every connection to this address (see `warmUp`). */
  warmWanted: boolean;
  /** The connection whose warm-up has started, so each connection is warmed once. */
  warmedConn: KpsConnLike | null;
  /** Warm-up exchanges in flight (they do not count as traffic the warm-up yields to). */
  warmInFlight: number;
}

/** Notified when a connection closes (`clean` as `kps.conn.closed` logs it). */
export type KpsConnectionListener = (address: string, lane: KpsLane, clean: boolean) => void;

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);
const STANDARD_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH"];

/** KPS-HTTP/1 client with a connection pool keyed by KPS address. */
export class KpsHttpTransport {
  /** `fetch`-compatible entry point; safe to pass around unbound. */
  readonly fetch: NoxFetch;
  private readonly pool = new Map<string, PoolEntry>();
  private readonly limits: KpsHttpReadLimits;
  private readonly counters: KpsFetchStats = {
    dialsOk: 0,
    dialsFailed: 0,
    streamsOpened: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
  private maintenance: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** Primary connections kept open with keepalives whatever their recency (pinned entry and standby). */
  private retained: ReadonlySet<string> = new Set();
  private readonly listeners = new Set<KpsConnectionListener>();
  private readonly laneFetches = new Map<KpsLane, NoxFetch>();
  /** Warm-up bytes sent, with their send time, for `warmupMaxBytesPerMinute`. */
  private readonly warmupSent: { at: number; bytes: number }[] = [];

  constructor(
    private readonly dial: KpsDial,
    private readonly settings: KpsTransportSettings = { ...KPS_TRANSPORT_DEFAULTS },
    private readonly log?: NoxLogSink,
    private readonly random: () => number = secureRandomUnit,
  ) {
    if (typeof dial !== "function") {
      throw new NoxClientError(
        "KPS mode requires kps.dial, a function (address, opts) => Promise<KpsConn>",
        NoxClientErrorCode.InvalidConfig,
      );
    }
    this.limits = { maxHeadBytes: settings.maxHeadBytes, maxBodyBytes: settings.maxBodyBytes };
    this.fetch = (input, init) => this.request(input, init, "primary");
    this.laneFetches.set("primary", this.fetch);
  }

  /** `fetch` on one lane (see `KpsLane`). */
  fetchOn(lane: KpsLane): NoxFetch {
    let laneFetch = this.laneFetches.get(lane);
    if (laneFetch === undefined) {
      laneFetch = (input, init) => this.request(input, init, lane);
      this.laneFetches.set(lane, laneFetch);
    }
    return laneFetch;
  }

  /**
   * Keep these primary connections open with keepalives, whatever their
   * recency (the pinned entry and its standby). Others follow the idle rules.
   */
  retain(addresses: Iterable<string>): void {
    this.retained = new Set(addresses);
  }

  /**
   * Warm the browser's send window on connections to these addresses (the
   * pinned entry and its standby; other addresses stop being targets): now
   * when connected, else when the dial completes, and again after a redial.
   * Each connection is warmed once; see `KpsTransportSettings.warmupBytes`.
   */
  warmUp(addresses: Iterable<string>): void {
    if (this.closed || this.settings.warmupBytes === 0) return;
    const wanted = new Set([...addresses].map((address) => parseKpsAddress(address).address));
    for (const entry of this.pool.values()) {
      if (entry.lane === "primary" && !wanted.has(entry.address)) entry.warmWanted = false;
    }
    for (const address of wanted) {
      const entry = this.entry(address, "primary");
      entry.warmWanted = true;
      if (entry.conn !== null) this.startWarmup(entry);
    }
  }

  /** Listen for connection closes; returns the unsubscribe function. */
  onConnectionClosed(listener: KpsConnectionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Smoothed round trip of small exchanges to `address`, if measured. */
  rttMs(address: string): number | undefined {
    return this.pool.get(poolKey(address, "primary"))?.rttMs ?? this.pool.get(poolKey(address, "claims"))?.rttMs;
  }

  /** How long the current primary connection to `address` took to dial, if connected. */
  dialMs(address: string): number | undefined {
    const entry = this.pool.get(poolKey(address, "primary"));
    return entry?.conn != null ? entry.dialMs : undefined;
  }

  /** Start dialling `address` in the background (no-op when connected, dialling or cooling down). */
  prewarm(address: string, lane: KpsLane = "primary"): void {
    if (this.closed) return;
    const entry = this.entry(parseKpsAddress(address).address, lane);
    if (entry.conn !== null || entry.dial !== null || entry.coolUntil > Date.now()) return;
    this.connection(entry).catch(noop);
  }

  /** Make sure a connection to `address` is up, dialling it if needed. */
  async warm(address: string, signal?: AbortSignal): Promise<void> {
    const entry = this.entry(parseKpsAddress(address).address, "primary");
    try {
      await this.connection(entry, signal);
    } catch (error) {
      throw this.failure(entry, "dial", error, undefined, "/");
    }
  }

  /** True while `address` is in its dial cooldown after a failure. */
  isCoolingDown(address: string): boolean {
    const entry = this.pool.get(poolKey(address, "primary"));
    return entry !== undefined && entry.conn === null && entry.coolUntil > Date.now();
  }

  /** True when a connection to `address` is established. */
  isConnected(address: string): boolean {
    return this.pool.get(poolKey(address, "primary"))?.conn != null;
  }

  stats(): KpsFetchStats {
    return { ...this.counters };
  }

  /** Close every connection and fail every waiting or in-flight exchange. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.maintenance !== null) {
      clearInterval(this.maintenance);
      this.maintenance = null;
    }
    const error = new NoxKpsError("KPS transport closed", "closed");
    const closing: Promise<void>[] = [];
    for (const entry of this.pool.values()) {
      for (const waiter of entry.waiters.splice(0)) waiter.fail(error);
      for (const teardown of [...entry.teardowns]) teardown(error);
      entry.teardowns.clear();
      const conn = entry.conn;
      entry.conn = null;
      if (conn !== null) closing.push(safeClose(conn, { code: "closed" }));
    }
    this.pool.clear();
    await Promise.all(closing);
  }

  private entry(address: string, lane: KpsLane): PoolEntry {
    const key = poolKey(address, lane);
    let entry = this.pool.get(key);
    if (entry === undefined) {
      entry = {
        address,
        lane,
        label: kpsAddressLabel(address),
        certhash: address.slice(address.lastIndexOf(":") + 1),
        dial: null,
        conn: null,
        teardowns: new Set(),
        active: 0,
        waiters: [],
        failures: 0,
        coolUntil: 0,
        lastActivity: Date.now(),
        keepaliveInFlight: false,
        dialMs: undefined,
        rttMs: undefined,
        warmWanted: false,
        warmedConn: null,
        warmInFlight: 0,
      };
      this.pool.set(key, entry);
    }
    return entry;
  }

  /**
   * The pool entry an exchange on `lane` uses: the lane's own connection when
   * it is up, else the primary one (and the lane's connection is dialled in
   * the background).
   */
  private laneEntry(address: string, lane: KpsLane): PoolEntry {
    const primary = this.entry(address, "primary");
    if (lane === "primary") return primary;
    const own = this.entry(address, lane);
    if (own.conn !== null) return own;
    if (own.dial === null && own.coolUntil <= Date.now() && primary.conn !== null) this.connection(own).catch(noop);
    return primary;
  }

  private async request(input: string, init: RequestInit | undefined, lane: KpsLane): Promise<Response> {
    const endpoint = parseKpsEndpoint(String(input));
    if (endpoint === null) {
      const text = String(input);
      const colon = text.indexOf(":");
      const scheme = colon > 0 && colon <= 16 ? text.slice(0, colon + 1) : "(none)";
      throw new NoxClientError(
        `KPS mode only carries kps:<ip>:<port>:<certhash>/<path> endpoints; refused an endpoint with scheme ${scheme}`,
        NoxClientErrorCode.ModeViolation,
      );
    }
    if (this.closed) {
      throw new NoxClientError("KPS transport closed", NoxClientErrorCode.TransportFailed, {
        phase: "dial",
        kpsCode: "closed",
      } satisfies KpsFailureCause);
    }
    const method = normalizeMethod(init?.method);
    const entry = this.laneEntry(endpoint.addr, lane);
    const requestBytes = encodeKpsHttpRequest({
      method,
      path: endpoint.target,
      certhash: entry.certhash,
      headers: forwardedHeaders(init?.headers),
      body: requestBody(init?.body),
    });
    const callerSignal = init?.signal ?? undefined;
    if (isAborted(callerSignal)) throw abortReason(callerSignal);

    const started = Date.now();
    const exchange = new AbortController();
    const fail = (error: unknown): void => {
      if (!exchange.signal.aborted) exchange.abort(error);
    };
    const onCallerAbort = (): void => fail(abortReason(callerSignal));
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const exchangeTimer = setTimeout(
      () =>
        fail(
          new NoxKpsError(
            `KPS exchange ${method} ${endpoint.target} via ${entry.label} timed out after ${this.settings.exchangeTimeoutMs} ms`,
            "timeout",
          ),
        ),
      this.settings.exchangeTimeoutMs,
    );

    let phase: KpsFailurePhase = "dial";
    let acquired = false;
    let stream: KpsStreamLike | null = null;
    let streamDone = false;
    const finishStream = (abandon: boolean): void => {
      if (stream === null || streamDone) return;
      streamDone = true;
      const opened = stream;
      if (abandon) void Promise.resolve(opened.resetWrite({ code: "cancelled" })).catch(noop);
      void Promise.resolve(opened.close(abandon ? { code: "cancelled" } : undefined)).catch(noop);
    };
    let removeTeardown = noop;
    try {
      const conn = await this.connection(entry, exchange.signal);
      phase = "open";
      await this.acquire(entry, exchange.signal);
      acquired = true;
      entry.lastActivity = Date.now();
      stream = await this.openStream(entry, conn, exchange.signal);
      this.counters.streamsOpened += 1;
      const opened = stream;
      removeTeardown = this.addTeardown(entry, conn, fail);
      const writer = opened.writable.getWriter();
      const reader = opened.readable.getReader();
      exchange.signal.addEventListener(
        "abort",
        () => {
          void reader.cancel(exchange.signal.reason).catch(noop);
          finishStream(true);
        },
        { once: true },
      );
      phase = "write";
      await raceSignal(writeChunked(writer, requestBytes, this.settings.writeChunkBytes), exchange.signal);
      this.counters.bytesOut += requestBytes.length;
      // Closing the writable is closeWrite (SPEC §10.2): the request ends at EOF.
      await raceSignal(writer.close(), exchange.signal);
      phase = "read";
      const { head, rest } = await raceSignal(readKpsHttpResponseHead(reader, this.limits), exchange.signal);
      const headAt = Date.now();
      const body = await raceSignal(
        readKpsHttpResponseBody(reader, head, rest, method, this.limits),
        exchange.signal,
      );
      this.counters.bytesIn += body.length;
      this.counters.lastExchangeMs = Date.now() - started;
      if (requestBytes.length <= KPS_RTT_SAMPLE_MAX_BYTES && body.length <= KPS_RTT_SAMPLE_MAX_BYTES) {
        const sample = Date.now() - started;
        entry.rttMs = entry.rttMs === undefined ? sample : entry.rttMs + KPS_RTT_EMA_ALPHA * (sample - entry.rttMs);
      }
      entry.lastActivity = Date.now();
      finishStream(false);
      const response = toResponse(head, body);
      EXCHANGE_TIMINGS.set(response, { startedAt: started, headAt, bodyAt: Date.now() });
      return response;
    } catch (error) {
      finishStream(true);
      if (isAborted(callerSignal)) throw abortReason(callerSignal);
      throw this.failure(
        entry,
        phase,
        exchange.signal.aborted ? exchange.signal.reason : error,
        method,
        endpoint.target,
      );
    } finally {
      clearTimeout(exchangeTimer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      removeTeardown();
      if (acquired) this.release(entry);
    }
  }

  /** A `TRANSPORT_FAILED` error naming the phase, logged without payloads. */
  private failure(
    entry: PoolEntry,
    phase: KpsFailurePhase,
    error: unknown,
    method: string | undefined,
    target: string,
  ): NoxClientError {
    if (error instanceof NoxClientError) return error;
    const kpsCode = kpsErrorCodeOf(error, "network-error");
    const finalPhase: KpsFailurePhase =
      phase === "read" && (kpsCode === "protocol-error" || kpsCode === "too-large") ? "parse" : phase;
    this.emit("warn", "kps.exchange.failed", {
      entry: entry.label,
      route: target,
      phase: finalPhase,
      code: kpsCode,
    });
    const what = method === undefined ? "KPS dial" : `KPS ${method} ${target}`;
    return new NoxClientError(
      `${what} via ${entry.label} failed during ${finalPhase} (${kpsCode}): ${describeError(error)}`,
      NoxClientErrorCode.TransportFailed,
      { phase: finalPhase, kpsCode, error } satisfies KpsFailureCause,
    );
  }

  private connection(entry: PoolEntry, signal?: AbortSignal): Promise<KpsConnLike> {
    if (this.closed) return Promise.reject(new NoxKpsError("KPS transport closed", "closed"));
    if (entry.conn !== null) return Promise.resolve(entry.conn);
    if (entry.dial === null) {
      const wait = entry.coolUntil - Date.now();
      if (wait > 0) {
        return Promise.reject(
          new NoxKpsError(
            `KPS entry ${entry.label} is cooling down after ${entry.failures} failed dial(s); next dial in ${wait} ms`,
            "network-error",
          ),
        );
      }
      entry.dial = this.startDial(entry);
    }
    return raceSignal(entry.dial, signal);
  }

  private startDial(entry: PoolEntry): Promise<KpsConnLike> {
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = this.settings.dialTimeoutMs;
    const timer = setTimeout(
      () => controller.abort(new NoxKpsError(`KPS dial to ${entry.label} timed out after ${timeoutMs} ms`, "timeout")),
      timeoutMs,
    );
    let pending: Promise<KpsConnLike>;
    try {
      pending = Promise.resolve(this.dial(entry.address, { signal: controller.signal }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    // A dial that completes after its deadline (or after close) is closed, not leaked.
    pending.then(
      (late) => {
        if (controller.signal.aborted || this.closed) void safeClose(late, { code: "cancelled" });
      },
      noop,
    );
    return raceSignal(pending, controller.signal).then(
      (conn) => {
        clearTimeout(timer);
        if (this.closed) {
          void safeClose(conn, { code: "closed" });
          throw new NoxKpsError("KPS transport closed", "closed");
        }
        assertConnection(conn);
        entry.dial = null;
        entry.conn = conn;
        entry.failures = 0;
        entry.coolUntil = 0;
        entry.lastActivity = Date.now();
        entry.dialMs = Date.now() - started;
        this.counters.dialsOk += 1;
        const onClosed = (info: unknown): void => {
          const current = entry.conn === conn;
          if (current) entry.conn = null;
          const clean = typeof info === "object" && info !== null && (info as { ok?: unknown }).ok === true;
          this.emit("info", "kps.conn.closed", { entry: entry.label, lane: entry.lane, clean });
          const error = new NoxKpsError(`KPS connection to ${entry.label} closed`, "closed");
          for (const teardown of [...entry.teardowns]) teardown(error);
          entry.teardowns.clear();
          if (current && !this.closed) {
            for (const listener of [...this.listeners]) {
              try {
                listener(entry.address, entry.lane, clean);
              } catch {
                // A listener never breaks the transport.
              }
            }
          }
        };
        conn.closed.then(onClosed, onClosed);
        this.emit("info", "kps.dial.ok", { entry: entry.label, lane: entry.lane, ms: entry.dialMs });
        this.startMaintenance();
        if (entry.warmWanted) queueMicrotask(() => this.startWarmup(entry));
        return conn;
      },
      (error: unknown) => {
        clearTimeout(timer);
        entry.dial = null;
        entry.failures += 1;
        this.counters.dialsFailed += 1;
        const ceiling = Math.min(
          this.settings.redialBaseMs * 2 ** Math.min(entry.failures - 1, 30),
          this.settings.redialMaxMs,
        );
        const backoff = Math.max(1, Math.round(ceiling * (0.5 + 0.5 * this.random())));
        entry.coolUntil = Date.now() + backoff;
        const code = kpsErrorCodeOf(error, "network-error");
        this.emit("warn", "kps.dial.failed", {
          entry: entry.label,
          lane: entry.lane,
          code,
          failures: entry.failures,
          retryInMs: backoff,
        });
        throw error instanceof NoxKpsError
          ? error
          : new NoxKpsError(`KPS dial to ${entry.label} failed: ${describeError(error)}`, code, error);
      },
    );
  }

  private async openStream(entry: PoolEntry, conn: KpsConnLike, signal: AbortSignal): Promise<KpsStreamLike> {
    const controller = new AbortController();
    const timeoutMs = this.settings.openStreamTimeoutMs;
    const timer = setTimeout(
      () =>
        controller.abort(new NoxKpsError(`KPS openStream to ${entry.label} timed out after ${timeoutMs} ms`, "timeout")),
      timeoutMs,
    );
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<KpsStreamLike>;
    try {
      pending = Promise.resolve(conn.openStream({ signal: controller.signal }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (late) => {
        if (controller.signal.aborted) void Promise.resolve(late.close({ code: "cancelled" })).catch(noop);
      },
      noop,
    );
    try {
      const stream = await raceSignal(pending, controller.signal);
      assertStream(stream);
      return stream;
    } catch (error) {
      // A stream that cannot be opened within the bound means the connection
      // is wedged (kps ISSUES #14): evict it so the next exchange redials.
      if (!signal.aborted && controller.signal.aborted && entry.conn === conn) {
        entry.conn = null;
        void safeClose(conn, { code: "timeout" });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private startWarmup(entry: PoolEntry): void {
    const conn = entry.conn;
    if (this.closed || conn === null || entry.lane !== "primary" || entry.warmedConn === conn) return;
    entry.warmedConn = conn;
    void this.runWarmup(entry, conn);
  }

  /** Bytes still allowed by `warmupMaxBytesPerMinute` now. */
  private warmupAllowance(now: number): number {
    while (this.warmupSent.length > 0 && now - (this.warmupSent[0]?.at ?? now) >= WARMUP_BUDGET_WINDOW_MS) {
      this.warmupSent.shift();
    }
    const used = this.warmupSent.reduce((sum, sent) => sum + sent.bytes, 0);
    return this.settings.warmupMaxBytesPerMinute - used;
  }

  /**
   * Paced, growing padding rounds on `conn` (see `warmupBytes`). Rounds are
   * not awaited one by one: the browser's own acknowledgement clock paces
   * them, and the gap only spreads them over about one round trip each.
   */
  private async runWarmup(entry: PoolEntry, conn: KpsConnLike): Promise<void> {
    const rounds = kpsWarmupRounds(this.settings.warmupBytes);
    const started = Date.now();
    const open: { at: number; done: boolean }[] = [];
    const exchanges: Promise<void>[] = [];
    let sent = 0;
    let stop = "done";
    for (const [index, size] of rounds.entries()) {
      if (index > 0) await sleep(clampGap(entry.rttMs ?? this.settings.warmupRoundGapMs));
      const now = Date.now();
      if (this.closed || entry.conn !== conn) {
        stop = "closed";
        break;
      }
      if (entry.active > entry.warmInFlight) {
        stop = "yielded";
        break;
      }
      const rtt = entry.rttMs;
      if (rtt !== undefined && open.some((round) => !round.done && now - round.at > rtt * this.settings.warmupAbortRtts)) {
        stop = "slow";
        break;
      }
      if (this.warmupAllowance(now) < size) {
        stop = "budget";
        break;
      }
      this.warmupSent.push({ at: now, bytes: size });
      const round = { at: now, done: false };
      open.push(round);
      entry.warmInFlight += 1;
      sent += size;
      exchanges.push(
        this.request(`kps:${entry.address}${KPS_WARMUP_TARGET}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: warmupBody(size),
        }, "primary").then(
          (response) => {
            void response.arrayBuffer().catch(noop);
          },
          noop,
        ).finally(() => {
          round.done = true;
          entry.warmInFlight -= 1;
        }),
      );
    }
    await Promise.all(exchanges);
    this.emit("debug", "kps.warmup", {
      entry: entry.label,
      bytes: sent,
      rounds: exchanges.length,
      stop,
      ms: Date.now() - started,
    });
  }

  private acquire(entry: PoolEntry, signal: AbortSignal): Promise<void> {
    if (entry.active < this.settings.maxStreamsPerConnection) {
      entry.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = entry.waiters.indexOf(waiter);
        if (index >= 0) entry.waiters.splice(index, 1);
        reject(signal.reason);
      };
      const waiter: StreamWaiter = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          entry.active += 1;
          resolve();
        },
        fail: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      entry.waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(entry: PoolEntry): void {
    entry.active = Math.max(0, entry.active - 1);
    entry.lastActivity = Date.now();
    const next = entry.waiters.shift();
    if (next !== undefined) next.grant();
  }

  private addTeardown(
    entry: PoolEntry,
    conn: KpsConnLike,
    teardown: (error: NoxKpsError) => void,
  ): () => void {
    if (entry.conn !== conn) {
      queueMicrotask(() => teardown(new NoxKpsError(`KPS connection to ${entry.label} closed`, "closed")));
      return noop;
    }
    entry.teardowns.add(teardown);
    return () => {
      entry.teardowns.delete(teardown);
    };
  }

  private startMaintenance(): void {
    if (this.maintenance !== null || this.closed) return;
    this.maintenance = setInterval(() => this.maintain(), this.settings.maintenanceIntervalMs);
  }

  /**
   * Per lane, keep the retained primary connections and then the most
   * recently used ones up to `idleConnectionsKept` (primary) or
   * `claimLaneConnectionsKept` (claims), closing the others once idle for
   * `idleCloseMs`; send `GET /health` on kept connections idle for
   * `keepaliveMs` (keeps NAT bindings and the `nox-kps` idle timer, 120 s,
   * alive, ARCHITECTURE §3.5).
   */
  private maintain(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const lane of ["primary", "claims"] as const) {
      const kept = lane === "primary" ? this.settings.idleConnectionsKept : this.settings.claimLaneConnectionsKept;
      const idle = [...this.pool.values()]
        .filter((entry) => entry.lane === lane && entry.conn !== null && entry.active === 0 && entry.waiters.length === 0)
        .sort((left, right) => {
          const retainedFirst = Number(this.retained.has(right.address)) - Number(this.retained.has(left.address));
          return retainedFirst !== 0 ? retainedFirst : right.lastActivity - left.lastActivity;
        });
      for (const [index, entry] of idle.entries()) {
        const idleFor = now - entry.lastActivity;
        const conn = entry.conn;
        if (conn === null) continue;
        const keep = (lane === "primary" && this.retained.has(entry.address)) || index < kept;
        if (!keep) {
          if (idleFor >= this.settings.idleCloseMs) {
            entry.conn = null;
            this.emit("debug", "kps.conn.idle-close", { entry: entry.label, lane, idleMs: idleFor });
            void safeClose(conn, { code: "closed" });
          }
          continue;
        }
        if (idleFor >= this.settings.keepaliveMs && !entry.keepaliveInFlight) {
          entry.keepaliveInFlight = true;
          this.request(`kps:${entry.address}${KPS_HEALTH_TARGET}`, { method: "GET" }, lane)
            .then(
              (response) => {
                void response.arrayBuffer().catch(noop);
              },
              () => {
                this.emit("warn", "kps.keepalive.failed", { entry: entry.label, lane });
              },
            )
            .finally(() => {
              entry.keepaliveInFlight = false;
            });
        }
      }
    }
    if (![...this.pool.values()].some((entry) => entry.conn !== null) && this.maintenance !== null) {
      clearInterval(this.maintenance);
      this.maintenance = null;
    }
  }

  private emit(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Readonly<Record<string, string | number | boolean>>,
  ): void {
    if (this.log === undefined) return;
    try {
      this.log(level, event, fields);
    } catch {
      // Diagnostics are best effort; a throwing sink never breaks transport.
    }
  }
}

/**
 * Resolve with `promise` or reject with `signal.reason` once the signal aborts,
 * whichever comes first. The losing promise's rejection is observed so it never
 * surfaces as unhandled.
 */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  promise.catch(noop);
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The KPS failure phase recorded on an error or its causes, if any. */
export function kpsFailurePhase(error: unknown): KpsFailurePhase | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const phase = (current as { phase?: unknown }).phase;
    if (phase === "dial" || phase === "open" || phase === "write" || phase === "read" || phase === "parse") {
      return phase;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Write `bytes` as writes of at most `chunk` bytes, queued at once (the
 * stream keeps their order), so each becomes its own data-channel send.
 */
async function writeChunked(writer: WritableStreamDefaultWriter<Uint8Array>, bytes: Uint8Array, chunk: number): Promise<void> {
  if (bytes.length <= chunk) {
    await writer.write(bytes);
    return;
  }
  const writes: Promise<void>[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const write = writer.write(bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
    write.catch(noop);
    writes.push(write);
  }
  await Promise.all(writes);
}

/** A claim body that names no reply, padded with JSON whitespace to `size` bytes. */
function warmupBody(size: number): Uint8Array<ArrayBuffer> {
  const head = '{"surb_ids":[]}';
  const body = new Uint8Array(Math.max(size, head.length)).fill(0x20);
  body.set(new TextEncoder().encode(head));
  return body;
}

/** Warm-up round gap: about one round trip, kept within sane bounds. */
function clampGap(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 20), 1_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read through a function so TypeScript keeps no stale narrowing. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  const reason: unknown = signal?.reason;
  if (reason !== undefined) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function normalizeMethod(method: string | undefined): string {
  if (method === undefined) return "GET";
  const upper = method.toUpperCase();
  return STANDARD_METHODS.includes(upper) ? upper : method;
}

function requestBody(body: RequestInit["body"]): Uint8Array | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  }
  throw new NoxKpsError(
    "KPS transport request bodies must be bytes or a string (streams, Blob and FormData are not carried)",
    "unsupported",
  );
}

/** Request headers taken from the caller; `Host` and `Content-Length` are computed. */
const FORWARDED_REQUEST_HEADERS: readonly (readonly [string, string])[] = [
  ["content-type", "Content-Type"],
  ["accept", "Accept"],
];

/**
 * Only `Content-Type` and `Accept` are taken from the caller (`Accept` lets a
 * claim ask for binary replies); every other header stays on this side.
 */
function forwardedHeaders(headers: RequestInit["headers"]): [string, string][] {
  if (headers === undefined) return [];
  const found = new Map<string, string>();
  const take = (name: string, value: string): void => {
    const lower = name.toLowerCase();
    if (FORWARDED_REQUEST_HEADERS.some(([key]) => key === lower)) found.set(lower, value);
  };
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, name) => take(name, value));
  } else if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair)) take(String(pair[0]), String(pair[1]));
    }
  } else {
    for (const [name, entry] of Object.entries(headers as Record<string, string>)) take(name, String(entry));
  }
  const out: [string, string][] = [];
  for (const [key, canonical] of FORWARDED_REQUEST_HEADERS) {
    const value = found.get(key);
    if (value !== undefined) out.push([canonical, value]);
  }
  return out;
}

function toResponse(head: KpsHttpResponseHead, body: Uint8Array<ArrayBuffer>): Response {
  try {
    return new Response(NULL_BODY_STATUSES.has(head.status) ? null : body, {
      status: head.status,
      statusText: head.reason,
      headers: head.headers.map(([name, value]) => [name, value] as [string, string]),
    });
  } catch (error) {
    throw new NoxKpsError(
      `KPS-HTTP/1 response (status ${head.status}) cannot be represented: ${describeError(error)}`,
      "protocol-error",
      error,
    );
  }
}

function assertConnection(conn: unknown): asserts conn is KpsConnLike {
  const candidate = conn as Partial<KpsConnLike> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.openStream !== "function" ||
    typeof candidate.close !== "function" ||
    typeof (candidate.closed as Promise<unknown> | undefined)?.then !== "function"
  ) {
    throw new NoxKpsError("KPS dial returned an object without openStream/close/closed", "protocol-error");
  }
}

function assertStream(stream: unknown): asserts stream is KpsStreamLike {
  const candidate = stream as Partial<KpsStreamLike> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.readable?.getReader !== "function" ||
    typeof candidate.writable?.getWriter !== "function" ||
    typeof candidate.close !== "function" ||
    typeof candidate.resetWrite !== "function"
  ) {
    throw new NoxKpsError(
      "KPS openStream returned an object without readable/writable/resetWrite/close",
      "protocol-error",
    );
  }
}

async function safeClose(conn: unknown, reason: KpsReason): Promise<void> {
  try {
    const close = (conn as { close?: unknown } | null)?.close;
    if (typeof close === "function") {
      await (close as (reason?: KpsReason) => Promise<void>).call(conn, reason);
    }
  } catch {
    // Closing a connection nobody uses is best effort.
  }
}

/** Pool key of one lane's connection to an address. */
function poolKey(address: string, lane: KpsLane): string {
  return lane === "primary" ? address : `${address}#${lane}`;
}

function noop(): void {
  // Intentionally empty.
}
