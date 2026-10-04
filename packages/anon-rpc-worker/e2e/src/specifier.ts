// Deploys and updates the reference WorkerSpecifier on a local anvil chain, and
// reads it back the way the harness does (two eth_calls at "latest").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeBytes32,
  decodeStringArray,
  encodeSetWorker,
  encodeWorkerArgs,
  selector,
} from "./abi.js";
import { E2E_ROOT } from "./config.js";
import { TestbedError } from "./errors.js";
import { expectHex, jsonRpc } from "./jsonrpc.js";

export interface SpecifierArtifact {
  readonly contractName: string;
  readonly source: { readonly sha256: string; readonly commit: string; readonly path: string };
  readonly compiler: { readonly solc: string };
  readonly bytecode: string;
}

export interface WorkerPin {
  readonly workerHash: string;
  readonly resolvers: readonly string[];
}

const RECEIPT_POLL_MS = 100;

export function specifierArtifactPath(e2eRoot: string = E2E_ROOT): string {
  return join(e2eRoot, "contracts", "WorkerSpecifier.json");
}

export function loadSpecifierArtifact(e2eRoot: string = E2E_ROOT): SpecifierArtifact {
  const path = specifierArtifactPath(e2eRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TestbedError("prerequisite", `cannot read ${path}; run pnpm compile:specifier`, { cause: error });
  }
  const artifact = parsed as Partial<SpecifierArtifact>;
  if (
    artifact.contractName !== "WorkerSpecifier" ||
    typeof artifact.bytecode !== "string" ||
    !/^0x(?:[0-9a-f]{2})+$/u.test(artifact.bytecode) ||
    typeof artifact.source?.sha256 !== "string"
  ) {
    throw new TestbedError("prerequisite", `${path} is not a WorkerSpecifier artifact; run pnpm compile:specifier`);
  }
  return artifact as SpecifierArtifact;
}

async function waitForReceipt(rpcUrl: string, txHash: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await jsonRpc(rpcUrl, "eth_getTransactionReceipt", [txHash]);
    if (receipt !== null && typeof receipt === "object") {
      const status = (receipt as { status?: unknown }).status;
      if (status !== "0x1") {
        throw new TestbedError("rpc", `transaction ${txHash} at ${rpcUrl} reverted (status ${String(status)})`);
      }
      return receipt as Record<string, unknown>;
    }
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }
  throw new TestbedError("timeout", `no receipt for ${txHash} at ${rpcUrl} within ${timeoutMs} ms`);
}

/** Read a specifier the way the harness does. */
export async function readSpecifier(rpcUrl: string, address: string): Promise<WorkerPin> {
  const hashRet = expectHex(
    await jsonRpc(rpcUrl, "eth_call", [{ to: address, data: selector("workerHash()") }, "latest"]),
    "workerHash()",
  );
  const resolversRet = expectHex(
    await jsonRpc(rpcUrl, "eth_call", [{ to: address, data: selector("workerResolvers()") }, "latest"]),
    "workerResolvers()",
  );
  return { workerHash: decodeBytes32(hashRet), resolvers: decodeStringArray(resolversRet) };
}

function assertPin(actual: WorkerPin, expected: WorkerPin, address: string): void {
  const same =
    actual.workerHash.toLowerCase() === expected.workerHash.toLowerCase() &&
    actual.resolvers.length === expected.resolvers.length &&
    actual.resolvers.every((url, i) => url === expected.resolvers[i]);
  if (!same) {
    throw new TestbedError(
      "abi",
      `specifier ${address} reads back ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

/**
 * Deploy a WorkerSpecifier from an unlocked anvil account and verify that it
 * reads back the given pin. Returns the contract address.
 */
export async function deploySpecifier(
  rpcUrl: string,
  from: string,
  pin: WorkerPin,
  timeoutMs = 15_000,
  artifact: SpecifierArtifact = loadSpecifierArtifact(),
): Promise<string> {
  const data = artifact.bytecode + encodeWorkerArgs(pin.workerHash, pin.resolvers).slice(2);
  const txHash = expectHex(await jsonRpc(rpcUrl, "eth_sendTransaction", [{ from, data }]), "deploy tx hash");
  const receipt = await waitForReceipt(rpcUrl, txHash, timeoutMs);
  const address = receipt["contractAddress"];
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(address)) {
    throw new TestbedError("rpc", `deploy receipt ${txHash} has no contractAddress`);
  }
  assertPin(await readSpecifier(rpcUrl, address), pin, address);
  return address;
}

/** setWorker(hash, resolvers) from the owner, then verify the read-back. */
export async function setWorker(
  rpcUrl: string,
  from: string,
  address: string,
  pin: WorkerPin,
  timeoutMs = 15_000,
): Promise<void> {
  const data = encodeSetWorker(pin.workerHash, pin.resolvers);
  const txHash = expectHex(
    await jsonRpc(rpcUrl, "eth_sendTransaction", [{ from, to: address, data }]),
    "setWorker tx hash",
  );
  await waitForReceipt(rpcUrl, txHash, timeoutMs);
  assertPin(await readSpecifier(rpcUrl, address), pin, address);
}
