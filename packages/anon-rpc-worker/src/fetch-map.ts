/**
 * anon-rpc fetch calls (SPEC §9) on the Nox general HTTP path (D-03,
 * ARCHITECTURE §4.5): each call becomes one `ServiceRequest::HttpRequest`
 * that an exit performs, and the exit's `SerializableHttpResponse` becomes the
 * `AnonFetchResponse`.
 *
 * The exit sees the request (URL, headers, body) and never the sender. It
 * follows no redirects (`sendPrepared` follows them here), returns headers as
 * a map (duplicates collapse, order is lost) and sends no reply at all to a
 * request it cannot parse, so requests are validated here before anything
 * enters the mixnet.
 */
import { decodeHttpResponse, type DecodedHttpResponse, type HttpRequestOptions } from "@hisoka-io/nox-client";
import type { AnonFetchResponse, AnonRequestInit, ByteBody, HeaderList } from "./spec-types.js";
import { CALL_CODES, NoxWorkerError, callError } from "./errors.js";
import { MIN_SURBS, profileRequest, type RequestProfile } from "./jsonrpc.js";
import { describeError } from "./log.js";

/** The slice of `NoxClient` a fetch call needs. */
export interface NoxHttpPort {
  httpRequest(
    method: string,
    url: string,
    headers: [string, string][],
    body: Uint8Array,
    options: HttpRequestOptions,
  ): Promise<Uint8Array>;
}

/** Limits from the worker config. */
export interface FetchSettings {
  readonly attemptTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  /**
   * `accept-encoding` sent upstream. Default: `gzip` where the runtime has
   * `DecompressionStream`, else `identity`.
   */
  readonly acceptEncoding?: ReplyEncoding;
}

/** Reply encodings the worker can ask upstreams for. */
export type ReplyEncoding = "gzip" | "identity";

/**
 * `gzip` when this runtime can inflate replies itself. Exits pass bodies
 * through as the upstream sent them (their HTTP client has no decompression),
 * so a gzip reply crosses the mixnet compressed: a 414 KB `eth_getLogs` reply
 * takes about 2 reply packets instead of 14.
 */
export function defaultReplyEncoding(): ReplyEncoding {
  return typeof DecompressionStream === "function" ? "gzip" : "identity";
}

/** A validated request, ready for the mixnet. */
export interface PreparedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
  readonly redirect: "follow" | "manual" | "error";
  readonly profile: RequestProfile;
}

/** Room for the exit's status, header map and framing on top of the body cap. */
export const RESPONSE_ENVELOPE_ALLOWANCE = 65_536;
/** Longest URL accepted (the exit applies its own limits too). */
export const MAX_URL_LENGTH = 8_192;
/** Largest request header block accepted. */
export const MAX_REQUEST_HEADER_BYTES = 65_536;

/** RFC 9110 token. */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
/** Field value: visible ASCII, space, tab and obs-text; no CR, LF or NUL. */
const FIELD_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/u;
/** Methods `fetch` upper-cases (Fetch §2.2.1). */
const NORMALIZED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);
/** Methods `fetch` refuses (Fetch §2.2.1). */
const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Redirects followed per call (ARCHITECTURE §4.5); a further redirect is a network error. */
export const MAX_REDIRECT_HOPS = 5;
/** Fetch's redirect statuses. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** Headers that describe a body, dropped when a redirect turns the request into a GET (Fetch "request-body-header name"). */
const REQUEST_BODY_HEADERS = new Set(["content-encoding", "content-language", "content-location", "content-type"]);
/** Credentials dropped when a redirect leaves the origin. */
const CROSS_ORIGIN_DROPPED_HEADERS = new Set(["authorization", "cookie"]);

/**
 * Request headers never forwarded: the exit drops `host` and `user-agent`
 * itself, framing and hop-by-hop fields belong to the exit's own connection,
 * and cookies, origin and referer would tie calls together or to a page.
 * `accept-encoding` is replaced (see `defaultReplyEncoding`).
 */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "user-agent",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "expect",
  "cookie",
  "origin",
  "referer",
  "accept-encoding",
]);

/** Content codings the worker inflates. */
const GZIP_CODINGS: ReadonlySet<string> = new Set(["gzip", "x-gzip"]);

