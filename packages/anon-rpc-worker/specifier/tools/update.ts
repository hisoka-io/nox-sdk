// Repointing an owner-updatable WorkerSpecifier at a new worker release: one `setWorker(hash, resolvers)` call from
// the owner. `planSetWorker` is a dry run built on the read-only client: it reads the specifier, checks the new
// resolver list, simulates the call as the owner and takes the gas estimate from the target chain itself.
// `broadcastSetWorker` signs and sends that planned transaction; it exists only for the explicit --broadcast path of
// scripts/set-worker.ts and re-checks the chain, the signer and the specifier's state before it sends.

import { getAddress, JsonRpcProvider, Wallet } from "ethers";
import { allHttpsMatch, type AvailabilityResult } from "./availability.ts";
import { normalizeHash, setWorkerCalldata } from "./deployment.ts";
import { readSpecifier } from "./harness.ts";
import { feeCap, readFees, type FeeSnapshot, type PlanSettings } from "./plan.ts";
import { formatEth, formatGwei } from "./report.ts";
import { checkResolvers, type ResolverPolicy, type ResolverReport } from "./resolvers.ts";
import { expectHex, harnessProvider, hexToBigInt, redactUrl, RpcError, type RpcClient } from "./rpc.ts";
import { inspectSpecifier, type KnownArtifacts, type OwnerInfo } from "./specifier.ts";

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export type UpdateRequest = {
  /** Read-only client of the chain the specifier lives on. */
  rpc: RpcClient;
  specifier: string;
  workerHash: string;
  resolvers: readonly string[];
  /** When given, the plan fails unless the RPC answers with this chain id. */
  expectedChainId?: bigint;
  /** When given, the plan fails unless this is the specifier's current owner. */
  from?: string;
  resolverPolicy: ResolverPolicy;
  settings: PlanSettings;
};

export type SpecifierContents = { workerHash: string; resolvers: string[] };

