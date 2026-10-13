// The setWorker update tool against a local chain: a reference WorkerSpecifier owned by a fresh key plays the
// stable address. The tests check that planning sends nothing, that the printed transaction is the one that
// updates the specifier, that every refusal happens before anything is signed, and that the explicit broadcast
// path updates the specifier and reads it back through the harness.

import { spawn } from "node:child_process";
import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnvil, type Anvil } from "../tools/anvil.ts";
import { loadArtifact, PROJECT_ROOT, type Variant } from "../tools/artifacts.ts";
import type { AvailabilityResult } from "../tools/availability.ts";
import { creationCode, renounceOwnershipCalldata, setWorkerCalldata } from "../tools/deployment.ts";
import { readSpecifier } from "../tools/harness.ts";
import { DEFAULT_PLAN_SETTINGS, retargetResolvers } from "../tools/plan.ts";
import { DEFAULT_RESOLVER_POLICY, orderResolvers } from "../tools/resolvers.ts";
import { harnessProvider, hexToBigInt, READ_ONLY_METHODS, readOnlyRpc, waitForReceipt, type RpcClient } from "../tools/rpc.ts";
import type { KnownArtifacts } from "../tools/specifier.ts";
import {
  broadcastSetWorker,
  castSetWorkerArgs,
  planSetWorker,
  renderUpdatePlan,
  UpdateError,
  type BroadcastOptions,
  type UpdateRequest,
} from "../tools/update.ts";
import { SAMPLE_HASH, SAMPLE_RESOLVERS } from "./sample.ts";

const owner = Wallet.createRandom();
const stranger = Wallet.createRandom();
const NEXT_HASH = keccak256(toUtf8Bytes("the next worker bundle")).toLowerCase();
const NEXT_RESOLVERS = orderResolvers(retargetResolvers(SAMPLE_RESOLVERS, SAMPLE_HASH, NEXT_HASH));
const FUNDS = `0x${(10n ** 20n).toString(16)}`;

let anvil: Anvil;
let artifacts: KnownArtifacts;
let specifier: string;
let immutable: string;
/** Methods the planner sent through the read-only client, in order. */
let methods: string[];
let rpc: RpcClient;

async function sendAs(from: string, tx: Record<string, string>): Promise<Record<string, unknown>> {
  await anvil.rpc.request("anvil_impersonateAccount", [from]);
  await anvil.rpc.request("anvil_setBalance", [from, FUNDS]);
  const hash = await anvil.rpc.request("eth_sendTransaction", [{ from, ...tx }]);
  if (typeof hash !== "string") throw new Error(`eth_sendTransaction returned ${JSON.stringify(hash)}`);
  return waitForReceipt(anvil.rpc, hash, 15_000);
}

async function deploy(variant: Variant, from: string): Promise<string> {
  const receipt = await sendAs(from, { data: creationCode(artifacts[variant], SAMPLE_HASH, SAMPLE_RESOLVERS) });
  const address = receipt["contractAddress"];
  if (receipt["status"] !== "0x1" || typeof address !== "string") throw new Error("deployment failed");
  return address;
}

function request(overrides: Partial<UpdateRequest> = {}): UpdateRequest {
  return {
    rpc,
    specifier,
    workerHash: NEXT_HASH,
    resolvers: NEXT_RESOLVERS,
    resolverPolicy: DEFAULT_RESOLVER_POLICY,
    settings: { ...DEFAULT_PLAN_SETTINGS, rpcTimeoutMs: 15_000 },
    ...overrides,
  };
}

function broadcastOptions(overrides: Partial<BroadcastOptions> = {}): BroadcastOptions {
  return {
    rpcUrl: anvil.url,
    privateKey: owner.privateKey,
    availability: null,
    confirmations: 1,
    timeoutMs: 30_000,
    ...overrides,
  };
}

const read = () => readSpecifier(harnessProvider(anvil.rpc), specifier);
const blockNumber = async () => hexToBigInt(await anvil.rpc.request("eth_blockNumber"), "eth_blockNumber");

/** Runs `fn` and puts the chain back as it was. */
async function onSnapshot<T>(fn: () => Promise<T>): Promise<T> {
  const id = await anvil.rpc.request("evm_snapshot");
  try {
    return await fn();
  } finally {
    expect(await anvil.rpc.request("evm_revert", [id])).toBe(true);
  }
}

function run(command: string, args: readonly string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PROJECT_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out, err }));
  });
}

const script = (args: readonly string[]) =>
  run(`${PROJECT_ROOT}/node_modules/.bin/vite-node`, ["scripts/set-worker.ts", "--", ...args]);

