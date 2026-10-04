// Human-readable rendering of plans and inspections, and the signer commands a plan hands over.

import type { AvailabilityResult } from "./availability.ts";
import { feeCap, type DeploymentPlan, type FeeSnapshot, type TxPlan, type VariantPlan } from "./plan.ts";
import type { SpecifierInspection } from "./specifier.ts";

const WEI_PER_GWEI = 10n ** 9n;
const WEI_PER_ETH = 10n ** 18n;

function decimal(value: bigint, unit: bigint, digits: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / unit;
  const scale = 10n ** BigInt(digits);
  const frac = ((abs % unit) * scale) / unit;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(digits, "0")}`;
}

export const formatEth = (wei: bigint): string => `${decimal(wei, WEI_PER_ETH, 8)} ETH`;
export const formatGwei = (wei: bigint): string => `${decimal(wei, WEI_PER_GWEI, 4)} gwei`;

/** JSON with bigints as decimal strings. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export type SignerArgs = readonly string[];

/**
 * `cast send --create` arguments for a planned creation transaction. The signer flags come from the caller (e.g.
 * `--ledger`); `--from` names the planned sender, so cast refuses when the hardware wallet would sign from another
 * account (another derivation index lands the contract at another address and nonce); the gas limit is the planned
 * one; fees are left to cast at signing time, since they move. cast then signs a fee cap of twice the base fee plus
 * the tip, so the account must hold gas limit x that cap (see `scenarioCost`).
 */
export function castCreateArgs(
  rpcUrl: string,
  signer: SignerArgs,
  tx: TxPlan,
  creationCode: string,
  from: string,
): string[] {
  return [
    "send",
    "--rpc-url",
    rpcUrl,
    ...signer,
    "--from",
    from,
    "--gas-limit",
    tx.gasLimit.toString(),
    "--create",
    creationCode,
  ];
}

function txLine(tx: TxPlan): string {
  return [
    `    ${tx.label}`,
    `      data ${tx.dataBytes} bytes · estimateGas ${tx.estimateGas} · gasUsed on fork ${tx.gasUsedOnFork} · gas limit ${tx.gasLimit}`,
    `      cost ${formatEth(tx.costExpected)} expected (base fee + tip) · ${formatEth(tx.costAtBaseFee)} at base fee · hold ${formatEth(tx.budget)} (gas limit x fee cap)`,
  ].join("\n");
}

function variantBlock(plan: DeploymentPlan, v: VariantPlan, creationCodeFile: string): string {
  const lines = [
    `  ${v.contract} (${v.variant})`,
    `    creation code keccak256 ${v.creationCodeKeccak} (saved to ${creationCodeFile})`,
    txLine(v.deploy),
    `    fork deployment ${v.forkAddress}: harness read-back OK, runtime ${v.inspection.runtimeBytes} bytes, codehash ${v.inspection.runtimeCodehash}`,
    `    state-changing opcodes in runtime code: ${v.inspection.stateChangingOpcodes.length === 0 ? "none" : v.inspection.stateChangingOpcodes.join(", ")}`,
    `    update policy once deployed: ${v.inspection.updatePolicy}`,
  ];
  if (plan.deployer !== null) {
    lines.push(
      `    address if ${plan.deployer.address} sends this as its next transaction (nonce ${plan.deployer.nonce}): ${v.forkAddress}`,
    );
  }
  if (v.followUps.length > 0) {
    lines.push("    owner operations (each measured from the freshly deployed state):");
    for (const f of v.followUps) lines.push(txLine(f).replace(/^ {4}/gm, "      "));
  }
  return lines.join("\n");
}

type Sequence = { contract: string; what: string; txs: TxPlan[] };

/** The transaction sequences a founder may sign for one variant: the deploy alone, then with each owner step. */
export function sequencesOf(v: VariantPlan): Sequence[] {
  const sequences: Sequence[] = [{ contract: v.contract, what: "deploy", txs: [v.deploy] }];
  for (const kind of ["renounceOwnership", "transferOwnership"] as const) {
    const followUp = v.followUps.find((t) => t.kind === kind);
    if (followUp !== undefined) {
      sequences.push({ contract: v.contract, what: `deploy + ${kind}`, txs: [v.deploy, followUp] });
    }
  }
  return sequences;
}

const gasUsed = (txs: readonly TxPlan[]): bigint => txs.reduce((sum, t) => sum + t.gasUsedOnFork, 0n);
const gasLimit = (txs: readonly TxPlan[]): bigint => txs.reduce((sum, t) => sum + t.gasLimit, 0n);

export type ScenarioCost = {
  baseFeePerGas: bigint;
  /** The fee cap a wallet signs at this base fee: base fee x multiplier + tip. */
  maxFeePerGas: bigint;
  /** What the sequence costs: gas used x (base fee + tip), summed. */
  paid: bigint;
  /**
   * The balance to hold before signing: gas limit x fee cap, summed over the sequence. A node rejects a transaction
   * ("insufficient funds for gas * price + value") unless the sender holds its gas limit x fee cap up front, so this,
   * not `paid`, is the amount to fund.
   */
  hold: bigint;
};

/** Cost paid and balance required for a transaction sequence signed when the base fee is `baseFeePerGas`. */
export function scenarioCost(
  txs: readonly TxPlan[],
  baseFeePerGas: bigint,
  fees: Pick<FeeSnapshot, "priorityFeePerGas" | "maxFeeBaseFeeMultiplier">,
): ScenarioCost {
  const maxFeePerGas = feeCap(baseFeePerGas, fees.priorityFeePerGas, fees.maxFeeBaseFeeMultiplier);
  return {
    baseFeePerGas,
    maxFeePerGas,
    paid: gasUsed(txs) * (baseFeePerGas + fees.priorityFeePerGas),
    hold: gasLimit(txs) * maxFeePerGas,
  };
}

export function renderPlan(plan: DeploymentPlan, files: Readonly<Record<string, string>>): string {
  const f = plan.fees;
  const out: string[] = [
    "DRY RUN: nothing was signed or sent to the target chain. Transactions ran only on a local anvil fork.",
    "",
    `chain ${f.chainId} via ${plan.upstream} · block ${f.blockNumber} (${new Date(Number(f.blockTimestamp) * 1000).toISOString()})`,
    `fees: base ${formatGwei(f.baseFeePerGas)} · eth_gasPrice ${formatGwei(f.gasPrice)} · tip ${formatGwei(f.priorityFeePerGas)} · fee cap ${formatGwei(f.maxFeePerGas)}`,
    `workerHash ${plan.workerHash}`,
    `resolvers (${plan.resolvers.length}, ${plan.resolverReport.totalBytes} bytes):`,
    ...plan.resolvers.map((r, i) => `  [${i}] ${r}`),
  ];
  for (const w of plan.resolverReport.warnings) out.push(`warning: ${w}`);
  if (plan.availability !== null) out.push(...renderAvailability(plan.availability));
  out.push("");
  for (const v of plan.variants) {
    out.push(variantBlock(plan, v, files[v.variant] ?? "<not saved>"), "");
  }
  out.push(
    "ETH for the deploying account at today's fees (hold = gas limit x fee cap, the balance the node requires before it accepts each transaction; expected = gas used x (base fee + tip), the cost paid):",
  );
  const all = plan.variants.flatMap((v) => sequencesOf(v));
  for (const { contract, what, txs } of all) {
    const hold = txs.reduce((sum, t) => sum + t.budget, 0n);
    const expected = txs.reduce((sum, t) => sum + t.costExpected, 0n);
    out.push(
      `  ${contract}: ${what}: ${gasUsed(txs)} gas used, gas limit ${gasLimit(txs)}, expected ${formatEth(expected)}, hold ${formatEth(hold)}`,
    );
  }
  if (plan.variants.length > 1) {
    const hold = plan.variants.reduce((s, v) => s + v.deploy.budget, 0n);
    out.push(`  both deployments: hold ${formatEth(hold)}`);
  }
  if (plan.scenarioBaseFeesGwei.length > 0) {
    out.push(
      "",
      `The same sequences at other base fees on signing day (tip ${formatGwei(f.priorityFeePerGas)}; fee cap = ${f.maxFeeBaseFeeMultiplier} x base fee + tip, as cast signs it when the command leaves fees to cast).`,
      "  paid = gas used x (base fee + tip); hold = gas limit x fee cap, summed: the balance to fund before signing.",
    );
    for (const { contract, what, txs } of all) {
      const prices = plan.scenarioBaseFeesGwei.map((gwei) => {
        const c = scenarioCost(txs, gwei * WEI_PER_GWEI, f);
        return `base ${gwei} gwei (cap ${formatGwei(c.maxFeePerGas)}): paid ${formatEth(c.paid)}, hold ${formatEth(c.hold)}`;
      });
      out.push(`  ${contract}: ${what}:`, ...prices.map((p) => `    ${p}`));
    }
  }
  if (plan.deployer !== null) {
    out.push(`  ${plan.deployer.address} holds ${formatEth(plan.deployer.balance)} at block ${f.blockNumber}`);
  }
  return out.join("\n");
}

export function renderInspection(s: SpecifierInspection): string {
  const owner =
    s.owner.kind === "eoa" || s.owner.kind === "contract"
      ? `${s.owner.kind} ${s.owner.address}`
      : s.owner.kind === "unreadable"
        ? `unreadable (${s.owner.reason})`
        : s.owner.kind;
  const lines = [
    `${s.address} (chain ${s.chainId}, block ${s.blockNumber})`,
    `  contract      ${s.contract} · runtime ${s.runtimeBytes} bytes · codehash ${s.runtimeCodehash}`,
    `  owner         ${owner}`,
    `  update policy ${s.updatePolicy}`,
    `  state-changing opcodes: ${s.stateChangingOpcodes.length === 0 ? "none" : s.stateChangingOpcodes.join(", ")}`,
    `  workerHash    ${s.workerHash}`,
    `  resolvers (${s.resolvers.length}):`,
    ...s.resolvers.map((r, i) => `    [${i}] ${r}`),
  ];
  for (const e of s.resolverReport.errors) lines.push(`  resolver issue: ${e}`);
  for (const w of s.resolverReport.warnings) lines.push(`  resolver note: ${w}`);
  return lines.join("\n");
}

export function renderAvailability(results: readonly AvailabilityResult[]): string[] {
  return [
    "resolver fetch check (through the harness's fetchAndVerifyBundle):",
    ...results.map((r, i) => `  [${i}] ${r.status.toUpperCase()}: ${r.detail}`),
  ];
}
