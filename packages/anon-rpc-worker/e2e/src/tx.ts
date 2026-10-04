// Transactions from an unlocked anvil account: send, wait for the receipt,
// and deploy from a vendored artifact (ABI + creation bytecode).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_ROOT } from "./config.js";
import { TestbedError } from "./errors.js";
import { expectHex, jsonRpc } from "./jsonrpc.js";

const RECEIPT_POLL_MS = 100;
/** Default receipt deadline for local anvil transactions. */
export const TX_TIMEOUT_MS = 15_000;

export interface TxReceipt {
  readonly transactionHash: string;
  readonly blockNumber: number;
  readonly contractAddress?: string;
}

export interface ContractArtifact {
  readonly contractName: string;
  readonly bytecode: string;
}

/** Poll for a receipt; a reverted transaction is an error naming the hash and endpoint. */
export async function waitForReceipt(rpcUrl: string, txHash: string, timeoutMs = TX_TIMEOUT_MS): Promise<TxReceipt> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await jsonRpc(rpcUrl, "eth_getTransactionReceipt", [txHash]);
    if (receipt !== null && typeof receipt === "object") {
      const fields = receipt as { status?: unknown; blockNumber?: unknown; contractAddress?: unknown };
      if (fields.status !== "0x1") {
        throw new TestbedError("rpc", `transaction ${txHash} at ${rpcUrl} reverted (status ${String(fields.status)})`);
      }
      const block = Number.parseInt(expectHex(fields.blockNumber, `receipt ${txHash} blockNumber`), 16);
      const address = fields.contractAddress;
      return {
        transactionHash: txHash,
        blockNumber: block,
        ...(typeof address === "string" && /^0x[0-9a-fA-F]{40}$/u.test(address) ? { contractAddress: address } : {}),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }
  throw new TestbedError("timeout", `no receipt for ${txHash} at ${rpcUrl} within ${timeoutMs} ms`);
}

/** eth_sendTransaction from an unlocked account, then wait for a successful receipt. */
export async function sendTransaction(
  rpcUrl: string,
  tx: { readonly from: string; readonly to?: string; readonly data: string; readonly gas?: string },
  what: string,
  timeoutMs = TX_TIMEOUT_MS,
): Promise<TxReceipt> {
  const txHash = expectHex(await jsonRpc(rpcUrl, "eth_sendTransaction", [tx]), `${what} tx hash`);
  return waitForReceipt(rpcUrl, txHash, timeoutMs);
}

/** Deploy `artifact` with ABI-encoded constructor arguments; returns the contract address. */
export async function deployContract(
  rpcUrl: string,
  from: string,
  artifact: ContractArtifact,
  constructorArgs = "0x",
  timeoutMs = TX_TIMEOUT_MS,
): Promise<string> {
  const data = artifact.bytecode + constructorArgs.slice(2);
  const receipt = await sendTransaction(rpcUrl, { from, data }, `deploy ${artifact.contractName}`, timeoutMs);
  if (receipt.contractAddress === undefined) {
    throw new TestbedError("rpc", `deploy receipt ${receipt.transactionHash} of ${artifact.contractName} has no contractAddress`);
  }
  return receipt.contractAddress.toLowerCase();
}

/** Load contracts/<name>.json (written by scripts/compile-local-contracts.sh). */
export function loadArtifact(name: string, e2eRoot: string = E2E_ROOT): ContractArtifact {
  const path = join(e2eRoot, "contracts", `${name}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TestbedError("prerequisite", `cannot read ${path}; run scripts/compile-local-contracts.sh`, { cause: error });
  }
  const artifact = parsed as Partial<ContractArtifact>;
  if (
    artifact.contractName !== name ||
    typeof artifact.bytecode !== "string" ||
    !/^0x(?:[0-9a-f]{2})+$/u.test(artifact.bytecode)
  ) {
    throw new TestbedError("prerequisite", `${path} is not a ${name} artifact; run scripts/compile-local-contracts.sh`);
  }
  return artifact as ContractArtifact;
}
