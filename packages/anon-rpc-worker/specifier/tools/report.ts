// Human-readable rendering of plans and inspections, and the signer commands a plan hands over.

import type { DeploymentPlan, TxPlan, VariantPlan } from "./plan.ts";
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
 * `--ledger`); the gas limit is the planned one; fees are left to cast at signing time, since they move.
 */
export function castCreateArgs(rpcUrl: string, signer: SignerArgs, tx: TxPlan, creationCode: string): string[] {
  return ["send", "--rpc-url", rpcUrl, ...signer, "--gas-limit", tx.gasLimit.toString(), "--create", creationCode];
}

function txLine(tx: TxPlan): string {
  return [
    `    ${tx.label}`,
    `      data ${tx.dataBytes} bytes · estimateGas ${tx.estimateGas} · gasUsed on fork ${tx.gasUsedOnFork} · gas limit ${tx.gasLimit}`,
    `      cost ${formatEth(tx.costExpected)} expected (base fee + tip) · ${formatEth(tx.costAtBaseFee)} at base fee · budget ${formatEth(tx.budget)} at the fee cap`,
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
  out.push("");
  for (const v of plan.variants) {
    out.push(variantBlock(plan, v, files[v.variant] ?? "<not saved>"), "");
  }
  out.push(
    "ETH to hold in the deploying account (budget = gas limit x fee cap; expected = gas used x (base fee + tip)):",
  );
  for (const v of plan.variants) {
    const all = [v.deploy, ...v.followUps.filter((t) => t.label.startsWith("transferOwnership"))];
    const budget = all.reduce((s, t) => s + t.budget, 0n);
    const expected = all.reduce((s, t) => s + t.costExpected, 0n);
    const what = all.length > 1 ? "deploy + transferOwnership" : "deploy";
    out.push(`  ${v.contract}: ${what}: budget ${formatEth(budget)}, expected ${formatEth(expected)}`);
  }
  if (plan.variants.length > 1) {
    const budget = plan.variants.reduce((s, v) => s + v.deploy.budget, 0n);
    out.push(`  both deployments: budget ${formatEth(budget)}`);
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