beforeAll(async () => {
  artifacts = { reference: await loadArtifact("reference"), immutable: await loadArtifact("immutable") };
  anvil = await startAnvil({ startTimeoutMs: 30_000, rpcTimeoutMs: 15_000 });
  specifier = await deploy("reference", owner.address);
  immutable = await deploy("immutable", owner.address);
  const inner = readOnlyRpc(anvil.url, { timeoutMs: 15_000 });
  methods = [];
  rpc = {
    url: inner.url,
    request(method, params) {
      methods.push(method);
      return inner.request(method, params);
    },
  };
});

afterAll(async () => {
  await anvil?.stop();
});

describe("planSetWorker (dry run)", () => {
  it("prints the owner's setWorker transaction and leaves the chain untouched", async () => {
    const before = await blockNumber();
    methods.length = 0;
    const plan = await planSetWorker(request(), artifacts);

    expect(plan.chainId).toBe(31337n);
    expect(plan.owner).toEqual({ kind: "eoa", address: owner.address, delegatedTo: null });
    expect(plan.current).toEqual({ workerHash: SAMPLE_HASH, resolvers: [...SAMPLE_RESOLVERS] });
    expect(plan.next).toEqual({ workerHash: NEXT_HASH, resolvers: NEXT_RESOLVERS });
    expect(plan.changes).toEqual({ workerHash: true, resolvers: true });
    expect(plan.tx.from).toBe(owner.address);
    expect(plan.tx.to.toLowerCase()).toBe(specifier.toLowerCase());
    expect(plan.tx.data).toBe(setWorkerCalldata(NEXT_HASH, NEXT_RESOLVERS));
    expect(plan.tx.estimateGas).toBeGreaterThan(21_000n);
    expect(plan.tx.gasLimit).toBe((plan.tx.estimateGas * 120n) / 100n);
    expect(plan.tx.budget).toBe(plan.tx.gasLimit * plan.fees.maxFeePerGas);

    // The estimate and the simulation come from the target chain, and only read-only methods were used.
    expect(methods).toContain("eth_call");
    expect(methods).toContain("eth_estimateGas");
    expect(methods.filter((m) => !READ_ONLY_METHODS.has(m))).toEqual([]);
    expect(await blockNumber()).toBe(before);
    expect(await read()).toEqual({ workerHash: SAMPLE_HASH, resolvers: [...SAMPLE_RESOLVERS] });

    const text = renderUpdatePlan(plan, null);
    expect(text).toContain(`data  ${plan.tx.data}`);
    expect(text).toContain(`workerHash next ${NEXT_HASH}`);
  });

  it("plans a resolver-only change for the same worker", async () => {
    const resolvers = orderResolvers(SAMPLE_RESOLVERS);
    const plan = await planSetWorker(request({ workerHash: SAMPLE_HASH, resolvers }), artifacts);
    expect(plan.changes).toEqual({ workerHash: false, resolvers: true });
  });

  it("hands over a cast command that performs exactly the planned update", async () => {
    const plan = await planSetWorker(request(), artifacts);
    await onSnapshot(async () => {
      const sent = await run("cast", castSetWorkerArgs(anvil.url, ["--unlocked", "--json"], plan));
      expect(sent.err).toBe("");
      expect(sent.code).toBe(0);
      expect(await read()).toEqual({ workerHash: NEXT_HASH, resolvers: NEXT_RESOLVERS });
    });
    expect((await read()).workerHash).toBe(SAMPLE_HASH);
  });

  it("refuses an update that would change nothing", async () => {
    await expect(
      planSetWorker(request({ workerHash: SAMPLE_HASH, resolvers: SAMPLE_RESOLVERS, resolverPolicy: DEFAULT_RESOLVER_POLICY }), artifacts),
    ).rejects.toThrow(/nothing to update/);
  });

  it("refuses a sender that is not the owner", async () => {
    await expect(planSetWorker(request({ from: stranger.address }), artifacts)).rejects.toThrow(/is not the owner/);
    await expect(planSetWorker(request({ from: owner.address }), artifacts)).resolves.toBeDefined();
  });

  it("refuses an immutable specifier and a frozen one", async () => {
    await expect(planSetWorker(request({ specifier: immutable }), artifacts)).rejects.toThrow(
      /ImmutableWorkerSpecifier/,
    );
    await onSnapshot(async () => {
      const receipt = await sendAs(owner.address, { to: specifier, data: renounceOwnershipCalldata() });
      expect(receipt["status"]).toBe("0x1");
      await expect(planSetWorker(request(), artifacts)).rejects.toThrow(/frozen/);
    });
  });

  it("refuses resolvers that name another bundle, and a chain other than the expected one", async () => {
    // SAMPLE_RESOLVERS carry content-addressed paths of SAMPLE_HASH, not of NEXT_HASH.
    await expect(planSetWorker(request({ resolvers: SAMPLE_RESOLVERS }), artifacts)).rejects.toThrow(UpdateError);
    await expect(planSetWorker(request({ expectedChainId: 1n }), artifacts)).rejects.toThrow(/expected chain 1/);
    await expect(planSetWorker(request({ expectedChainId: 31337n }), artifacts)).resolves.toBeDefined();
  });
});

