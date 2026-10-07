/**
 * The transport of each fetch hop (E2E TLS design §5): a TLS tunnel, the
 * exit's `HttpRequest` path, or a refusal. The choice is made before any
 * byte of the hop leaves the worker, from the URL and the capability data
 * only, and a call that started on a tunnel never continues in plaintext, so
 * an exit cannot force a downgrade by dropping tunnel traffic.
 */
import { TUNNEL_PART_MAX_DATA, type DecodedHttpResponse, type TunnelRejectCodeV1 } from "@hisoka-io/nox-client";
import type { TlsSetting } from "../config.js";
import { CALL_CODES, NoxWorkerError, callError } from "../errors.js";
import {
  MAX_REQUEST_HEADER_BYTES,
  mapClientError,
  type CallBudget,
  type PreparedRequest,
  type TunnelHop,
} from "../fetch-map.js";
import { describeError, type WorkerLogger } from "../log.js";
import { TLS_PORT } from "./channel.js";
import { tlsErrorCode, type NoxTlsBindings } from "./module.js";
import { NoTunnelExitError, type TlsPool } from "./pool.js";
import {
  TunnelOpenTimeoutError,
  TunnelProtocolError,
  TunnelRejectedError,
  TunnelTimeoutError,
} from "./tunnel.js";

/** Reply blocks per exchange the exits accept by default (`max_surbs_per_exchange`). */
export const MAX_SURBS_PER_EXCHANGE = 32;
/** Parts in one 1 MiB exit window (`max_window_bytes`). */
export const WINDOW_PARTS = 32;
/** Reply blocks for an exchange of unknown reply size. */
export const MIN_REQUEST_SURBS = 2;

/** Why a URL cannot go through a tunnel (logged as `tls.fallback{reason}`). */
export type FallbackReason = "http-url" | "port" | "ip-literal" | "host-name" | "no-tunnel-exit";

/** What a tunnel needs from a URL. */
export interface TunnelTarget {
  readonly host: string;
  /** Path and query, the HTTP request target. */
  readonly target: string;
  /** `Authorization` from URL credentials, when the URL carries any. */
  readonly authorization: string | undefined;
}