export type UpdatePlan = {
  generatedAt: string;
  upstream: string;
  chainId: bigint;
  blockNumber: bigint;
  specifier: string;
  owner: Extract<OwnerInfo, { kind: "eoa" | "contract" }>;
  current: SpecifierContents;
  next: SpecifierContents;
  changes: { workerHash: boolean; resolvers: boolean };
  resolverReport: ResolverReport;
  fees: FeeSnapshot;
  tx: {
    from: string;
    to: string;
    data: `0x${string}`;
    dataBytes: number;
    /** eth_estimateGas answered by the target chain (not a fork), with the owner as the sender. */
    estimateGas: bigint;
    gasLimit: bigint;
    /** estimateGas x (base fee + tip): an upper estimate of the cost paid. */
    costExpected: bigint;
    /** gasLimit x fee cap: the balance the sender must hold for a node to accept the transaction. */
    budget: bigint;
  };
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Plans the `setWorker` call. Nothing is signed or sent: every request goes through the read-only client, and the
 * call is simulated with eth_call and eth_estimateGas on the target chain.
 */
export async function planSetWorker(request: UpdateRequest, artifacts: KnownArtifacts): Promise<UpdatePlan> {
  const workerHash = normalizeHash(request.workerHash);
  const resolverReport = checkResolvers(request.resolvers, workerHash, request.resolverPolicy);
  if (resolverReport.errors.length > 0) {
    throw new UpdateError(`resolver list is not publishable:\n  - ${resolverReport.errors.join("\n  - ")}`);
  }

  const inspection = await inspectSpecifier(request.rpc, request.specifier, artifacts);
  if (request.expectedChainId !== undefined && inspection.chainId !== request.expectedChainId) {
    throw new UpdateError(
      `the RPC serves chain ${inspection.chainId}, expected chain ${request.expectedChainId} (--chain-id)`,
    );
  }
  if (inspection.contract !== "reference WorkerSpecifier") {
    throw new UpdateError(
      `${inspection.address} on chain ${inspection.chainId} is "${inspection.contract}" (${inspection.updatePolicy}); setWorker exists only on the owner-updatable WorkerSpecifier`,
    );
  }
  const owner = inspection.owner;
  if (owner.kind === "renounced") {
    throw new UpdateError(`${inspection.address} is frozen: ownership was renounced, so setWorker can never succeed`);
  }
  if (owner.kind !== "eoa" && owner.kind !== "contract") {
    throw new UpdateError(
      `owner() of ${inspection.address} could not be read${owner.kind === "unreadable" ? `: ${owner.reason}` : ""}`,
    );
  }
  if (request.from !== undefined && getAddress(request.from) !== owner.address) {
    throw new UpdateError(
      `--from ${getAddress(request.from)} is not the owner of ${inspection.address}; the owner is ${owner.address}, and setWorker reverts with NotOwner() for any other sender`,
    );
  }

  const current: SpecifierContents = { workerHash: inspection.workerHash, resolvers: inspection.resolvers };
  const next: SpecifierContents = { workerHash, resolvers: [...request.resolvers] };
  const changes = {
    workerHash: current.workerHash.toLowerCase() !== workerHash,
    resolvers: !sameList(current.resolvers, next.resolvers),
  };
  if (!changes.workerHash && !changes.resolvers) {
    throw new UpdateError(
      `${inspection.address} already publishes workerHash ${workerHash} with this resolver list; there is nothing to update`,
    );
  }

  const data = setWorkerCalldata(workerHash, next.resolvers);
  const call = { from: owner.address, to: inspection.address, data };
  try {
    await request.rpc.request("eth_call", [call, "latest"]);
  } catch (e) {
    if (e instanceof RpcError) throw new UpdateError(`setWorker reverts when simulated as the owner: ${e.message}`);
    throw e;
  }
  const estimateGas = hexToBigInt(await request.rpc.request("eth_estimateGas", [call]), "eth_estimateGas(setWorker)");
  const gasLimit = (estimateGas * BigInt(100 + request.settings.gasLimitHeadroomPercent)) / 100n;
  const fees = await readFees(request.rpc, request.settings);

  return {
    generatedAt: new Date().toISOString(),
    upstream: redactUrl(request.rpc.url),
    chainId: inspection.chainId,
    blockNumber: inspection.blockNumber,
    specifier: inspection.address,
    owner,
    current,
    next,
    changes,
    resolverReport,
    fees,
    tx: {
      from: owner.address,
      to: inspection.address,
      data,
      dataBytes: (data.length - 2) / 2,
      estimateGas,
      gasLimit,
      costExpected: estimateGas * (fees.baseFeePerGas + fees.priorityFeePerGas),
      budget: gasLimit * fees.maxFeePerGas,
    },
  };
}

/**
 * `cast send` arguments for the planned call, for an owner that signs with its own wallet (`signer` is e.g.
 * `["--ledger"]`). `--from` makes cast refuse a different signing account. The calldata goes in as raw hex.
 */
export function castSetWorkerArgs(rpcUrl: string, signer: readonly string[], plan: UpdatePlan): string[] {
  return [
    "send",
    "--rpc-url",
    rpcUrl,
    ...signer,
    "--from",
    plan.tx.from,
    "--gas-limit",
    plan.tx.gasLimit.toString(),
    plan.tx.to,
    plan.tx.data,
  ];
}

function describeOwner(owner: UpdatePlan["owner"]): string {
  if (owner.kind === "contract") return `contract ${owner.address} (codehash ${owner.codehash})`;
  return `EOA ${owner.address}${owner.delegatedTo === null ? "" : ` (EIP-7702 delegated to ${owner.delegatedTo})`}`;
}

export function renderUpdatePlan(plan: UpdatePlan, availability: readonly AvailabilityResult[] | null): string {
  const lines = [
    `chain ${plan.chainId} via ${plan.upstream} · block ${plan.blockNumber}`,
    `specifier ${plan.specifier} (reference WorkerSpecifier) · owner ${describeOwner(plan.owner)}`,
    `workerHash now  ${plan.current.workerHash}`,
    `workerHash next ${plan.next.workerHash}${plan.changes.workerHash ? "" : " (unchanged)"}`,
    `resolvers next (${plan.next.resolvers.length}, ${plan.resolverReport.totalBytes} bytes)${plan.changes.resolvers ? "" : " (unchanged)"}:`,
    ...plan.next.resolvers.map((r, i) => `  [${i}] ${r}`),
    ...plan.resolverReport.warnings.map((w) => `  warning: ${w}`),
  ];
  if (availability !== null) {
    lines.push("resolver fetch check (through the harness's fetchAndVerifyBundle):");
    availability.forEach((a, i) => lines.push(`  [${i}] ${a.status.toUpperCase()}: ${a.detail}`));
  }
  lines.push(
    "transaction (setWorker, simulated as the owner on the target chain):",
    `  from  ${plan.tx.from}`,
    `  to    ${plan.tx.to}`,
    "  value 0",
    `  data  ${plan.tx.data}`,
    `  data ${plan.tx.dataBytes} bytes · eth_estimateGas ${plan.tx.estimateGas} · gas limit ${plan.tx.gasLimit}`,
    `  fees: base ${formatGwei(plan.fees.baseFeePerGas)} · tip ${formatGwei(plan.fees.priorityFeePerGas)} · fee cap ${formatGwei(feeCap(plan.fees.baseFeePerGas, plan.fees.priorityFeePerGas, plan.fees.maxFeeBaseFeeMultiplier))}`,
    `  cost up to ${formatEth(plan.tx.costExpected)} at today's fees · hold ${formatEth(plan.tx.budget)} (gas limit x fee cap)`,
  );
  if (plan.owner.kind === "contract") {
    lines.push(
      "  the owner is a contract: submit to, value and data above as its transaction (for a Safe, a new transaction",
      "  with these fields); the gas figures describe the inner call only",
    );
  }
  return lines.join("\n");
}

export type BroadcastOptions = {
  /** RPC of the target chain, used to send. */
  rpcUrl: string;
  /** The owner's private key as hex. Never logged or echoed. */
  privateKey: string;
  /** Results of the resolver fetch check; pass null only when the caller chose to skip it. */
  availability: readonly AvailabilityResult[] | null;
  /** Blocks to wait for after the transaction is mined. */
  confirmations: number;
  timeoutMs: number;
};

export type BroadcastResult = {
  txHash: string;
  blockNumber: number;
  nonce: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  fee: bigint;
};

/**
 * Signs and sends the planned `setWorker` transaction, then reads the specifier back through the harness. It
 * refuses before signing when the chain id differs from the plan, the key is not the owner's, the owner has
 * pending transactions, the specifier changed since the plan, or an `https:` resolver does not serve the new bytes.
 */
export async function broadcastSetWorker(plan: UpdatePlan, options: BroadcastOptions): Promise<BroadcastResult> {
  if (plan.owner.kind !== "eoa") {
    throw new UpdateError(
      `the owner ${plan.owner.address} is a contract; submit the printed transaction through it (for a Safe, as a Safe transaction)`,
    );
  }
  if (options.availability !== null && !allHttpsMatch(options.availability)) {
    throw new UpdateError(
      "an https: resolver does not serve the new bundle bytes; publish the bundle first, since wallets pinned to this address would have nothing to boot from",
    );
  }
  const provider = new JsonRpcProvider(options.rpcUrl, undefined, { staticNetwork: true });
  try {
    const chainId = (await provider.getNetwork()).chainId;
    if (chainId !== plan.chainId) {
      throw new UpdateError(`the sending RPC serves chain ${chainId}, but the plan is for chain ${plan.chainId}`);
    }
    const key = options.privateKey.trim();
    const wallet = new Wallet(key.startsWith("0x") ? key : `0x${key}`, provider);
    if (wallet.address !== plan.owner.address) {
      throw new UpdateError(
        `the key file holds the key of ${wallet.address}, which is not the owner ${plan.owner.address}`,
      );
    }
    const nonce = await provider.getTransactionCount(wallet.address, "latest");
    const pending = await provider.getTransactionCount(wallet.address, "pending");
    if (nonce !== pending) {
      throw new UpdateError(`the owner has pending transactions (latest nonce ${nonce}, pending ${pending})`);
    }
    const reader = harnessProvider({
      url: options.rpcUrl,
      request: (method, params) => provider.send(method, [...(params ?? [])]),
    });
    const before = await readSpecifier(reader, plan.specifier);
    if (before.workerHash !== plan.current.workerHash || !sameList(before.resolvers, plan.current.resolvers)) {
      throw new UpdateError(`${plan.specifier} changed since the plan was made; plan again`);
    }

    const tx = await wallet.sendTransaction({
      to: plan.tx.to,
      data: plan.tx.data,
      gasLimit: plan.tx.gasLimit,
      nonce,
      chainId: plan.chainId,
    });
    const receipt = await tx.wait(options.confirmations, options.timeoutMs);
    if (receipt === null || receipt.status !== 1) {
      throw new UpdateError(`setWorker transaction ${tx.hash} did not succeed (status ${receipt?.status ?? "none"})`);
    }
    const after = await readSpecifier(reader, plan.specifier);
    if (after.workerHash !== plan.next.workerHash || !sameList(after.resolvers, plan.next.resolvers)) {
      throw new UpdateError(
        `transaction ${tx.hash} succeeded, but ${plan.specifier} reads back workerHash ${after.workerHash}`,
      );
    }
    return {
      txHash: expectHex(tx.hash, "transaction hash"),
      blockNumber: receipt.blockNumber,
      nonce,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      fee: receipt.fee,
    };
  } finally {
    provider.destroy();
  }
}
