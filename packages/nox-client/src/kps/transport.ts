/**
 * `NoxFetch` over KPS: each request is one KPS-HTTP/1 exchange on its own
 * stream, and streams share one reused connection per KPS address.
 *
 * Only `kps:<address><path>` locators are accepted. Anything else is refused
 * with `NoxKpsError("unsupported")`; this module never reaches an ambient
 * `fetch`, so a KPS client cannot fall back to HTTPS.
 */
import { NoxClientError, NoxClientErrorCode, type NoxFetch } from "../types.js";
import { parseKpsLocator, canonicalKpsAddress, kpsAddressLabel } from "./address.js";
import { NoxKpsError, describeError, kpsErrorCodeOf, type KpsErrorCode } from "./errors.js";
import {
  encodeKpsHttpRequest,
  readKpsHttpResponseBody,
  readKpsHttpResponseHead,
  type KpsHttpReadLimits,
  type KpsHttpResponseHead,
} from "./http1.js";
import type {
  NoxKpsConnection,
  NoxKpsDialer,
  NoxKpsReason,
  NoxKpsStream,
  NoxKpsTransportEvent,
  NoxKpsTransportSettings,
} from "./types.js";

/** Transport defaults (tor-js bounds `openStream` at 20 s; Nox exchanges are small). */
export const KPS_TRANSPORT_DEFAULTS: Readonly<NoxKpsTransportSettings> = Object.freeze({
  dialTimeoutMs: 15_000,
  openStreamTimeoutMs: 10_000,
  headTimeoutMs: 15_000,
  exchangeTimeoutMs: 45_000,
  maxHeadBytes: 16 * 1024,
  maxResponseBytes: 16 * 1024 * 1024,
  maxConcurrentStreams: 32,
  redialBaseMs: 1_000,
  redialMaxMs: 30_000,
});

/** Fill and validate transport settings. Throws `INVALID_CONFIG`. */
export function resolveKpsTransportSettings(
  overrides: Partial<NoxKpsTransportSettings> | undefined,
): NoxKpsTransportSettings {
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null)) {
    throw new NoxClientError("kps.transport must be an object", NoxClientErrorCode.InvalidConfig);
  }
  const settings: NoxKpsTransportSettings = { ...KPS_TRANSPORT_DEFAULTS };
  for (const key of Object.keys(overrides ?? {})) {
    if (!(key in KPS_TRANSPORT_DEFAULTS)) {
      throw new NoxClientError(
        `kps.transport.${key} is not a KPS transport setting`,
        NoxClientErrorCode.InvalidConfig,
      );
    }
    const value = (overrides as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new NoxClientError(
        `kps.transport.${key} must be a positive safe integer`,
        NoxClientErrorCode.InvalidConfig,
      );
    }
    (settings as unknown as Record<string, number>)[key] = value;
  }
  if (settings.redialMaxMs < settings.redialBaseMs) {
    throw new NoxClientError(
      "kps.transport.redialMaxMs must be at least redialBaseMs",
      NoxClientErrorCode.InvalidConfig,
    );
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
  dial: Promise<NoxKpsConnection> | null;
  conn: NoxKpsConnection | null;
  readonly teardowns: Set<(error: NoxKpsError) => void>;
  active: number;
  readonly waiters: StreamWaiter[];
  failures: number;
  coolUntil: number;
}

const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);
const STANDARD_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH"];

/** KPS-HTTP/1 client with a connection pool keyed by KPS address. */
export class KpsHttpTransport {
  /** `fetch`-compatible entry point; bind-free, safe to pass around. */
  readonly fetch: NoxFetch;
  private readonly pool = new Map<string, PoolEntry>();
  private readonly limits: KpsHttpReadLimits;
  private closed = false;

  constructor(
    private readonly dialer: NoxKpsDialer,
    private readonly settings: NoxKpsTransportSettings = { ...KPS_TRANSPORT_DEFAULTS },
    private readonly onEvent?: (event: NoxKpsTransportEvent) => void,
  ) {
    if (typeof dialer !== "object" || dialer === null || typeof dialer.dial !== "function") {
      throw new NoxClientError(
        "KPS mode requires a dialer with a dial(address) function (anonRpcWorker.kps fits)",
        NoxClientErrorCode.InvalidConfig,
      );
    }
    this.limits = {
      maxHeadBytes: settings.maxHeadBytes,
      maxBodyBytes: settings.maxResponseBytes,
    };
    this.fetch = (input, init) => this.request(input, init);
  }

  /** Make sure a connection to `address` is up (dialing if needed). */
  async warm(address: string, signal?: AbortSignal): Promise<void> {
    await this.connection(this.entry(canonicalKpsAddress(address)), signal);
  }

  /** True while `address` is in its post-failure dial cooldown. */
  isCoolingDown(address: string): boolean {
    const entry = this.pool.get(canonicalKpsAddress(address));
    return entry !== undefined && entry.conn === null && entry.coolUntil > Date.now();
  }

  /** True when a connection to `address` is established. */
  isConnected(address: string): boolean {
    return this.pool.get(canonicalKpsAddress(address))?.conn != null;
  }

