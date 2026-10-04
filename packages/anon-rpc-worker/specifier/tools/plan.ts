// Dry-run deployment planning. Everything that touches the target chain goes through a read-only client
// (fees, block, deployer balance and nonce); every transaction goes to a local anvil fork pinned to the block
// that was read. The fork deployment is read back through the reference harness, so the creation code in the
// plan is proven to produce a specifier wallets can read, before anyone signs it.

import { getAddress, Wallet } from "ethers";
import { startAnvil, type Anvil } from "./anvil.ts";
import { checkAvailability, type AvailabilityResult } from "./availability.ts";
import { CONTRACTS, loadArtifact, type Variant } from "./artifacts.ts";
import {
  codeKeccak,
  creationCode,
  normalizeHash,
  renounceOwnershipCalldata,
  setWorkerCalldata,
  transferOwnershipCalldata,
} from "./deployment.ts";
import { MAX_BUNDLE_BYTES } from "./harness.ts";
import { checkResolvers, type ResolverPolicy, type ResolverReport } from "./resolvers.ts";
import { expectHex, hexToBigInt, readOnlyRpc, redactUrl, toQuantity, waitForReceipt, type RpcClient } from "./rpc.ts";
import { inspectSpecifier, type KnownArtifacts, type SpecifierInspection } from "./specifier.ts";

export type PlanSettings = {
  /** Recent blocks sampled for the priority fee. */
  feeHistoryBlocks: number;
  /** Percentile of those blocks' tips used as the priority fee. */
  tipPercentile: number;
  /** Gas limit = estimate plus this percentage. */
  gasLimitHeadroomPercent: number;
  /** maxFeePerGas = baseFee times this, plus the tip (the usual wallet rule). */
  maxFeeBaseFeeMultiplier: bigint;
  anvilStartTimeoutMs: number;
  rpcTimeoutMs: number;
  /** Body cap when fetching resolvers (the reference harness uses 64 MiB). */
  maxBundleBytes: number;
  /** Gas prices (gwei) at which the report also prices each sequence, for budgeting beyond today's fees. */
  scenarioGasPricesGwei: readonly bigint[];
};

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  feeHistoryBlocks: 20,
  tipPercentile: 50,
  gasLimitHeadroomPercent: 20,
  maxFeeBaseFeeMultiplier: 2n,
  anvilStartTimeoutMs: 90_000,
  rpcTimeoutMs: 60_000,
  maxBundleBytes: MAX_BUNDLE_BYTES,
  scenarioGasPricesGwei: [1n, 4n, 20n],
};

export type PlanRequest = {
  variants: readonly Variant[];
  workerHash: string;
  resolvers: readonly string[];
  /** RPC of the target chain. Read from, and forked locally; never sent to. */
  upstreamUrl: string;
  /** The account that will sign: its balance is checked and the fork deploys from it, giving the real address. */
  deployer?: string;
  /** Reference variant only: the account (e.g. a Safe) that takes ownership after deployment. */
  newOwner?: string;
  resolverPolicy: ResolverPolicy;
  /** Fetch every https: resolver through the harness and compare with the hash (read-only GETs). */
  checkResolvers: boolean;
  settings: PlanSettings;
};

export type FeeSnapshot = {
  chainId: bigint;
  blockNumber: bigint;
  blockTimestamp: bigint;
  baseFeePerGas: bigint;
  /** eth_gasPrice as reported by the upstream node. */
  gasPrice: bigint;
  /** Tip at the chosen percentile over the sampled blocks. */
  priorityFeePerGas: bigint;
  /** What a wallet would sign as the fee cap. */
  maxFeePerGas: bigint;
};

export type TxKind = "deploy" | "transferOwnership" | "setWorker" | "renounceOwnership";

export type TxPlan = {
  kind: TxKind;
  label: string;
  /** null for a contract creation. */
  to: string | null;
  data: `0x${string}`;
  dataBytes: number;
  estimateGas: bigint;
  gasUsedOnFork: bigint;
  gasLimit: bigint;
  /** gasUsed x baseFee. */
  costAtBaseFee: bigint;
  /** gasUsed x (baseFee + tip). */
  costExpected: bigint;
  /** gasLimit x maxFeePerGas: the most this transaction can cost under the signed caps. */
  budget: bigint;
};