/** Response fields that describe the exit's hop, or that a worker must not hand on. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
  "set-cookie",
]);

/**
 * Validate a call and read its body. Throws a `NoxWorkerError` with code
 * `unsupported` or `too-large`, or the signal's reason when it aborts.
 */
export async function prepareRequest(
  rawUrl: unknown,
  init: AnonRequestInit | undefined,
  settings: FetchSettings,
  signal: AbortSignal,
): Promise<PreparedRequest> {
  const url = parseTargetUrl(rawUrl);
  const method = normalizeMethod(init?.method);
  const redirect = init?.redirect ?? "follow";
  if (redirect !== "follow" && redirect !== "manual" && redirect !== "error") {
    throw callError(CALL_CODES.unsupported, 'redirect must be "follow", "manual" or "error"');
  }
  const headers = prepareHeaders(init?.headers, settings.acceptEncoding ?? defaultReplyEncoding());
  const body = await readBody(init?.body, settings.maxRequestBytes, signal);
  if ((method === "GET" || method === "HEAD") && body.length > 0) {
    throw callError(CALL_CODES.unsupported, `A ${method} request cannot carry a body`);
  }
  const contentType = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1];
  return { method, url, headers, body, redirect, profile: profileRequest(method, contentType, body) };
}

/** Per-call timing the caller controls. */
export interface CallBudget {
  /** Aborts on host abort or call deadline; its reason is the call's rejection. */
  readonly signal: AbortSignal;
  /** Milliseconds left before the call deadline. */
  remainingMs(): number;
}

/**
 * Send a prepared request through the mixnet and map the exit's reply,
 * applying the call's redirect mode (ARCHITECTURE §4.5). The exit never
 * follows redirects, so the worker does it with fetch's rules:
 *
 * - `follow` (the SPEC default): a 301, 302, 303, 307 or 308 with a
 *   `Location` is re-issued as a new mixnet request inside the same call
 *   deadline, at most `MAX_REDIRECT_HOPS` times. 303, and 301/302 after POST,
 *   become GET without a body; 307 and 308 keep method and body. A
 *   cross-origin hop drops `authorization` and `cookie`. `url` is the final
 *   URL. A write (`eth_sendRawTransaction`) is never re-issued with a changed
 *   method; that 3xx is returned as it came.
 * - `manual`: the 3xx is returned unchanged.
 * - `error`: a redirect is a `network-error`, as are a hop past the cap, a
 *   `Location` that is not an absolute http(s) URL, and the deadline passing
 *   between hops.
 *
 * Each hop is sized and retried by its profile: small and medium reads (and
 * safe methods) get `attemptTimeoutMs` per attempt and one resend on a
 * different route after a response timeout; large reads, writes and anything
 * else get one attempt with the whole remaining deadline, since large replies
 * need time and writes are never resent (ARCHITECTURE §4.7). The SDK still
 * resends any request whose packet was certainly never sent (a KPS dial or
 * stream-open failure) through another entry.
 */
export async function sendPrepared(
  request: PreparedRequest,
  port: NoxHttpPort,
  settings: FetchSettings,
  budget: CallBudget,
): Promise<AnonFetchResponse> {
  if (budget.remainingMs() <= 0) throw callError(CALL_CODES.timeout, "The call deadline passed before sending");
  let current = request;
  for (let hop = 0; ; hop++) {
    const reply = await exchange(current, port, settings, budget);
    checkStatus(reply);
    if (!REDIRECT_STATUSES.has(reply.status) || current.redirect === "manual") {
      return finishResponse(reply, current, settings);
    }
    if (current.redirect === "error") {
      throw callError(
        CALL_CODES.networkError,
        `Redirect refused: the upstream answered ${reply.status} and the call set redirect: "error"`,
      );
    }
    const location = reply.headers.find(([name]) => name.toLowerCase() === "location")?.[1];
    // fetch returns a redirect status without a Location as an ordinary response.
    if (location === undefined) return finishResponse(reply, current, settings);
    const next = redirectedRequest(current, reply.status, location);
    if (next === null) return finishResponse(reply, current, settings);
    if (hop + 1 > MAX_REDIRECT_HOPS) {
      throw callError(CALL_CODES.networkError, `Too many redirects: more than ${MAX_REDIRECT_HOPS} hops`);
    }
    if (budget.remainingMs() <= 0) {
      throw callError(CALL_CODES.networkError, `The call deadline passed after ${hop + 1} redirect(s)`);
    }
    current = next;
  }
}

