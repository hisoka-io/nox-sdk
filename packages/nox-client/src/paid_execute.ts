import {
  AbiCoder,
  Interface,
  concat,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  randomBytes,
  toBeHex,
  toBigInt,
  toQuantity,
  toUtf8Bytes,
} from "ethers";
import type {
  ExecutionQuoteV1,
  PaidQuoteRequestV2,
  PaidTransactionOutcomeV2,
} from "./bincode.js";
import type { NoxClient } from "./client.js";
import {
  hashExecutionQuoteV1,
  parsePaidChainTimestamp,
  quoteTypedData,
  safeExternalError,
} from "./paid.js";
import type { IssuedPaidQuoteV2 } from "./paid.js";
import { NoxClientError, NoxClientErrorCode } from "./types.js";

const ENTRY_POINT = /* @__PURE__ */ new Interface([
  "function execute((uint8 quoteVersion, uint256 chainId, address entryPoint, address exitAddress, bytes32 clientIntentId, address paymentAdapter, bytes32 paymentId, address feeAsset, uint256 exitFee, uint256 networkFee, uint256 paymentGasLimit, address actionTarget, bytes32 actionCalldataHash, uint256 actionGasLimit, bytes32 trackedAssetsHash, uint256 maximumTransactionGas, uint256 maximumFeePerGas, uint256 returnDataLimit, uint64 validAfterUnix, uint64 validUntilUnix, uint256 quoteNonce) quote, bytes exitSignature, bytes actionData, address[] trackedAssets, bytes paymentData) returns ((bool success, uint256 returnDataLength, bytes32 returnPrefixHash) outcome)",
  "function isExecutionConsumed(bytes32 executionId) view returns (bool)",
  "function isPaymentConsumed(bytes32 paymentId) view returns (bool)",
  "function isClientIntentConsumed(bytes32 clientIntentId) view returns (bool)",
  "function predictSandbox(bytes32 clientIntentId) view returns (address)",
  "event PaidExecutionSettled(bytes32 indexed executionId, bytes32 indexed paymentId, address indexed exit, address feeAsset, uint256 exitFee, uint256 networkFee, address actionTarget, bool actionSuccess, uint256 returnDataLength, bytes32 returnPrefixHash)",
  "error InvalidQuoteVersion()",
  "error WrongChain()",
  "error WrongEntryPoint()",
  "error WrongExit()",
  "error InvalidQuoteSigner()",
  "error QuoteNotActive()",
  "error QuoteExpired()",
  "error InvalidIdentifier()",
  "error InvalidFee()",
  "error InvalidGasBounds()",
  "error GasPriceExceedsQuote()",
  "error ActionCalldataTooLarge()",
  "error PaymentDataTooLarge()",
  "error TooManyTrackedAssets()",
  "error InvalidTrackedAsset()",
  "error DuplicateTrackedAsset(address asset)",
  "error ActionHashMismatch()",
  "error TrackedAssetsHashMismatch()",
  "error InvalidActionTarget()",
  "error ExecutionAlreadyConsumed()",
  "error PaymentAlreadyConsumed()",
  "error ClientIntentAlreadyConsumed()",
  "error PaymentFailed()",
  "error IncorrectPaymentAmount(uint256 expected, uint256 received)",
  "error RewardPoolResidualBalance()",
  "error InsufficientExecutionGas()",
  "error SandboxExecutionFailed()",
]);