export type VariantPlan = {
  variant: Variant;
  contract: string;
  creationCodeKeccak: `0x${string}`;
  deploy: TxPlan;
  /** Reference variant: owner operations measured on the deployed fork copy (each from the same state). */
  followUps: TxPlan[];
  /** Where the fork deployment landed: the real address if `deployer` signs this as its next transaction. */
  forkAddress: string;
  /** The fork deployment, read back through the reference harness. */
  inspection: SpecifierInspection;
};

export type DeploymentPlan = {
  generatedAt: string;
  upstream: string;
  fees: FeeSnapshot;
  workerHash: `0x${string}`;
  resolvers: string[];
  resolverReport: ResolverReport;
  /** Per-resolver fetch results, when requested. */
  availability: AvailabilityResult[] | null;
  deployer: { address: string; nonce: bigint; balance: bigint } | null;
  newOwner: string | null;
  variants: VariantPlan[];
  /** Copied from the settings so the rendered report can price each sequence at these gas prices. */
  scenarioGasPricesGwei: bigint[];
};

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function median(values: readonly bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)] ?? 0n;
}

async function readFees(rpc: RpcClient, settings: PlanSettings): Promise<FeeSnapshot> {
  const chainId = hexToBigInt(await rpc.request("eth_chainId"), "eth_chainId");
  const block = await rpc.request("eth_getBlockByNumber", ["latest", false]);
  if (!isRecord(block)) throw new PlanError("eth_getBlockByNumber(latest) returned no block");
  const blockNumber = hexToBigInt(block["number"], "block.number");
  const blockTimestamp = hexToBigInt(block["timestamp"], "block.timestamp");
  if (block["baseFeePerGas"] === undefined)
    throw new PlanError(`block ${blockNumber} has no baseFeePerGas (pre-London chain?)`);
  const baseFeePerGas = hexToBigInt(block["baseFeePerGas"], "block.baseFeePerGas");
  const gasPrice = hexToBigInt(await rpc.request("eth_gasPrice"), "eth_gasPrice");

  const history = await rpc.request("eth_feeHistory", [
    toQuantity(BigInt(settings.feeHistoryBlocks)),
    toQuantity(blockNumber),
    [settings.tipPercentile],
  ]);
  const rewards = isRecord(history) && Array.isArray(history["reward"]) ? history["reward"] : [];
  const tips: bigint[] = [];
  for (const row of rewards) {
    if (Array.isArray(row) && row.length > 0) tips.push(hexToBigInt(row[0], "feeHistory.reward"));
  }
  const priorityFeePerGas = tips.length > 0 ? median(tips) : gasPrice > baseFeePerGas ? gasPrice - baseFeePerGas : 0n;
  const maxFeePerGas = baseFeePerGas * settings.maxFeeBaseFeeMultiplier + priorityFeePerGas;
  return { chainId, blockNumber, blockTimestamp, baseFeePerGas, gasPrice, priorityFeePerGas, maxFeePerGas };
}

/** The resolver list for the next version: content-addressed paths retargeted from `from` to `to`. */
export function retargetResolvers(resolvers: readonly string[], from: string, to: string): string[] {
  const a = from.slice(2).toLowerCase();
  const b = to.slice(2).toLowerCase();
  return resolvers.map((r) => r.replaceAll(`${a.slice(0, 2)}/${a.slice(2)}`, `${b.slice(0, 2)}/${b.slice(2)}`));
}

type Fork = { anvil: Anvil; sender: string };

/** Balance given to an impersonated deployer on the fork only, so measurements never depend on its real funds. */
const FORK_SENDER_BALANCE_WEI = 1000n * 10n ** 18n;

