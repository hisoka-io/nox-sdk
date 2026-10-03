/**
 * Strict client side of KPS-HTTP/1 (anon-rpc SPEC §4.2, tor-js PROTOCOL §3):
 * one HTTP/1.1 exchange per KPS stream, request written then the write half
 * closed, response read to EOF. A violation abandons the exchange; nothing is
 * recovered leniently, which is what keeps request smuggling out by construction.
 */
import { NoxKpsError } from "./errors.js";

/** One request on one stream. `headers` must not contain managed fields. */
export interface KpsHttpRequest {
  readonly method: string;
  /** Origin-form target, already validated by `parseKpsLocator`. */
  readonly path: string;
  /** Certhash of the dialed address; sent as `Host` (SPEC §4.2 SHOULD). */
  readonly certhash: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array | null;
}

/** Parsed final response head. Header names are lowercased, order kept. */
export interface KpsHttpResponseHead {
  readonly status: number;
  readonly reason: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly contentLength: number | undefined;
}

export interface KpsHttpReadLimits {
  /** Largest accepted header block, status line and final CRLF included. */
  readonly maxHeadBytes: number;
  /** Largest accepted response body. */
  readonly maxBodyBytes: number;
}

/** Interim (1xx) response heads skipped before the final one. */
export const MAX_INTERIM_RESPONSES = 8;

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const REQUEST_VALUE_RE = /^[\t\x20-\x7e]*$/u;
const RESPONSE_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/u;
const STATUS_LINE_RE = /^HTTP\/1\.1 ([1-5][0-9]{2})(?: ([\t\x20-\x7e\x80-\xff]*))?$/u;
const CONTENT_LENGTH_RE = /^[0-9]{1,15}$/u;

/**
 * Request fields the codec owns. `Host` and `Content-Length` are written by
 * the codec; the others select HTTP/1.1 features KPS-HTTP/1 forbids.
 */
const MANAGED_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "connection",
  "keep-alive",
  "proxy-connection",
  "upgrade",
  "expect",
]);

/** Methods whose request always carries `Content-Length`, even when 0. */
const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

const CR = 13;
const LF = 10;

/**
 * Serialize a request. `Content-Length` is sent whenever there is a body or
 * the method is POST/PUT/PATCH: the profile delimits bodies by EOF, but a
 * standard HTTP/1.1 server (hyper) reads a request body only by length
 * (RFC 9112 §6.3), and the profile allows the field as advisory.
 */
export function encodeKpsHttpRequest(request: KpsHttpRequest): Uint8Array {
  const method = request.method;
  if (!TOKEN_RE.test(method)) {
    throw new NoxKpsError("KPS-HTTP/1 request method is not an HTTP token", "protocol-error");
  }
  if (!TOKEN_RE.test(request.certhash)) {
    throw new NoxKpsError("KPS-HTTP/1 Host value (certhash) is not a valid token", "protocol-error");
  }
  const body = request.body;
  const bodyLength = body === null ? 0 : body.length;
  if ((method === "GET" || method === "HEAD") && bodyLength > 0) {
    throw new NoxKpsError(`KPS-HTTP/1 ${method} requests must not carry a body`, "protocol-error");
  }
  const lines = [`${method} ${request.path} HTTP/1.1`, `Host: ${request.certhash}`];
  for (const [name, value] of request.headers) {
    if (!TOKEN_RE.test(name)) {
      throw new NoxKpsError("KPS-HTTP/1 request header name is not an HTTP token", "protocol-error");
    }
    if (MANAGED_REQUEST_FIELDS.has(name.toLowerCase())) {
      throw new NoxKpsError(
        `KPS-HTTP/1 request header "${name}" is managed by the transport`,
        "protocol-error",
      );
    }
    if (!REQUEST_VALUE_RE.test(value)) {
      throw new NoxKpsError(
        `KPS-HTTP/1 request header "${name}" has a value with control or non-ASCII characters`,
        "protocol-error",
      );
    }
    lines.push(`${name}: ${value.trim()}`);
  }
  if (bodyLength > 0 || BODY_METHODS.has(method)) {
    lines.push(`Content-Length: ${bodyLength}`);
  }
  const head = `${lines.join("\r\n")}\r\n\r\n`;
  const out = new Uint8Array(head.length + bodyLength);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  if (body !== null && bodyLength > 0) out.set(body, head.length);
  return out;
}

/**
 * Read the final response head. Interim 1xx heads are skipped (at most
 * `MAX_INTERIM_RESPONSES`); a 101 abandons the exchange (no upgrades).
 * Returns the head and any body bytes that arrived with it.
 */
export async function readKpsHttpResponseHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limits: KpsHttpReadLimits,
): Promise<{ head: KpsHttpResponseHead; rest: Uint8Array }> {
  let buffer: Uint8Array = new Uint8Array(0);
  let interim = 0;
  for (;;) {
    let end = findHeadEnd(buffer);
    while (end >= 0) {
      if (end + 4 > limits.maxHeadBytes) throw headTooLarge(limits.maxHeadBytes);
      const head = parseResponseHead(buffer.subarray(0, end));
      buffer = buffer.subarray(end + 4);
      if (head.status >= 200) return { head, rest: buffer };
      if (head.status === 101) {
        throw new NoxKpsError("KPS-HTTP/1 forbids protocol upgrades (got 101)", "protocol-error");
      }
      interim += 1;
      if (interim > MAX_INTERIM_RESPONSES) {
        throw new NoxKpsError(
          `KPS-HTTP/1 response sent more than ${MAX_INTERIM_RESPONSES} interim 1xx heads`,
          "protocol-error",
        );
      }
      end = findHeadEnd(buffer);
    }
    if (buffer.length >= limits.maxHeadBytes) throw headTooLarge(limits.maxHeadBytes);
    const chunk = await readChunk(reader);
    if (chunk === null) {
      throw new NoxKpsError(
        buffer.length === 0
          ? "KPS peer closed the stream without a response"
          : "KPS stream ended inside the response head",
        "protocol-error",
      );
    }
    buffer = concatBytes([buffer, chunk], buffer.length + chunk.length);
  }
}

