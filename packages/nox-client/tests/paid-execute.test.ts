import {
  AbiCoder,
  Interface,
  Wallet,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  solidityPackedKeccak256,
  toBeHex,
  zeroPadValue,
} from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeServiceRequest,
  encodePaidQuoteOutcomeV2,
  encodePaidTransactionOutcomeV2,
} from "../src/bincode.js";
import type {
  ExecutionQuoteV1,
  PaidQuoteRequestV2,
  PaidTransactionOutcomeV2,
  PaidTransactionRejectionCodeV2,
  RelayerPayload,
} from "../src/bincode.js";
import { AdaptiveSurbBudget, NoxClient } from "../src/client.js";
import { hashExecutionQuoteV1, quoteTypedData } from "../src/paid.js";
import type { IssuedPaidQuoteV2, PaidQuoteResultV2 } from "../src/paid.js";
import {
  PAID_EXECUTE_DEFAULTS,
  arbitrumDataFeeGas,
  deriveClientIntentId,
  encodeEntryPointExecute,
  executePaid,
  paidExecuteCalldata,
  planPaidGas,
  rpcChainReader,
} from "../src/paid_execute.js";
import type {
  ExecutePaidOptions,
  PaidAction,
  PaidCallRequest,
  PaidChainReader,
  PaidExecutionClient,
  PaidPaymentSource,
  PaidSettlement,
} from "../src/paid_execute.js";
import { NoxClientError, NoxClientErrorCode } from "../src/types.js";
import type { TopologyNode } from "../src/types.js";

const CHAIN_ID = 421_614n;
const ENTRY_POINT = `0x${"11".repeat(20)}`;
const ADAPTER = `0x${"44".repeat(20)}`;
const FEE_ASSET = `0x${"66".repeat(20)}`;
const TARGET = `0x${"77".repeat(20)}`;
const SANDBOX = `0x${"5a".repeat(20)}`;
const PAYMENT_ID = new Uint8Array(32).fill(0x55);
const SALT = new Uint8Array(32).fill(0xa1);
const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
const ACTION_DATA = Uint8Array.from([1, 2, 3, 0]);
const T0 = 1_800_000_000n;
const QUOTE_TTL = 30n;
const EXIT_FEE = 400n;
const NETWORK_FEE = 40n;

const ABI = new Interface([
  "function execute((uint8 quoteVersion, uint256 chainId, address entryPoint, address exitAddress, bytes32 clientIntentId, address paymentAdapter, bytes32 paymentId, address feeAsset, uint256 exitFee, uint256 networkFee, uint256 paymentGasLimit, address actionTarget, bytes32 actionCalldataHash, uint256 actionGasLimit, bytes32 trackedAssetsHash, uint256 maximumTransactionGas, uint256 maximumFeePerGas, uint256 returnDataLimit, uint64 validAfterUnix, uint64 validUntilUnix, uint256 quoteNonce) quote, bytes exitSignature, bytes actionData, address[] trackedAssets, bytes paymentData) returns ((bool success, uint256 returnDataLength, bytes32 returnPrefixHash) outcome)",
  "function isExecutionConsumed(bytes32) view returns (bool)",
  "function isPaymentConsumed(bytes32) view returns (bool)",
  "function isClientIntentConsumed(bytes32) view returns (bool)",
  "function predictSandbox(bytes32) view returns (address)",
  "event PaidExecutionSettled(bytes32 indexed executionId, bytes32 indexed paymentId, address indexed exit, address feeAsset, uint256 exitFee, uint256 networkFee, address actionTarget, bool actionSuccess, uint256 returnDataLength, bytes32 returnPrefixHash)",
]);

const EXIT_KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412ef50c3c0fba7c8",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
];

function word(value: bigint): Uint8Array {
  return getBytes(toBeHex(value, 32));
}

let nowMs = Number(T0) * 1000;

/** In-memory EntryPoint state behind the `PaidChainReader` interface. */
class FakeChain implements PaidChainReader {
  block = 1_000n;
  timestamp = T0;
  /** Seconds the chain and the local clock advance per `blockNumber` read. */
  secondsPerRead = 0n;
  estimate = 3_100_000n;
  simulatedSuccess = true;
  simulationError: Error | undefined;
  /** L1 data fee, in gas, that the Arbitrum NodeInterface reports. */
  l1Gas = 0n;
  readonly executions = new Set<string>();
  readonly payments = new Set<string>();
  readonly intents = new Set<string>();
  readonly logs: PaidSettlement[] = [];
  readonly inputs = new Map<string, string>();
  readonly calls: PaidCallRequest[] = [];
  readonly estimates: { from: string; to: string; data: string }[] = [];
  readonly logQueries: [bigint, bigint][] = [];

  async blockNumber(): Promise<bigint> {
    this.block += 1n;
    this.timestamp += this.secondsPerRead;
    nowMs += Number(this.secondsPerRead) * 1000;
    return this.block;
  }

  async call(tx: PaidCallRequest, _block: bigint | "latest"): Promise<string> {
    this.calls.push(tx);
    if (tx.to === NODE_INTERFACE) {
      return AbiCoder.defaultAbiCoder().encode(["uint64", "uint256", "uint256"], [this.l1Gas, 1n, 1n]);
    }
    const parsed = ABI.parseTransaction({ data: tx.data });
    if (parsed === null) throw new Error("unexpected call");
    const flags: Record<string, Set<string>> = {
      isExecutionConsumed: this.executions,
      isPaymentConsumed: this.payments,
      isClientIntentConsumed: this.intents,
    };
    const flag = flags[parsed.name];
    if (flag !== undefined) {
      return ABI.encodeFunctionResult(parsed.name, [flag.has(parsed.args[0] as string)]);
    }
    if (parsed.name === "predictSandbox") {
      return ABI.encodeFunctionResult("predictSandbox", [SANDBOX]);
    }
    if (this.simulationError !== undefined) throw this.simulationError;
    return ABI.encodeFunctionResult("execute", [[this.simulatedSuccess, 0n, `0x${"00".repeat(32)}`]]);
  }

  async estimateGas(tx: { from: string; to: string; data: string }): Promise<bigint> {
    this.estimates.push(tx);
    return this.estimate;
  }

  async blockTimestamp(_block: bigint | "latest"): Promise<bigint> {
    return this.timestamp;
  }

