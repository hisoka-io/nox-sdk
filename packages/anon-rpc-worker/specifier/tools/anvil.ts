// Starts a throwaway anvil node on a free loopback port: a fresh dev chain, or a fork of a live chain. A fork
// only reads from its upstream RPC (state is fetched lazily); transactions sent to it stay on this machine.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { localChainRpc, redactUrl, type RpcClient } from "./rpc.ts";

export type AnvilOptions = {
  /** Upstream RPC to fork (read-only use). Omit for a fresh dev chain. */
  forkUrl?: string;
  /** Pin the fork to this block so every reading in one run refers to the same state. */
  forkBlockNumber?: bigint;
  /** How long to wait for the node to answer eth_chainId. */
  startTimeoutMs: number;
  /** Per-request timeout for the returned client. */
  rpcTimeoutMs: number;
};

export type Anvil = {
  readonly url: string;
  readonly rpc: RpcClient;
  stop(): Promise<void>;
};

export class AnvilError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnvilError";
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new AnvilError("could not reserve a loopback port for anvil"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

const running = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of running) child.kill("SIGKILL");
  });
}

/** Largest JSON-RPC request the fork relay forwards (anvil's fork reads are small). */
const RELAY_MAX_REQUEST_BYTES = 1024 * 1024;

type ForkRelay = { url: string; close(): Promise<void> };

/**
 * A loopback HTTP relay that forwards anvil's fork reads (JSON-RPC POSTs) to `upstream`. Failures answer 502 with
 * a message that never contains the upstream URL.
 */
function startForkRelay(upstream: string): Promise<ForkRelay> {
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > RELAY_MAX_REQUEST_BYTES) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) })
        .then(async (upstreamResponse) => {
          const body = Buffer.from(await upstreamResponse.arrayBuffer());
          response.writeHead(upstreamResponse.status, { "content-type": "application/json" }).end(body);
        })
        .catch((e: unknown) => {
          const reason = e instanceof Error ? e.message : String(e);
          response
            .writeHead(502, { "content-type": "text/plain" })
            .end(`fork upstream ${redactUrl(upstream)} failed: ${reason.split(upstream).join(redactUrl(upstream))}`);
        });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new AnvilError("could not reserve a loopback port for the fork relay"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

export async function startAnvil(options: AnvilOptions): Promise<Anvil> {
  const port = await freePort();
  const args = ["--host", "127.0.0.1", "--port", String(port), "--silent"];
  // The fork URL may carry an API key. anvil takes it only as a command-line argument, which every local user can
  // read in the process list, so anvil forks a loopback relay instead and only this process knows the real URL.
  const relay = options.forkUrl === undefined ? undefined : await startForkRelay(options.forkUrl);
  if (relay !== undefined) {
    args.push("--fork-url", relay.url);
    if (options.forkBlockNumber !== undefined) args.push("--fork-block-number", options.forkBlockNumber.toString());
  }
  const child = spawn("anvil", args, { stdio: ["ignore", "ignore", "pipe"] });
  running.add(child);
  installExitHook();

  let stderr = "";
  // anvil may echo the fork URL in its errors; keep only the redacted form.
  const scrub = (text: string): string =>
    options.forkUrl === undefined ? text : text.split(options.forkUrl).join(redactUrl(options.forkUrl));
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = scrub(stderr + chunk.toString("utf8")).slice(-4000);
  });
  let exited: string | undefined;
  child.once("exit", (code, signal) => {
    running.delete(child);
    void relay?.close();
    exited = `anvil exited (code ${code ?? "none"}, signal ${signal ?? "none"})`;
  });
  let spawnFailure: AnvilError | undefined;
  child.once("error", (e) => {
    spawnFailure = new AnvilError(`cannot start anvil (is Foundry installed and on PATH?): ${e.message}`);
  });

  const url = `http://127.0.0.1:${port}`;
  const rpc = localChainRpc(url, { timeoutMs: options.rpcTimeoutMs });
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (exited !== undefined) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });

  const deadline = Date.now() + options.startTimeoutMs;
  const forkNote = options.forkUrl === undefined ? "" : ` forking ${redactUrl(options.forkUrl)}`;
  for (;;) {
    if (spawnFailure !== undefined) throw spawnFailure;
    if (exited !== undefined) {
      throw new AnvilError(`${exited} before answering on ${url}${forkNote}: ${stderr.trim() || "no stderr output"}`);
    }
    try {
      await rpc.request("eth_chainId");
      return { url, rpc, stop };
    } catch (e) {
      if (Date.now() > deadline) {
        await stop();
        throw new AnvilError(
          `anvil on ${url}${forkNote} did not answer within ${options.startTimeoutMs} ms: ${stderr.trim() || String(e)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
