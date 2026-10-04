// Local https-style bundle resolver: serves ContentStore entries at
// /keccak/<hh>/<62 hex> with 200 + bytes, like raw.githubusercontent.com on a
// `keccak` branch. CORS-open, because the harness fetches it from the host page.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { keccakPath, parseKeccakPath, type ContentStore } from "./content-store.js";
import { TestbedError } from "./errors.js";

export interface ResolverServer {
  readonly origin: string;
  /** Every request path, in arrival order (for assertions). */
  readonly requests: readonly string[];
  /** Resolver URL for a stored bundle. */
  urlFor(hash: string): string;
  close(): Promise<void>;
}

export async function startResolverServer(store: ContentStore, host = "127.0.0.1"): Promise<ResolverServer> {
  const requests: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    requests.push(path);
    const cors = { "access-control-allow-origin": "*" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, HEAD" });
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, cors);
      res.end();
      return;
    }
    const name = parseKeccakPath(path);
    const bytes = name === undefined ? undefined : store.get(name);
    if (bytes === undefined) {
      res.writeHead(404, { ...cors, "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      ...cors,
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new TestbedError("resolver", "resolver server has no address");
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    requests,
    urlFor: (hash: string) => `${origin}${keccakPath(hash)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Browsers keep connections alive; close them so close() returns.
        server.closeAllConnections();
      }),
  };
}