/** One mixnet exchange for `request`, decoded. */
async function exchange(
  request: PreparedRequest,
  port: NoxHttpPort,
  settings: FetchSettings,
  budget: CallBudget,
): Promise<DecodedHttpResponse> {
  const remaining = budget.remainingMs();
  const resendable = request.profile.retryable ||
    (request.profile.rpcClass === "other" && SAFE_METHODS.has(request.method));
  const options: HttpRequestOptions = {
    timeoutMs: resendable ? Math.min(settings.attemptTimeoutMs, remaining) : remaining,
    opKey: request.profile.opKey,
    minSurbs: MIN_SURBS,
    retry: resendable ? "route" : "none",
    signal: budget.signal,
    maxResponseBytes: settings.maxResponseBytes + RESPONSE_ENVELOPE_ALLOWANCE,
  };
  if (request.profile.expectedResponseBytes !== undefined) {
    options.expectedResponseBytes = request.profile.expectedResponseBytes;
  }
  let bytes: Uint8Array;
  try {
    bytes = await port.httpRequest(request.method, request.url, request.headers, request.body, options);
  } catch (error) {
    if (budget.signal.aborted) throw budget.signal.reason;
    throw mapClientError(error);
  }
  try {
    return decodeHttpResponse(bytes);
  } catch (error) {
    throw callError(CALL_CODES.protocolError, "The exit's reply could not be decoded", error);
  }
}

/**
 * The request a redirect leads to (Fetch §4.4 HTTP-redirect fetch), or `null`
 * when the redirect is returned as it came (a write whose method would change).
 * Throws `network-error` for a `Location` that is not an absolute http(s) URL.
 */
export function redirectedRequest(request: PreparedRequest, status: number, location: string): PreparedRequest | null {
  const url = redirectTarget(location, request.url);
  const toGet = status === 303
    ? request.method !== "GET" && request.method !== "HEAD"
    : (status === 301 || status === 302) && request.method === "POST";
  if (toGet && request.profile.rpcClass === "write") return null;
  let headers = request.headers;
  if (toGet) headers = headers.filter(([name]) => !REQUEST_BODY_HEADERS.has(name.toLowerCase()));
  if (new URL(url).origin !== new URL(request.url).origin) {
    headers = headers.filter(([name]) => !CROSS_ORIGIN_DROPPED_HEADERS.has(name.toLowerCase()));
  }
  const method = toGet ? "GET" : request.method;
  const body = toGet ? new Uint8Array(0) : request.body;
  const contentType = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1];
  return {
    method,
    url,
    headers,
    body,
    redirect: request.redirect,
    profile: toGet ? profileRequest(method, contentType, body) : request.profile,
  };
}

function redirectTarget(location: string, base: string): string {
  let url: URL;
  try {
    url = new URL(location, base);
  } catch {
    throw callError(CALL_CODES.networkError, "Redirect refused: the Location header is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw callError(CALL_CODES.networkError, `Redirect refused: the target scheme ${url.protocol} is not http(s)`);
  }
  url.hash = "";
  if (url.href.length > MAX_URL_LENGTH) {
    throw callError(CALL_CODES.networkError, `Redirect refused: the target URL is longer than ${MAX_URL_LENGTH} characters`);
  }
  return url.href;
}

function checkStatus(reply: DecodedHttpResponse): void {
  if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599) {
    throw callError(CALL_CODES.protocolError, `The exit returned status ${reply.status}, outside 200-599`);
  }
}

/** Inflate a gzip reply (see `inflateReply`), then map it with `toAnonResponse`. */
export async function finishResponse(
  reply: DecodedHttpResponse,
  request: Pick<PreparedRequest, "url">,
  settings: Pick<FetchSettings, "maxResponseBytes">,
): Promise<AnonFetchResponse> {
  checkStatus(reply);
  if (reply.truncated) {
    throw callError(CALL_CODES.tooLarge, "The exit cut the response body at its response size limit");
  }
  return toAnonResponse(await inflateReply(reply, settings.maxResponseBytes), request, settings);
}