  /** Close every connection and fail every waiting or in-flight exchange. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new NoxKpsError("KPS transport closed", "closed");
    for (const entry of this.pool.values()) {
      for (const waiter of entry.waiters.splice(0)) waiter.fail(error);
      for (const teardown of [...entry.teardowns]) teardown(error);
      entry.teardowns.clear();
      const conn = entry.conn;
      entry.conn = null;
      if (conn !== null) void conn.close({ code: "closed" }).catch(noop);
    }
    this.pool.clear();
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
      };
      this.pool.set(address, entry);
    }
    return entry;
  }

  private async request(input: string, init?: RequestInit): Promise<Response> {
    if (this.closed) throw new NoxKpsError("KPS transport closed", "closed");
    const locator = parseKpsLocator(String(input));
    const method = normalizeMethod(init?.method);
    const requestBytes = encodeKpsHttpRequest({
      method,
      path: locator.path,
      certhash: locator.certhash,
      headers: headerPairs(init?.headers),
      body: requestBody(init?.body),
    });
    const entry = this.entry(locator.address);
    const callerSignal = init?.signal ?? undefined;
    if (callerSignal?.aborted === true) throw abortReason(callerSignal);

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
            `KPS exchange ${method} ${locator.path} via ${entry.label} timed out after ${this.settings.exchangeTimeoutMs} ms`,
            "timeout",
          ),
        ),
      this.settings.exchangeTimeoutMs,
    );

    let acquired = false;
    let stream: NoxKpsStream | null = null;
    let streamClosed = false;
    const closeStream = (reason?: NoxKpsReason): void => {
      if (stream === null || streamClosed) return;
      streamClosed = true;
      void stream.close(reason).catch(noop);
    };
    let removeTeardown = noop;
    try {
      const conn = await this.connection(entry, exchange.signal);
      await this.acquire(entry, exchange.signal);
      acquired = true;
      stream = await this.openStream(entry, conn, exchange.signal);
      const opened = stream;
      removeTeardown = this.addTeardown(entry, conn, fail);
      const writer = opened.writable.getWriter();
      const reader = opened.readable.getReader();
      exchange.signal.addEventListener(
        "abort",
        () => {
          void reader.cancel(exchange.signal.reason).catch(noop);
          closeStream({ code: "cancelled" });
        },
        { once: true },
      );
      await raceSignal(writer.write(requestBytes), exchange.signal);
      // Closing the writable is closeWrite (SPEC §10.2): the request ends at EOF.
      await raceSignal(writer.close(), exchange.signal);
      const headTimer = setTimeout(
        () =>
          fail(
            new NoxKpsError(
              `KPS exchange ${method} ${locator.path} via ${entry.label}: no response head within ${this.settings.headTimeoutMs} ms`,
              "timeout",
            ),
          ),
        this.settings.headTimeoutMs,
      );
      let head: KpsHttpResponseHead;
      let rest: Uint8Array;
      try {
        ({ head, rest } = await raceSignal(
          readKpsHttpResponseHead(reader, this.limits),
          exchange.signal,
        ));
      } finally {
        clearTimeout(headTimer);
      }
      const body = await raceSignal(
        readKpsHttpResponseBody(reader, head, rest, method, this.limits),
        exchange.signal,
      );
      return toResponse(head, body);
    } catch (error) {
      if (isAborted(callerSignal)) throw abortReason(callerSignal);
      const failure = asKpsError(
        exchange.signal.aborted ? exchange.signal.reason : error,
        `KPS exchange ${method} ${locator.path} via ${entry.label} failed`,
      );
      this.emit({ type: "exchange-failed", entry: entry.label, code: failure.code, route: locator.path });
      throw failure;
    } finally {
      clearTimeout(exchangeTimer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      removeTeardown();
      closeStream();
      if (acquired) this.release(entry);
    }
  }

  private connection(entry: PoolEntry, signal?: AbortSignal): Promise<NoxKpsConnection> {
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

  private startDial(entry: PoolEntry): Promise<NoxKpsConnection> {
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = this.settings.dialTimeoutMs;
    const timer = setTimeout(
      () =>
        controller.abort(
          new NoxKpsError(`KPS dial to ${entry.label} timed out after ${timeoutMs} ms`, "timeout"),
        ),
      timeoutMs,
    );
    let pending: Promise<NoxKpsConnection>;
    try {
      pending = Promise.resolve(this.dialer.dial(entry.address, { signal: controller.signal }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    // A dial that completes after its deadline (or after close) is closed, not leaked.
    pending.then(
      (late) => {
        if (controller.signal.aborted || this.closed) void safeClose(late);
      },
      noop,
    );
    return raceSignal(pending, controller.signal).then(
      (conn) => {
        clearTimeout(timer);
        if (this.closed) {
          void safeClose(conn);
          throw new NoxKpsError("KPS transport closed", "closed");
        }
        assertConnection(conn);
        entry.dial = null;
        entry.conn = conn;
        entry.failures = 0;
        entry.coolUntil = 0;
        const onClosed = (info: unknown): void => {
          if (entry.conn === conn) entry.conn = null;
          const clean = typeof info === "object" && info !== null && (info as { ok?: unknown }).ok === true;
          this.emit({ type: "connection-closed", entry: entry.label, clean });
          const error = new NoxKpsError(`KPS connection to ${entry.label} closed`, "closed");
          for (const teardown of [...entry.teardowns]) teardown(error);
          entry.teardowns.clear();
        };
        conn.closed.then(onClosed, onClosed);
        this.emit({ type: "dialed", entry: entry.label, elapsedMs: Date.now() - started });
        return conn;
      },
      (error: unknown) => {
        clearTimeout(timer);
        entry.dial = null;
        entry.failures += 1;
        const backoff = Math.min(
          this.settings.redialBaseMs * 2 ** Math.min(entry.failures - 1, 30),
          this.settings.redialMaxMs,
        );
        entry.coolUntil = Date.now() + backoff;
        const failure = asKpsError(error, `KPS dial to ${entry.label} failed`, "network-error");
        this.emit({
          type: "dial-failed",
          entry: entry.label,
          code: failure.code,
          failures: entry.failures,
          retryInMs: backoff,
        });
        throw failure;
      },
    );
  }

  private async openStream(
    entry: PoolEntry,
    conn: NoxKpsConnection,
    signal: AbortSignal,
  ): Promise<NoxKpsStream> {
    const controller = new AbortController();
    const timeoutMs = this.settings.openStreamTimeoutMs;
    const timer = setTimeout(
      () =>
        controller.abort(
          new NoxKpsError(`KPS openStream to ${entry.label} timed out after ${timeoutMs} ms`, "timeout"),
        ),
      timeoutMs,
    );
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<NoxKpsStream>;
    try {
      pending = Promise.resolve(conn.openStream({ signal: controller.signal }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (late) => {
        if (controller.signal.aborted) void late.close({ code: "cancelled" }).catch(noop);
      },
      noop,
    );
    try {
      const stream = await raceSignal(pending, controller.signal);
      assertStream(stream);
      return stream;
    } catch (error) {
      // A stream that cannot be opened within the bound means the connection
      // is wedged (kps ISSUES #14); drop it so the next exchange re-dials.
      if (!signal.aborted && controller.signal.aborted && entry.conn === conn) {
        entry.conn = null;
        void safeClose(conn);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private acquire(entry: PoolEntry, signal: AbortSignal): Promise<void> {
    if (entry.active < this.settings.maxConcurrentStreams) {
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
    const next = entry.waiters.shift();
    if (next !== undefined) next.grant();
  }

  private addTeardown(
    entry: PoolEntry,
    conn: NoxKpsConnection,
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

  private emit(event: NoxKpsTransportEvent): void {
    if (this.onEvent === undefined) return;
    try {
      this.onEvent(event);
    } catch {
      // Diagnostics are best effort; a throwing hook never breaks transport.
    }
  }
}

/**
 * Resolve with `promise` or reject with `signal.reason` once the signal aborts,
 * whichever comes first. The losing promise's rejection is observed so it can
 * never surface as unhandled.
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

function asKpsError(error: unknown, context: string, fallback: KpsErrorCode = "network-error"): NoxKpsError {
  if (error instanceof NoxKpsError) return error;
  return new NoxKpsError(`${context}: ${describeError(error)}`, kpsErrorCodeOf(error, fallback), error);
}

/** Read through a function so TypeScript does not keep a stale narrowing. */
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

function headerPairs(headers: RequestInit["headers"]): [string, string][] {
  if (headers === undefined) return [];
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const pairs: [string, string][] = [];
    headers.forEach((value, name) => pairs.push([name, value]));
    return pairs;
  }
  if (Array.isArray(headers)) {
    return headers.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new NoxKpsError("KPS transport header pairs must be [name, value]", "protocol-error");
      }
      return [String(pair[0]), String(pair[1])];
    });
  }
  return Object.entries(headers as Record<string, string>).map(([name, value]) => [name, String(value)]);
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

function assertConnection(conn: unknown): asserts conn is NoxKpsConnection {
  const candidate = conn as Partial<NoxKpsConnection> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.openStream !== "function" ||
    typeof candidate.close !== "function" ||
    typeof (candidate.closed as Promise<unknown> | undefined)?.then !== "function"
  ) {
    throw new NoxKpsError(
      "KPS dialer returned an object without openStream/close/closed",
      "protocol-error",
    );
  }
}

function assertStream(stream: unknown): asserts stream is NoxKpsStream {
  const candidate = stream as Partial<NoxKpsStream> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.readable?.getReader !== "function" ||
    typeof candidate.writable?.getWriter !== "function" ||
    typeof candidate.close !== "function"
  ) {
    throw new NoxKpsError("KPS openStream returned an object without readable/writable/close", "protocol-error");
  }
}

async function safeClose(conn: unknown): Promise<void> {
  try {
    const close = (conn as { close?: unknown } | null)?.close;
    if (typeof close === "function") {
      await (close as (reason?: unknown) => Promise<void>).call(conn, { code: "cancelled" });
    }
  } catch {
    // Closing a connection nobody uses is best effort.
  }
}

function noop(): void {
  // Intentionally empty.
}
