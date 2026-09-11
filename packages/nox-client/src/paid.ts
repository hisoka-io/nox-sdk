import {
  TypedDataEncoder,
  getAddress,
  hexlify,
  verifyTypedData,
} from "ethers";
import type {
  ExecutionQuoteV1,
  PaidQuoteOutcomeV2,
  PaidQuoteRequestV2,
} from "./bincode.js";
import { NoxClientError, NoxClientErrorCode } from "./types.js";
import type { TopologyNode } from "./types.js";

const QUOTE_VERSION = 1;
const ENTRY_POINT_GAS_RESERVE = 250_000n;
const MAX_RETURN_DATA_LIMIT = 4_096;
const MAX_U64 = (1n << 64n) - 1n;

const EXECUTION_QUOTE_TYPES = {
  ExecutionQuote: [
    { name: "quoteVersion", type: "uint8" },
    { name: "chainId", type: "uint256" },
    { name: "entryPoint", type: "address" },
    { name: "exitAddress", type: "address" },
    { name: "clientIntentId", type: "bytes32" },
    { name: "paymentAdapter", type: "address" },
    { name: "paymentId", type: "bytes32" },
    { name: "feeAsset", type: "address" },
    { name: "exitFee", type: "uint256" },
    { name: "networkFee", type: "uint256" },
    { name: "paymentGasLimit", type: "uint256" },
    { name: "actionTarget", type: "address" },
    { name: "actionCalldataHash", type: "bytes32" },
    { name: "actionGasLimit", type: "uint256" },
    { name: "trackedAssetsHash", type: "bytes32" },
    { name: "maximumTransactionGas", type: "uint256" },
    { name: "maximumFeePerGas", type: "uint256" },
    { name: "returnDataLimit", type: "uint256" },
    { name: "validAfterUnix", type: "uint64" },
    { name: "validUntilUnix", type: "uint64" },
    { name: "quoteNonce", type: "uint256" },
  ],
};

export type IssuedPaidQuoteV2 = Extract<
  PaidQuoteOutcomeV2,
  { readonly status: "issued" }
> & {
  readonly selectedExit: TopologyNode;
};

export type PaidQuoteResultV2 =
  | IssuedPaidQuoteV2
  | Extract<PaidQuoteOutcomeV2, { readonly status: "rejected" }>;