/**
 * The reply with a `gzip` body inflated and its `content-encoding` removed;
 * any other reply unchanged. Inflation stops past `maxBytes` (`too-large`),
 * so a small compressed reply cannot expand without bound; a corrupt body is
 * a `protocol-error`.
 */
export async function inflateReply(reply: DecodedHttpResponse, maxBytes: number): Promise<DecodedHttpResponse> {
  const coding = reply.headers.find(([name]) => name.toLowerCase() === "content-encoding")?.[1]?.trim().toLowerCase();
  if (coding === undefined || !GZIP_CODINGS.has(coding)) return reply;
  const headers = reply.headers.filter(([name]) => name.toLowerCase() !== "content-encoding");
  if (reply.body.length === 0) return { ...reply, headers };
  if (typeof DecompressionStream !== "function") {
    throw callError(CALL_CODES.protocolError, "The upstream sent a gzip body and this runtime cannot inflate it");
  }
  const source = reply.body;
  const inflated = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(source);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = inflated.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      throw callError(CALL_CODES.protocolError, "The upstream's gzip body is corrupt", error);
    }
    if (result.done) break;
    total += result.value.length;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw callError(CALL_CODES.tooLarge, `The response body inflates past ${maxBytes} bytes`);
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { ...reply, headers, body };
}

/** Map the exit's decoded reply to an `AnonFetchResponse`; `request.url` becomes `url`. */
export function toAnonResponse(
  reply: DecodedHttpResponse,
  request: Pick<PreparedRequest, "url">,
  settings: Pick<FetchSettings, "maxResponseBytes">,
): AnonFetchResponse {
  checkStatus(reply);
  if (reply.truncated) {
    throw callError(CALL_CODES.tooLarge, "The exit cut the response body at its response size limit");
  }
  if (reply.body.length > settings.maxResponseBytes) {
    throw callError(
      CALL_CODES.tooLarge,
      `The response body has ${reply.body.length} bytes; the limit is ${settings.maxResponseBytes}`,
    );
  }
  const headers: HeaderList = [];
  for (const [name, value] of reply.headers) {
    const lower = name.toLowerCase();
    if (lower === "content-encoding" && value.trim().toLowerCase() !== "identity") {
      throw callError(
        CALL_CODES.protocolError,
        `The upstream sent a ${value.trim()} body; this worker accepts identity and gzip`,
      );
    }
    if (DROPPED_RESPONSE_HEADERS.has(lower) || !TOKEN_RE.test(name) || !FIELD_VALUE_RE.test(value)) continue;
    headers.push([lower, value]);
  }
  headers.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  // A fresh buffer of exactly the body: the harness transfers `body.buffer`.
  return { status: reply.status, headers, body: reply.body.slice(), url: request.url };
}

/**
 * Map a Nox client failure to a per-call code. The client reports its own
 * failures as `NoxClientError` with a string `code`.
 */
/** Causes followed when looking for the KPS code of a transport failure. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The KPS error code recorded anywhere in the cause chain. A packet failure
 * arrives as NoxClientError(TransportFailed) → packet error → transport error
 * → `{ phase, kpsCode }`, so one level is not enough.
 */