/**
 * Read the body to EOF. HEAD, 204 and 304 responses must be empty. When
 * `Content-Length` is present on a response that carries a body, the
 * EOF-delimited length must equal it: a mismatch means a truncated or
 * overlong body and abandons the exchange.
 */
export async function readKpsHttpResponseBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  head: KpsHttpResponseHead,
  rest: Uint8Array,
  method: string,
  limits: KpsHttpReadLimits,
): Promise<Uint8Array<ArrayBuffer>> {
  const bodyless = method === "HEAD" || head.status === 204 || head.status === 304;
  if (!bodyless && head.contentLength !== undefined && head.contentLength > limits.maxBodyBytes) {
    throw bodyTooLarge(limits.maxBodyBytes, head.contentLength);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (rest.length > 0) {
    chunks.push(rest);
    total = rest.length;
  }
  if (total > limits.maxBodyBytes) throw bodyTooLarge(limits.maxBodyBytes, total);
  for (;;) {
    const chunk = await readChunk(reader);
    if (chunk === null) break;
    total += chunk.length;
    if (total > limits.maxBodyBytes) throw bodyTooLarge(limits.maxBodyBytes, total);
    chunks.push(chunk);
  }
  if (bodyless) {
    if (total > 0) {
      throw new NoxKpsError(
        `KPS-HTTP/1 ${method === "HEAD" ? "HEAD" : String(head.status)} response carried ${total} body bytes`,
        "protocol-error",
      );
    }
    return new Uint8Array(0);
  }
  if (head.contentLength !== undefined && head.contentLength !== total) {
    throw new NoxKpsError(
      `KPS-HTTP/1 response body has ${total} bytes but Content-Length is ${head.contentLength}`,
      "protocol-error",
    );
  }
  return concatBytes(chunks, total);
}

/** Parse one response head (without its final CRLF CRLF). */
export function parseResponseHead(bytes: Uint8Array): KpsHttpResponseHead {
  const text = latin1(bytes);
  const lines = text.split("\r\n");
  for (const line of lines) {
    if (line.includes("\r") || line.includes("\n")) {
      throw new NoxKpsError("KPS-HTTP/1 response has a bare CR or LF in its head", "protocol-error");
    }
  }
  const statusLine = lines[0] ?? "";
  const match = STATUS_LINE_RE.exec(statusLine);
  if (match === null) {
    throw new NoxKpsError(
      `KPS-HTTP/1 response has a malformed status line: ${JSON.stringify(statusLine.slice(0, 80))}`,
      "protocol-error",
    );
  }
  const status = Number(match[1]);
  const reason = match[2] ?? "";
  const headers: [string, string][] = [];
  let contentLength: number | undefined;
  let contentLengthFields = 0;
  for (const line of lines.slice(1)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      throw new NoxKpsError("KPS-HTTP/1 forbids obsolete header line folding", "protocol-error");
    }
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon) : "";
    if (!TOKEN_RE.test(name)) {
      throw new NoxKpsError(
        `KPS-HTTP/1 response has a malformed header line: ${JSON.stringify(line.slice(0, 80))}`,
        "protocol-error",
      );
    }
    const value = line.slice(colon + 1).replace(/^[\t ]+|[\t ]+$/gu, "");
    if (!RESPONSE_VALUE_RE.test(value)) {
      throw new NoxKpsError(
        `KPS-HTTP/1 response header "${name}" has control characters`,
        "protocol-error",
      );
    }
    const lower = name.toLowerCase();
    if (lower === "transfer-encoding") {
      throw new NoxKpsError("KPS-HTTP/1 forbids Transfer-Encoding (bodies end at EOF)", "protocol-error");
    }
    if (lower === "content-length") {
      contentLengthFields += 1;
      if (contentLengthFields > 1) {
        throw new NoxKpsError("KPS-HTTP/1 response has more than one Content-Length field", "protocol-error");
      }
      if (!CONTENT_LENGTH_RE.test(value)) {
        throw new NoxKpsError("KPS-HTTP/1 response Content-Length is not a decimal length", "protocol-error");
      }
      contentLength = Number(value);
    }
    headers.push([lower, value]);
  }
  return { status, reason, headers, contentLength };
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array | null> {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    if (!(value instanceof Uint8Array)) {
      throw new NoxKpsError("KPS stream delivered a non-byte chunk", "protocol-error");
    }
    if (value.length > 0) return value;
  }
}

function findHeadEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === CR && bytes[i + 1] === LF && bytes[i + 2] === CR && bytes[i + 3] === LF) {
      return i;
    }
  }
  return -1;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/** Concatenate chunks into one fresh array of exactly `length` bytes. */
export function concatBytes(chunks: readonly Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function headTooLarge(limit: number): NoxKpsError {
  return new NoxKpsError(`KPS-HTTP/1 response head exceeds ${limit} bytes`, "too-large");
}

function bodyTooLarge(limit: number, seen: number): NoxKpsError {
  return new NoxKpsError(
    `KPS-HTTP/1 response body exceeds ${limit} bytes (at least ${seen})`,
    "too-large",
  );
}