  async settlementLog(
    _entryPoint: string,
    executionId: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<PaidSettlement | null> {
    this.logQueries.push([fromBlock, toBlock]);
    return this.find((log) => log.executionId === executionId, fromBlock, toBlock);
  }

  async settlementLogByPayment(
    _entryPoint: string,
    paymentId: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<PaidSettlement | null> {
    this.logQueries.push([fromBlock, toBlock]);
    return this.find((log) => log.paymentId === paymentId, fromBlock, toBlock);
  }

  async transactionInput(transactionHash: string): Promise<string | null> {
    return this.inputs.get(transactionHash) ?? null;
  }

  /** Apply `execute` calldata as the EntryPoint would and emit its settlement log. */
  settle(calldata: Uint8Array, actionSuccess: boolean, transactionHash: string): void {
    const [quote] = ABI.decodeFunctionData("execute", calldata);
    const executionId = hashExecutionQuoteV1(quoteFromResult(quote));
    this.executions.add(executionId);
    this.payments.add(quote.paymentId as string);
    this.intents.add(quote.clientIntentId as string);
    this.block += 1n;
    this.logs.push({
      executionId,
      paymentId: quote.paymentId as string,
      exit: quote.exitAddress as string,
      feeAsset: quote.feeAsset as string,
      exitFee: quote.exitFee as bigint,
      networkFee: quote.networkFee as bigint,
      actionTarget: quote.actionTarget as string,
      actionSuccess,
      returnDataLength: actionSuccess ? 0n : 4n,
      returnPrefixHash: `0x${(actionSuccess ? "00" : "ee").repeat(32)}`,
      transactionHash,
      blockNumber: this.block,
    });
    this.inputs.set(transactionHash, hexlify(calldata));
  }

  private find(
    match: (log: PaidSettlement) => boolean,
    fromBlock: bigint,
    toBlock: bigint,
  ): PaidSettlement | null {
    return (
      this.logs.find(
        (log) => match(log) && log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
      ) ?? null
    );
  }
}

function quoteFromResult(quote: Record<string, unknown>): ExecutionQuoteV1 {
  const bytes = (key: string): Uint8Array => getBytes(quote[key] as string);
  const number = (key: string): Uint8Array => word(quote[key] as bigint);
  return {
    quoteVersion: Number(quote["quoteVersion"]),
    chainId: number("chainId"),
    entryPoint: bytes("entryPoint"),
    exitAddress: bytes("exitAddress"),
    clientIntentId: bytes("clientIntentId"),
    paymentAdapter: bytes("paymentAdapter"),
    paymentId: bytes("paymentId"),
    feeAsset: bytes("feeAsset"),
    exitFee: number("exitFee"),
    networkFee: number("networkFee"),
    paymentGasLimit: number("paymentGasLimit"),
    actionTarget: bytes("actionTarget"),
    actionCalldataHash: bytes("actionCalldataHash"),
    actionGasLimit: number("actionGasLimit"),
    trackedAssetsHash: bytes("trackedAssetsHash"),
    maximumTransactionGas: number("maximumTransactionGas"),
    maximumFeePerGas: number("maximumFeePerGas"),
    returnDataLimit: number("returnDataLimit"),
    validAfterUnix: quote["validAfterUnix"] as bigint,
    validUntilUnix: quote["validUntilUnix"] as bigint,
    quoteNonce: number("quoteNonce"),
  };
}

type QuoteBehaviour =
  | { kind: "issue"; exitFee?: bigint; issuedBy?: number; startsInSecs?: bigint }
  | { kind: "reject"; code: PaidTransactionRejectionCodeV2 }
  | { kind: "throw"; code: NoxClientErrorCode };

type SubmitBehaviour =
  | { kind: "settle"; actionSuccess?: boolean; replacedBy?: string }
  | { kind: "timeout"; settle: boolean }
  | { kind: "reject"; code: PaidTransactionRejectionCodeV2; settle?: boolean }
  | { kind: "throw"; code: NoxClientErrorCode };

interface FakeExit {
  quote?: QuoteBehaviour;
  submit?: SubmitBehaviour;
}

class FakeClient implements PaidExecutionClient {
  readonly wallets = EXIT_KEYS.map((key) => new Wallet(key));
  readonly exclusions: string[][] = [];
  readonly requests: { request: PaidQuoteRequestV2; exit: string }[] = [];
  readonly submissions: { issued: IssuedPaidQuoteV2; calldata: Uint8Array }[] = [];
  private nonce = 0n;

  constructor(
    private readonly chain: FakeChain,
    private readonly exits: readonly FakeExit[],
  ) {}

  node(index: number): TopologyNode {
    return {
      id: this.wallets[index]!.address.toLowerCase(),
      address: "",
      routingAddress: `/exit/${index}`,
      publicKey: new Uint8Array(32),
      layer: 2,
      role: 2,
    };
  }

  selectPaidExit(options?: { readonly exclude?: readonly string[] }): TopologyNode {
    const exclude = options?.exclude ?? [];
    this.exclusions.push([...exclude]);
    const index = this.exits.findIndex((_, at) => !exclude.includes(this.node(at).id));
    if (index < 0) {
      throw new NoxClientError("no paid exit left", NoxClientErrorCode.PaidExitUnavailable);
    }
    return this.node(index);
  }

  async requestPaidQuote(
    request: PaidQuoteRequestV2,
    selectedExit: TopologyNode,
  ): Promise<PaidQuoteResultV2> {
    this.requests.push({ request, exit: selectedExit.id });
    const index = this.wallets.findIndex((wallet) => wallet.address.toLowerCase() === selectedExit.id);
    const behaviour = this.exits[index]?.quote ?? { kind: "issue" };
    if (behaviour.kind === "throw") throw new NoxClientError("quote failed", behaviour.code);
    if (behaviour.kind === "reject") {
      return { status: "rejected", code: behaviour.code, retryable: true, detail: "exit refused" };
    }
    const issuer = behaviour.issuedBy ?? index;
    const wallet = this.wallets[issuer]!;
    const validUntil = this.chain.timestamp + QUOTE_TTL;
    this.nonce += 1n;
    const quote: ExecutionQuoteV1 = {
      quoteVersion: 1,
      chainId: word(request.chainId),
      entryPoint: request.entryPoint,
      exitAddress: getBytes(wallet.address),
      clientIntentId: request.clientIntentId,
      paymentAdapter: request.paymentAdapter,
      paymentId: request.paymentId,
      feeAsset: request.feeAsset,
      exitFee: word(behaviour.exitFee ?? EXIT_FEE),
      networkFee: word(NETWORK_FEE),
      paymentGasLimit: word(request.paymentGasLimit),
      actionTarget: request.actionTarget,
      actionCalldataHash: request.actionCalldataHash,
      actionGasLimit: word(request.actionGasLimit),
      trackedAssetsHash: request.trackedAssetsHash,
      maximumTransactionGas: word(request.maximumTransactionGas),
      maximumFeePerGas: word(100_000_000n),
      returnDataLimit: word(BigInt(request.returnDataLimit)),
      validAfterUnix: this.chain.timestamp + (behaviour.startsInSecs ?? 0n),
      validUntilUnix: validUntil < request.validUntilUnix ? validUntil : request.validUntilUnix,
      quoteNonce: word(this.nonce),
    };
    const typed = quoteTypedData(quote);
    return {
      status: "issued",
      quote,
      executionId: getBytes(hashExecutionQuoteV1(quote)),
      exitSignature: getBytes(await wallet.signTypedData(typed.domain, typed.types, typed.value)),
      selectedExit: this.node(issuer),
    };
  }

  async submitPaidTransaction(
    issued: IssuedPaidQuoteV2,
    calldata: Uint8Array,
  ): Promise<PaidTransactionOutcomeV2> {
    this.submissions.push({ issued, calldata });
    const index = this.wallets.findIndex(
      (wallet) => wallet.address.toLowerCase() === issued.selectedExit.id,
    );
    const behaviour = this.exits[index]?.submit ?? { kind: "settle" };
    const hash = keccak256(calldata);
    if (behaviour.kind === "throw") throw new NoxClientError("refused locally", behaviour.code);
    if (behaviour.kind === "reject") {
      if (behaviour.settle === true) this.chain.settle(calldata, true, hash);
      return {
        status: "rejected",
        executionId: issued.executionId,
        code: behaviour.code,
        retryable: true,
        detail: "exit refused the submission",
      };
    }
    if (behaviour.kind === "timeout") {
      if (behaviour.settle) this.chain.settle(calldata, true, hash);
      throw new NoxClientError("no reply", NoxClientErrorCode.ResponseTimeout);
    }
    this.chain.settle(calldata, behaviour.actionSuccess ?? true, behaviour.replacedBy ?? hash);
    return { status: "submitted", executionId: issued.executionId, transactionHash: getBytes(hash) };
  }

  async rpcCall(): Promise<unknown> {
    throw new Error("the fake reader is injected; no mixnet read is expected");
  }
}

interface PaymentProbe {
  readonly source: PaidPaymentSource;
  readonly built: { executionId: string; amount: bigint; feeAsset: string }[];
}

function paymentSource(overrides: Partial<PaidPaymentSource> = {}): PaymentProbe {
  const built: PaymentProbe["built"] = [];
  return {
    built,
    source: {
      adapter: ADAPTER,
      feeAsset: FEE_ASSET,
      paymentId: PAYMENT_ID,
      gasLimit: 1_400_000n,
      paymentDataLength: 64,
      buildPaymentData: async (args) => {
        built.push({ executionId: hexlify(args.executionId), amount: args.amount, feeAsset: args.feeAsset });
        return new Uint8Array(64).fill(0xcd);
      },
      ...overrides,
    },
  };
}

const ACTION: PaidAction = { target: TARGET, data: ACTION_DATA, gasLimit: 1_600_000n };

function setup(exits: readonly FakeExit[] = [{}], payment = paymentSource()) {
  const chain = new FakeChain();
  const client = new FakeClient(chain, exits);
  const options: ExecutePaidOptions = {
    chainId: CHAIN_ID,
    entryPoint: ENTRY_POINT,
    action: ACTION,
    payment: payment.source,
    maxTotalFee: 1_000n,
    intentSalt: SALT,
    chain,
    preflight: chain,
    pollIntervalMs: 0,
  };
  return { chain, client, options, payment };
}

beforeEach(() => {
  nowMs = Number(T0) * 1000;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("paid gas plan", () => {
  it("covers the EntryPoint requirement, the envelope and the exit buffer", () => {
    const plan = planPaidGas({
      paymentGasLimit: 1_400_000n,
      actionGasLimit: 1_600_000n,
      calldataGas: 480_000n,
      dataFeeGas: 120_000n,
    });
    expect(plan).toEqual({
      boundedGas: 3_250_000n,
      // 21,000 + 480,000 + 120,000 * 1.5
      envelopeGas: 681_000n,
      // ceil(3,931,000 * 1.2 * 1.05)
      maximumTransactionGas: 4_953_060n,
    });
    expect(plan.maximumTransactionGas).toBeLessThan(12_000_000n);
  });

  it("puts the data fee headroom on the data fee alone", () => {
    const input = { paymentGasLimit: 1_000_000n, actionGasLimit: 1_000_000n, calldataGas: 100_000n };
    const noFee = planPaidGas(input);
    expect(planPaidGas({ ...input, dataFeeGas: 0n, dataFeeHeadroomBps: 9_000 })).toEqual(noFee);
    expect(planPaidGas({ ...input, dataFeeGas: 200_000n }).envelopeGas).toBe(noFee.envelopeGas + 300_000n);
    expect(planPaidGas({ ...input, dataFeeGas: 200_000n, dataFeeHeadroomBps: 0 }).envelopeGas).toBe(
      noFee.envelopeGas + 200_000n,
    );
    expect(() => planPaidGas({ ...input, dataFeeHeadroomBps: -1 })).toThrow("dataFeeHeadroomBps");
  });

  it("keeps the exit's live estimate of 2026-10-13 under the default cap", () => {
    // Arbitrum Sepolia dry run on exit nox-7: limits 1,955,800 + 1,914,000, data fee 0,
    // cap 5,593,014, exit eth_estimateGas 4,456,946.
    const live = { paymentGasLimit: 1_955_800n, actionGasLimit: 1_914_000n, calldataGas: 298_100n };
    const cap = planPaidGas(live).maximumTransactionGas;
    expect(cap).toBe(5_593_014n);
    const exitLimit = (4_456_946n * 12_000n + 9_999n) / 10_000n;
    expect(exitLimit).toBe(5_348_336n);
    // At least 3% of the cap stays unused.
    expect((cap - exitLimit) * 10_000n).toBeGreaterThan(cap * 300n);
  });

  it("rounds up and honours explicit buffers", () => {
    expect(
      planPaidGas({
        paymentGasLimit: 1n,
        actionGasLimit: 1n,
        calldataGas: 0n,
        exitGasBufferBps: 1,
        capHeadroomBps: 0,
      }).maximumTransactionGas,
    ).toBe(271_030n); // ceil(271,002 * 1.0001) = ceil(271,029.1002)
  });

  it("clamps to the caller's ceiling and refuses one below the EntryPoint requirement", () => {
    const input = { paymentGasLimit: 1_000_000n, actionGasLimit: 1_000_000n, calldataGas: 100_000n };
    expect(planPaidGas({ ...input, maximumTransactionGas: 2_400_000n }).maximumTransactionGas).toBe(2_400_000n);
    expect(planPaidGas({ ...input, maximumTransactionGas: 20_000_000n }).maximumTransactionGas).toBe(2_987_460n);
    expect(() => planPaidGas({ ...input, maximumTransactionGas: 2_249_999n })).toThrow(
      "below paymentGasLimit + actionGasLimit + 250000",
    );
  });

  it("prices execute calldata from its ABI layout", () => {
    // 4 selector + 25 head words + signature (32 + 96) + action (32 + 32) + one asset (32 + 32) + payment (32 + 64)
    expect(paidExecuteCalldata(ACTION_DATA, 1, 40)).toEqual({
      bytes: 1_156,
      gas: 1_155n * 16n + 4n,
    });
  });
});

describe("paid execution encoding", () => {
  it("derives the intent id from the action and the caller's salt", () => {
    const id = deriveClientIntentId(CHAIN_ID, ENTRY_POINT, TARGET, ACTION_DATA, SALT);
    expect(hexlify(id)).toBe("0x2067ccebbf4e0331a22e8350021c78fe5748406be342229c64e73cad9a5d254a");
    expect(hexlify(id)).toBe(
      solidityPackedKeccak256(
        ["string", "uint256", "address", "address", "bytes32", "bytes32"],
        ["nox.client-intent.v1", CHAIN_ID, ENTRY_POINT, TARGET, keccak256(ACTION_DATA), SALT],
      ),
    );
    const other = (data: Uint8Array, salt: Uint8Array) =>
      hexlify(deriveClientIntentId(CHAIN_ID, ENTRY_POINT, TARGET, data, salt));
    expect(other(Uint8Array.from([1, 2, 3]), SALT)).not.toBe(hexlify(id));
    expect(other(ACTION_DATA, new Uint8Array(32).fill(0xa2))).not.toBe(hexlify(id));
    expect(() => other(ACTION_DATA, new Uint8Array(31))).toThrow("intentSalt must be 32 bytes");
  });

  it("matches the NoxEntryPoint.execute encoding of the compiled contract ABI", () => {
    const fill = (value: number, length: number) => new Uint8Array(length).fill(value);
    const quote: ExecutionQuoteV1 = {
      quoteVersion: 1,
      chainId: word(421_614n),
      entryPoint: fill(0x11, 20),
      exitAddress: fill(0x22, 20),
      clientIntentId: fill(0x33, 32),
      paymentAdapter: fill(0x44, 20),
      paymentId: fill(0x55, 32),
      feeAsset: fill(0x66, 20),
      exitFee: word(77n),
      networkFee: word(8n),
      paymentGasLimit: word(500_000n),
      actionTarget: fill(0x77, 20),
      actionCalldataHash: fill(0x88, 32),
      actionGasLimit: word(700_000n),
      trackedAssetsHash: fill(0x99, 32),
      maximumTransactionGas: word(1_450_000n),
      maximumFeePerGas: word(123n),
      returnDataLimit: word(256n),
      validAfterUnix: 1_799_999_900n,
      validUntilUnix: 1_800_000_000n,
      quoteNonce: word(1n),
    };
    const issued = {
      status: "issued",
      quote,
      executionId: getBytes(hashExecutionQuoteV1(quote)),
      exitSignature: fill(0xab, 65),
      selectedExit: new FakeClient(new FakeChain(), [{}]).node(0),
    } satisfies IssuedPaidQuoteV2;
    const calldata = encodeEntryPointExecute(issued, ACTION_DATA, [FEE_ASSET], fill(0xcd, 40));

    expect(hexlify(calldata.slice(0, 4))).toBe("0x8f42c610");
    expect(calldata.length).toBe(paidExecuteCalldata(ACTION_DATA, 1, 40).bytes);
    expect(keccak256(calldata)).toBe(
      "0xdcf37e95d8dfab46a9f772990fa954eef70b6ce2986e0fcab99b73c6c859acbd",
    );
  });
});

describe("executePaid", () => {
  it("quotes with a tight cap, pays the quoted amount and reports the settlement log", async () => {
    const { chain, client, options, payment } = setup();
    const result = await executePaid(client, options);

    const { request } = client.requests[0]!;
    const intentId = hexlify(deriveClientIntentId(CHAIN_ID, ENTRY_POINT, TARGET, ACTION_DATA, SALT));
    expect(hexlify(request.clientIntentId)).toBe(intentId);
    expect(request.paymentGasLimit).toBe(1_400_000n);
    expect(request.actionGasLimit).toBe(1_600_000n);
    expect(request.maximumTransactionGas).toBe(
      planPaidGas({
        paymentGasLimit: 1_400_000n,
        actionGasLimit: 1_600_000n,
        calldataGas: paidExecuteCalldata(ACTION_DATA, 0, 64).gas,
      }).maximumTransactionGas,
    );
    expect(request.maximumTransactionGas).toBeLessThan(5_000_000n);
    expect(hexlify(request.trackedAssetsHash)).toBe(
      keccak256(AbiCoder.defaultAbiCoder().encode(["address[]"], [[]])),
    );
    expect(request.returnDataLimit).toBe(PAID_EXECUTE_DEFAULTS.returnDataLimit);

    const submission = client.submissions[0]!;
    const executionId = hexlify(submission.issued.executionId);
    expect(payment.built).toEqual([
      { executionId, amount: EXIT_FEE + NETWORK_FEE, feeAsset: FEE_ASSET },
    ]);
    const [, , actionData, trackedAssets, paymentData] = ABI.decodeFunctionData("execute", submission.calldata);
    expect(actionData).toBe(hexlify(ACTION_DATA));
    expect(trackedAssets).toEqual([]);
    expect(paymentData).toBe(hexlify(new Uint8Array(64).fill(0xcd)));

    // The preflight ran the exact submitted calldata as the exit, under the quoted cap and gas price.
    const simulated = chain.calls.find((call) => call.data === hexlify(submission.calldata))!;
    expect(simulated.from!.toLowerCase()).toBe(client.node(0).id);
    expect(simulated.gas).toBe(request.maximumTransactionGas);
    expect(simulated.gasPrice).toBe(100_000_000n);
    expect(chain.estimates).toHaveLength(1);

    expect(result).toMatchObject({
      status: "settled",
      executionId,
      exit: client.wallets[0]!.address,
      exitFee: EXIT_FEE,
      networkFee: NETWORK_FEE,
      transactionHash: keccak256(submission.calldata),
      maximumTransactionGas: request.maximumTransactionGas,
    });
  });

  it("refuses an action the payment source vetoes before any quote", async () => {
    const payment = paymentSource({
      checkAction: () => {
        throw new Error("the action spends the fee note");
      },
    });
    const { chain, client, options } = setup([{}], payment);
    await expect(executePaid(client, options)).resolves.toEqual({
      status: "not-paid",
      stage: "precheck",
      code: "ACTION_REFUSED",
      detail: "the action spends the fee note",
    });
    expect(client.requests).toHaveLength(0);
    expect(chain.calls).toHaveLength(0);
  });

  it("stops at a fee above maxTotalFee without proving or contacting a second exit", async () => {
    const { client, options, payment } = setup([{ quote: { kind: "issue", exitFee: 961n } }, {}]);
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "not-paid", stage: "fee-cap", code: "FEE_ABOVE_MAXIMUM" });
    expect(client.requests).toHaveLength(1);
    expect(payment.built).toHaveLength(0);
    expect(client.submissions).toHaveLength(0);
  });

  it("accepts a fee equal to maxTotalFee", async () => {
    const { client, options } = setup([{ quote: { kind: "issue", exitFee: 960n } }]);
    await expect(executePaid(client, options)).resolves.toMatchObject({ status: "settled", exitFee: 960n });
  });

  it("does not submit when the action simulates as failing", async () => {
    const { chain, client, options } = setup([{}, {}]);
    chain.simulatedSuccess = false;
    await expect(executePaid(client, options)).resolves.toMatchObject({
      status: "not-paid",
      stage: "preflight",
      code: "ACTION_WOULD_FAIL",
    });
    expect(client.submissions).toHaveLength(0);
    expect(client.requests).toHaveLength(1);
  });

  it("names the EntryPoint error when the simulation reverts", async () => {
    const { chain, client, options } = setup();
    chain.simulationError = new Error("RPC error: execution reverted, data 0xf499da20");
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "not-paid", stage: "preflight", code: "SIMULATION_FAILED" });
    expect((result as { detail: string }).detail).toMatch(/^PaymentFailed: /u);
    expect(client.submissions).toHaveLength(0);
  });

  it("does not submit when the estimate with the exit buffer exceeds the quoted cap", async () => {
    const { chain, client, options } = setup();
    chain.estimate = 3_500_000n;
    await expect(executePaid(client, options)).resolves.toMatchObject({
      status: "not-paid",
      stage: "preflight",
      code: "GAS_CAP_TOO_LOW",
    });
    expect(client.submissions).toHaveLength(0);
  });

  it("measures headroom on the local clock when the chain timestamp is stale", async () => {
    const { chain, client, options, payment } = setup([{}, {}]);
    // The latest block is 20 s old: the exit stamps validAfter from it, so 10 s of the 30 s remain.
    chain.timestamp = T0 - 20n;
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "not-paid", stage: "expired", code: "QUOTE_HEADROOM" });
    expect(payment.built).toHaveLength(0);
    expect(client.requests).toHaveLength(1);
  });

  it("stops when proving leaves less than the submit headroom", async () => {
    const payment = paymentSource({
      buildPaymentData: async () => {
        nowMs += 20_000;
        return new Uint8Array(64).fill(0xcd);
      },
    });
    const { client, options } = setup([{}], payment);
    await expect(executePaid(client, options)).resolves.toMatchObject({
      status: "not-paid",
      stage: "expired",
      code: "QUOTE_HEADROOM",
    });
    expect(client.submissions).toHaveLength(0);
  });

  it("moves to a second exit after a quote rejection, with the same ids", async () => {
    const { client, options } = setup([{ quote: { kind: "reject", code: "DuplicateExecution" } }, {}]);
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "settled", exit: client.wallets[1]!.address });
    expect(client.exclusions).toEqual([[], [client.node(0).id]]);
    expect(client.requests.map(({ request }) => hexlify(request.clientIntentId))).toEqual([
      hexlify(client.requests[0]!.request.clientIntentId),
      hexlify(client.requests[0]!.request.clientIntentId),
    ]);
  });

  it("returns the last rejection once maxExits exits were contacted", async () => {
    const { client, options } = setup([
      { quote: { kind: "reject", code: "Unprofitable" } },
      { quote: { kind: "reject", code: "StalePrice" } },
      {},
    ]);
    await expect(executePaid(client, options)).resolves.toEqual({
      status: "not-paid",
      stage: "quote",
      code: "StalePrice",
      detail: "exit refused",
    });
    expect(client.requests).toHaveLength(2);
  });

  it("counts both exits when a different exit issues the quote", async () => {
    const { chain, client, options } = setup([
      { quote: { kind: "issue", issuedBy: 1 } },
      { submit: { kind: "reject", code: "SimulationFailure" } },
      {},
    ]);
    chain.secondsPerRead = 9n;
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "not-paid", stage: "submit", code: "SimulationFailure" });
    expect(client.requests).toHaveLength(1);
    expect(client.submissions).toHaveLength(1);
    expect(client.submissions[0]!.issued.selectedExit.id).toBe(client.node(1).id);
  });

  it("counts a quote timeout as two exits contacted", async () => {
    const { client, options } = setup([
      { quote: { kind: "throw", code: NoxClientErrorCode.ResponseTimeout } },
      {},
    ]);
    await expect(executePaid(client, options)).resolves.toMatchObject({
      status: "not-paid",
      stage: "quote",
      code: NoxClientErrorCode.ResponseTimeout,
    });
    expect(client.requests).toHaveLength(1);
  });

  it("raises the exit gas buffer for the next exit after GasCapExceeded", async () => {
    const { client, options } = setup([{ submit: { kind: "reject", code: "GasCapExceeded" } }, {}]);
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "settled", exit: client.wallets[1]!.address });
    const calldataGas = paidExecuteCalldata(ACTION_DATA, 0, 64).gas;
    const limits = { paymentGasLimit: 1_400_000n, actionGasLimit: 1_600_000n, calldataGas };
    expect(client.requests.map(({ request }) => request.maximumTransactionGas)).toEqual([
      planPaidGas(limits).maximumTransactionGas,
      planPaidGas({ ...limits, exitGasBufferBps: 3_000 }).maximumTransactionGas,
    ]);
    expect(hexlify(client.submissions[1]!.issued.executionId)).not.toBe(
      hexlify(client.submissions[0]!.issued.executionId),
    );
  });

  it("finds the settlement on chain when the submission gets no reply", async () => {
    const { client, options } = setup([{ submit: { kind: "timeout", settle: true } }, {}]);
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "settled", exit: client.wallets[0]!.address });
    expect(client.requests).toHaveLength(1);
  });

  it("waits for expiry after a lost submission, then pays through a second exit with the same ids", async () => {
    const { chain, client, options } = setup([{ submit: { kind: "timeout", settle: false } }, {}]);
    chain.secondsPerRead = 9n;
    const result = await executePaid(client, { ...options, minSubmitHeadroomSecs: 5 });

    expect(result).toMatchObject({ status: "settled", exit: client.wallets[1]!.address });
    const [first, second] = client.requests;
    expect(hexlify(second!.request.clientIntentId)).toBe(hexlify(first!.request.clientIntentId));
    expect(hexlify(second!.request.paymentId)).toBe(hexlify(first!.request.paymentId));
    const firstQuote = client.submissions[0]!.issued.quote;
    // The second quote was requested only after the chain passed the first quote's validUntil.
    expect(client.submissions[1]!.issued.quote.validAfterUnix).toBeGreaterThan(firstQuote.validUntilUnix);
    expect(chain.logs).toHaveLength(1);
  });

  it("holds a possibly broadcast rejection until the chain decides", async () => {
    const { chain, client, options } = setup([{ submit: { kind: "reject", code: "SubmissionFailure" } }]);
    chain.secondsPerRead = 9n;
    await expect(executePaid(client, { ...options, minSubmitHeadroomSecs: 5 })).resolves.toMatchObject({
      status: "not-paid",
      stage: "expired",
      code: "QUOTE_EXPIRED_UNSETTLED",
    });
  });

  it("reports the settlement under a replaced transaction hash", async () => {
    const replacedBy = `0x${"be".repeat(32)}`;
    const { client, options } = setup([{ submit: { kind: "settle", replacedBy } }]);
    await expect(executePaid(client, options)).resolves.toMatchObject({
      status: "settled",
      transactionHash: replacedBy,
    });
  });

  it("reports a kept fee with a failed action as its own status", async () => {
    const { client, options } = setup([{ submit: { kind: "settle", actionSuccess: false } }]);
    const result = await executePaid(client, options);
    expect(result).toMatchObject({
      status: "paid-action-failed",
      exitFee: EXIT_FEE,
      networkFee: NETWORK_FEE,
      returnDataLength: 4n,
      returnPrefixHash: `0x${"ee".repeat(32)}`,
    });
    expect(result).not.toHaveProperty("maximumTransactionGas");
  });

  it("returns unknown while the chain shows neither a settlement nor expiry", async () => {
    const { client, options } = setup([{ submit: { kind: "timeout", settle: false } }, {}]);
    const result = await executePaid(client, { ...options, confirmationTimeoutMs: 0 });
    expect(result).toMatchObject({
      status: "unknown",
      executionId: hexlify(client.submissions[0]!.issued.executionId),
      validUntilUnix: T0 + QUOTE_TTL,
    });
    expect(client.requests).toHaveLength(1);
  });

  it("returns unknown when the settlement log disagrees with the quote", async () => {
    const { chain, client, options } = setup();
    const settle = chain.settle.bind(chain);
    chain.settle = (calldata, actionSuccess, hash) => {
      settle(calldata, actionSuccess, hash);
      const log = chain.logs.pop()!;
      chain.logs.push({ ...log, exitFee: log.exitFee + 1n });
    };
    await expect(executePaid(client, options)).resolves.toMatchObject({
      status: "unknown",
      detail: "settlement log exitFee does not match the quote",
    });
  });

  it("resumes from chain evidence without a new quote", async () => {
    const { client, options, payment } = setup();
    const first = await executePaid(client, options);
    const second = await executePaid(client, options);
    expect(first.status).toBe("settled");
    expect(second).toMatchObject({
      status: "settled",
      executionId: (first as { executionId: string }).executionId,
      transactionHash: (first as { transactionHash: string }).transactionHash,
      maximumTransactionGas: client.requests[0]!.request.maximumTransactionGas,
    });
    expect(client.requests).toHaveLength(1);
    expect(payment.built).toHaveLength(1);
  });

  it("does not report another action's settlement for a consumed payment id", async () => {
    const { chain, client, options } = setup();
    await executePaid(client, options);
    const other: PaidAction = { ...ACTION, data: Uint8Array.from([9, 9]) };
    chain.intents.add(hexlify(deriveClientIntentId(CHAIN_ID, ENTRY_POINT, TARGET, other.data, SALT)));
    await expect(executePaid(client, { ...options, action: other })).resolves.toMatchObject({
      status: "not-paid",
      stage: "precheck",
      code: "PAYMENT_CONSUMED",
    });
  });

  it("returns unknown for a consumed intent whose settlement is outside the lookback", async () => {
    const { chain, client, options } = setup();
    await executePaid(client, options);
    chain.block += 10_000n;
    const result = await executePaid(client, { ...options, resumeLookbackBlocks: 4_500n });
    expect(result).toMatchObject({ status: "unknown", executionId: null, validUntilUnix: null });
    // 4,501 blocks in ranges of at most 2,000, newest first.
    const ranges = chain.logQueries.slice(-3);
    expect(ranges.map(([from, to]) => to - from + 1n)).toEqual([2_000n, 2_000n, 501n]);
    expect(ranges[0]![1]).toBe(chain.block);
  });

  it("refuses a spent payment id and an intent paid through another payment", async () => {
    const spent = setup();
    spent.chain.payments.add(hexlify(PAYMENT_ID));
    await expect(executePaid(spent.client, spent.options)).resolves.toMatchObject({
      status: "not-paid",
      stage: "precheck",
      code: "PAYMENT_CONSUMED",
    });
    const paid = setup();
    paid.chain.intents.add(hexlify(deriveClientIntentId(CHAIN_ID, ENTRY_POINT, TARGET, ACTION_DATA, SALT)));
    await expect(executePaid(paid.client, paid.options)).resolves.toMatchObject({
      status: "not-paid",
      stage: "precheck",
      code: "INTENT_CONSUMED",
    });
    expect(spent.client.requests.length + paid.client.requests.length).toBe(0);
  });

  it("stops after the preflight on a dry run", async () => {
    const { chain, client, options } = setup();
    const result = await executePaid(client, { ...options, dryRun: true });
    expect(result).toMatchObject({
      status: "dry-run",
      exitFee: EXIT_FEE,
      networkFee: NETWORK_FEE,
      estimatedGas: 3_100_000n,
      maximumTransactionGas: client.requests[0]!.request.maximumTransactionGas,
    });
    expect(Object.keys((result as { timings: object }).timings).sort()).toEqual([
      "payment",
      "precheck",
      "preflight",
      "quote",
    ]);
    expect(client.submissions).toHaveLength(0);
    expect(chain.logs).toHaveLength(0);
  });

  it("refuses payment data longer than the source declared", async () => {
    const payment = paymentSource({ paymentDataLength: 63 });
    const { client, options } = setup([{}], payment);
    await expect(executePaid(client, options)).resolves.toMatchObject({
      status: "not-paid",
      stage: "payment",
      code: "PAYMENT_BUILD_FAILED",
    });
    expect(client.submissions).toHaveLength(0);
  });

  it("estimates a generic action from the predicted sandbox with a margin", async () => {
    const { chain, client, options } = setup();
    chain.estimate = 200_000n;
    const { gasLimit: _declared, ...generic } = ACTION;
    await executePaid(client, { ...options, action: generic, dryRun: true });
    expect(chain.estimates[0]).toEqual({ from: getAddress(SANDBOX), to: TARGET, data: hexlify(ACTION_DATA) });
    expect(client.requests[0]!.request.actionGasLimit).toBe(300_000n);
  });

  it("adds the data fee to the cap without sending calldata before the quote", async () => {
    const { chain, client, options } = setup();
    const seen: { to: string; data: string }[] = [];
    chain.dataFeeGas = async (tx) => {
      seen.push(tx);
      return 250_000n;
    };
    await executePaid(client, { ...options, dryRun: true });
    const calldata = paidExecuteCalldata(ACTION_DATA, 0, 64);
    expect(client.requests[0]!.request.maximumTransactionGas).toBe(
      planPaidGas({
        paymentGasLimit: 1_400_000n,
        actionGasLimit: 1_600_000n,
        calldataGas: calldata.gas,
        dataFeeGas: 250_000n,
      }).maximumTransactionGas,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.to.toLowerCase()).toBe(ENTRY_POINT);
    expect(getBytes(seen[0]!.data)).toHaveLength(calldata.bytes);
    expect(seen[0]!.data).not.toContain(hexlify(ACTION_DATA).slice(2));
  });

  it("sends the signed calldata to the preflight reader only", async () => {
    const { chain, client, options } = setup();
    const preflight = new FakeChain();
    const result = await executePaid(client, { ...options, preflight, dryRun: true });
    expect(result.status).toBe("dry-run");
    const selector = "0x8f42c610";
    expect(preflight.calls.map((call) => call.data.slice(0, 10))).toEqual([selector]);
    expect(preflight.estimates.map((call) => call.data.slice(0, 10))).toEqual([selector]);
    expect(chain.calls.some((call) => call.data.startsWith(selector))).toBe(false);
    expect(chain.estimates).toHaveLength(0);
  });

  it("gives two callers of the same calldata separate intent ids", async () => {
    const { chain, client, options } = setup();
    expect((await executePaid(client, options)).status).toBe("settled");
    const second = paymentSource({ paymentId: new Uint8Array(32).fill(0x56) });
    const result = await executePaid(client, {
      ...options,
      payment: second.source,
      intentSalt: new Uint8Array(32).fill(0xa2),
    });
    expect(result.status).toBe("settled");
    expect(chain.logs).toHaveLength(2);
    expect(hexlify(client.requests[1]!.request.clientIntentId)).not.toBe(
      hexlify(client.requests[0]!.request.clientIntentId),
    );
  });

  it("says only that the intent id is consumed when another payment consumed it", async () => {
    const { chain, client, options } = setup();
    const intentId = hexlify(deriveClientIntentId(CHAIN_ID, ENTRY_POINT, TARGET, ACTION_DATA, SALT));
    chain.intents.add(intentId);
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "not-paid", stage: "precheck", code: "INTENT_CONSUMED" });
    expect((result as { detail: string }).detail).toBe(
      `intent id ${intentId} is consumed on the EntryPoint by an execution with another payment id; this payment source is unspent`,
    );
  });

  it("reports the settlement when an exit rejects a submission it broadcast", async () => {
    const { client, options } = setup([
      { submit: { kind: "reject", code: "SimulationFailure", settle: true } },
      { quote: { kind: "reject", code: "Unprofitable" } },
    ]);
    const result = await executePaid(client, options);
    expect(result).toMatchObject({
      status: "settled",
      exit: client.wallets[0]!.address,
      executionId: hexlify(client.submissions[0]!.issued.executionId),
    });
    expect(client.requests).toHaveLength(1);
  });

  it("holds a rejected submission until its quote can no longer settle", async () => {
    const { chain, client, options } = setup([{ submit: { kind: "reject", code: "SimulationFailure" } }]);
    const pending = await executePaid(client, { ...options, maxExits: 1, confirmationTimeoutMs: 0 });
    expect(pending).toMatchObject({
      status: "unknown",
      executionId: hexlify(client.submissions[0]!.issued.executionId),
      validUntilUnix: T0 + QUOTE_TTL,
    });
    chain.settle(client.submissions[0]!.calldata, true, `0x${"be".repeat(32)}`);
    await expect(executePaid(client, options)).resolves.toMatchObject({
      status: "settled",
      transactionHash: `0x${"be".repeat(32)}`,
    });
  });

  it("does not quote again while an earlier execution can still settle", async () => {
    const { chain, client, options } = setup([{ submit: { kind: "timeout", settle: false } }, {}]);
    const first = await executePaid(client, { ...options, confirmationTimeoutMs: 0 });
    if (first.status !== "unknown" || first.executionId === null || first.validUntilUnix === null) {
      throw new Error("expected an unknown result with its execution id");
    }
    const pending = { executionId: first.executionId, validUntilUnix: first.validUntilUnix };
    await expect(executePaid(client, { ...options, pending })).resolves.toMatchObject({
      status: "unknown",
      ...pending,
    });
    expect(client.requests).toHaveLength(1);

    chain.timestamp = first.validUntilUnix + 1n;
    nowMs = Number(chain.timestamp) * 1000;
    chain.secondsPerRead = 9n;
    await expect(
      executePaid(client, { ...options, pending, minSubmitHeadroomSecs: 5 }),
    ).resolves.toMatchObject({
      status: "settled",
      exit: client.wallets[1]!.address,
    });
  });

  it("stops before proving when the quote is not active on chain yet", async () => {
    const { client, options, payment } = setup([{ quote: { kind: "issue", startsInSecs: 5n } }]);
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "not-paid", stage: "quote", code: "QUOTE_NOT_ACTIVE" });
    expect(payment.built).toHaveLength(0);
    expect(client.submissions).toHaveLength(0);
  });

  it("returns at once when the submission is refused before it is sent", async () => {
    const { chain, client, options } = setup([
      { submit: { kind: "throw", code: NoxClientErrorCode.InvalidConfig } },
      {},
    ]);
    const blockBefore = chain.block;
    const result = await executePaid(client, options);
    expect(result).toMatchObject({ status: "not-paid", stage: "submit", code: NoxClientErrorCode.InvalidConfig });
    expect(client.requests).toHaveLength(1);
    // One block read for the precheck; no evidence polling for a submission that never left.
    expect(chain.block).toBe(blockBefore + 1n);
  });

  it("prices the Arbitrum data fee into the cap on Arbitrum chains", async () => {
    const limits = {
      paymentGasLimit: 1_400_000n,
      actionGasLimit: 1_600_000n,
      calldataGas: paidExecuteCalldata(ACTION_DATA, 0, 64).gas,
    };
    const arbitrum = setup();
    arbitrum.chain.l1Gas = 250_000n;
    await executePaid(arbitrum.client, { ...arbitrum.options, dryRun: true });
    expect(arbitrum.client.requests[0]!.request.maximumTransactionGas).toBe(
      planPaidGas({ ...limits, dataFeeGas: 250_000n }).maximumTransactionGas,
    );
    const other = setup();
    other.chain.l1Gas = 250_000n;
    await executePaid(other.client, { ...other.options, chainId: 31_337n, dryRun: true });
    expect(other.client.requests[0]!.request.maximumTransactionGas).toBe(
      planPaidGas(limits).maximumTransactionGas,
    );
    expect(other.chain.calls.some((call) => call.to === NODE_INTERFACE)).toBe(false);
  });

  it("throws for invalid options instead of contacting an exit", async () => {
    const { client, options } = setup();
    await expect(executePaid(client, { ...options, maxTotalFee: 0n })).rejects.toThrow("maxTotalFee");
    const { intentSalt: _salt, preflight: _preflight, ...bare } = options;
    await expect(
      executePaid(client, { ...bare, preflight: options.preflight, clientIntentId: new Uint8Array(31) }),
    ).rejects.toThrow("clientIntentId");
    await expect(
      executePaid(client, { ...options, clientIntentId: new Uint8Array(32) }),
    ).rejects.toThrow("exactly one of intentSalt and clientIntentId");
    await expect(
      executePaid(client, { ...bare, preflight: options.preflight }),
    ).rejects.toThrow("exactly one of intentSalt and clientIntentId");
    await expect(
      executePaid(client, { ...bare, intentSalt: SALT } as ExecutePaidOptions),
    ).rejects.toThrow("preflight must be a reader");
    expect(client.requests).toHaveLength(0);
  });
});

