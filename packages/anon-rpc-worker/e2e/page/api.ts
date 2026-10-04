// The host page's test API (window.e2e). Arguments and results are plain JSON
// so Playwright can pass them across page.evaluate().

import type { EchoSample } from "../shared/kps-echo.js";

export interface ErrorInfo {
  readonly name: string;
  readonly message: string;
  /** Present when the harness reports a structured code (signalFailed, RpcError). */
  readonly code?: string;
}

export interface BootRequest {
  /** Handle name used by later calls. */
  readonly id: string;
  /** WorkerSpecifier contract address. */
  readonly address: string;
  /** JSON-RPC URL the page's preExisting.rpcProvider reads the specifier through. */
  readonly specifierRpcUrl: string;
  /** Worker config (§7.1); omitted means the harness passes no config at all. */
  readonly config?: unknown;
  readonly readyTimeoutMs: number;
  /**
   * false: return right after construction, without waiting for `ready`, so
   * calls can be issued before the worker is ready (AR-37). Default true.
   */
  readonly awaitReady?: boolean;
}

export interface BootResult {
  readonly ok: boolean;
  /** Construction to `ready` settling, in ms. */
  readonly readyMs: number;
  readonly error?: ErrorInfo;
  /** The sandbox attribute of the harness iframe that hosts this worker. */
  readonly sandbox: string | null;
}

export interface FetchRequest {
  readonly id: string;
  readonly url: string;
  readonly method?: string;
  readonly headers?: readonly (readonly [string, string])[];
  /** UTF-8 request body. */
  readonly body?: string;
  readonly timeoutMs: number;
  /** Abort this call after N ms (abort tests); absent means only the timeout applies. */
  readonly abortAfterMs?: number;
}

export interface FetchResult {
  readonly ok: boolean;
  readonly ms: number;
  readonly status?: number;
  readonly headers?: [string, string][];
  readonly bodyText?: string;
  readonly error?: ErrorInfo;
}

export interface LogLine {
  readonly level: string;
  readonly text: string;
}

export interface DirectEchoRequest {
  readonly addr: string;
  /** "echo" (default) or "download" against tools/kps-bulk-server. */
  readonly transfer?: "echo" | "download";
  readonly sizes: readonly number[];
  /** Additional sequential streams of sizes[0] bytes on the same connection. */
  readonly sequentialStreams: number;
  /** Concurrent streams of sizes[0] bytes on the same connection. */
  readonly parallelStreams: number;
  readonly dialTimeoutMs: number;
  /** Deadline for one stream: open, write, read the echo to EOF. */
  readonly streamTimeoutMs: number;
}

export interface DirectEchoResult {
  readonly ok: boolean;
  readonly dialMs: number;
  readonly remote?: { readonly ip: string; readonly port: number };
  readonly samples: readonly EchoSample[];
  readonly sequential: readonly EchoSample[];
  readonly parallel: readonly EchoSample[];
  readonly error?: string;
}

export interface E2EPageApi {
  readonly harnessVersion: string;
  boot(request: BootRequest): Promise<BootResult>;
  fetch(request: FetchRequest): Promise<FetchResult>;
  /** Wait for `ready` of a worker booted with awaitReady: false. */
  ready(id: string, timeoutMs: number): Promise<BootResult>;
  /** Drain up to `max` log entries, waiting at most `waitMs` for each. */
  logs(id: string, max: number, waitMs: number): Promise<LogLine[]>;
  close(id: string): void;
  /** Dial a KPS address straight from the page with @kpstreams/webrtc-client. */
  directKpsEcho(request: DirectEchoRequest): Promise<DirectEchoResult>;
}