async function openFork(request: PlanRequest, blockNumber: bigint): Promise<Fork> {
  const anvil = await startAnvil({
    forkUrl: request.upstreamUrl,
    forkBlockNumber: blockNumber,
    startTimeoutMs: request.settings.anvilStartTimeoutMs,
    rpcTimeoutMs: request.settings.rpcTimeoutMs,
  });
  try {
    if (request.deployer !== undefined) {
      const sender = getAddress(request.deployer);
      await anvil.rpc.request("anvil_impersonateAccount", [sender]);
      await anvil.rpc.request("anvil_setBalance", [sender, toQuantity(FORK_SENDER_BALANCE_WEI)]);
      return { anvil, sender };
    }
    // No deployer given: a fresh random address (no code, no delegation, nonce 0 on the target chain) stands in,
    // rather than anvil's well-known dev accounts, which carry real-world state on public chains.
    const sender = Wallet.createRandom().address;
    await anvil.rpc.request("anvil_impersonateAccount", [sender]);
    await anvil.rpc.request("anvil_setBalance", [sender, toQuantity(FORK_SENDER_BALANCE_WEI)]);
    return { anvil, sender };
  } catch (e) {
    await anvil.stop();
    throw e;
  }
}

async function measure(
  fork: Fork,
  fees: FeeSnapshot,
  settings: PlanSettings,
  kind: TxKind,
  label: string,
  to: string | null,
  data: `0x${string}`,
): Promise<{ tx: TxPlan; created: string | null }> {
  const call = to === null ? { from: fork.sender, data } : { from: fork.sender, to, data };
  const estimateGas = hexToBigInt(await fork.anvil.rpc.request("eth_estimateGas", [call]), `eth_estimateGas(${label})`);
  const gasLimit = (estimateGas * BigInt(100 + settings.gasLimitHeadroomPercent)) / 100n;
  const txHash = expectHex(
    await fork.anvil.rpc.request("eth_sendTransaction", [{ ...call, gas: toQuantity(gasLimit) }]),
    `eth_sendTransaction(${label})`,
  );
  const receipt = await waitForReceipt(fork.anvil.rpc, txHash, settings.rpcTimeoutMs);
  if (receipt["status"] !== "0x1") throw new PlanError(`${label}: reverted on the fork (tx ${txHash})`);
  const gasUsed = hexToBigInt(receipt["gasUsed"], `${label} gasUsed`);
  const created = typeof receipt["contractAddress"] === "string" ? getAddress(receipt["contractAddress"]) : null;
  const dataBytes = (data.length - 2) / 2;
  return {
    created,
    tx: {
      kind,
      label,
      to,
      data,
      dataBytes,
      estimateGas,
      gasUsedOnFork: gasUsed,
      gasLimit,
      costAtBaseFee: gasUsed * fees.baseFeePerGas,
      costExpected: gasUsed * (fees.baseFeePerGas + fees.priorityFeePerGas),
      budget: gasLimit * fees.maxFeePerGas,
    },
  };
}

async function snapshot(fork: Fork): Promise<string> {
  const id = await fork.anvil.rpc.request("evm_snapshot");
  if (typeof id !== "string") throw new PlanError("evm_snapshot returned no id");
  return id;
}

