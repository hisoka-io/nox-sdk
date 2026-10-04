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
}

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
});

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
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new NoxClientError(`kps.${key} must be a positive safe integer`, NoxClientErrorCode.InvalidConfig);
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
}

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
    this.fetch = (input, init) => this.request(input, init);
  }

  /** Make sure a connection to `address` is up, dialling it if needed. */
  async warm(address: string, signal?: AbortSignal): Promise<void> {
    const entry = this.entry(parseKpsAddress(address).address);
    try {
      await this.connection(entry, signal);
    } catch (error) {
      throw this.failure(entry, "dial", error, undefined, "/");
    }
  }

  /** True while `address` is in its dial cooldown after a failure. */
  isCoolingDown(address: string): boolean {
    const entry = this.pool.get(address);
    return entry !== undefined && entry.conn === null && entry.coolUntil > Date.now();
  }

  /** True when a connection to `address` is established. */
  isConnected(address: string): boolean {
    return this.pool.get(address)?.conn != null;
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

  private entry(address: string): PoolEntry {
    let entry = this.pool.get(address);
    if (entry === undefined) {
      entry = {
        address,
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
      };
      this.pool.set(address, entry);
    }
    return entry;
  }

  private async request(input: string, init?: RequestInit): Promise<Response> {
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
    const entry = this.entry(endpoint.addr);
    const requestBytes = encodeKpsHttpRequest({
      method,
      path: endpoint.target,
      certhash: entry.certhash,
      headers: contentTypeOnly(init?.headers),
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
      await raceSignal(writer.write(requestBytes), exchange.signal);
      this.counters.bytesOut += requestBytes.length;
      // Closing the writable is closeWrite (SPEC §10.2): the request ends at EOF.
      await raceSignal(writer.close(), exchange.signal);
      phase = "read";
      const { head, rest } = await raceSignal(readKpsHttpResponseHead(reader, this.limits), exchange.signal);
      const body = await raceSignal(
        readKpsHttpResponseBody(reader, head, rest, method, this.limits),
        exchange.signal,
      );
      this.counters.bytesIn += body.length;
      this.counters.lastExchangeMs = Date.now() - started;
      entry.lastActivity = Date.now();
      finishStream(false);
      return toResponse(head, body);
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
        this.counters.dialsOk += 1;
        const onClosed = (info: unknown): void => {
          if (entry.conn === conn) entry.conn = null;
          const clean = typeof info === "object" && info !== null && (info as { ok?: unknown }).ok === true;
          this.emit("info", "kps.conn.closed", { entry: entry.label, clean });
          const error = new NoxKpsError(`KPS connection to ${entry.label} closed`, "closed");
          for (const teardown of [...entry.teardowns]) teardown(error);
          entry.teardowns.clear();
        };
        conn.closed.then(onClosed, onClosed);
        this.emit("info", "kps.dial.ok", { entry: entry.label, ms: Date.now() - started });
        this.startMaintenance();
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
   * Keep at most `idleConnectionsKept` idle connections, most recently used
   * first, closing the others once idle for `idleCloseMs`; send `GET /health`
   * on kept connections idle for `keepaliveMs` (keeps NAT bindings and the
   * `nox-kps` idle timer alive, ARCHITECTURE §3.5).
   */
  private maintain(): void {
    if (this.closed) return;
    const now = Date.now();
    const idle = [...this.pool.values()]
      .filter((entry) => entry.conn !== null && entry.active === 0 && entry.waiters.length === 0)
      .sort((left, right) => right.lastActivity - left.lastActivity);
    for (const [index, entry] of idle.entries()) {
      const idleFor = now - entry.lastActivity;
      const conn = entry.conn;
      if (conn === null) continue;
      if (index >= this.settings.idleConnectionsKept) {
        if (idleFor >= this.settings.idleCloseMs) {
          entry.conn = null;
          this.emit("debug", "kps.conn.idle-close", { entry: entry.label, idleMs: idleFor });
          void safeClose(conn, { code: "closed" });
        }
        continue;
      }
      if (idleFor >= this.settings.keepaliveMs && !entry.keepaliveInFlight) {
        entry.keepaliveInFlight = true;
        this.request(`kps:${entry.address}${KPS_HEALTH_TARGET}`, { method: "GET" })
          .then(
            (response) => {
              void response.arrayBuffer().catch(noop);
            },
            () => {
              this.emit("warn", "kps.keepalive.failed", { entry: entry.label });
            },
          )
          .finally(() => {
            entry.keepaliveInFlight = false;
          });
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

/** Only `Content-Type` is taken from the caller; `Host` and `Content-Length` are computed. */
function contentTypeOnly(headers: RequestInit["headers"]): [string, string][] {
  if (headers === undefined) return [];
  let value: string | null = null;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    value = headers.get("content-type");
  } else if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0]).toLowerCase() === "content-type") value = String(pair[1]);
    }
  } else {
    for (const [name, entry] of Object.entries(headers as Record<string, string>)) {
      if (name.toLowerCase() === "content-type") value = String(entry);
    }
  }
  return value === null ? [] : [["Content-Type", value]];
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

function noop(): void {
  // Intentionally empty.
}
