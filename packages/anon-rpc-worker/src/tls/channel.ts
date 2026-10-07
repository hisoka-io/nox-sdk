/**
 * A TLS session to one host over one tunnel: the handshake exchange, then
 * HTTP/1.1 requests. Completeness of a response comes from HTTP framing or,
 * for a close-delimited body, from TLS close_notify; an exit that ends the
 * stream early produces a truncation error, never a short response.
 */
import type { TopologyNode } from "@hisoka-io/nox-client";
import type { HttpParserLike, HttpReplyHead, NoxTlsBindings, TlsSessionLike } from "./module.js";
import { Tunnel, TunnelProtocolError, type CopyPolicy, type TunnelDeps, type TunnelPort } from "./tunnel.js";

/** Reply blocks for the handshake exchange: one carries the server flight, the other is the exit's reserve. */
export const HANDSHAKE_SURBS = 2;
/** The TLS port every tunnel uses. */
export const TLS_PORT = 443;

export interface ExchangeTiming {
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  readonly background: boolean;
}

export interface RequestSpec extends ExchangeTiming {
  /** The encoded HTTP/1.1 request. */
  readonly http: Uint8Array;
  readonly headRequest: boolean;
  readonly maxHeadBytes: number;
  readonly maxBodyBytes: number;
  /** Reply blocks for the exchange that carries the request. */
  readonly surbs: number;
}

export class TlsChannel {
  readonly tunnel: Tunnel;
  readonly openedAt: number;
  /** Requests sent on this session. */
  calls = 0;
  /** False once a response asked to close or the stream ended. */
  private keepAlive = true;
  private parser: HttpParserLike | undefined;
  private parserDone = false;
  private freed = false;
  private readonly tls: TlsSessionLike;

  constructor(
    port: TunnelPort,
    exit: TopologyNode,
    readonly host: string,
    policy: CopyPolicy,
    deps: TunnelDeps,
    private readonly bindings: NoxTlsBindings,
  ) {
    this.tls = bindings.newSession(host);
    this.openedAt = deps.now();
    this.tunnel = new Tunnel(port, exit, host, TLS_PORT, policy, deps, (bytes) => this.onBytes(bytes));
  }

  get exit(): TopologyNode {
    return this.tunnel.exit;
  }

  /** TLS version negotiated (`TLSv1_3`, `TLSv1_2`). */
  get protocol(): string {
    return this.tls.protocol();
  }

  /** The session can carry another request. */
  get reusable(): boolean {
    return !this.freed && this.keepAlive && !this.tunnel.eof && !this.tls.isClosed();
  }

  /**
   * Seq 0: open the tunnel with the ClientHello and process the server's
   * flight. Afterwards the client's next flight (the TLS 1.3 Finished) waits
   * in the session until the first request, which travels with it.
   */
  async handshake(timing: ExchangeTiming & { readonly openTimeoutMs: number }): Promise<void> {
    const hello = this.tls.takeOutgoing();
    const outcome = await this.tunnel.exchange({
      data: hello,
      surbs: HANDSHAKE_SURBS,
      deadlineAt: timing.deadlineAt,
      background: timing.background,
      openTimeoutMs: timing.openTimeoutMs,
      ...(timing.signal === undefined ? {} : { signal: timing.signal }),
      satisfied: () => this.tls.wantsWrite() || !this.tls.isHandshaking(),
    });
    if (outcome === "eof") throw new TunnelProtocolError("The upstream closed the connection during the TLS handshake");
  }

  /** One HTTP request and its complete response. */
  async request(spec: RequestSpec): Promise<HttpReplyHead> {
    this.calls += 1;
    const parser = this.bindings.newParser(spec.headRequest, spec.maxHeadBytes, spec.maxBodyBytes);
    this.parser = parser;
    this.parserDone = false;
    try {
      this.tls.writePlaintext(spec.http);
      for (;;) {
        const data = this.tls.takeOutgoing();
        const outcome = await this.tunnel.exchange({
          data,
          surbs: spec.surbs,
          deadlineAt: spec.deadlineAt,
          background: spec.background,
          ...(spec.signal === undefined ? {} : { signal: spec.signal }),
          satisfied: () => this.parserDone || this.tls.wantsWrite(),
        });
        if (outcome === "eof") {
          this.keepAlive = false;
          this.tls.pushTransportEof();
          this.feedParser(this.tls.takePlaintext());
          if (!this.parserDone) {
            parser.finishOnClose(this.tls.closeNotifyReceived());
            this.parserDone = true;
          }
        }
        if (this.parserDone) break;
      }
      const response = parser.response();
      if (response === null) throw new TunnelProtocolError("The HTTP parser finished without a response");
      if (!response.keepAlive) this.keepAlive = false;
      return response;
    } finally {
      this.parser = undefined;
      parser.free();
    }
  }

  /** Send close_notify and half-close the upstream; nothing waits for it. */
  teardown(deadlineAt: number): Promise<void> {
    if (this.freed) return Promise.resolve();
    this.keepAlive = false;
    let data: Uint8Array;
    try {
      this.tls.close();
      data = this.tls.takeOutgoing();
    } catch (error) {
      this.free();
      return Promise.reject(error);
    }
    this.free();
    return this.tunnel.eof ? Promise.resolve() : this.tunnel.teardown(data, deadlineAt);
  }

  /** Release the TLS session's WebAssembly memory. */
  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.tls.free();
  }

  private onBytes(bytes: Uint8Array): void {
    this.tls.pushIncoming(bytes);
    this.feedParser(this.tls.takePlaintext());
    if (this.tls.closeNotifyReceived() && this.parser !== undefined && !this.parserDone) {
      this.parser.finishOnClose(true);
      this.parserDone = true;
    }
  }

  private feedParser(plaintext: Uint8Array): void {
    if (plaintext.length === 0) return;
    if (this.parser === undefined || this.parserDone) {
      throw new TunnelProtocolError(`The upstream sent ${plaintext.length} bytes with no request outstanding`);
    }
    this.parserDone = this.parser.push(plaintext);
  }
}