describe("rpc chain reader", () => {
  const settlementLog = (overrides: Record<string, unknown> = {}) => {
    const event = ABI.encodeEventLog("PaidExecutionSettled", [
      `0x${"e1".repeat(32)}`,
      hexlify(PAYMENT_ID),
      `0x${"22".repeat(20)}`,
      FEE_ASSET,
      EXIT_FEE,
      NETWORK_FEE,
      TARGET,
      true,
      0n,
      `0x${"00".repeat(32)}`,
    ]);
    return {
      address: ENTRY_POINT,
      topics: event.topics,
      data: event.data,
      transactionHash: `0x${"ab".repeat(32)}`,
      blockNumber: "0x3e9",
      ...overrides,
    };
  };

  it("maps reads to JSON-RPC and decodes the settlement event", async () => {
    const sent: [string, unknown[]][] = [];
    const reader = rpcChainReader(async (method, params) => {
      sent.push([method, params]);
      if (method === "eth_blockNumber") return "0x3e8";
      if (method === "eth_getBlockByNumber") return { timestamp: "0x6b49d200" };
      if (method === "eth_getLogs") return [settlementLog()];
      if (method === "eth_getTransactionByHash") return { input: "0x8f42c610" };
      return "0x01";
    });

    expect(await reader.blockNumber()).toBe(1_000n);
    expect(await reader.blockTimestamp(1_000n)).toBe(T0);
    await reader.call({ to: ENTRY_POINT, data: "0x00", gas: 5_000_000n, gasPrice: 7n }, "latest");
    expect(await reader.transactionInput(`0x${"ab".repeat(32)}`)).toBe("0x8f42c610");
    const log = await reader.settlementLog(ENTRY_POINT, `0x${"e1".repeat(32)}`, 900n, 1_001n);
    await reader.settlementLogByPayment(ENTRY_POINT, hexlify(PAYMENT_ID), 900n, 1_001n);

    expect(log).toMatchObject({
      executionId: `0x${"e1".repeat(32)}`,
      paymentId: hexlify(PAYMENT_ID),
      exitFee: EXIT_FEE,
      networkFee: NETWORK_FEE,
      actionSuccess: true,
      transactionHash: `0x${"ab".repeat(32)}`,
      blockNumber: 1_001n,
    });
    const topic = "0x08999181408049964f922b10eccdf5d39b08dcb8920aac22cd2fc19282d63012";
    expect(sent.filter(([method]) => method !== "eth_blockNumber")).toEqual([
      ["eth_getBlockByNumber", ["0x3e8", false]],
      ["eth_call", [{ to: ENTRY_POINT, data: "0x00", gas: "0x4c4b40", gasPrice: "0x7" }, "latest"]],
      ["eth_getTransactionByHash", [`0x${"ab".repeat(32)}`]],
      ["eth_getLogs", [{ address: ENTRY_POINT, topics: [topic, `0x${"e1".repeat(32)}`], fromBlock: "0x384", toBlock: "0x3e9" }]],
      ["eth_getLogs", [{ address: ENTRY_POINT, topics: [topic, null, hexlify(PAYMENT_ID)], fromBlock: "0x384", toBlock: "0x3e9" }]],
    ]);
  });

  it("refuses logs from another contract, removed logs and ambiguous matches", async () => {
    const reader = (logs: unknown[]) => rpcChainReader(async () => logs);
    const query = (logs: unknown[]) =>
      reader(logs).settlementLog(ENTRY_POINT, `0x${"e1".repeat(32)}`, 1n, 2n);
    await expect(query([])).resolves.toBeNull();
    await expect(query([settlementLog({ address: TARGET })])).rejects.toThrow("PaidExecutionSettled");
    await expect(query([settlementLog({ removed: true })])).rejects.toThrow("malformed");
    await expect(query([settlementLog(), settlementLog()])).rejects.toThrow("more than one");
  });

  it("reads the Arbitrum data fee from NodeInterface", async () => {
    const nodeInterface = new Interface([
      "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64, uint256, uint256)",
    ]);
    const calls: PaidCallRequest[] = [];
    const dataFeeGas = arbitrumDataFeeGas({
      call: async (tx) => {
        calls.push(tx);
        return nodeInterface.encodeFunctionResult("gasEstimateL1Component", [123_456n, 1n, 2n]);
      },
    });
    await expect(dataFeeGas({ to: ENTRY_POINT, data: "0x8f42c610" })).resolves.toBe(123_456n);
    expect(calls[0]!.to).toBe("0x00000000000000000000000000000000000000C8");
    expect(calls[0]!.data.slice(0, 10)).toBe("0x77d488a2");
    expect(calls[0]!.data).toContain(zeroPadValue(ENTRY_POINT, 32).slice(2));
  });
});

