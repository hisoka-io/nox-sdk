// Local anvil chains: one holds the WorkerSpecifier (stands in for mainnet), one
// is the wallet's RPC target that Nox exits reach through HttpRequest.

import { join } from "node:path";
import type { AnvilConfig } from "./config.js";
import { TestbedError } from "./errors.js";
import { expectHex, jsonRpc } from "./jsonrpc.js";
import { freeTcpPort } from "./ports.js";
import { delay, ManagedProcess } from "./process.js";

/** Poll interval while anvil starts. */
const READY_POLL_MS = 100;

export interface AnvilChain {
  readonly label: string;
  readonly url: string;
  readonly port: number;
  readonly chainId: number;
  /** First unlocked dev account (anvil's default mnemonic): signs nothing locally. */
  readonly account: string;
  readonly logFile: string;
  stop(): Promise<void>;
}

export interface StartAnvilOptions {
  readonly label: string;
  readonly chainId: number;
  readonly logDir: string;
  readonly port?: number;
  /**
   * anvil's `--slots-in-an-epoch`. With 1, the `finalized` block tag trails
   * `latest` by two blocks (the default 32 keeps it at genesis on a short-lived
   * chain), so the worker's registry checks see recent registry changes.
   */
  readonly slotsInAnEpoch?: number;
}

export async function startAnvil(config: AnvilConfig, options: StartAnvilOptions): Promise<AnvilChain> {
  const port = options.port ?? (await freeTcpPort());
  const logFile = join(options.logDir, `${options.label}.log`);
  const proc = ManagedProcess.start({
    label: `anvil(${options.label})`,
    command: config.bin,
    args: [
      "--host", "127.0.0.1",
      "--port", String(port),
      "--chain-id", String(options.chainId),
      ...(options.slotsInAnEpoch === undefined ? [] : ["--slots-in-an-epoch", String(options.slotsInAnEpoch)]),
    ],
    logFile,
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + config.startupTimeoutMs;
  let chainId: string | undefined;
  while (chainId === undefined) {
    proc.assertRunning(`while starting on port ${port}`);
    try {
      chainId = expectHex(await jsonRpc(url, "eth_chainId", [], 2_000), "eth_chainId");
    } catch (error) {
      if (Date.now() > deadline) {
        await proc.stop();
        throw new TestbedError(
          "timeout",
          `anvil(${options.label}) did not answer eth_chainId at ${url} within ${config.startupTimeoutMs} ms (log: ${logFile})`,
          { cause: error },
        );
      }
      await delay(READY_POLL_MS);
    }
  }
  if (Number.parseInt(chainId, 16) !== options.chainId) {
    await proc.stop();
    throw new TestbedError("rpc", `anvil(${options.label}) reports chain ${chainId}, expected ${options.chainId}`);
  }
  const accounts = await jsonRpc(url, "eth_accounts");
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof account !== "string") {
    await proc.stop();
    throw new TestbedError("rpc", `anvil(${options.label}) exposes no unlocked account`);
  }
  return {
    label: options.label,
    url,
    port,
    chainId: options.chainId,
    account,
    logFile,
    stop: () => proc.stop("SIGTERM"),
  };
}

/** Mine `count` empty blocks (anvil `anvil_mine`). */
export async function mineBlocks(url: string, count: number): Promise<void> {
  await jsonRpc(url, "anvil_mine", [`0x${count.toString(16)}`]);
}
