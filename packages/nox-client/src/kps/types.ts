/**
 * KPS capability shapes the client consumes. They are a structural subset of
 * anon-rpc SPEC §10 (`KpsApi`, `KpsConn`, `KpsStream`) and §12 (`KpsReason`),
 * so `anonRpcWorker.kps` can be passed as the dialer unchanged, and so can a
 * `@kpstreams/*` client wrapped in a one-line `dial` function.
 */
import type { KpsErrorCode } from "./errors.js";

/** `<ip>:<port>:<certhash>`, IPv6 hosts bracketed (KPS SPEC §2). */
export type KpsAddress = string;

export interface NoxKpsReason {
  code?: KpsErrorCode;
  message?: string;
}

export interface NoxKpsCloseInfo {
  ok: boolean;
  reason?: NoxKpsReason;
}

export interface NoxKpsAbortOptions {
  signal?: AbortSignal;
}

/** One reliable, ordered, bidirectional byte stream (SPEC §10.2). */
export interface NoxKpsStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  closeWrite(): Promise<void>;
  cancelRead(reason?: NoxKpsReason): Promise<void>;
  resetWrite(reason?: NoxKpsReason): Promise<void>;
  close(reason?: NoxKpsReason): Promise<void>;
  readonly closed: Promise<NoxKpsCloseInfo>;
}

/** One authenticated, multiplexed connection to a pinned identity (SPEC §10.1). */
export interface NoxKpsConnection {
  openStream(opts?: NoxKpsAbortOptions): Promise<NoxKpsStream>;
  close(reason?: NoxKpsReason): Promise<void>;
  readonly closed: Promise<NoxKpsCloseInfo>;
}

/**
 * Dials KPS addresses. The dialer MUST authenticate the peer against the
 * certhash in the address (SPEC §10); the client never sees certificates.
 */
export interface NoxKpsDialer {
  dial(address: KpsAddress, opts?: NoxKpsAbortOptions): Promise<NoxKpsConnection>;
}

/** Tunables of the KPS-HTTP/1 transport. Every field has a default. */
export interface NoxKpsTransportSettings {
  /** Bound on one dial (connection establishment and KPS HELLO). */
  dialTimeoutMs: number;
  /** Bound on opening one stream on an established connection (kps ISSUES #14). */
  openStreamTimeoutMs: number;
  /** Bound from the request being written to the final response head. */
  headTimeoutMs: number;
  /** Bound on one whole exchange, dial wait included. */
  exchangeTimeoutMs: number;
  /** Largest accepted response header block. */
  maxHeadBytes: number;
  /** Largest accepted response body. */
  maxResponseBytes: number;
  /** Streams open at once on one connection; further requests wait in order. */
  maxConcurrentStreams: number;
  /** First dial cooldown after a failed dial; doubles per consecutive failure. */
  redialBaseMs: number;
  /** Cap on the dial cooldown. */
  redialMaxMs: number;
}

/** Non-sensitive transport events for diagnostics. `entry` is a certhash prefix. */
export type NoxKpsTransportEvent =
  | { type: "dialed"; entry: string; elapsedMs: number }
  | { type: "dial-failed"; entry: string; code: KpsErrorCode; failures: number; retryInMs: number }
  | { type: "connection-closed"; entry: string; clean: boolean }
  | { type: "exchange-failed"; entry: string; code: KpsErrorCode; route: string };