function kpsCodeInChain(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
    const kpsCode = (current as { kpsCode?: unknown }).kpsCode;
    if (kpsCode !== undefined) return kpsCode;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function mapClientError(error: unknown): NoxWorkerError {
  if (error instanceof NoxWorkerError) return error;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const kpsCode = kpsCodeInChain(error);
  const detail = describeError(error);
  switch (code) {
    case "RESPONSE_TIMEOUT":
      return callError(CALL_CODES.timeout, `No reply through the mixnet in time (${detail})`, error);
    case "TRANSPORT_FAILED":
      return kpsCode === "timeout"
        ? callError(CALL_CODES.timeout, `The entry did not answer in time (${detail})`, error)
        : callError(CALL_CODES.networkError, `The entry could not be reached (${detail})`, error);
    case "KPS_UNAVAILABLE":
    case "NO_NODES_AVAILABLE":
    case "SURB_V2_UNAVAILABLE":
    case "TOPOLOGY_STALE":
    case "TOPOLOGY_FETCH_FAILED":
    case "TOPOLOGY_VERIFICATION_FAILED":
      return callError(CALL_CODES.networkError, `No usable route right now (${detail})`, error);
    case "RESPONSE_TOO_LARGE":
      return callError(CALL_CODES.tooLarge, `The reply exceeds the response size limit (${detail})`, error);
    case "DECRYPTION_FAILED":
      return callError(CALL_CODES.protocolError, `The reply could not be decoded (${detail})`, error);
    default:
      return callError(CALL_CODES.internalError, `The Nox client failed (${detail})`, error);
  }
}

function parseTargetUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw callError(CALL_CODES.unsupported, "The call has no URL; this worker serves absolute http(s) URLs");
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw callError(CALL_CODES.tooLarge, `The URL is longer than ${MAX_URL_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw callError(CALL_CODES.unsupported, "The URL is not absolute; this worker serves absolute http(s) URLs");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw callError(CALL_CODES.unsupported, `This worker serves absolute http(s) URLs, not ${url.protocol}`);
  }
  url.hash = "";
  return url.href;
}

function normalizeMethod(method: unknown): string {
  if (method === undefined) return "GET";
  if (typeof method !== "string" || !TOKEN_RE.test(method)) {
    throw callError(CALL_CODES.unsupported, "The request method is not an HTTP token");
  }
  const upper = method.toUpperCase();
  if (FORBIDDEN_METHODS.has(upper)) throw callError(CALL_CODES.unsupported, `The ${upper} method is not carried`);
  return NORMALIZED_METHODS.has(upper) ? upper : method;
}

/** Keep order and duplicates (the wire type is a list), drop per policy, then set `accept-encoding`. */
function prepareHeaders(list: HeaderList | undefined, encoding: ReplyEncoding): [string, string][] {
  if (list === undefined) return [["accept-encoding", encoding]];
  if (!Array.isArray(list)) throw callError(CALL_CODES.unsupported, "headers must be a list of [name, value] pairs");
  const out: [string, string][] = [];
  let bytes = 0;
  for (const pair of list as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      throw callError(CALL_CODES.unsupported, "headers must be a list of [name, value] string pairs");
    }
    const name: string = pair[0];
    const value = (pair[1] as string).replace(/^[\t ]+|[\t ]+$/gu, "");
    if (!TOKEN_RE.test(name)) throw callError(CALL_CODES.unsupported, "A request header name is not an HTTP token");
    if (!FIELD_VALUE_RE.test(value)) {
      throw callError(CALL_CODES.unsupported, "A request header value has a control character");
    }
    const lower = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(lower) || lower.startsWith("proxy-")) continue;
    bytes += name.length + value.length + 4;
    if (bytes > MAX_REQUEST_HEADER_BYTES) {
      throw callError(CALL_CODES.tooLarge, `Request headers exceed ${MAX_REQUEST_HEADER_BYTES} bytes`);
    }
    out.push([name, value]);
  }
  out.push(["accept-encoding", encoding]);
  return out;
}

async function readBody(body: ByteBody | undefined | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (body instanceof Uint8Array) {
    if (body.length > limit) throw tooLargeBody(limit);
    return body.slice();
  }
  if (typeof (body as { getReader?: unknown }).getReader !== "function") {
    throw callError(CALL_CODES.unsupported, "The request body must be a Uint8Array or a ReadableStream of bytes");
  }
  if (signal.aborted) throw signal.reason;
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let result: { done: boolean; value?: unknown };
      try {
        result = await reader.read();
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw callError(CALL_CODES.networkError, "The request body stream failed", error);
      }
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) {
        void reader.cancel().catch(() => undefined);
        throw callError(CALL_CODES.unsupported, "The request body stream yielded a chunk that is not a Uint8Array");
      }
      total += chunk.length;
      if (total > limit) {
        void reader.cancel().catch(() => undefined);
        throw tooLargeBody(limit);
      }
      chunks.push(chunk);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (signal.aborted) throw signal.reason;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function tooLargeBody(limit: number): NoxWorkerError {
  return callError(CALL_CODES.tooLarge, `The request body exceeds ${limit} bytes`);
}
