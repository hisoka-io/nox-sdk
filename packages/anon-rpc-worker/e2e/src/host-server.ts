// Static server for the wallet-side host page: /harness/<version>/ serves
// page/index.html, and /harness/<version>/page.js the page script bundled
// against that published harness version.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { buildPageBundle, HARNESS_VERSIONS, type HarnessVersion } from "./bundles.js";
import { E2E_ROOT } from "./config.js";
import { TestbedError } from "./errors.js";

export interface HostServer {
  readonly origin: string;
  pageUrl(version: HarnessVersion): string;
  close(): Promise<void>;
}

export async function startHostServer(e2eRoot: string = E2E_ROOT, host = "127.0.0.1"): Promise<HostServer> {
  const html = readFileSync(join(e2eRoot, "page", "index.html"));
  const bundles = new Map<string, Uint8Array>();
  for (const version of HARNESS_VERSIONS) bundles.set(version, await buildPageBundle(version, e2eRoot));

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const match = /^\/harness\/([0-9.]+)\/(page\.js)?$/u.exec(path);
    const bundle = match?.[1] === undefined ? undefined : bundles.get(match[1]);
    if (match === null || bundle === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (match[2] === "page.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(bundle);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new TestbedError("port", "host page server has no address");
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    pageUrl: (version) => `${origin}/harness/${version}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
