// Minimal KPS-HTTP/1 client exchange (the profile of anon-rpc SPEC §4.2 and
// tor-js PROTOCOL §3): one request per KPS stream, Host = the certhash of the
// dialed address, request half-closed after the body, response EOF-delimited,
// Transfer-Encoding forbidden in either direction. Used by the probe worker to
// reach nox-kps sidecar routes (e.g. GET /topology) from inside the harness.

import { readToEnd, type ByteStream } from "./kps-echo.js";

const CRLF = "\r\n";
/** Response head cap, the same 16 KiB the reference gateway allows. */
export const MAX_HEAD_BYTES = 16 * 1024;

export interface KpsHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

export interface KpsHttpResponse {
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
}

/** The certhash part of `ip:port:certhash` (also for bracketed IPv6). */
export function certhashOf(addr: string): string {
  return addr.slice(addr.lastIndexOf(":") + 1);
}

export function buildRequest(request: KpsHttpRequest, certhash: string): Uint8Array {
  if (!/^[A-Z]+$/u.test(request.method)) throw new Error(`invalid method ${request.method}`);
  if (!request.path.startsWith("/") || /[\s]/u.test(request.path)) throw new Error(`invalid path ${request.path}`);
  const lines = [`${request.method} ${request.path} HTTP/1.1`, `Host: ${certhash}`];
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "transfer-encoding") continue;
    if (/[\r\n]/u.test(name) || /[\r\n]/u.test(value)) throw new Error(`header ${name} contains a line break`);
    lines.push(`${name}: ${value}`);
  }
  if (request.body.length > 0 || request.method === "POST") lines.push(`Content-Length: ${request.body.length}`);
  const head = new TextEncoder().encode(lines.join(CRLF) + CRLF + CRLF);
  const out = new Uint8Array(head.length + request.body.length);
  out.set(head, 0);
  out.set(request.body, head.length);
  return out;
}

function headerEnd(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length, MAX_HEAD_BYTES + 4);
  for (let i = 0; i + 3 < limit; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
  }
  return -1;
}

export function parseResponse(bytes: Uint8Array): KpsHttpResponse {
  const end = headerEnd(bytes);
  if (end < 0) throw new Error(`no response head terminator within ${MAX_HEAD_BYTES} bytes`);
  const lines = new TextDecoder().decode(bytes.subarray(0, end)).split(CRLF);
  const statusLine = lines[0] ?? "";
  const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(statusLine);
  if (match === null) throw new Error(`malformed status line ${JSON.stringify(statusLine.slice(0, 80))}`);
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`malformed header line ${JSON.stringify(line.slice(0, 80))}`);
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name === "transfer-encoding") throw new Error("forbidden Transfer-Encoding in a KPS-HTTP/1 response");
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  const body = bytes.slice(end + 4);
  const declared = headers.find(([name]) => name === "content-length")?.[1];
  if (declared !== undefined && Number(declared) !== body.length) {
    throw new Error(`Content-Length ${declared} but the stream carried ${body.length} body bytes`);
  }
  return { status: Number(match[1]), headers, body };
}

/** One exchange on an open stream: write, half-close, read to EOF, parse. */
export async function exchange(
  stream: ByteStream,
  request: KpsHttpRequest,
  certhash: string,
  maxBodyBytes: number,
): Promise<KpsHttpResponse> {
  const response = readToEnd(stream.readable, maxBodyBytes + MAX_HEAD_BYTES);
  // Observed below; this keeps a read failure from surfacing as an unhandled
  // rejection when the write fails first.
  response.catch(() => undefined);
  const writer = stream.writable.getWriter();
  await writer.write(buildRequest(request, certhash));
  await writer.close();
  return parseResponse(await response);
}
