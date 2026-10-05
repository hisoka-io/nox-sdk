// A second JSON-RPC "provider" for the worker's registry checks: an HTTP
// server on its own loopback port that forwards every POST body to the
// upstream anvil and returns the reply unchanged. The SDK tells providers
// apart by organisation, and on loopback by port, so the chain check sees two
// different providers that serve the same chain, as the fleet's providers do.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TestbedError } from "./errors.js";

/** Largest request body forwarded (a registry read batch is a few KB). */
const MAX_BODY_BYTES = 1_048_576;
const FORWARD_TIMEOUT_MS = 15_000;

export interface RpcForwarder {
  readonly url: string;
  /** Requests forwarded so far. */
  readonly forwarded: () => number;
  close(): Promise<void>;
}

export async function startRpcForwarder(upstreamUrl: string, host = "127.0.0.1"): Promise<RpcForwarder> {
  let forwarded = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("POST only");
        return;
      }
      try {
        const body = await readBody(req);
        const upstream = await fetch(upstreamUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body.toString("utf8"),
          signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        });
        forwarded += 1;
        res.writeHead(upstream.status, { "content-type": "application/json" });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`forwarding failed: ${String(error)}`);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new TestbedError("port", "RPC forwarder has no address");
  return {
    url: `http://${host}:${address.port}/`,
    forwarded: () => forwarded,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new TestbedError("rpc", `RPC forwarder request over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
