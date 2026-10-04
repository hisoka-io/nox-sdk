// Trap server for the egress negative controls: stands in for a mesh ingress
// (`/topology`, `/api/v1/ws`). It records every HTTP request and completes
// every WebSocket handshake, so a test can prove that a leaking worker's
// traffic really left the browser.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { TestbedError } from "./errors.js";

/** RFC 6455 §1.3 handshake GUID. */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface TrapHit {
  readonly kind: "http" | "websocket";
  readonly method: string;
  readonly path: string;
  /** The Host header the client sent. */
  readonly host: string;
}

export interface TrapServer {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  readonly port: number;
  readonly hits: readonly TrapHit[];
  close(): Promise<void>;
}

export function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

function hit(kind: TrapHit["kind"], req: IncomingMessage): TrapHit {
  return { kind, method: req.method ?? "", path: req.url ?? "", host: req.headers.host ?? "" };
}

export async function startTrapServer(host = "127.0.0.1"): Promise<TrapServer> {
  const hits: TrapHit[] = [];
  const sockets = new Set<Duplex>();
  const server: Server = createServer((req, res) => {
    hits.push(hit("http", req));
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ trap: true, path: req.url ?? "" }));
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    hits.push(hit("websocket", req));
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.length === 0) {
      socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n" +
        `sec-websocket-accept: ${websocketAccept(key)}\r\n\r\n`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(new TestbedError("port", `trap server could not listen on ${host}: ${error.message}`, { cause: error })));
    server.listen(0, host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new TestbedError("port", "trap server has no listening address");
  return {
    origin: `http://${host}:${address.port}`,
    port: address.port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