describe("selectPaidExit exclusion", () => {
  function client(): NoxClient {
    const node = (id: number, layer: number, role: number): TopologyNode => ({
      id: `0x${id.toString(16).padStart(40, "0")}`,
      address: layer === 0 ? "https://entry.test" : "",
      routingAddress: `/n${id}`,
      publicKey: new Uint8Array(32),
      layer,
      role,
    });
    const detached = Object.create(NoxClient.prototype) as NoxClient;
    Reflect.set(detached, "_nodes", [node(1, 0, 1), node(2, 1, 1), node(0xa, 2, 2), node(0xb, 2, 2)]);
    Reflect.set(detached, "_entryUrl", "https://entry.test");
    Reflect.set(detached, "_avoidUntil", new Map());
    return detached;
  }

  it("never returns an excluded exit, in any address case", () => {
    const detached = client();
    const kept = `0x${"0".repeat(39)}b`;
    for (let i = 0; i < 20; i++) {
      expect(detached.selectPaidExit({ exclude: [`0x${"0".repeat(39)}A`] }).id).toBe(kept);
    }
    expect(() =>
      detached.selectPaidExit({ exclude: [`0x${"0".repeat(39)}a`, kept] }),
    ).toThrow(expect.objectContaining({ code: NoxClientErrorCode.PaidExitUnavailable }));
  });
});

