// HTTPS in front of the upstream anvil, the RPC provider of the TLS-tunnel
// spec: `https://localhost/` on 127.0.0.1:443 with a certificate from the
// bed's test CA (fixtures/tls). The worker trusts that CA through
// `build-test-worker.mjs --extra-root`; exits reach the front through TLS
// tunnels (port 443 is the only port tunnels open, so the bed runs in a
// network namespace where binding it needs no privileges). Every request body
// is kept, so a spec can show that a canary reached the provider.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import { TestbedError } from "./errors.js";

/** The one port TLS tunnels open. */
export const HTTPS_FRONT_PORT = 443;
/** Host name the certificate names; the exit resolves it to loopback. */
export const HTTPS_FRONT_HOST = "localhost";
/** Largest request body the front accepts. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface HttpsFront {
  /** `https://localhost/`. */
  readonly url: string;
  /** DER of the CA that issued the front's certificate. */
  readonly caDerPath: string;
  /** Bodies of every request served, in order. */
  readonly bodies: string[];
  /** Requests that carried `Connection: keep-alive` over one TLS connection after the first. */
  readonly reusedConnections: number;
  close(): Promise<void>;
}

export async function startHttpsFront(fixtureDir: string, upstreamUrl: string): Promise<HttpsFront> {
  const bodies: string[] = [];
  const seen = new WeakSet<object>();
  let reused = 0;
  const server: Server = createServer(
    {
      key: readFileSync(join(fixtureDir, "localhost.key.pem")),
      cert: readFileSync(join(fixtureDir, "localhost.cert.pem")),
      ALPNProtocols: ["http/1.1"],
    },
    (request, response) => {
      if (seen.has(request.socket)) reused += 1;
      seen.add(request.socket);
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        bodies.push(body);
        fetch(upstreamUrl, { method: "POST", headers: { "content-type": "application/json" }, body: body.trimEnd() })
          .then(async (upstream) => {
            const text = await upstream.text();
            response.writeHead(upstream.status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
            response.end(text);
          })
          .catch((error: unknown) => {
            response.writeHead(502, { "content-type": "text/plain" });
            response.end(`upstream failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        new TestbedError(
          "port",
          `the HTTPS front cannot listen on 127.0.0.1:${HTTPS_FRONT_PORT} (${error.code ?? error.message}); ` +
            "run the bed in a network namespace (unshare -rn) where port 443 needs no privileges",
        ),
      ));
    server.listen(HTTPS_FRONT_PORT, "127.0.0.1", resolve);
  });
  return {
    url: `https://${HTTPS_FRONT_HOST}/`,
    caDerPath: join(fixtureDir, "ca.cert.der"),
    bodies,
    get reusedConnections() {
      return reused;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