/** Longest DNS name the exit accepts. */
const MAX_HOST_BYTES = 253;
const DNS_NAME_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** The tunnel target of `url`, or why it has none. */
export function tunnelTarget(url: URL): TunnelTarget | FallbackReason {
  if (url.protocol !== "https:") return "http-url";
  if (url.port !== "" && Number(url.port) !== TLS_PORT) return "port";
  const host = url.hostname;
  if (host.startsWith("[") || IPV4_RE.test(host)) return "ip-literal";
  if (host.length > MAX_HOST_BYTES || !DNS_NAME_RE.test(host)) return "host-name";
  const authorization = url.username === "" && url.password === ""
    ? undefined
    : `Basic ${base64(new TextEncoder().encode(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`))}`;
  return { host, target: `${url.pathname}${url.search}`, authorization };
}

/**
 * The transport of one hop under `setting` (the §5 table). `hop` counts
 * redirects; `startedOnTunnel` is true once an earlier hop of the call used
 * a tunnel. Throws the call's rejection when the hop may not leave.
 */
export function chooseTransport(
  setting: TlsSetting,
  url: URL,
  tunnelExitKnown: boolean,
  hop: number,
  startedOnTunnel: boolean,
): { readonly via: "tunnel" } | { readonly via: "http"; readonly reason: FallbackReason | undefined } {
  if (setting === "off" && !startedOnTunnel) return { via: "http", reason: undefined };
  const target = tunnelTarget(url);
  const reason = typeof target === "string" ? target : tunnelExitKnown ? undefined : "no-tunnel-exit";
  if (reason === undefined) return { via: "tunnel" };
  if (startedOnTunnel) {
    throw callError(
      CALL_CODES.networkError,
      `Redirect refused: this call started on a TLS tunnel and the target cannot use one (${reason})`,
    );
  }
  if (setting === "preferred") return { via: "http", reason };
  if (reason === "no-tunnel-exit") throw callError(CALL_CODES.networkError, "No exit offers TLS tunnels");
  const message = "TLS tunnels reach https hosts by name on port 443";
  throw hop === 0
    ? callError(CALL_CODES.unsupported, `${message} (tls is "required")`)
    : callError(CALL_CODES.networkError, `Redirect refused: ${message} (tls is "required")`);
}

/** Reply blocks for the exchange that carries a request expecting `expectedBytes`. */
export function requestSurbs(expectedBytes: number | undefined): number {
  if (expectedBytes === undefined || expectedBytes <= 0) return MIN_REQUEST_SURBS;
  const wanted = Math.ceil(expectedBytes / TUNNEL_PART_MAX_DATA) + 1;
  return Math.max(MIN_REQUEST_SURBS, Math.min(wanted, MAX_SURBS_PER_EXCHANGE, WINDOW_PARTS + 1));
}

const PERMISSION_CODES: ReadonlySet<TunnelRejectCodeV1> = new Set(["PortNotAllowed", "HostNotAllowed", "DestinationBlocked"]);
const PROTOCOL_CODES: ReadonlySet<TunnelRejectCodeV1> = new Set(["NotTls", "Malformed", "OutOfOrder"]);
const TLS_PROTOCOL_CODES: ReadonlySet<string> = new Set([
  "TLS_ALERT_RECEIVED",
  "TLS_DECRYPT_FAILED",
  "TLS_PEER_MISBEHAVED",
  "TLS_PEER_INCOMPATIBLE",
  "TLS_PROTOCOL",
  "TLS_IO",
  "TLS_CLOSED",
  "HTTP_RESPONSE_MALFORMED",
  "HTTP_RESPONSE_TRUNCATED",
]);

/** A tunnel or TLS failure as a call rejection (the §5 error table). */
export function mapTlsError(error: unknown): NoxWorkerError {
  if (error instanceof NoxWorkerError) return error;
  const detail = describeError(error);
  if (error instanceof TunnelRejectedError) {
    if (PERMISSION_CODES.has(error.code)) {
      return callError(CALL_CODES.permissionDenied, `The tunnel exit refuses this destination (${error.code})`, error);
    }
    if (PROTOCOL_CODES.has(error.code)) return callError(CALL_CODES.protocolError, detail, error);
    if (error.code === "ByteLimit") return callError(CALL_CODES.tooLarge, detail, error);
    return callError(CALL_CODES.networkError, detail, error);
  }
  if (error instanceof TunnelTimeoutError) return callError(CALL_CODES.timeout, detail, error);
  if (error instanceof TunnelOpenTimeoutError || error instanceof NoTunnelExitError) {
    return callError(CALL_CODES.networkError, detail, error);
  }
  if (error instanceof TunnelProtocolError) return callError(CALL_CODES.protocolError, detail, error);
  const code = tlsErrorCode(error);
  if (code === "TLS_CERTIFICATE_REJECTED") return callError(CALL_CODES.networkError, detail, error);
  if (code === "HTTP_RESPONSE_TOO_LARGE") return callError(CALL_CODES.tooLarge, detail, error);
  if (code === "HTTP_REQUEST_INVALID" || code === "TLS_INVALID_SERVER_NAME") {
    return callError(CALL_CODES.unsupported, detail, error);
  }
  if (code !== undefined && TLS_PROTOCOL_CODES.has(code)) return callError(CALL_CODES.protocolError, detail, error);
  return mapClientError(error);
}

/** Response headers that describe the TLS connection itself. */
const CONNECTION_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-connection"]);

/** Tunnel exchanges for fetch hops. */
export class TlsTransport implements TunnelHop {
  constructor(
    private readonly pool: TlsPool,
    private readonly bindings: NoxTlsBindings,
    private readonly settings: { readonly tls: TlsSetting; readonly tlsSession: string; readonly maxResponseBytes: number },
    private readonly log: WorkerLogger,
    private readonly now: () => number,
  ) {}

  /** `chooseTransport` with this worker's setting and exits; logs a fallback. */
  route(request: PreparedRequest, hop: number, startedOnTunnel: boolean): "tunnel" | "http" {
    const choice = chooseTransport(this.settings.tls, new URL(request.url), this.pool.hasTunnelExit(), hop, startedOnTunnel);
    if (choice.via === "http" && choice.reason !== undefined) this.log.info("tls.fallback", { reason: choice.reason });
    return choice.via;
  }

  /**
   * One hop through a TLS tunnel. A tunnel lost before the response (the
   * exit no longer knows the session, a silent exit, a spare the upstream
   * closed) is retried once on a new tunnel for a resendable read, or for
   * any request whose only copy the exit refused before writing it.
   */
  async exchange(request: PreparedRequest, budget: CallBudget): Promise<DecodedHttpResponse> {
    const target = tunnelTarget(new URL(request.url));
    if (typeof target === "string") throw callError(CALL_CODES.internalError, `A ${target} URL reached the tunnel path`);
    const http = this.encode(request, target);
    const resendable = request.profile.retryable;
    for (let attempt = 0; ; attempt++) {
      const deadlineAt = this.now() + budget.remainingMs();
      let channel;
      try {
        channel = await this.pool.acquire(target.host, { deadlineAt, signal: budget.signal });
      } catch (error) {
        if (budget.signal.aborted) throw budget.signal.reason;
        throw mapTlsError(error);
      }
      try {
        const reply = await channel.request({
          http,
          headRequest: request.method === "HEAD",
          maxHeadBytes: MAX_REQUEST_HEADER_BYTES,
          maxBodyBytes: this.settings.maxResponseBytes,
          surbs: requestSurbs(request.profile.expectedResponseBytes),
          deadlineAt,
          signal: budget.signal,
          background: false,
        });
        this.pool.release(channel, true);
        return {
          status: reply.status,
          headers: reply.headers.filter(([name]) => !CONNECTION_HEADERS.has(name.toLowerCase())),
          body: reply.body,
          truncated: false,
        };
      } catch (error) {
        this.pool.release(channel, false);
        if (budget.signal.aborted) throw budget.signal.reason;
        if (attempt > 0 || budget.remainingMs() <= 0 || !retriable(error, resendable)) throw mapTlsError(error);
        this.log.info("tls.retry", { reason: error instanceof Error ? error.name : "error" });
      }
    }
  }

  private encode(request: PreparedRequest, target: TunnelTarget): Uint8Array {
    const headers: string[] = [];
    let hasAuthorization = false;
    for (const [name, value] of request.headers) {
      if (name.toLowerCase() === "authorization") hasAuthorization = true;
      headers.push(name, value);
    }
    if (target.authorization !== undefined && !hasAuthorization) headers.push("authorization", target.authorization);
    const contentType = request.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1];
    const json = request.body.length > 0 && (request.profile.method !== undefined || contentType?.toLowerCase().includes("json") === true);
    try {
      return this.bindings.encodeRequest(
        request.method,
        target.host,
        target.target,
        headers,
        request.body,
        this.settings.tlsSession === "keep-alive",
        json,
      );
    } catch (error) {
      throw mapTlsError(error);
    }
  }
}

/** Whether a failed tunnel hop may run again on a new tunnel. */
function retriable(error: unknown, resendable: boolean): boolean {
  if (error instanceof TunnelRejectedError) {
    const lost = error.code === "UnknownSession" || error.code === "Expired";
    if (lost && error.soleCopy) return true;
    return resendable && (lost || error.code === "UpstreamClosed");
  }
  if (!resendable) return false;
  if (error instanceof TunnelTimeoutError || error instanceof TunnelOpenTimeoutError) return true;
  // A spare the upstream had already closed: the stream ended before any response byte.
  return tlsErrorCode(error) === "HTTP_RESPONSE_TRUNCATED";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
