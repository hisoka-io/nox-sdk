// The dry-run planner against a local stand-in for mainnet: a fresh anvil chain plays the target network, the
// planner reads it through the read-only client and forks it into a second anvil for the transactions. The test
// checks the numbers add up, that the target chain is untouched, and that the signer command the plan prints
// deploys a specifier the harness reads correctly.

import { spawn } from "node:child_process";
import { getCreateAddress, Wallet } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnvil, type Anvil } from "../tools/anvil.ts";
import { loadArtifact, MAINNET_REFERENCE_CODEHASH, PROJECT_ROOT } from "../tools/artifacts.ts";
import { creationCode, PayloadError } from "../tools/deployment.ts";
import { readSpecifier } from "../tools/harness.ts";
import {
  DEFAULT_PLAN_SETTINGS,
  planDeployment,
  PlanError,
  type DeploymentPlan,
  type PlanRequest,
} from "../tools/plan.ts";
import { castCreateArgs } from "../tools/report.ts";
import { DEFAULT_RESOLVER_POLICY } from "../tools/resolvers.ts";
import { harnessProvider, hexToBigInt } from "../tools/rpc.ts";
import { SAMPLE_HASH, SAMPLE_RESOLVERS } from "./sample.ts";

let upstream: Anvil;
let plan: DeploymentPlan;
let blockBefore: bigint;
const deployer = Wallet.createRandom().address;
const newOwner = Wallet.createRandom().address;

function request(overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    variants: ["immutable", "reference"],
    workerHash: SAMPLE_HASH,
    resolvers: SAMPLE_RESOLVERS,
    upstreamUrl: upstream.url,
    deployer,
    newOwner,
    resolverPolicy: DEFAULT_RESOLVER_POLICY,
    settings: { ...DEFAULT_PLAN_SETTINGS, anvilStartTimeoutMs: 30_000, rpcTimeoutMs: 15_000 },
    ...overrides,
  };
}

function cast(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("cast", args, { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`cast exited ${code}: ${err}`))));
  });
}

beforeAll(async () => {
  upstream = await startAnvil({ startTimeoutMs: 30_000, rpcTimeoutMs: 15_000 });
  blockBefore = hexToBigInt(await upstream.rpc.request("eth_blockNumber"), "eth_blockNumber");
  plan = await planDeployment(request());
});

afterAll(async () => {
  await upstream?.stop();
});