export async function fetchPaidChainTimestamp(
  ethRpcUrl: string,
  timeoutMs: number,
): Promise<bigint> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ethRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload)) {
      throw new Error("response root is not an object");
    }
    const block = payload["result"];
    if (!isRecord(block)) {
      throw new Error("latest block is missing");
    }
    const timestamp = block["timestamp"];
    if (
      typeof timestamp !== "string" ||
      !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u.test(timestamp)
    ) {
      throw new Error("timestamp is not a canonical hex u64");
    }
    const decoded = BigInt(timestamp);
    if (decoded > MAX_U64) {
      throw new Error("timestamp is not a canonical hex u64");
    }
    return decoded;
  } catch (error) {
    throw new NoxClientError(
      `Paid chain timestamp query failed: ${safeExternalError(error)}`,
      NoxClientErrorCode.TransportFailed,
      error,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function quoteTypedData(quote: ExecutionQuoteV1) {
  const chainId = wordToBigInt(quote.chainId, "quote.chainId");
  const entryPoint = addressHex(quote.entryPoint, "quote.entryPoint");
  return {
    domain: {
      name: "NoxEntryPoint",
      version: "1",
      chainId,
      verifyingContract: entryPoint,
    },
    types: EXECUTION_QUOTE_TYPES,
    value: {
      quoteVersion: quote.quoteVersion,
      chainId,
      entryPoint,
      exitAddress: addressHex(quote.exitAddress, "quote.exitAddress"),
      clientIntentId: fixedHex(quote.clientIntentId, 32, "quote.clientIntentId"),
      paymentAdapter: addressHex(quote.paymentAdapter, "quote.paymentAdapter"),
      paymentId: fixedHex(quote.paymentId, 32, "quote.paymentId"),
      feeAsset: addressHex(quote.feeAsset, "quote.feeAsset"),
      exitFee: wordToBigInt(quote.exitFee, "quote.exitFee"),
      networkFee: wordToBigInt(quote.networkFee, "quote.networkFee"),
      paymentGasLimit: wordToBigInt(
        quote.paymentGasLimit,
        "quote.paymentGasLimit",
      ),
      actionTarget: addressHex(quote.actionTarget, "quote.actionTarget"),
      actionCalldataHash: fixedHex(
        quote.actionCalldataHash,
        32,
        "quote.actionCalldataHash",
      ),
      actionGasLimit: wordToBigInt(quote.actionGasLimit, "quote.actionGasLimit"),
      trackedAssetsHash: fixedHex(
        quote.trackedAssetsHash,
        32,
        "quote.trackedAssetsHash",
      ),
      maximumTransactionGas: wordToBigInt(
        quote.maximumTransactionGas,
        "quote.maximumTransactionGas",
      ),
      maximumFeePerGas: wordToBigInt(
        quote.maximumFeePerGas,
        "quote.maximumFeePerGas",
      ),
      returnDataLimit: wordToBigInt(
        quote.returnDataLimit,
        "quote.returnDataLimit",
      ),
      validAfterUnix: quote.validAfterUnix,
      validUntilUnix: quote.validUntilUnix,
      quoteNonce: wordToBigInt(quote.quoteNonce, "quote.quoteNonce"),
    },
  };
}

export function hashExecutionQuoteV1(quote: ExecutionQuoteV1): string {
  const typed = quoteTypedData(quote);
  return TypedDataEncoder.hash(typed.domain, typed.types, typed.value);
}

export function validatePaidQuoteRequest(
  request: PaidQuoteRequestV2,
  nowUnix: bigint,
): void {
  requireU64(request.chainId, "chainId", true);
  requireNonZero(request.entryPoint, 20, "entryPoint");
  requireNonZero(request.clientIntentId, 32, "clientIntentId");
  requireNonZero(request.paymentAdapter, 20, "paymentAdapter");
  requireNonZero(request.paymentId, 32, "paymentId");
  requireNonZero(request.feeAsset, 20, "feeAsset");
  requireNonZero(request.actionTarget, 20, "actionTarget");
  requireNonZero(request.actionCalldataHash, 32, "actionCalldataHash");
  requireFixed(request.trackedAssetsHash, 32, "trackedAssetsHash");
  requireU64(request.paymentGasLimit, "paymentGasLimit", true);
  requireU64(request.actionGasLimit, "actionGasLimit", true);
  requireU64(request.maximumTransactionGas, "maximumTransactionGas", true);
  requireU64(request.validUntilUnix, "validUntilUnix", true);
  if (!Number.isSafeInteger(request.returnDataLimit) || request.returnDataLimit < 0) {
    throw invalidRequest("returnDataLimit must be a non-negative integer");
  }
  if (request.returnDataLimit > MAX_RETURN_DATA_LIMIT) {
    throw invalidRequest(
      `returnDataLimit exceeds the EntryPoint cap ${MAX_RETURN_DATA_LIMIT}`,
    );
  }
  const boundedGas =
    request.paymentGasLimit + request.actionGasLimit + ENTRY_POINT_GAS_RESERVE;
  if (request.maximumTransactionGas < boundedGas) {
    throw invalidRequest(
      `maximumTransactionGas must cover paymentGasLimit + actionGasLimit + ${ENTRY_POINT_GAS_RESERVE}`,
    );
  }
  if (request.validUntilUnix <= nowUnix) {
    throw invalidRequest("validUntilUnix must be in the future");
  }
}

export function validateIssuedPaidQuote(
  outcome: PaidQuoteOutcomeV2,
  request: PaidQuoteRequestV2 | undefined,
  selectedExit: TopologyNode,
  chainTimestamp?: bigint,
): IssuedPaidQuoteV2 {
  if (outcome.status !== "issued") {
    throw invalidQuote(`exit rejected the quote with ${outcome.code}`);
  }
  const { quote } = outcome;
  if (quote.quoteVersion !== QUOTE_VERSION) {
    throw invalidQuote(`quoteVersion must be ${QUOTE_VERSION}`);
  }
  const selectedExitAddress = normalizeAddress(selectedExit.id, "selected exit");
  const quoteExitAddress = normalizeAddress(
    addressHex(quote.exitAddress, "quote.exitAddress"),
    "quote.exitAddress",
  );
  if (quoteExitAddress !== selectedExitAddress) {
    throw invalidQuote("quote exit does not match the selected exit");
  }
  const digest = hashExecutionQuoteV1(quote);
  if (fixedHex(outcome.executionId, 32, "executionId").toLowerCase() !== digest) {
    throw invalidQuote("executionId does not match the signed quote");
  }
  const signature = fixedHex(outcome.exitSignature, 65, "exitSignature");
  let signer: string;
  try {
    const typed = quoteTypedData(quote);
    signer = verifyTypedData(
      typed.domain,
      typed.types,
      typed.value,
      signature,
    ).toLowerCase();
  } catch {
    throw invalidQuote("exit signature is invalid");
  }
  if (signer !== selectedExitAddress) {
    throw invalidQuote("exit signature does not recover the selected exit");
  }
  validateQuoteBounds(quote, chainTimestamp);
  if (request !== undefined) validateQuoteMatchesRequest(quote, request);
  return {
    ...outcome,
    selectedExit: cloneTopologyNode(selectedExit),
  };
}

function validateQuoteBounds(
  quote: ExecutionQuoteV1,
  chainTimestamp: bigint | undefined,
): void {
  const paymentGas = wordToBigInt(quote.paymentGasLimit, "quote.paymentGasLimit");
  const actionGas = wordToBigInt(quote.actionGasLimit, "quote.actionGasLimit");
  const maximumGas = wordToBigInt(
    quote.maximumTransactionGas,
    "quote.maximumTransactionGas",
  );
  if (paymentGas === 0n || actionGas === 0n) {
    throw invalidQuote("payment and action gas limits must be positive");
  }
  if (maximumGas < paymentGas + actionGas + ENTRY_POINT_GAS_RESERVE) {
    throw invalidQuote("maximum transaction gas does not cover the EntryPoint reserve");
  }
  if (wordToBigInt(quote.maximumFeePerGas, "quote.maximumFeePerGas") === 0n) {
    throw invalidQuote("maximumFeePerGas must be positive");
  }
  if (
    wordToBigInt(quote.exitFee, "quote.exitFee") +
      wordToBigInt(quote.networkFee, "quote.networkFee") ===
    0n
  ) {
    throw invalidQuote("quoted payment must be positive");
  }
  const returnDataLimit = wordToBigInt(
    quote.returnDataLimit,
    "quote.returnDataLimit",
  );
  if (returnDataLimit > BigInt(MAX_RETURN_DATA_LIMIT)) {
    throw invalidQuote("returnDataLimit exceeds the EntryPoint cap");
  }
  if (quote.validAfterUnix > quote.validUntilUnix) {
    throw invalidQuote("quote has an invalid validity window");
  }
  if (chainTimestamp !== undefined && quote.validAfterUnix > chainTimestamp) {
    throw invalidQuote("quote is not active yet");
  }
  if (chainTimestamp !== undefined && chainTimestamp > quote.validUntilUnix) {
    throw invalidQuote("quote is expired");
  }
}

function validateQuoteMatchesRequest(
  quote: ExecutionQuoteV1,
  request: PaidQuoteRequestV2,
): void {
  const byteFields: ReadonlyArray<
    readonly [Uint8Array, Uint8Array, string]
  > = [
    [quote.entryPoint, request.entryPoint, "entryPoint"],
    [quote.clientIntentId, request.clientIntentId, "clientIntentId"],
    [quote.paymentAdapter, request.paymentAdapter, "paymentAdapter"],
    [quote.paymentId, request.paymentId, "paymentId"],
    [quote.feeAsset, request.feeAsset, "feeAsset"],
    [quote.actionTarget, request.actionTarget, "actionTarget"],
    [quote.actionCalldataHash, request.actionCalldataHash, "actionCalldataHash"],
    [quote.trackedAssetsHash, request.trackedAssetsHash, "trackedAssetsHash"],
  ];
  for (const [quoted, requested, field] of byteFields) {
    if (!bytesEqual(quoted, requested)) {
      throw invalidQuote(`${field} does not match the quote request`);
    }
  }
  const numericFields: ReadonlyArray<readonly [bigint, bigint, string]> = [
    [wordToBigInt(quote.chainId, "quote.chainId"), request.chainId, "chainId"],
    [
      wordToBigInt(quote.paymentGasLimit, "quote.paymentGasLimit"),
      request.paymentGasLimit,
      "paymentGasLimit",
    ],
    [
      wordToBigInt(quote.actionGasLimit, "quote.actionGasLimit"),
      request.actionGasLimit,
      "actionGasLimit",
    ],
    [
      wordToBigInt(quote.maximumTransactionGas, "quote.maximumTransactionGas"),
      request.maximumTransactionGas,
      "maximumTransactionGas",
    ],
    [
      wordToBigInt(quote.returnDataLimit, "quote.returnDataLimit"),
      BigInt(request.returnDataLimit),
      "returnDataLimit",
    ],
  ];
  for (const [quoted, requested, field] of numericFields) {
    if (quoted !== requested) {
      throw invalidQuote(`${field} does not match the quote request`);
    }
  }
  if (quote.validUntilUnix > request.validUntilUnix) {
    throw invalidQuote("validUntilUnix exceeds the requested deadline");
  }
}

function cloneTopologyNode(node: TopologyNode): TopologyNode {
  return {
    ...node,
    publicKey: node.publicKey.slice(),
  };
}

function wordToBigInt(value: Uint8Array, field: string): bigint {
  requireFixed(value, 32, field);
  return BigInt(hexlify(value));
}

function addressHex(value: Uint8Array, field: string): string {
  requireFixed(value, 20, field);
  try {
    return getAddress(hexlify(value));
  } catch (error) {
    throw invalidQuote(`${field} is not a valid address: ${String(error)}`);
  }
}

function fixedHex(value: Uint8Array, length: number, field: string): string {
  requireFixed(value, length, field);
  return hexlify(value);
}

function normalizeAddress(value: string, field: string): string {
  try {
    return getAddress(value).toLowerCase();
  } catch (error) {
    throw invalidQuote(`${field} is not a valid address: ${String(error)}`);
  }
}

function requireFixed(value: Uint8Array, length: number, field: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw invalidQuote(`${field} must be ${length} bytes`);
  }
}

function requireNonZero(
  value: Uint8Array,
  length: number,
  field: string,
): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw invalidRequest(`${field} must be ${length} bytes`);
  }
  if (value.every((byte) => byte === 0)) {
    throw invalidRequest(`${field} must not be zero`);
  }
}

function requireU64(value: bigint, field: string, positive: boolean): void {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    throw invalidRequest(`${field} must fit an unsigned 64-bit integer`);
  }
  if (positive && value === 0n) {
    throw invalidRequest(`${field} must be positive`);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function invalidRequest(message: string): NoxClientError {
  return new NoxClientError(
    `Invalid paid quote request: ${message}`,
    NoxClientErrorCode.InvalidConfig,
  );
}

function invalidQuote(message: string): NoxClientError {
  return new NoxClientError(
    `Invalid paid quote response: ${message}`,
    NoxClientErrorCode.DecryptionFailed,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeExternalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s]+/gu, "[redacted URL]")
    .replace(/[\u0000-\u001f\u007f]/gu, "?")
    .slice(0, 160);
}
