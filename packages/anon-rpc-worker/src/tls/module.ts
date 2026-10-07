/**
 * The embedded TLS module (packages/nox-tls, rustls with ring compiled to
 * WebAssembly). The worker runs TLS itself and hands the exit TLS records
 * only. Errors thrown by the module carry a stable string `code`.
 */

/** One TLS session (sans-IO): the tunnel moves its records. */
export interface TlsSessionLike {
  takeOutgoing(): Uint8Array;
  pushIncoming(data: Uint8Array): void;
  pushTransportEof(): void;
  isHandshaking(): boolean;
  wantsWrite(): boolean;
  closeNotifyReceived(): boolean;
  isClosed(): boolean;
  writePlaintext(data: Uint8Array): void;
  takePlaintext(): Uint8Array;
  close(): void;
  protocol(): string;
  free(): void;
}

export interface HttpReplyHead {
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
  readonly keepAlive: boolean;
}

/** Incremental HTTP/1.1 response parser. */
export interface HttpParserLike {
  /** True once the response is complete. */
  push(data: Uint8Array): boolean;
  finishOnClose(closeNotify: boolean): void;
  response(): HttpReplyHead | null;
  free(): void;
}

export interface TlsModuleInfo {
  readonly crate: string;
  /** Trust anchors compiled in (Mozilla roots via webpki-roots). */
  readonly webpkiRoots: number;
}

/** What the worker uses of the module. */
export interface NoxTlsBindings {
  newSession(serverName: string): TlsSessionLike;
  newParser(headRequest: boolean, maxHeadBytes: number, maxBodyBytes: number): HttpParserLike;
  /** `headers` alternates names and values. */
  encodeRequest(
    method: string,
    authority: string,
    target: string,
    headers: string[],
    body: Uint8Array,
    keepAlive: boolean,
    padJson: boolean,
  ): Uint8Array;
  readonly info: TlsModuleInfo;
}

/** The wasm-bindgen exports of packages/nox-tls (web target). */
export interface NoxTlsExports {
  TlsClientConfig: new (extraRootDer: Uint8Array | undefined) => object;
  TlsClientSession: new (config: object, serverName: string) => TlsSessionLike;
  HttpResponseParser: new (headRequest: boolean, maxHeadBytes: number, maxBodyBytes: number) => HttpParserLike;
  encodeHttpRequest(
    method: string,
    authority: string,
    target: string,
    headers: string[],
    body: Uint8Array,
    keepAlive: boolean,
    padJson: boolean,
  ): Uint8Array;
  buildInfo(): TlsModuleInfo;
}

/**
 * Bindings over an initialised module. `extraRootDer` is a test bed's CA,
 * embedded by `build-test-worker.mjs --extra-root`; release bundles embed none.
 */
export function tlsBindings(exports: NoxTlsExports, extraRootDer: Uint8Array | null): NoxTlsBindings {
  const config = new exports.TlsClientConfig(extraRootDer ?? undefined);
  return {
    newSession: (serverName) => new exports.TlsClientSession(config, serverName),
    newParser: (headRequest, maxHeadBytes, maxBodyBytes) =>
      new exports.HttpResponseParser(headRequest, maxHeadBytes, maxBodyBytes),
    encodeRequest: (...args) => exports.encodeHttpRequest(...args),
    info: exports.buildInfo(),
  };
}

/** A `code` the module set on an error, or `undefined`. */
export function tlsErrorCode(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^(TLS|HTTP)_[A-Z_]+$/u.test(code) ? code : undefined;
}