describe("planDeployment (dry run)", () => {
  it("reads fees and the pinned block from the target chain", () => {
    expect(plan.fees.chainId).toBe(31337n);
    expect(plan.fees.blockNumber).toBe(blockBefore);
    expect(plan.fees.baseFeePerGas).toBeGreaterThan(0n);
    expect(plan.fees.maxFeePerGas).toBe(plan.fees.baseFeePerGas * 2n + plan.fees.priorityFeePerGas);
    expect(plan.deployer).toEqual({ address: deployer, nonce: 0n, balance: 0n });
  });

  it("measures both variants with consistent gas and cost arithmetic", () => {
    expect(plan.variants.map((v) => v.variant)).toEqual(["immutable", "reference"]);
    for (const v of plan.variants) {
      const tx = v.deploy;
      expect(tx.to).toBeNull();
      expect(tx.gasUsedOnFork).toBeGreaterThan(21_000n);
      expect(tx.estimateGas).toBeGreaterThanOrEqual(tx.gasUsedOnFork);
      expect(tx.gasLimit).toBe((tx.estimateGas * 120n) / 100n);
      expect(tx.costAtBaseFee).toBe(tx.gasUsedOnFork * plan.fees.baseFeePerGas);
      expect(tx.costExpected).toBe(tx.gasUsedOnFork * (plan.fees.baseFeePerGas + plan.fees.priorityFeePerGas));
      expect(tx.budget).toBe(tx.gasLimit * plan.fees.maxFeePerGas);
    }
  });

  it("deploys each variant from the deployer's current nonce, so the fork address is the real one", () => {
    const predicted = getCreateAddress({ from: deployer, nonce: 0 });
    for (const v of plan.variants) expect(v.forkAddress).toBe(predicted);
  });

  it("reads every fork deployment back through the harness", () => {
    const [immutable, reference] = plan.variants;
    expect(immutable?.inspection.contract).toBe("ImmutableWorkerSpecifier");
    expect(immutable?.inspection.stateChangingOpcodes).toEqual([]);
    expect(reference?.inspection.contract).toBe("reference WorkerSpecifier");
    expect(reference?.inspection.runtimeCodehash).toBe(MAINNET_REFERENCE_CODEHASH);
    for (const v of plan.variants) {
      expect(v.inspection.workerHash).toBe(SAMPLE_HASH);
      expect(v.inspection.resolvers).toEqual(SAMPLE_RESOLVERS);
    }
  });

  it("measures the reference contract's owner operations", () => {
    const reference = plan.variants[1];
    expect(reference?.followUps.map((f) => f.label)).toEqual([
      `transferOwnership to ${newOwner}`,
      "setWorker (next version: new hash, same resolver hosts)",
      "renounceOwnership (freeze this version)",
    ]);
    for (const f of reference?.followUps ?? []) expect(f.gasUsedOnFork).toBeGreaterThan(21_000n);
    expect(plan.variants[0]?.followUps).toEqual([]);
  });

  it("leaves the target chain untouched", async () => {
    expect(hexToBigInt(await upstream.rpc.request("eth_blockNumber"), "eth_blockNumber")).toBe(blockBefore);
    expect(await upstream.rpc.request("eth_getCode", [plan.variants[0]?.forkAddress, "latest"])).toBe("0x");
    expect(hexToBigInt(await upstream.rpc.request("eth_getTransactionCount", [deployer, "latest"]), "nonce")).toBe(0n);
  });

  it("produces a signer command that deploys a specifier the harness reads correctly", async () => {
    const accounts = await upstream.rpc.request("eth_accounts");
    const signer = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
    for (const v of plan.variants) {
      const code = creationCode(await loadArtifact(v.variant), plan.workerHash, plan.resolvers);
      const args = castCreateArgs(upstream.url, ["--unlocked", "--from", signer], v.deploy, code);
      const receipt: unknown = JSON.parse(await cast([...args.slice(0, 1), "--json", ...args.slice(1)]));
      const address =
        typeof receipt === "object" && receipt !== null
          ? (receipt as Record<string, unknown>)["contractAddress"]
          : null;
      expect(typeof address).toBe("string");
      const spec = await readSpecifier(harnessProvider(upstream.rpc), String(address));
      expect(spec).toEqual({ workerHash: SAMPLE_HASH, resolvers: SAMPLE_RESOLVERS });
    }
  });
});

describe("planDeployment input checks", () => {
  it("refuses an unpublishable resolver list before touching any chain", async () => {
    await expect(
      planDeployment(request({ resolvers: ["http://127.0.0.1:8080/worker.js", ...SAMPLE_RESOLVERS] })),
    ).rejects.toThrow(PlanError);
  });

  it("refuses a contract as the deployer", async () => {
    // Any contract on the target chain will do: deploy one there directly (local stand-in chain only).
    const accounts = await upstream.rpc.request("eth_accounts");
    const signer = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : "";
    const code = creationCode(await loadArtifact("immutable"), plan.workerHash, plan.resolvers);
    const receipt: unknown = JSON.parse(
      await cast(["send", "--json", "--rpc-url", upstream.url, "--unlocked", "--from", signer, "--create", code]),
    );
    const deployed =
      typeof receipt === "object" && receipt !== null ? (receipt as Record<string, unknown>)["contractAddress"] : null;
    if (typeof deployed !== "string") throw new Error("cast send returned no contract address");
    await expect(planDeployment(request({ deployer: deployed }))).rejects.toThrow(/is a contract/);
  });

  it("refuses a zero worker hash", async () => {
    await expect(planDeployment(request({ workerHash: `0x${"00".repeat(32)}` }))).rejects.toThrow(PayloadError);
  });
});