describe("broadcastSetWorker (explicit --broadcast)", () => {
  it("refuses, before sending, a key that is not the owner's", async () => {
    const plan = await planSetWorker(request(), artifacts);
    const before = await blockNumber();
    await expect(broadcastSetWorker(plan, broadcastOptions({ privateKey: stranger.privateKey }))).rejects.toThrow(
      /not the owner/,
    );
    expect(await blockNumber()).toBe(before);
    expect((await read()).workerHash).toBe(SAMPLE_HASH);
  });

  it("refuses when an https: resolver does not serve the new bytes", async () => {
    const plan = await planSetWorker(request(), artifacts);
    const availability: AvailabilityResult[] = NEXT_RESOLVERS.map((entry, i) => ({
      entry,
      status: entry.startsWith("kps:") ? "not-checked" : i === 0 ? "unreachable" : "match",
      detail: "",
    }));
    const before = await blockNumber();
    await expect(broadcastSetWorker(plan, broadcastOptions({ availability }))).rejects.toThrow(
      /does not serve the new bundle bytes/,
    );
    expect(await blockNumber()).toBe(before);
  });

  it("refuses a plan made before the specifier changed, and a plan for another chain", async () => {
    const plan = await planSetWorker(request(), artifacts);
    await onSnapshot(async () => {
      const other = keccak256(toUtf8Bytes("an update made elsewhere"));
      const receipt = await sendAs(owner.address, { to: specifier, data: setWorkerCalldata(other, ["https://example.org/w.js"]) });
      expect(receipt["status"]).toBe("0x1");
      await expect(broadcastSetWorker(plan, broadcastOptions())).rejects.toThrow(/changed since the plan/);
      expect((await read()).workerHash).toBe(other);
    });
    await expect(broadcastSetWorker({ ...plan, chainId: 1n }, broadcastOptions())).rejects.toThrow(
      /the plan is for chain 1/,
    );
    expect((await read()).workerHash).toBe(SAMPLE_HASH);
  });

  it("signs as the owner, updates the specifier and reads it back through the harness", async () => {
    const plan = await planSetWorker(request(), artifacts);
    await onSnapshot(async () => {
      // The owner pays from its own balance here: no impersonation is involved in the broadcast path.
      await anvil.rpc.request("anvil_stopImpersonatingAccount", [owner.address]);
      const result = await broadcastSetWorker(plan, broadcastOptions());
      expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(result.gasUsed).toBeLessThanOrEqual(plan.tx.gasLimit);
      expect(result.gasUsed).toBeLessThanOrEqual(plan.tx.estimateGas);
      expect(await read()).toEqual({ workerHash: NEXT_HASH, resolvers: NEXT_RESOLVERS });
      // A second run of the same plan finds the specifier changed and sends nothing.
      await expect(broadcastSetWorker(plan, broadcastOptions())).rejects.toThrow(/changed since the plan/);
    });
  });
});

describe("scripts/set-worker.ts", () => {
  const base = () => [
    "--specifier",
    specifier,
    "--rpc-url",
    anvil.url,
    "--hash",
    NEXT_HASH,
    ...NEXT_RESOLVERS.flatMap((r) => ["--resolver", r]),
    "--skip-resolver-fetch",
  ];

  it("is a dry run by default: prints the transaction and sends nothing", async () => {
    const before = await blockNumber();
    const { code, out, err } = await script(base());
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("DRY RUN: nothing was signed or sent.");
    expect(out).toContain(`data  ${setWorkerCalldata(NEXT_HASH, NEXT_RESOLVERS)}`);
    expect(out).toContain(`--from ${owner.address}`);
    expect(await blockNumber()).toBe(before);
    expect((await read()).workerHash).toBe(SAMPLE_HASH);
  });

  it("does not broadcast without --chain-id and --key-file", async () => {
    const before = await blockNumber();
    const noChain = await script([...base(), "--broadcast"]);
    expect(noChain.code).toBe(1);
    expect(noChain.err).toContain("--broadcast needs --chain-id");
    const noKey = await script([...base(), "--broadcast", "--chain-id", "31337"]);
    expect(noKey.code).toBe(1);
    expect(noKey.err).toContain("--broadcast needs --key-file");
    expect(await blockNumber()).toBe(before);
    expect((await read()).workerHash).toBe(SAMPLE_HASH);
  });
});
