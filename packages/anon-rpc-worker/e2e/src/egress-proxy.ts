// Recording forward proxy for the egress check. A guarded browser context sends
// every HTTP(S) request and every WebSocket through this proxy (Playwright sets
// `<-loopback>`, so loopback traffic is proxied too), from pages, sandboxed
// frames and Web Workers alike. Each request is recorded before anything else
// happens. Loopback targets are forwarded so the page behaves normally; any
// other target is recorded and refused without a DNS lookup, so a leaking
// worker under test never reaches the internet.

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect, isIPv4, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { EgressEvent, EgressKind } from "./egress.js";
import { TestbedError } from "./errors.js";

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, for Playwright's `proxy.server`. */
  readonly url: string;
  /** Every request in arrival order (layer "proxy"). */
  readonly events: readonly EgressEvent[];
  close(): Promise<void>;
}

/** Proxy-only request headers that must not reach the target. */
const PROXY_HEADERS = new Set(["proxy-connection", "proxy-authorization"]);

/** Hosts the proxy forwards to; everything else is recorded and refused. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = bare.toLowerCase();
  if (lower === "localhost" || lower === "::1") return true;
  return isIPv4(lower) && lower.startsWith("127.");
}

interface Target {
  readonly host: string;
  readonly port: number;
}

function connectTarget(authority: string): Target | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/u.exec(authority);
  if (match === null) return undefined;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const host = match[1] ?? "";
  return { host: host.startsWith("[") ? host.slice(1, -1) : host, port };
}

function absoluteUrl(raw: string | undefined): URL | undefined {
  if (raw === undefined || !/^https?:\/\//iu.test(raw)) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function urlTarget(url: URL): Target {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  return { host, port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port) };
}

function forwardHeaders(req: IncomingMessage): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i] ?? "";
    if (PROXY_HEADERS.has(name.toLowerCase())) continue;
    out.push(name, req.rawHeaders[i + 1] ?? "");
  }
  return out;
}

function refuse(socket: Duplex, status: string, reason: string): void {
  socket.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(reason)}\r\nconnection: close\r\n\r\n${reason}`);
}

export async function startEgressProxy(host = "127.0.0.1"): Promise<EgressProxy> {
  const events: EgressEvent[] = [];
  const started = Date.now();
  const tunnels = new Set<Duplex>();
  const record = (kind: EgressKind, target: string, method?: string): void => {
    events.push({ layer: "proxy", kind, target, atMs: Date.now() - started, ...(method === undefined ? {} : { method }) });
  };
  const track = (socket: Duplex): void => {
    tunnels.add(socket);
    socket.once("close", () => tunnels.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const splice = (client: Duplex, upstream: Socket, head: Buffer, preamble?: string): void => {
    track(upstream);
    upstream.once("connect", () => {
      if (preamble === undefined) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      else upstream.write(preamble);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", (error) => {
      if (client.writable) refuse(client, "502 Bad Gateway", `egress proxy: upstream failed: ${error.message}`);
      else client.destroy();
    });
    client.once("close", () => upstream.destroy());
  };

  const server: Server = createServer((req, res) => {
    const url = absoluteUrl(req.url);
    if (url === undefined) {
      record("http", `origin-form ${req.url ?? ""}`, req.method);
      res.writeHead(400, { "content-type": "text/plain" });
      res.end(`egress proxy: expected an absolute-form request URL, got ${req.url ?? "(none)"}`);
      return;
    }
    record("http", url.href, req.method);
    const target = urlTarget(url);
    if (!isLoopbackHost(target.host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`egress proxy: ${url.host} is outside loopback; recorded and refused`);
      return;
    }
    const upstream = httpRequest(
      { host: target.host, port: target.port, method: req.method, path: `${url.pathname}${url.search}`, headers: forwardHeaders(req) },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.rawHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`egress proxy: ${url.host} failed: ${error.message}`);
    });
    req.pipe(upstream);
  });

  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    const authority = req.url ?? "";
    record("connect", authority, "CONNECT");
    const target = connectTarget(authority);
    if (target === undefined) return refuse(client, "400 Bad Request", `egress proxy: bad CONNECT target ${authority}`);
    if (!isLoopbackHost(target.host)) {
      return refuse(client, "403 Forbidden", `egress proxy: ${authority} is outside loopback; recorded and refused`);
    }
    splice(client, connect(target.port, target.host), head);
  });

  server.on("upgrade", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    const url = absoluteUrl(req.url);
    record("websocket", url === undefined ? `origin-form ${req.url ?? ""}` : url.href.replace(/^http/iu, "ws"), req.method);
    if (url === undefined) return refuse(client, "400 Bad Request", "egress proxy: expected an absolute-form upgrade URL");
    const target = urlTarget(url);
    if (!isLoopbackHost(target.host)) {
      return refuse(client, "403 Forbidden", `egress proxy: ${url.host} is outside loopback; recorded and refused`);
    }
    const headers = forwardHeaders(req);
    const lines = [`${req.method ?? "GET"} ${url.pathname}${url.search} HTTP/1.1`];
    for (let i = 0; i + 1 < headers.length; i += 2) lines.push(`${headers[i] ?? ""}: ${headers[i + 1] ?? ""}`);
    splice(client, connect(target.port, target.host), head, `${lines.join("\r\n")}\r\n\r\n`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(new TestbedError("egress", `egress proxy could not listen on ${host}: ${error.message}`, { cause: error })));
    server.listen(0, host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new TestbedError("egress", "egress proxy has no listening address");
  return {
    url: `http://${host}:${address.port}`,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of tunnels) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