const NODE_INTERFACE = /* @__PURE__ */ new Interface([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);
const ARBITRUM_NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";

/** Topic of `PaidExecutionSettled`. */
const SETTLED_TOPIC =
  "0x08999181408049964f922b10eccdf5d39b08dcb8920aac22cd2fc19282d63012";
const CLIENT_INTENT_TAG = "nox.client-intent.v1";
/** Chains whose transactions carry an L1 data fee read from `NodeInterface`. */
const ARBITRUM_CHAIN_IDS: ReadonlySet<bigint> = /* @__PURE__ */ new Set([42_161n, 421_614n]);
const ENTRY_POINT_GAS_RESERVE = 250_000n;
const TRANSACTION_BASE_GAS = 21_000n;
const NONZERO_BYTE_GAS = 16n;
const ZERO_BYTE_GAS = 4n;
const BPS = 10_000n;
/** Words before the dynamic tails of `execute`: the 21-word quote and four offsets. */
const EXECUTE_HEAD_WORDS = 25;
const SIGNATURE_BYTES = 65;

/** Defaults of `executePaid`; every one can be overridden per call. */
export const PAID_EXECUTE_DEFAULTS = {
  /** Buffer the exit adds to its own gas estimate (`gas_limit_buffer_bps` in the exit config). */
  exitGasBufferBps: 2_000,
  /**
   * Room on top of the planned cap for the gap between the plan and the exit's
   * `eth_estimateGas`. Live on Arbitrum Sepolia (2026-10-13) the estimate came
   * 0.41% above the plan (0.16% below on a fork), which left 4.4% of the cap
   * unused, above the 3% floor the live runs stop at.
   */
  capHeadroomBps: 500,
  /**
   * Extra room on the data fee alone, for its movement between the plan and the
   * exit's estimate (5000 lets it rise by half). Adds nothing where the chain
   * reports no data fee.
   */
  dataFeeHeadroomBps: 5_000,
  /** Multiplier, in basis points, applied to an estimated action gas limit (15000 is 1.5x). */
  actionMarginBps: 15_000,
  /** Added to `exitGasBufferBps` after an exit answers a submission with `GasCapExceeded`. */
  exitGasBufferStepBps: 1_000,
  minSubmitHeadroomSecs: 12,
  maxExits: 2,
  returnDataLimit: 256,
  /** Requested quote lifetime; the exit caps it with its own TTL. */
  quoteRequestTtlSecs: 120,
  /** Polling continues this long after the quote expires when no `confirmationTimeoutMs` is given. */
  confirmationGraceMs: 60_000,
  pollIntervalMs: 2_000,
  /** Largest block range per `eth_getLogs` request that exits serve. */
  logRangeBlocks: 2_000n,
  /** Blocks searched for the settlement of an intent that is already consumed. */
  resumeLookbackBlocks: 16_000n,
} as const;

/** The `NoxClient` methods `executePaid` uses. */
export type PaidExecutionClient = Pick<
  NoxClient,
  "selectPaidExit" | "requestPaidQuote" | "submitPaidTransaction" | "rpcCall"
>;

export interface PaidAction {
  readonly target: string;
  readonly data: Uint8Array;
  /** Used as given. When omitted, the limit is estimated through the chain reader. */
  readonly gasLimit?: bigint;
  readonly trackedAssets?: readonly string[];
  /** Bytes of action return data hashed into the settlement, up to 4096. Default 256. */
  readonly returnDataLimit?: number;
}

export interface PaidPaymentSource {
  readonly adapter: string;
  readonly feeAsset: string;
  /** 32 bytes defined by the adapter, such as the nullifier of the fee note. */
  readonly paymentId: Uint8Array;
  /** `paymentGasLimit` of the quote. */
  readonly gasLimit: bigint;
  /** Upper bound on the bytes `buildPaymentData` returns; priced into the gas cap before the quote. */
  readonly paymentDataLength: number;
  /** Throws when the action cannot be combined with this payment. */
  checkAction?(action: PaidAction): void;
  buildPaymentData(args: {
    readonly executionId: Uint8Array;
    /** `exitFee + networkFee` of the signed quote. */
    readonly amount: bigint;
    readonly feeAsset: string;
  }): Promise<Uint8Array>;
}

export interface PaidSettlement {
  readonly executionId: string;
  readonly paymentId: string;
  readonly exit: string;
  readonly feeAsset: string;
  readonly exitFee: bigint;
  readonly networkFee: bigint;
  readonly actionTarget: string;
  readonly actionSuccess: boolean;
  readonly returnDataLength: bigint;
  readonly returnPrefixHash: string;
  readonly transactionHash: string;
  readonly blockNumber: bigint;
}

export interface PaidCallRequest {
  readonly from?: string;
  readonly to: string;
  readonly data: string;
  readonly gas?: bigint;
  readonly gasPrice?: bigint;
}

export interface PaidChainReader {
  blockNumber(): Promise<bigint>;
  call(tx: PaidCallRequest, block: bigint | "latest"): Promise<string>;
  estimateGas(tx: { readonly from: string; readonly to: string; readonly data: string }): Promise<bigint>;
  blockTimestamp(block: bigint | "latest"): Promise<bigint>;
  /** The `PaidExecutionSettled` log of `executionId` in the block range, or `null`. */
  settlementLog(
    entryPoint: string,
    executionId: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<PaidSettlement | null>;
  /** The `PaidExecutionSettled` log that consumed `paymentId` in the block range, or `null`. */
  settlementLogByPayment(
    entryPoint: string,
    paymentId: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<PaidSettlement | null>;
  /** Calldata of a mined transaction, or `null` when the reader does not know it. */
  transactionInput(transactionHash: string): Promise<string | null>;
  /** Chain data fee of a transaction expressed in gas. Absent means 0. */
  dataFeeGas?(tx: { readonly to: string; readonly data: string }): Promise<bigint>;
}

/**
 * The reads of the simulation. They carry the complete signed `execute`
 * calldata, fee proof included, and need `from`, `gas` and `gasPrice` honoured.
 */
export type PaidPreflightReader = Pick<PaidChainReader, "call" | "estimateGas">;

export interface PaidGasOptions {
  readonly exitGasBufferBps?: number;
  readonly capHeadroomBps?: number;
  readonly dataFeeHeadroomBps?: number;
  readonly actionMarginBps?: number;
  /** Upper clamp on the planned `maximumTransactionGas`. */
  readonly maximumTransactionGas?: bigint;
}

export interface ExecutePaidOptions {
  readonly chainId: bigint;
  readonly entryPoint: string;
  readonly action: PaidAction;
  readonly payment: PaidPaymentSource;
  /** Hard ceiling on `exitFee + networkFee`, in fee-asset units. */
  readonly maxTotalFee: bigint;
  /**
   * 32 bytes held by the caller and reused on every retry of this action; the
   * intent id is `deriveClientIntentId` of the action and this salt. Give
   * either `intentSalt` or `clientIntentId`.
   */
  readonly intentSalt?: Uint8Array;
  readonly clientIntentId?: Uint8Array;
  /** State and evidence reads. Default: `mixnetChainReader(client)`. */
  readonly chain?: PaidChainReader;
  /**
   * Simulates the action and the signed `execute` calldata. It sees the fee
   * proof before the quoting exit does, so it is an endpoint of the caller's
   * choice, such as `rpcChainReader` over an RPC provider of your own.
   */
  readonly preflight: PaidPreflightReader;
  /** `executionId` and `validUntilUnix` of an earlier `unknown` result for this action and payment. */
  readonly pending?: { readonly executionId: string; readonly validUntilUnix: bigint };
  readonly gas?: PaidGasOptions;
  readonly minSubmitHeadroomSecs?: number;
  /** Exits contacted at most, counting every exit a quote request may have reached. */
  readonly maxExits?: number;
  /** Stop after the preflight; nothing is submitted. */
  readonly dryRun?: boolean;
  /** Default: until the quote expires plus `confirmationGraceMs`. */
  readonly confirmationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly resumeLookbackBlocks?: bigint;
}

/** Milliseconds spent per stage of one `executePaid` call. */
export type PaidTimings = Readonly<
  Partial<Record<"precheck" | "quote" | "payment" | "preflight" | "submit" | "confirmation", number>>
>;

export type PaidNotPaidStage =
  | "precheck"
  | "quote"
  | "fee-cap"
  | "payment"
  | "preflight"
  | "submit"
  | "expired";

export type ExecutePaidResult =
  | {
      readonly status: "settled";
      readonly executionId: string;
      readonly exit: string;
      readonly exitFee: bigint;
      readonly networkFee: bigint;
      readonly transactionHash: string;
      readonly blockNumber: bigint;
      readonly maximumTransactionGas: bigint;
      readonly timings: PaidTimings;
    }
  | {
      readonly status: "paid-action-failed";
      readonly executionId: string;
      readonly exit: string;
      readonly exitFee: bigint;
      readonly networkFee: bigint;
      readonly transactionHash: string;
      readonly blockNumber: bigint;
      readonly returnDataLength: bigint;
      readonly returnPrefixHash: string;
      readonly timings: PaidTimings;
    }
  | {
      readonly status: "dry-run";
      readonly executionId: string;
      readonly exit: string;
      readonly exitFee: bigint;
      readonly networkFee: bigint;
      readonly maximumTransactionGas: bigint;
      readonly estimatedGas: bigint;
      readonly timings: PaidTimings;
    }
  | {
      readonly status: "not-paid";
      readonly stage: PaidNotPaidStage;
      readonly code: string;
      readonly detail: string;
    }
  | {
      readonly status: "unknown";
      /** `null` when the intent was already consumed before this call and its settlement was not found. */
      readonly executionId: string | null;
      readonly validUntilUnix: bigint | null;
      readonly detail: string;
    };

export interface PaidGasPlanInput {
  readonly paymentGasLimit: bigint;
  readonly actionGasLimit: bigint;
  /** Intrinsic calldata gas of the `execute` transaction, see `paidExecuteCalldata`. */
  readonly calldataGas: bigint;
  readonly dataFeeGas?: bigint;
  readonly exitGasBufferBps?: number;
  readonly capHeadroomBps?: number;
  readonly dataFeeHeadroomBps?: number;
  readonly maximumTransactionGas?: bigint;
}

export interface PaidGasPlan {
  /** `paymentGasLimit + actionGasLimit + 250000`, the gas the EntryPoint requires at validation. */
  readonly boundedGas: bigint;
  /** Base transaction gas, calldata gas and the data fee with its headroom. */
  readonly envelopeGas: bigint;
  readonly maximumTransactionGas: bigint;
}

/**
 * Intent id of an action for one caller: the same action and salt on the same
 * EntryPoint always map to the same id, so a retry or a restarted app cannot
 * settle it twice. The EntryPoint consumes intent ids across all callers; the
 * salt keeps the id of one caller's action apart from every other caller's.
 */
export function deriveClientIntentId(
  chainId: bigint,
  entryPoint: string,
  target: string,
  data: Uint8Array,
  salt: Uint8Array,
): Uint8Array {
  if (!(salt instanceof Uint8Array) || salt.length !== 32) {
    throw invalid("intentSalt must be 32 bytes");
  }
  return getBytes(
    keccak256(
      concat([
        toUtf8Bytes(CLIENT_INTENT_TAG),
        toBeHex(chainId, 32),
        getAddress(entryPoint),
        getAddress(target),
        keccak256(data),
        salt,
      ]),
    ),
  );
}

/**
 * Size and intrinsic calldata gas of `NoxEntryPoint.execute`. Action bytes are
 * priced exactly; quote, signature and payment bytes are priced as non-zero.
 */
export function paidExecuteCalldata(
  actionData: Uint8Array,
  trackedAssetCount: number,
  paymentDataLength: number,
): { readonly bytes: number; readonly gas: bigint } {
  const padded = (length: number): number => Math.ceil(length / 32) * 32;
  const bytes =
    4 +
    EXECUTE_HEAD_WORDS * 32 +
    32 + padded(SIGNATURE_BYTES) +
    32 + padded(actionData.length) +
    32 + trackedAssetCount * 32 +
    32 + padded(paymentDataLength);
  let zeroBytes = 0;
  for (const byte of actionData) if (byte === 0) zeroBytes += 1;
  const gas =
    BigInt(bytes - zeroBytes) * NONZERO_BYTE_GAS + BigInt(zeroBytes) * ZERO_BYTE_GAS;
  return { bytes, gas };
}

/**
 * The tightest `maximumTransactionGas` an exit accepts for the given limits:
 * what the EntryPoint requires, plus the transaction envelope (the data fee
 * with `dataFeeHeadroomBps`), plus the exit's own estimate buffer and
 * `capHeadroomBps`.
 */
export function planPaidGas(input: PaidGasPlanInput): PaidGasPlan {
  const exitGasBufferBps = bps(
    input.exitGasBufferBps ?? PAID_EXECUTE_DEFAULTS.exitGasBufferBps,
    "exitGasBufferBps",
  );
  const capHeadroomBps = bps(
    input.capHeadroomBps ?? PAID_EXECUTE_DEFAULTS.capHeadroomBps,
    "capHeadroomBps",
  );
  const dataFeeHeadroomBps = bps(
    input.dataFeeHeadroomBps ?? PAID_EXECUTE_DEFAULTS.dataFeeHeadroomBps,
    "dataFeeHeadroomBps",
  );
  for (const [value, field] of [
    [input.paymentGasLimit, "paymentGasLimit"],
    [input.actionGasLimit, "actionGasLimit"],
  ] as const) {
    if (typeof value !== "bigint" || value <= 0n) throw invalid(`${field} must be a positive bigint`);
  }
  const dataFeeGas = input.dataFeeGas ?? 0n;
  if (input.calldataGas < 0n || dataFeeGas < 0n) {
    throw invalid("calldataGas and dataFeeGas must not be negative");
  }
  const boundedGas = input.paymentGasLimit + input.actionGasLimit + ENTRY_POINT_GAS_RESERVE;
  const envelopeGas =
    TRANSACTION_BASE_GAS + input.calldataGas + ceilDiv(dataFeeGas * (BPS + dataFeeHeadroomBps), BPS);
  let maximumTransactionGas = ceilDiv(
    (boundedGas + envelopeGas) * (BPS + exitGasBufferBps) * (BPS + capHeadroomBps),
    BPS * BPS,
  );
  const clamp = input.maximumTransactionGas;
  if (clamp !== undefined && clamp < maximumTransactionGas) {
    if (clamp < boundedGas) {
      throw invalid(
        `gas.maximumTransactionGas ${clamp} is below paymentGasLimit + actionGasLimit + ${ENTRY_POINT_GAS_RESERVE}`,
      );
    }
    maximumTransactionGas = clamp;
  }
  return { boundedGas, envelopeGas, maximumTransactionGas };
}

/** ABI-encode `NoxEntryPoint.execute` (selector `0x8f42c610`) for a signed quote. */
export function encodeEntryPointExecute(
  quote: IssuedPaidQuoteV2,
  actionData: Uint8Array,
  trackedAssets: readonly string[],
  paymentData: Uint8Array,
): Uint8Array {
  return getBytes(
    ENTRY_POINT.encodeFunctionData("execute", [
      quoteTypedData(quote.quote).value,
      quote.exitSignature,
      actionData,
      trackedAssets,
      paymentData,
    ]),
  );
}

/** JSON-RPC transport of a chain reader: `(method, params) => result`. */
export type PaidRpcSend = (method: string, params: unknown[]) => Promise<unknown>;

/** A chain reader over any JSON-RPC transport, for example an RPC provider of your own. */
export function rpcChainReader(send: PaidRpcSend): PaidChainReader {
  const settlement = async (
    entryPoint: string,
    topics: readonly (string | null)[],
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<PaidSettlement | null> => {
    const logs = await send("eth_getLogs", [
      {
        address: entryPoint,
        topics: [SETTLED_TOPIC, ...topics],
        fromBlock: toQuantity(fromBlock),
        toBlock: toQuantity(toBlock),
      },
    ]);
    if (!Array.isArray(logs)) throw new Error("eth_getLogs result is not an array");
    const parsed = logs.map((log) => parseSettlementLog(log, entryPoint));
    if (parsed.length > 1) throw new Error("more than one settlement log matches");
    return parsed[0] ?? null;
  };
  return {
    blockNumber: async () => quantity(await send("eth_blockNumber", []), "eth_blockNumber"),
    call: async (tx, block) =>
      hexData(await send("eth_call", [callObject(tx), blockTag(block)]), "eth_call"),
    estimateGas: async (tx) =>
      quantity(await send("eth_estimateGas", [tx]), "eth_estimateGas"),
    blockTimestamp: async (block) =>
      parsePaidChainTimestamp(await send("eth_getBlockByNumber", [blockTag(block), false])),
    settlementLog: (entryPoint, executionId, fromBlock, toBlock) =>
      settlement(entryPoint, [executionId], fromBlock, toBlock),
    settlementLogByPayment: (entryPoint, paymentId, fromBlock, toBlock) =>
      settlement(entryPoint, [null, paymentId], fromBlock, toBlock),
    transactionInput: async (transactionHash) => {
      const transaction = await send("eth_getTransactionByHash", [transactionHash]);
      if (!isRecord(transaction)) return null;
      return hexData(transaction["input"], "eth_getTransactionByHash input");
    },
  };
}

/**
 * The default chain reader: every read goes through the mixnet and is answered
 * by an exit's RPC endpoint. Exits answer `eth_call` and `eth_estimateGas` for
 * `to` and `data` at their latest block, which serves state and evidence reads
 * and not the preflight.
 */
export function mixnetChainReader(client: Pick<NoxClient, "rpcCall">): PaidChainReader {
  return rpcChainReader((method, params) => client.rpcCall(method, params));
}

/**
 * `dataFeeGas` for Arbitrum chains: the L1 data fee of a transaction in L2 gas,
 * read from `NodeInterface.gasEstimateL1Component` with `eth_call`.
 */
export function arbitrumDataFeeGas(
  reader: Pick<PaidChainReader, "call">,
): NonNullable<PaidChainReader["dataFeeGas"]> {
  return async (tx) => {
    const result = await reader.call(
      {
        to: ARBITRUM_NODE_INTERFACE,
        data: NODE_INTERFACE.encodeFunctionData("gasEstimateL1Component", [tx.to, false, tx.data]),
      },
      "latest",
    );
    const [gas] = NODE_INTERFACE.decodeFunctionResult("gasEstimateL1Component", result);
    return toBigInt(gas as bigint);
  };
}

type NotPaid = Extract<ExecutePaidResult, { status: "not-paid" }>;
type Unknown = Extract<ExecutePaidResult, { status: "unknown" }>;

/** Rejections after which the exit may still hold or have broadcast the transaction. */
const POSSIBLY_BROADCAST = /* @__PURE__ */ new Set<string>(["SubmissionFailure", "DuplicateExecution"]);

/**
 * Pay for one action through a paid exit: quote, checks on the signed quote,
 * payment proof, calldata, simulation, submission and on-chain evidence.
 *
 * Resolves for every runtime condition; it throws only for invalid options.
 * `settled` and `paid-action-failed` are returned from the
 * `PaidExecutionSettled` log alone. Calling it again with the same action and
 * payment source resumes instead of paying twice.
 */
export async function executePaid(
  client: PaidExecutionClient,
  options: ExecutePaidOptions,
): Promise<ExecutePaidResult> {
  const settings = resolveSettings(options);
  const reader = options.chain ?? mixnetChainReader(client);
  const timings: Record<string, number> = {};
  const submitted: SubmittedQuote[] = [];
  const result = await attemptPaid(client, options, settings, reader, timings, submitted);
  const latest = submitted.reduce<SubmittedQuote | undefined>(
    (kept, quote) => (kept === undefined || quote.validUntilUnix > kept.validUntilUnix ? quote : kept),
    undefined,
  );
  if (result.status !== "not-paid" || latest === undefined) return result;
  // An exit that received the calldata can broadcast it until its quote expires.
  const evidence = await paymentEvidence(reader, settings, latest, true, timings);
  return typeof evidence === "string" ? result : evidence;
}

interface SubmittedQuote {
  readonly executionId: string;
  readonly validUntilUnix: bigint;
}

async function attemptPaid(
  client: PaidExecutionClient,
  options: ExecutePaidOptions,
  settings: Settings,
  reader: PaidChainReader,
  timings: Record<string, number>,
  submitted: SubmittedQuote[],
): Promise<ExecutePaidResult> {
  const { action, payment, preflight, pending } = options;
  const startedAt = Date.now();

  try {
    payment.checkAction?.(action);
  } catch (error) {
    return notPaid("precheck", "ACTION_REFUSED", describe(error));
  }

  // Step 1: state of the intent and the payment.
  let pinnedBlock: bigint;
  let pinnedTimestamp: bigint;
  let actionGasLimit: bigint;
  let dataFeeGas: bigint;
  const calldata = paidExecuteCalldata(
    action.data,
    settings.trackedAssets.length,
    payment.paymentDataLength,
  );
  try {
    pinnedBlock = await reader.blockNumber();
    const [paymentConsumed, intentConsumed, timestamp] = await Promise.all([
      readFlag(reader, settings, "isPaymentConsumed", settings.paymentIdHex, pinnedBlock),
      readFlag(reader, settings, "isClientIntentConsumed", settings.intentIdHex, pinnedBlock),
      reader.blockTimestamp(pinnedBlock),
    ]);
    pinnedTimestamp = timestamp;
    if (intentConsumed && paymentConsumed) {
      try {
        return await resume(reader, settings, pinnedBlock, { precheck: Date.now() - startedAt });
      } catch (error) {
        return unknown(
          null,
          null,
          `the intent and the payment id are consumed; reading the settlement failed: ${describe(error)}`,
        );
      }
    }
    if (intentConsumed) {
      return notPaid(
        "precheck",
        "INTENT_CONSUMED",
`intent id ${settings.intentIdHex} is consumed on the EntryPoint by an execution with another payment id; this payment source is unspent`,
      );
    }
    if (paymentConsumed) {
      return notPaid(
        "precheck",
        "PAYMENT_CONSUMED",
        "the payment id is already consumed by another execution",
      );
    }
    if (pending !== undefined && pinnedTimestamp <= pending.validUntilUnix) {
      return unknown(
        pending.executionId,
        pending.validUntilUnix,
        `execution ${pending.executionId} can settle until ${pending.validUntilUnix}; chain time is ${pinnedTimestamp}`,
      );
    }
    actionGasLimit =
      action.gasLimit ??
      (await estimateActionGas(reader, preflight, settings, action, pinnedBlock));
    const readDataFeeGas =
      reader.dataFeeGas ??
      (ARBITRUM_CHAIN_IDS.has(options.chainId) ? arbitrumDataFeeGas(reader) : undefined);
    dataFeeGas =
      readDataFeeGas === undefined
        ? 0n
        : await readDataFeeGas({
            to: settings.entryPoint,
            // Only the length is known before the quote; random bytes do not compress,
            // so the data fee is not underestimated and no calldata leaves the client.
            data: hexlify(randomBytes(calldata.bytes)),
          });
  } catch (error) {
    return notPaid("precheck", "CHAIN_READ_FAILED", describe(error));
  }
  const pinnedAtMs = Date.now();
  timings["precheck"] = pinnedAtMs - startedAt;
  // Chain time is a lower bound on a quiet chain; the local clock covers the gap.
  const nowUnix = (): bigint => {
    const local = Date.now();
    const elapsed = BigInt(Math.max(0, Math.floor((local - pinnedAtMs) / 1000)));
    const localUnix = BigInt(Math.floor(local / 1000));
    return pinnedTimestamp + elapsed > localUnix ? pinnedTimestamp + elapsed : localUnix;
  };

  const usedExits = new Set<string>();
  let contacted = 0;
  let exitGasBufferBps = settings.exitGasBufferBps;
  let last: NotPaid = notPaid("quote", "NO_PAID_EXIT", "no paid exit was contacted");

  while (contacted < settings.maxExits) {
    let plan: PaidGasPlan;
    try {
      plan = planPaidGas({
        paymentGasLimit: payment.gasLimit,
        actionGasLimit,
        calldataGas: calldata.gas,
        dataFeeGas,
        exitGasBufferBps,
        capHeadroomBps: settings.capHeadroomBps,
        dataFeeHeadroomBps: settings.dataFeeHeadroomBps,
        ...(settings.maximumTransactionGas === undefined
          ? {}
          : { maximumTransactionGas: settings.maximumTransactionGas }),
      });
    } catch (error) {
      return notPaid("precheck", "GAS_PLAN", describe(error));
    }

    // Step 2: one signed quote from one exit.
    let requestedExit: ReturnType<PaidExecutionClient["selectPaidExit"]>;
    try {
      requestedExit = client.selectPaidExit({ exclude: [...usedExits] });
    } catch (error) {
      return contacted === 0 ? notPaid("quote", errorCode(error, "NO_PAID_EXIT"), describe(error)) : last;
    }
    usedExits.add(requestedExit.id.toLowerCase());
    const request: PaidQuoteRequestV2 = {
      chainId: options.chainId,
      entryPoint: getBytes(settings.entryPoint),
      clientIntentId: settings.intentId,
      paymentAdapter: getBytes(settings.adapter),
      paymentId: settings.paymentId,
      feeAsset: getBytes(settings.feeAsset),
      paymentGasLimit: payment.gasLimit,
      actionTarget: getBytes(settings.target),
      actionCalldataHash: getBytes(keccak256(action.data)),
      actionGasLimit,
      trackedAssetsHash: getBytes(
        keccak256(AbiCoder.defaultAbiCoder().encode(["address[]"], [settings.trackedAssets])),
      ),
      maximumTransactionGas: plan.maximumTransactionGas,
      returnDataLimit: settings.returnDataLimit,
      validUntilUnix: nowUnix() + BigInt(PAID_EXECUTE_DEFAULTS.quoteRequestTtlSecs),
    };
    const quoteStartedAt = Date.now();
    let issued: IssuedPaidQuoteV2;
    try {
      const outcome = await client.requestPaidQuote(request, requestedExit);
      if (outcome.status === "rejected") {
        contacted += 1;
        last = notPaid("quote", outcome.code, describe(outcome.detail));
        continue;
      }
      issued = outcome;
    } catch (error) {
      const code = error instanceof NoxClientError ? error.code : undefined;
      last = notPaid("quote", errorCode(error, "QUOTE_FAILED"), describe(error));
      if (code === NoxClientErrorCode.ResponseTimeout) {
        // The client may have resent the request to a second exit it does not report.
        contacted += 2;
        continue;
      }
      if (code === NoxClientErrorCode.DecryptionFailed) {
        contacted += 1;
        continue;
      }
      return last;
    }
    timings["quote"] = Date.now() - quoteStartedAt;
    const issuingExit = issued.selectedExit.id.toLowerCase();
    contacted += issuingExit === requestedExit.id.toLowerCase() ? 1 : 2;
    usedExits.add(issuingExit);

    const typed = quoteTypedData(issued.quote).value;
    const executionId = hexlify(issued.executionId);
    const validUntilUnix = issued.quote.validUntilUnix;
    const total = typed.exitFee + typed.networkFee;
    if (total > options.maxTotalFee) {
      return notPaid(
        "fee-cap",
        "FEE_ABOVE_MAXIMUM",
        `quoted fee ${total} exceeds maxTotalFee ${options.maxTotalFee} (exit ${typed.exitAddress})`,
      );
    }
    if (issued.quote.validAfterUnix > nowUnix()) {
      let chainNow: bigint;
      try {
        chainNow = await reader.blockTimestamp("latest");
      } catch (error) {
        return notPaid("quote", "CHAIN_READ_FAILED", describe(error));
      }
      if (issued.quote.validAfterUnix > chainNow) {
        return notPaid(
          "quote",
          "QUOTE_NOT_ACTIVE",
          `quote of exit ${typed.exitAddress} starts at ${issued.quote.validAfterUnix}; chain time is ${chainNow}`,
        );
      }
    }
    const headroom = (): bigint => validUntilUnix - nowUnix();
    if (headroom() < BigInt(settings.minSubmitHeadroomSecs)) {
      return notPaid(
        "expired",
        "QUOTE_HEADROOM",
        `quote leaves ${headroom()} s before validUntil ${validUntilUnix}, below ${settings.minSubmitHeadroomSecs} s`,
      );
    }

    // Step 3: payment proof bound to this execution id, then the exact calldata.
    const paymentStartedAt = Date.now();
    let paymentData: Uint8Array;
    try {
      paymentData = await payment.buildPaymentData({
        executionId: issued.executionId.slice(),
        amount: total,
        feeAsset: settings.feeAsset,
      });
      if (!(paymentData instanceof Uint8Array) || paymentData.length === 0) {
        throw new Error("payment source returned no payment data");
      }
      if (paymentData.length > payment.paymentDataLength) {
        throw new Error(
          `payment data is ${paymentData.length} bytes, above the declared ${payment.paymentDataLength}`,
        );
      }
    } catch (error) {
      return notPaid("payment", "PAYMENT_BUILD_FAILED", describe(error));
    }
    timings["payment"] = Date.now() - paymentStartedAt;
    const executeCalldata = encodeEntryPointExecute(
      issued,
      action.data,
      settings.trackedAssets,
      paymentData,
    );
    const executeHex = hexlify(executeCalldata);

    // Step 4: simulate the exact transaction as the exit will send it.
    const preflightStartedAt = Date.now();
    let estimatedGas: bigint;
    try {
      const [estimate, simulated] = await Promise.all([
        preflight.estimateGas({ from: typed.exitAddress, to: settings.entryPoint, data: executeHex }),
        preflight.call(
          {
            from: typed.exitAddress,
            to: settings.entryPoint,
            data: executeHex,
            gas: plan.maximumTransactionGas,
            gasPrice: typed.maximumFeePerGas,
          },
          "latest",
        ),
      ]);
      estimatedGas = estimate;
      const [outcome] = ENTRY_POINT.decodeFunctionResult("execute", simulated);
      if ((outcome as { success: boolean }).success !== true) {
        return notPaid(
          "preflight",
          "ACTION_WOULD_FAIL",
          "the payment simulates as settling while the action fails; nothing was submitted",
        );
      }
    } catch (error) {
      return notPaid("preflight", "SIMULATION_FAILED", describe(error));
    }
    timings["preflight"] = Date.now() - preflightStartedAt;
    const exitGasLimit = ceilDiv(estimatedGas * (BPS + BigInt(exitGasBufferBps)), BPS);
    if (exitGasLimit > plan.maximumTransactionGas) {
      return notPaid(
        "preflight",
        "GAS_CAP_TOO_LOW",
        `estimate ${estimatedGas} with the exit buffer is ${exitGasLimit}, above the quoted cap ${plan.maximumTransactionGas}`,
      );
    }
    if (settings.dryRun) {
      return {
        status: "dry-run",
        executionId,
        exit: typed.exitAddress,
        exitFee: typed.exitFee,
        networkFee: typed.networkFee,
        maximumTransactionGas: plan.maximumTransactionGas,
        estimatedGas,
        timings: { ...timings },
      };
    }
    if (headroom() < BigInt(settings.minSubmitHeadroomSecs)) {
      return notPaid(
        "expired",
        "QUOTE_HEADROOM",
        `proving and simulation left ${headroom()} s before validUntil ${validUntilUnix}, below ${settings.minSubmitHeadroomSecs} s`,
      );
    }

    // Step 5: submit through the quoting exit.
    const submitStartedAt = Date.now();
    let outcome: PaidTransactionOutcomeV2 | undefined;
    try {
      outcome = await client.submitPaidTransaction(issued, executeCalldata);
    } catch (error) {
      if (error instanceof NoxClientError && error.code === NoxClientErrorCode.InvalidConfig) {
        // Local validation refused the submission; no packet was sent.
        return notPaid("submit", error.code, describe(error));
      }
      // No usable reply: the transaction may or may not have been broadcast.
      // The chain decides below.
    }
    timings["submit"] = Date.now() - submitStartedAt;
    submitted.push({ executionId, validUntilUnix });
    if (outcome?.status === "rejected" && !POSSIBLY_BROADCAST.has(outcome.code)) {
      last = notPaid("submit", outcome.code, describe(outcome.detail));
      if (outcome.code === "GasCapExceeded") {
        exitGasBufferBps += PAID_EXECUTE_DEFAULTS.exitGasBufferStepBps;
      }
      // The rejection is the exit's word; the payment flag is the chain's.
      const evidence = await paymentEvidence(
        reader,
        settings,
        { executionId, validUntilUnix },
        false,
        timings,
      );
      if (typeof evidence !== "string") return evidence;
      continue;
    }

    // Step 6: evidence by execution id, since the exit may replace the transaction.
    const confirmationStartedAt = Date.now();
    const evidence = await awaitSettlement(reader, settings, {
      executionId,
      validUntilUnix,
      fromBlock: pinnedBlock,
      expected: {
        exit: typed.exitAddress,
        exitFee: typed.exitFee,
        networkFee: typed.networkFee,
      },
      deadlineMs:
        confirmationStartedAt +
        (settings.confirmationTimeoutMs ??
          Number(headroom() > 0n ? headroom() : 0n) * 1000 +
            PAID_EXECUTE_DEFAULTS.confirmationGraceMs),
    });
    timings["confirmation"] = Date.now() - confirmationStartedAt;
    if (evidence === "expired") {
      last = notPaid(
        "expired",
        "QUOTE_EXPIRED_UNSETTLED",
        `execution ${executionId} did not settle before validUntil ${validUntilUnix}; nothing was paid`,
      );
      continue;
    }
    if (evidence.status === "unknown") return evidence;
    return settledResult(evidence.settlement, plan.maximumTransactionGas, { ...timings });
  }
  return last;
}

interface Settings {
  readonly entryPoint: string;
  readonly target: string;
  readonly adapter: string;
  readonly feeAsset: string;
  readonly trackedAssets: readonly string[];
  readonly intentId: Uint8Array;
  readonly intentIdHex: string;
  readonly paymentId: Uint8Array;
  readonly paymentIdHex: string;
  readonly actionCalldataHash: string;
  readonly returnDataLimit: number;
  readonly exitGasBufferBps: number;
  readonly capHeadroomBps: number;
  readonly dataFeeHeadroomBps: number;
  readonly actionMarginBps: number;
  readonly maximumTransactionGas: bigint | undefined;
  readonly minSubmitHeadroomSecs: number;
  readonly maxExits: number;
  readonly dryRun: boolean;
  readonly confirmationTimeoutMs: number | undefined;
  readonly pollIntervalMs: number;
  readonly resumeLookbackBlocks: bigint;
}

function resolveSettings(options: ExecutePaidOptions): Settings {
  const { action, payment, gas } = options;
  if (typeof options.chainId !== "bigint" || options.chainId <= 0n) {
    throw invalid("chainId must be a positive bigint");
  }
  if (typeof options.maxTotalFee !== "bigint" || options.maxTotalFee <= 0n) {
    throw invalid("maxTotalFee must be a positive bigint");
  }
  if (!(action.data instanceof Uint8Array)) throw invalid("action.data must be a Uint8Array");
  if (action.gasLimit !== undefined && action.gasLimit <= 0n) {
    throw invalid("action.gasLimit must be positive");
  }
  if (!(payment.paymentId instanceof Uint8Array) || payment.paymentId.length !== 32) {
    throw invalid("payment.paymentId must be 32 bytes");
  }
  if (typeof payment.gasLimit !== "bigint" || payment.gasLimit <= 0n) {
    throw invalid("payment.gasLimit must be a positive bigint");
  }
  if (!Number.isSafeInteger(payment.paymentDataLength) || payment.paymentDataLength <= 0) {
    throw invalid("payment.paymentDataLength must be a positive integer");
  }
  const entryPoint = address(options.entryPoint, "entryPoint");
  const target = address(action.target, "action.target");
  if ((options.clientIntentId === undefined) === (options.intentSalt === undefined)) {
    throw invalid("give exactly one of intentSalt and clientIntentId");
  }
  const intentId =
    options.clientIntentId ??
    deriveClientIntentId(
      options.chainId,
      entryPoint,
      target,
      action.data,
      options.intentSalt as Uint8Array,
    );
  if (!(intentId instanceof Uint8Array) || intentId.length !== 32) {
    throw invalid("clientIntentId must be 32 bytes");
  }
  const preflight: Partial<PaidPreflightReader> | undefined = options.preflight;
  if (typeof preflight?.call !== "function" || typeof preflight.estimateGas !== "function") {
    throw invalid(
      "preflight must be a reader over an RPC endpoint of your choice, such as rpcChainReader(send)",
    );
  }
  const { pending } = options;
  if (
    pending !== undefined &&
    (!/^0x[0-9a-fA-F]{64}$/u.test(pending.executionId) || typeof pending.validUntilUnix !== "bigint")
  ) {
    throw invalid("pending must carry the executionId and validUntilUnix of an unknown result");
  }
  const actionMarginBps = gas?.actionMarginBps ?? PAID_EXECUTE_DEFAULTS.actionMarginBps;
  if (!Number.isSafeInteger(actionMarginBps) || actionMarginBps < Number(BPS)) {
    throw invalid("gas.actionMarginBps must be an integer of at least 10000");
  }
  const exitGasBufferBps = gas?.exitGasBufferBps ?? PAID_EXECUTE_DEFAULTS.exitGasBufferBps;
  const capHeadroomBps = gas?.capHeadroomBps ?? PAID_EXECUTE_DEFAULTS.capHeadroomBps;
  const dataFeeHeadroomBps = gas?.dataFeeHeadroomBps ?? PAID_EXECUTE_DEFAULTS.dataFeeHeadroomBps;
  bps(exitGasBufferBps, "gas.exitGasBufferBps");
  bps(capHeadroomBps, "gas.capHeadroomBps");
  bps(dataFeeHeadroomBps, "gas.dataFeeHeadroomBps");
  return {
    entryPoint,
    target,
    adapter: address(payment.adapter, "payment.adapter"),
    feeAsset: address(payment.feeAsset, "payment.feeAsset"),
    trackedAssets: (action.trackedAssets ?? []).map((asset) => address(asset, "action.trackedAssets")),
    intentId,
    intentIdHex: hexlify(intentId),
    paymentId: payment.paymentId,
    paymentIdHex: hexlify(payment.paymentId),
    actionCalldataHash: keccak256(action.data),
    returnDataLimit: action.returnDataLimit ?? PAID_EXECUTE_DEFAULTS.returnDataLimit,
    exitGasBufferBps,
    capHeadroomBps,
    dataFeeHeadroomBps,
    actionMarginBps,
    maximumTransactionGas: gas?.maximumTransactionGas,
    minSubmitHeadroomSecs: nonNegativeInteger(
      options.minSubmitHeadroomSecs ?? PAID_EXECUTE_DEFAULTS.minSubmitHeadroomSecs,
      "minSubmitHeadroomSecs",
    ),
    maxExits: positiveInteger(options.maxExits ?? PAID_EXECUTE_DEFAULTS.maxExits, "maxExits"),
    dryRun: options.dryRun === true,
    confirmationTimeoutMs:
      options.confirmationTimeoutMs === undefined
        ? undefined
        : nonNegativeInteger(options.confirmationTimeoutMs, "confirmationTimeoutMs"),
    pollIntervalMs: nonNegativeInteger(
      options.pollIntervalMs ?? PAID_EXECUTE_DEFAULTS.pollIntervalMs,
      "pollIntervalMs",
    ),
    resumeLookbackBlocks: options.resumeLookbackBlocks ?? PAID_EXECUTE_DEFAULTS.resumeLookbackBlocks,
  };
}

async function readFlag(
  reader: PaidChainReader,
  settings: Settings,
  flag: "isExecutionConsumed" | "isPaymentConsumed" | "isClientIntentConsumed",
  id: string,
  block: bigint,
): Promise<boolean> {
  const result = await reader.call(
    { to: settings.entryPoint, data: ENTRY_POINT.encodeFunctionData(flag, [id]) },
    block,
  );
  return ENTRY_POINT.decodeFunctionResult(flag, result)[0] === true;
}

/**
 * Estimate path for actions without a declared limit. The answer comes from
 * the preflight reader, so a low answer yields a low limit; callers that hold
 * funds at stake declare `action.gasLimit` instead.
 */
async function estimateActionGas(
  reader: PaidChainReader,
  preflight: PaidPreflightReader,
  settings: Settings,
  action: PaidAction,
  block: bigint,
): Promise<bigint> {
  const predicted = await reader.call(
    {
      to: settings.entryPoint,
      data: ENTRY_POINT.encodeFunctionData("predictSandbox", [settings.intentIdHex]),
    },
    block,
  );
  const [sandbox] = ENTRY_POINT.decodeFunctionResult("predictSandbox", predicted);
  const estimate = await preflight.estimateGas({
    from: sandbox as string,
    to: settings.target,
    data: hexlify(action.data),
  });
  return ceilDiv(estimate * BigInt(settings.actionMarginBps), BPS);
}

/** Newest range first, in ranges the exits serve. */
async function findSettlement(
  fromBlock: bigint,
  toBlock: bigint,
  query: (from: bigint, to: bigint) => Promise<PaidSettlement | null>,
): Promise<PaidSettlement | null> {
  const range = PAID_EXECUTE_DEFAULTS.logRangeBlocks;
  for (let to = toBlock; to >= fromBlock; to -= range) {
    const from = to - range + 1n > fromBlock ? to - range + 1n : fromBlock;
    const found = await query(from, to);
    if (found !== null) return found;
  }
  return null;
}

/** The intent and the payment are both consumed: report the settlement that consumed them. */
async function resume(
  reader: PaidChainReader,
  settings: Settings,
  block: bigint,
  timings: PaidTimings,
): Promise<ExecutePaidResult> {
  const lookback = settings.resumeLookbackBlocks;
  const settlement = await findSettlement(
    block > lookback ? block - lookback : 0n,
    block,
    (from, to) => reader.settlementLogByPayment(settings.entryPoint, settings.paymentIdHex, from, to),
  );
  if (settlement === null) {
    return unknown(
      null,
      null,
      `the intent and the payment id are consumed; no settlement log in the last ${lookback} blocks`,
    );
  }
  // The log does not carry the intent id: the transaction's own calldata links
  // this settlement to this action.
  const input = await reader.transactionInput(settlement.transactionHash);
  if (input === null) {
    return unknown(settlement.executionId, null, "the settlement transaction is not readable");
  }
  const [quote] = ENTRY_POINT.decodeFunctionData("execute", input);
  const settled = quoteFromTuple(quote as QuoteTuple);
  const sameExecution = hashExecutionQuoteV1(settled) === settlement.executionId.toLowerCase();
  const sameAction =
    hexlify(settled.clientIntentId) === settings.intentIdHex &&
    hexlify(settled.actionCalldataHash) === settings.actionCalldataHash &&
    sameAddress(hexlify(settled.actionTarget), settings.target);
  if (!sameExecution) {
    return unknown(
      settlement.executionId,
      null,
      "the settlement transaction does not carry the settled quote",
    );
  }
  if (!sameAction) {
    return notPaid(
      "precheck",
      "PAYMENT_CONSUMED",
      `the payment id was consumed by another action in execution ${settlement.executionId}`,
    );
  }
  return settledResult(settlement, toBigInt(settled.maximumTransactionGas), timings);
}

interface PendingExecution {
  readonly executionId: string;
  readonly validUntilUnix: bigint;
  readonly fromBlock: bigint;
  readonly expected: { readonly exit: string; readonly exitFee: bigint; readonly networkFee: bigint };
  readonly deadlineMs: number;
}

/**
 * Poll until the execution settles, the quote expires unsettled, or the
 * deadline passes. The consumed flag of each round is read at the block whose
 * timestamp is compared, or at a later one when the reader serves its latest
 * block only, so a settlement that lands between two reads is not missed.
 */
async function awaitSettlement(
  reader: PaidChainReader,
  settings: Settings,
  pending: PendingExecution,
): Promise<{ status: "found"; settlement: PaidSettlement } | Unknown | "expired"> {
  let detail = "no chain evidence was read";
  for (;;) {
    try {
      const block = await reader.blockNumber();
      const [consumed, timestamp] = await Promise.all([
        readFlag(reader, settings, "isExecutionConsumed", pending.executionId, block),
        reader.blockTimestamp(block),
      ]);
      if (consumed) {
        const settlement = await findSettlement(pending.fromBlock, block, (from, to) =>
          reader.settlementLog(settings.entryPoint, pending.executionId, from, to),
        );
        if (settlement !== null) {
          const mismatch = settlementMismatch(settlement, settings, pending);
          if (mismatch === null) return { status: "found", settlement };
          return unknown(pending.executionId, pending.validUntilUnix, mismatch);
        }
        detail = "the execution is consumed and its settlement log is not readable yet";
      } else if (timestamp > pending.validUntilUnix) {
        return "expired";
      } else {
        detail = `not settled at block ${block}`;
      }
    } catch (error) {
      detail = `chain read failed: ${describe(error)}`;
    }
    if (Date.now() >= pending.deadlineMs) {
      return unknown(pending.executionId, pending.validUntilUnix, detail);
    }
    await new Promise((resolve) => setTimeout(resolve, settings.pollIntervalMs));
  }
}

/**
 * Whether the payment id was consumed after a submission. With `wait`, polls
 * until it is consumed, the quote has expired on chain, or the deadline passes.
 */
async function paymentEvidence(
  reader: PaidChainReader,
  settings: Settings,
  quote: SubmittedQuote,
  wait: boolean,
  timings: PaidTimings,
): Promise<ExecutePaidResult | "unconsumed" | "expired"> {
  let deadlineMs =
    Date.now() + (settings.confirmationTimeoutMs ?? PAID_EXECUTE_DEFAULTS.confirmationGraceMs);
  let extended = settings.confirmationTimeoutMs !== undefined;
  let detail = "no chain evidence was read";
  for (;;) {
    try {
      const block = await reader.blockNumber();
      const [consumed, timestamp] = await Promise.all([
        readFlag(reader, settings, "isPaymentConsumed", settings.paymentIdHex, block),
        reader.blockTimestamp(block),
      ]);
      if (consumed) return await resume(reader, settings, block, { ...timings });
      if (timestamp > quote.validUntilUnix) return "expired";
      if (!wait) return "unconsumed";
      if (!extended) {
        deadlineMs += Number(quote.validUntilUnix - timestamp) * 1000;
        extended = true;
      }
      detail = `the payment id is unconsumed at block ${block} and execution ${quote.executionId} can settle until ${quote.validUntilUnix}`;
    } catch (error) {
      detail = `chain read failed after a submission: ${describe(error)}`;
      if (!wait) return unknown(quote.executionId, quote.validUntilUnix, detail);
    }
    if (Date.now() >= deadlineMs) {
      return unknown(quote.executionId, quote.validUntilUnix, detail);
    }
    await new Promise((resolve) => setTimeout(resolve, settings.pollIntervalMs));
  }
}

function settlementMismatch(
  settlement: PaidSettlement,
  settings: Settings,
  pending: PendingExecution,
): string | null {
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [settlement.executionId.toLowerCase() === pending.executionId.toLowerCase(), "executionId"],
    [settlement.paymentId.toLowerCase() === settings.paymentIdHex, "paymentId"],
    [sameAddress(settlement.exit, pending.expected.exit), "exit"],
    [sameAddress(settlement.feeAsset, settings.feeAsset), "feeAsset"],
    [sameAddress(settlement.actionTarget, settings.target), "actionTarget"],
    [settlement.exitFee === pending.expected.exitFee, "exitFee"],
    [settlement.networkFee === pending.expected.networkFee, "networkFee"],
  ];
  const failed = checks.find(([ok]) => !ok);
  return failed === undefined ? null : `settlement log ${failed[1]} does not match the quote`;
}

function settledResult(
  settlement: PaidSettlement,
  maximumTransactionGas: bigint,
  timings: PaidTimings,
): ExecutePaidResult {
  const common = {
    executionId: settlement.executionId,
    exit: settlement.exit,
    exitFee: settlement.exitFee,
    networkFee: settlement.networkFee,
    transactionHash: settlement.transactionHash,
    blockNumber: settlement.blockNumber,
    timings,
  };
  return settlement.actionSuccess
    ? { status: "settled", ...common, maximumTransactionGas }
    : {
        status: "paid-action-failed",
        ...common,
        returnDataLength: settlement.returnDataLength,
        returnPrefixHash: settlement.returnPrefixHash,
      };
}

function parseSettlementLog(log: unknown, entryPoint: string): PaidSettlement {
  if (!isRecord(log) || log["removed"] === true) throw new Error("settlement log is malformed");
  const topics = log["topics"];
  const data = log["data"];
  const logAddress = log["address"];
  if (
    !Array.isArray(topics) ||
    !topics.every((topic): topic is string => typeof topic === "string") ||
    typeof data !== "string" ||
    typeof logAddress !== "string" ||
    !sameAddress(logAddress, entryPoint) ||
    topics[0] !== SETTLED_TOPIC
  ) {
    throw new Error("settlement log is not a PaidExecutionSettled event of the EntryPoint");
  }
  const parsed = ENTRY_POINT.parseLog({ topics, data });
  if (parsed === null) throw new Error("settlement log does not decode");
  const { args } = parsed;
  return {
    executionId: args["executionId"] as string,
    paymentId: args["paymentId"] as string,
    exit: args["exit"] as string,
    feeAsset: args["feeAsset"] as string,
    exitFee: args["exitFee"] as bigint,
    networkFee: args["networkFee"] as bigint,
    actionTarget: args["actionTarget"] as string,
    actionSuccess: args["actionSuccess"] as boolean,
    returnDataLength: args["returnDataLength"] as bigint,
    returnPrefixHash: args["returnPrefixHash"] as string,
    transactionHash: hexData(log["transactionHash"], "log transactionHash"),
    blockNumber: quantity(log["blockNumber"], "log blockNumber"),
  };
}

type QuoteTuple = Record<keyof ExecutionQuoteV1, string | bigint>;

function quoteFromTuple(tuple: QuoteTuple): ExecutionQuoteV1 {
  const word = (value: string | bigint): Uint8Array => getBytes(toBeHex(value, 32));
  const bytes = (value: string | bigint): Uint8Array => getBytes(value as string);
  return {
    quoteVersion: Number(tuple.quoteVersion),
    chainId: word(tuple.chainId),
    entryPoint: bytes(tuple.entryPoint),
    exitAddress: bytes(tuple.exitAddress),
    clientIntentId: bytes(tuple.clientIntentId),
    paymentAdapter: bytes(tuple.paymentAdapter),
    paymentId: bytes(tuple.paymentId),
    feeAsset: bytes(tuple.feeAsset),
    exitFee: word(tuple.exitFee),
    networkFee: word(tuple.networkFee),
    paymentGasLimit: word(tuple.paymentGasLimit),
    actionTarget: bytes(tuple.actionTarget),
    actionCalldataHash: bytes(tuple.actionCalldataHash),
    actionGasLimit: word(tuple.actionGasLimit),
    trackedAssetsHash: bytes(tuple.trackedAssetsHash),
    maximumTransactionGas: word(tuple.maximumTransactionGas),
    maximumFeePerGas: word(tuple.maximumFeePerGas),
    returnDataLimit: word(tuple.returnDataLimit),
    validAfterUnix: BigInt(tuple.validAfterUnix),
    validUntilUnix: BigInt(tuple.validUntilUnix),
    quoteNonce: word(tuple.quoteNonce),
  };
}

function callObject(tx: PaidCallRequest): Record<string, string> {
  return {
    ...(tx.from === undefined ? {} : { from: tx.from }),
    to: tx.to,
    data: tx.data,
    ...(tx.gas === undefined ? {} : { gas: toQuantity(tx.gas) }),
    ...(tx.gasPrice === undefined ? {} : { gasPrice: toQuantity(tx.gasPrice) }),
  };
}

function blockTag(block: bigint | "latest"): string {
  return block === "latest" ? block : toQuantity(block);
}

function quantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/u.test(value)) {
    throw new Error(`${field} is not a hex quantity`);
  }
  return BigInt(value);
}

function hexData(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value)) {
    throw new Error(`${field} is not hex data`);
  }
  return value;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function bps(value: number, field: string): bigint {
  return BigInt(nonNegativeInteger(value, field));
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${field} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (nonNegativeInteger(value, field) === 0) throw invalid(`${field} must be positive`);
  return value;
}

function address(value: string, field: string): string {
  try {
    return getAddress(value);
  } catch {
    throw invalid(`${field} is not a valid address`);
  }
}

function invalid(message: string): NoxClientError {
  return new NoxClientError(`Invalid paid execution: ${message}`, NoxClientErrorCode.InvalidConfig);
}

function notPaid(stage: PaidNotPaidStage, code: string, detail: string): NotPaid {
  return { status: "not-paid", stage, code, detail };
}

function unknown(
  executionId: string | null,
  validUntilUnix: bigint | null,
  detail: string,
): Unknown {
  return { status: "unknown", executionId, validUntilUnix, detail };
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof NoxClientError ? error.code : fallback;
}

/** Bounded text of a failure, with the EntryPoint error name when revert data is present. */
function describe(error: unknown): string {
  const text = safeExternalError(error);
  const carried = isRecord(error) ? error["data"] : undefined;
  const candidates = [
    ...(typeof carried === "string" ? [carried] : []),
    ...(text.match(/0x[0-9a-fA-F]{8,}/gu) ?? []),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = ENTRY_POINT.parseError(candidate);
      if (parsed !== null) return `${parsed.name}: ${text}`;
    } catch {
      // Not revert data of the EntryPoint.
    }
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