async function revert(fork: Fork, id: string): Promise<void> {
  if ((await fork.anvil.rpc.request("evm_revert", [id])) !== true) throw new PlanError(`evm_revert(${id}) failed`);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function planVariant(
  fork: Fork,
  fees: FeeSnapshot,
  request: PlanRequest,
  variant: Variant,
  workerHash: `0x${string}`,
  artifacts: KnownArtifacts,
): Promise<VariantPlan> {
  const artifact = artifacts[variant];
  const code = creationCode(artifact, workerHash, request.resolvers);
  const { tx: deploy, created } = await measure(
    fork,
    fees,
    request.settings,
    "deploy",
    `deploy ${artifact.contract}`,
    null,
    code,
  );
  if (created === null) throw new PlanError(`deploy ${artifact.contract}: receipt has no contract address`);

  const inspection = await inspectSpecifier(fork.anvil.rpc, created, artifacts);
  const expectedKind = variant === "immutable" ? "ImmutableWorkerSpecifier" : "reference WorkerSpecifier";
  if (inspection.contract !== expectedKind) {
    throw new PlanError(`fork deployment at ${created} is "${inspection.contract}", expected "${expectedKind}"`);
  }
  if (inspection.workerHash !== workerHash || !sameList(inspection.resolvers, request.resolvers)) {
    throw new PlanError(`the harness read back different contents from the fork deployment at ${created}`);
  }

  const followUps: TxPlan[] = [];
  if (variant === "reference") {
    const nextHash = codeKeccak(workerHash);
    const ops: { kind: TxKind; label: string; data: `0x${string}` }[] = [
      {
        kind: "setWorker",
        label: "setWorker (next version: new hash, same resolver hosts)",
        data: setWorkerCalldata(nextHash, retargetResolvers(request.resolvers, workerHash, nextHash)),
      },
      {
        kind: "renounceOwnership",
        label: "renounceOwnership (freeze this version)",
        data: renounceOwnershipCalldata(),
      },
    ];
    if (request.newOwner !== undefined) {
      ops.unshift({
        kind: "transferOwnership",
        label: `transferOwnership to ${getAddress(request.newOwner)}`,
        data: transferOwnershipCalldata(request.newOwner),
      });
    }
    for (const op of ops) {
      const id = await snapshot(fork);
      followUps.push((await measure(fork, fees, request.settings, op.kind, op.label, created, op.data)).tx);
      await revert(fork, id);
    }
  }

  return {
    variant,
    contract: CONTRACTS[variant].name,
    creationCodeKeccak: codeKeccak(code),
    deploy,
    followUps,
    forkAddress: created,
    inspection,
  };
}

export async function planDeployment(request: PlanRequest): Promise<DeploymentPlan> {
  const workerHash = normalizeHash(request.workerHash);
  const resolverReport = checkResolvers(request.resolvers, workerHash, request.resolverPolicy);
  if (resolverReport.errors.length > 0) {
    throw new PlanError(`resolver list is not publishable:\n  - ${resolverReport.errors.join("\n  - ")}`);
  }
  if (request.variants.length === 0) throw new PlanError("no variant requested");
  const availability = request.checkResolvers
    ? await checkAvailability(workerHash, request.resolvers, { maxBytes: request.settings.maxBundleBytes })
    : null;
  const artifacts: KnownArtifacts = {
    reference: await loadArtifact("reference"),
    immutable: await loadArtifact("immutable"),
  };

  const upstream = readOnlyRpc(request.upstreamUrl, { timeoutMs: request.settings.rpcTimeoutMs });
  const fees = await readFees(upstream, request.settings);
  let deployer: DeploymentPlan["deployer"] = null;
  if (request.deployer !== undefined) {
    const address = getAddress(request.deployer);
    const block = toQuantity(fees.blockNumber);
    const code = expectHex(await upstream.request("eth_getCode", [address, block]), "eth_getCode(deployer)");
    if (code !== "0x" && !code.toLowerCase().startsWith("0xef0100")) {
      throw new PlanError(
        `--deployer ${address} is a contract; contract accounts such as a Safe deploy through a factory, which this planner does not model (deploy from an EOA, then transferOwnership)`,
      );
    }
    deployer = {
      address,
      nonce: hexToBigInt(
        await upstream.request("eth_getTransactionCount", [address, block]),
        "eth_getTransactionCount",
      ),
      balance: hexToBigInt(await upstream.request("eth_getBalance", [address, block]), "eth_getBalance"),
    };
  }

  const fork = await openFork(request, fees.blockNumber);
  const variants: VariantPlan[] = [];
  try {
    for (const variant of request.variants) {
      const id = await snapshot(fork);
      variants.push(await planVariant(fork, fees, request, variant, workerHash, artifacts));
      await revert(fork, id);
    }
  } finally {
    await fork.anvil.stop();
  }

  return {
    generatedAt: new Date().toISOString(),
    upstream: redactUrl(request.upstreamUrl),
    fees,
    workerHash,
    resolvers: [...request.resolvers],
    resolverReport,
    availability,
    deployer,
    newOwner: request.newOwner === undefined ? null : getAddress(request.newOwner),
    variants,
    scenarioGasPricesGwei: [...request.settings.scenarioGasPricesGwei],
  };
}