describe("executePaid through NoxClient with two paid exits", () => {
  /** What the first exit contacted does; the other exit always quotes and settles. */
  type FirstExit = { quote: "reject" | "issue"; submit?: "settle" | "GasCapExceeded" };

  /**
   * A verified NoxClient over a topology with one entry, one mix and two paid
   * exits. The mixnet send is replaced by the two exits: each decodes the
   * bincode service request it receives, answers in bincode, signs its quotes
   * with its own key and settles on `chain`. Exit selection (random between the
   * two), exclusion, quote signature and route checks, and the request
   * encodings are the client's own.
   */
  function twoExitMesh(chain: FakeChain, firstExit: FirstExit) {
    const wallets = EXIT_KEYS.slice(0, 2).map((key) => new Wallet(key));
    const node = (id: string, layer: number, role: number, capabilities: string[]): TopologyNode => ({
      id,
      address: layer === 0 ? "https://entry.test" : "",
      routingAddress: `/n/${id}`,
      publicKey: new Uint8Array(32),
      layer,
      role,
      capabilities,
    });
    const exits = wallets.map((wallet) => node(wallet.address.toLowerCase(), 2, 2, ["paid_v2"]));
    const client = Object.create(NoxClient.prototype) as NoxClient;
    Reflect.set(client, "_nodes", [
      node(`0x${"e1".repeat(20)}`, 0, 1, []),
      node(`0x${"e2".repeat(20)}`, 1, 1, []),
      ...exits,
    ]);
    Reflect.set(client, "_entryUrl", "https://entry.test");
    Reflect.set(client, "_avoidUntil", new Map());
    Reflect.set(client, "_topologyVerifiedAtMs", nowMs);
    Reflect.set(client, "_config", { dangerouslySkipFingerprintCheck: false, topologyRefreshMs: 60_000 });
    Reflect.set(client, "adaptive", new AdaptiveSurbBudget());
    Reflect.set(client, "_paidChainTimestamp", async () => chain.timestamp);

    const sent: { exit: string; tag: string }[] = [];
    const quotedCaps: bigint[] = [];
    let nonce = 0n;
    Reflect.set(
      client,
      "_sendWithRetry",
      async (payload: RelayerPayload, _surbs: number, _timeout: unknown, selectedExit?: TopologyNode) => {
        if (payload.tag !== "AnonymousRequest" || selectedExit === undefined) {
          throw new Error("paid requests go to a selected exit");
        }
        const index = exits.findIndex((exit) => exit.id === selectedExit.id);
        const wallet = wallets[index]!;
        const isFirst = sent.length === 0 || sent[0]!.exit === selectedExit.id;
        const script: FirstExit = isFirst ? firstExit : { quote: "issue" };
        const request = decodeServiceRequest(payload.inner);
        sent.push({ exit: selectedExit.id, tag: request.tag });
        if (request.tag === "PaidQuoteRequestV2") {
          quotedCaps.push(request.maximumTransactionGas);
          if (script.quote === "reject") {
            const response = encodePaidQuoteOutcomeV2({
              status: "rejected",
              code: "Unprofitable",
              retryable: true,
              detail: "fee below the exit's floor",
            });
            return { response, exit: selectedExit };
          }
          nonce += 1n;
          const validUntil = chain.timestamp + QUOTE_TTL;
          const quote: ExecutionQuoteV1 = {
            quoteVersion: 1,
            chainId: word(request.chainId),
            entryPoint: request.entryPoint,
            exitAddress: getBytes(wallet.address),
            clientIntentId: request.clientIntentId,
            paymentAdapter: request.paymentAdapter,
            paymentId: request.paymentId,
            feeAsset: request.feeAsset,
            exitFee: word(EXIT_FEE),
            networkFee: word(NETWORK_FEE),
            paymentGasLimit: word(request.paymentGasLimit),
            actionTarget: request.actionTarget,
            actionCalldataHash: request.actionCalldataHash,
            actionGasLimit: word(request.actionGasLimit),
            trackedAssetsHash: request.trackedAssetsHash,
            maximumTransactionGas: word(request.maximumTransactionGas),
            maximumFeePerGas: word(100_000_000n),
            returnDataLimit: word(BigInt(request.returnDataLimit)),
            validAfterUnix: chain.timestamp,
            validUntilUnix: validUntil < request.validUntilUnix ? validUntil : request.validUntilUnix,
            quoteNonce: word(nonce),
          };
          const typed = quoteTypedData(quote);
          const response = encodePaidQuoteOutcomeV2({
            status: "issued",
            quote,
            executionId: getBytes(hashExecutionQuoteV1(quote)),
            exitSignature: getBytes(await wallet.signTypedData(typed.domain, typed.types, typed.value)),
          });
          return { response, exit: selectedExit };
        }
        if (request.tag === "PaidTransactionV2") {
          if (script.submit === "GasCapExceeded") {
            const response = encodePaidTransactionOutcomeV2({
              status: "rejected",
              executionId: request.executionId,
              code: "GasCapExceeded",
              retryable: true,
              detail: "estimate above the quoted cap",
            });
            return { response, exit: selectedExit };
          }
          const hash = keccak256(request.calldata);
          chain.settle(request.calldata, true, hash);
          const response = encodePaidTransactionOutcomeV2({
            status: "submitted",
            executionId: request.executionId,
            transactionHash: getBytes(hash),
          });
          return { response, exit: selectedExit };
        }
        throw new Error(`unexpected service request ${request.tag}`);
      },
    );
    return { client, wallets, exits, sent, quotedCaps };
  }

  function meshOptions(chain: FakeChain): ExecutePaidOptions {
    return {
      chainId: CHAIN_ID,
      entryPoint: ENTRY_POINT,
      action: ACTION,
      payment: paymentSource().source,
      maxTotalFee: 1_000n,
      intentSalt: SALT,
      chain,
      preflight: chain,
      pollIntervalMs: 0,
    };
  }

  it("settles through the second exit after the first refuses the quote", async () => {
    // selectPaidExit draws at random; repeat so both exits take each part.
    const firstSeen = new Set<string>();
    for (let run = 0; run < 12; run++) {
      const chain = new FakeChain();
      const { client, wallets, exits, sent } = twoExitMesh(chain, { quote: "reject" });
      const result = await executePaid(client, meshOptions(chain));
      const first = exits.findIndex((exit) => exit.id === sent[0]!.exit);
      const paying = 1 - first;
      firstSeen.add(sent[0]!.exit);
      expect(result).toMatchObject({ status: "settled", exit: wallets[paying]!.address });
      expect(sent).toEqual([
        { exit: exits[first]!.id, tag: "PaidQuoteRequestV2" },
        { exit: exits[paying]!.id, tag: "PaidQuoteRequestV2" },
        { exit: exits[paying]!.id, tag: "PaidTransactionV2" },
      ]);
      expect(chain.logs).toHaveLength(1);
      expect(chain.logs[0]!.exit.toLowerCase()).toBe(exits[paying]!.id);
    }
    expect(firstSeen.size).toBe(2);
  });

  it("re-quotes on the second exit with a raised buffer after GasCapExceeded, under the same intent", async () => {
    const chain = new FakeChain();
    const { client, wallets, exits, sent, quotedCaps } = twoExitMesh(chain, {
      quote: "issue",
      submit: "GasCapExceeded",
    });
    const result = await executePaid(client, meshOptions(chain));
    const first = exits.findIndex((exit) => exit.id === sent[0]!.exit);
    const second = 1 - first;
    expect(result).toMatchObject({ status: "settled", exit: wallets[second]!.address });
    expect(sent.map(({ exit, tag }) => [exits.findIndex((e) => e.id === exit), tag])).toEqual([
      [first, "PaidQuoteRequestV2"],
      [first, "PaidTransactionV2"],
      [second, "PaidQuoteRequestV2"],
      [second, "PaidTransactionV2"],
    ]);
    const calldataGas = paidExecuteCalldata(ACTION_DATA, 0, 64).gas;
    const limits = { paymentGasLimit: 1_400_000n, actionGasLimit: 1_600_000n, calldataGas };
    expect(quotedCaps).toEqual([
      planPaidGas(limits).maximumTransactionGas,
      planPaidGas({ ...limits, exitGasBufferBps: 3_000 }).maximumTransactionGas,
    ]);
    expect(chain.logs).toHaveLength(1);
    expect(chain.intents.size).toBe(1);
  });
});
