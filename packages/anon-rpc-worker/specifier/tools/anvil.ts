// Starts a throwaway anvil node on a free loopback port: a fresh dev chain, or a fork of a live chain. A fork
// only reads from its upstream RPC (state is fetched lazily); transactions sent to it stay on this machine.

import { spawn, type ChildProcess } from "node:child_process";
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

export async function startAnvil(options: AnvilOptions): Promise<Anvil> {
  const port = await freePort();
  const args = ["--host", "127.0.0.1", "--port", String(port), "--silent"];
  if (options.forkUrl !== undefined) {
    args.push("--fork-url", options.forkUrl);
    if (options.forkBlockNumber !== undefined) args.push("--fork-block-number", options.forkBlockNumber.toString());
  }
  const child = spawn("anvil", args, { stdio: ["ignore", "ignore", "pipe"] });
  running.add(child);
  installExitHook();

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  let exited: string | undefined;
  child.once("exit", (code, signal) => {
    running.delete(child);
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
