import { NoxClientError, NoxClientErrorCode } from "./types.js";
import type { FecInfo } from "./fragmentation.js";
import { bytesToHex } from "./utils.js";

export const PAYLOAD_VERSION = 1;
export const MAX_SUBMIT_REJECTION_DETAIL_BYTES = 256;

export const SUBMIT_REJECTION_CODES = [
  "SIMULATION",
  "PAYMENT_MISSING",
  "PRICE_UNAVAILABLE",
  "UNPROFITABLE",
  "GAS_PLAN",
  "DUPLICATE",
  "SUBMISSION",
] as const;

export type SubmitRejectionCode = (typeof SUBMIT_REJECTION_CODES)[number];

export type SubmitTransactionResponse =
  | {
      readonly status: "submitted";
      readonly transactionHash: string;
    }
  | {
      readonly status: "rejected";
      readonly code: SubmitRejectionCode;
      readonly detail: string;
    };

const SUBMIT_ERROR_PREFIX = new TextEncoder().encode("tx_error:");

export type RelayerPayload =
  | { tag: "SubmitTransaction"; to: Uint8Array; data: Uint8Array }
  | { tag: "Dummy"; padding: Uint8Array }
  | { tag: "Heartbeat"; id: bigint; timestamp: bigint }
  | { tag: "Fragment"; frag: FragmentWire }
  | { tag: "AnonymousRequest"; inner: Uint8Array; replySurbs: Uint8Array[] }
  | { tag: "ServiceResponse"; requestId: bigint; fragment: FragmentWire }
  | { tag: "NeedMoreSurbs"; requestId: bigint; fragmentsRemaining: number };

export interface PaidTransactionRequestV2 {
  readonly chainId: bigint;
  readonly entryPoint: Uint8Array;
  readonly calldata: Uint8Array;
  readonly executionId: Uint8Array;
  readonly validUntilUnix: bigint;
}

export interface PaidQuoteRequestV2 {
  readonly chainId: bigint;
  readonly entryPoint: Uint8Array;
  readonly clientIntentId: Uint8Array;
  readonly paymentAdapter: Uint8Array;
  readonly paymentId: Uint8Array;
  readonly feeAsset: Uint8Array;
  readonly paymentGasLimit: bigint;
  readonly actionTarget: Uint8Array;
  readonly actionCalldataHash: Uint8Array;
  readonly actionGasLimit: bigint;
  readonly trackedAssetsHash: Uint8Array;
  readonly maximumTransactionGas: bigint;
  readonly returnDataLimit: number;
  readonly validUntilUnix: bigint;
}

export interface ExecutionQuoteV1 {
  readonly quoteVersion: number;
  readonly chainId: Uint8Array;
  readonly entryPoint: Uint8Array;
  readonly exitAddress: Uint8Array;
  readonly clientIntentId: Uint8Array;
  readonly paymentAdapter: Uint8Array;
  readonly paymentId: Uint8Array;
  readonly feeAsset: Uint8Array;
  readonly exitFee: Uint8Array;
  readonly networkFee: Uint8Array;
  readonly paymentGasLimit: Uint8Array;
  readonly actionTarget: Uint8Array;
  readonly actionCalldataHash: Uint8Array;
  readonly actionGasLimit: Uint8Array;
  readonly trackedAssetsHash: Uint8Array;
  readonly maximumTransactionGas: Uint8Array;
  readonly maximumFeePerGas: Uint8Array;
  readonly returnDataLimit: Uint8Array;
  readonly validAfterUnix: bigint;
  readonly validUntilUnix: bigint;
  readonly quoteNonce: Uint8Array;
}

export type ServiceRequest =
  | { tag: "Echo"; data: Uint8Array }
  | {
      tag: "HttpRequest";
      method: string;
      url: string;
      headers: [string, string][];
      body: Uint8Array;
    }
  | {
      tag: "RpcRequest";
      method: string;
      params: Uint8Array;
      id: bigint;
      rpcUrl: string | null;
    }
  | { tag: "SubmitTransaction"; to: Uint8Array; data: Uint8Array }
  | {
      tag: "BroadcastSignedTransaction";
      signedTx: Uint8Array;
      rpcUrl: string | null;
      rpcMethod: string | null;
    }
  | { tag: "ReplenishSurbs"; requestId: bigint; surbs: Uint8Array[] }
  | ({ tag: "PaidTransactionV2" } & PaidTransactionRequestV2)
  | ({ tag: "PaidQuoteRequestV2" } & PaidQuoteRequestV2);

export const PAID_TRANSACTION_REJECTION_CODES_V2 = [
  "MalformedRequest",
  "WrongChain",
  "WrongEntryPoint",
  "UnknownQuote",
  "ExpiredQuote",
  "DuplicateExecution",
  "SimulationFailure",
  "PaymentMissing",
  "PaymentReverted",
  "UnsupportedFeeAsset",
  "StalePrice",
  "Unprofitable",
  "GasCapExceeded",
  "SubmissionFailure",
  "UnsupportedPaymentAdapter",
  "QuoteCapacityExceeded",
  "PendingLossLimit",
] as const;

export type PaidTransactionRejectionCodeV2 =
  (typeof PAID_TRANSACTION_REJECTION_CODES_V2)[number];

export type PaidTransactionOutcomeV2 =
  | {
      readonly status: "submitted";
      readonly executionId: Uint8Array;
      readonly transactionHash: Uint8Array;
    }
  | {
      readonly status: "rejected";
      readonly executionId: Uint8Array | null;
      readonly code: PaidTransactionRejectionCodeV2;
      readonly retryable: boolean;
      readonly detail: string;
    };

export type PaidQuoteOutcomeV2 =
  | {
      readonly status: "issued";
      readonly quote: ExecutionQuoteV1;
      readonly executionId: Uint8Array;
      readonly exitSignature: Uint8Array;
    }
  | {
      readonly status: "rejected";
      readonly code: PaidTransactionRejectionCodeV2;
      readonly retryable: boolean;
      readonly detail: string;
    };

export interface FragmentWire {
  messageId: bigint;
  totalFragments: number;
  sequence: number;
  data: Uint8Array;
  fec: FecInfo | null;
}

/** Encode a `ServiceRequest` with the version prefix byte. */
export function encodeServiceRequest(req: ServiceRequest): Uint8Array {
  const w = new Writer();
  w.u8(PAYLOAD_VERSION);
  writeServiceRequest(w, req);
  return w.finish();
}

/** Encode a `RelayerPayload` with the version prefix byte. */
export function encodeRelayerPayload(payload: RelayerPayload): Uint8Array {
  const w = new Writer();
  w.u8(PAYLOAD_VERSION);
  writeRelayerPayload(w, payload);
  return w.finish();
}

/** Decode a versioned wire payload into a `RelayerPayload`. */
export function decodeRelayerPayload(bytes: Uint8Array): RelayerPayload {
  checkVersion(bytes);
  const r = new Reader(bytes, 1);
  return readRelayerPayload(r);
}

/** Decode a versioned wire payload into a `ServiceRequest`. */
export function decodeServiceRequest(bytes: Uint8Array): ServiceRequest {
  checkVersion(bytes);
  const r = new Reader(bytes, 1);
  const request = readServiceRequest(r);
  r.expectEnd("ServiceRequest");
  return request;
}

export function encodePaidTransactionOutcomeV2(
  outcome: PaidTransactionOutcomeV2,
): Uint8Array {
  const writer = new Writer();
  writer.u8(PAYLOAD_VERSION);
  if (outcome.status === "submitted") {
    writer.u32(0);
    assertLen(outcome.executionId, 32, "PaidTransactionOutcomeV2.executionId");
    assertLen(
      outcome.transactionHash,
      32,
      "PaidTransactionOutcomeV2.transactionHash",
    );
    writer.fixedBytes(outcome.executionId);
    writer.fixedBytes(outcome.transactionHash);
  } else {
    writer.u32(1);
    if (outcome.executionId === null) {
      writer.u8(0);
    } else {
      writer.u8(1);
      assertLen(
        outcome.executionId,
        32,
        "PaidTransactionOutcomeV2.executionId",
      );
      writer.fixedBytes(outcome.executionId);
    }
    writePaidV2Rejection(writer, outcome);
  }
  return writer.finish();
}

export function decodePaidTransactionOutcomeV2(
  bytes: Uint8Array,
): PaidTransactionOutcomeV2 {
  checkVersion(bytes);
  const reader = new Reader(bytes, 1);
  const variant = reader.u32();
  let outcome: PaidTransactionOutcomeV2;
  if (variant === 0) {
    outcome = {
      status: "submitted",
      executionId: reader.fixedBytes(32),
      transactionHash: reader.fixedBytes(32),
    };
  } else if (variant === 1) {
    const option = reader.u8();
    if (option !== 0 && option !== 1) {
      throw invalidV2Outcome("execution_id option tag is invalid");
    }
    const executionId = option === 1 ? reader.fixedBytes(32) : null;
    outcome = {
      status: "rejected",
      executionId,
      ...readPaidV2Rejection(reader, invalidV2Outcome),
    };
  } else {
    throw invalidV2Outcome(`unknown outcome variant ${variant}`);
  }
  reader.expectEnd("PaidTransactionOutcomeV2");
  return outcome;
}

export function encodePaidQuoteOutcomeV2(
  outcome: PaidQuoteOutcomeV2,
): Uint8Array {
  const writer = new Writer();
  writer.u8(PAYLOAD_VERSION);
  if (outcome.status === "issued") {
    writer.u32(0);
    writeExecutionQuoteV1(writer, outcome.quote);
    assertLen(outcome.executionId, 32, "PaidQuoteOutcomeV2.executionId");
    assertLen(outcome.exitSignature, 65, "PaidQuoteOutcomeV2.exitSignature");
    writer.fixedBytes(outcome.executionId);
    writer.bytes(outcome.exitSignature);
  } else {
    writer.u32(1);
    writePaidV2Rejection(writer, outcome);
  }
  return writer.finish();
}

export function decodePaidQuoteOutcomeV2(
  bytes: Uint8Array,
): PaidQuoteOutcomeV2 {
  checkVersion(bytes);
  const reader = new Reader(bytes, 1);
  const variant = reader.u32();
  let outcome: PaidQuoteOutcomeV2;
  if (variant === 0) {
    const quote = readExecutionQuoteV1(reader);
    const executionId = reader.fixedBytes(32);
    const exitSignature = reader.bytes();
    if (exitSignature.length !== 65) {
      throw invalidQuoteOutcome("exit signature must be 65 bytes");
    }
    outcome = {
      status: "issued",
      quote,
      executionId,
      exitSignature,
    };
  } else if (variant === 1) {
    outcome = {
      status: "rejected",
      ...readPaidV2Rejection(reader, invalidQuoteOutcome),
    };
  } else {
    throw invalidQuoteOutcome(`unknown outcome variant ${variant}`);
  }
  reader.expectEnd("PaidQuoteOutcomeV2");
  return outcome;
}

function writePaidV2Rejection(
  writer: Writer,
  rejection: {
    readonly code: PaidTransactionRejectionCodeV2;
    readonly retryable: boolean;
    readonly detail: string;
  },
): void {
  const codeIndex = PAID_TRANSACTION_REJECTION_CODES_V2.indexOf(
    rejection.code,
  );
  if (codeIndex < 0) {
    throw invalidV2Encoding("rejection code is unsupported");
  }
  const detailBytes = new TextEncoder().encode(rejection.detail);
  if (
    detailBytes.length === 0 ||
    detailBytes.length > MAX_SUBMIT_REJECTION_DETAIL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(rejection.detail)
  ) {
    throw invalidV2Encoding("rejection detail is empty, oversized, or contains controls");
  }
  writer.u32(codeIndex);
  writer.u8(rejection.retryable ? 1 : 0);
  writer.bytes(detailBytes);
}

function readPaidV2Rejection(
  reader: Reader,
  invalid: (message: string) => NoxClientError,
): {
  code: PaidTransactionRejectionCodeV2;
  retryable: boolean;
  detail: string;
} {
  const code = PAID_TRANSACTION_REJECTION_CODES_V2[reader.u32()];
  if (code === undefined) {
    throw invalid("rejection code is unsupported");
  }
  const retryable = reader.u8();
  if (retryable !== 0 && retryable !== 1) {
    throw invalid("retryable flag is invalid");
  }
  const detailBytes = reader.bytes();
  if (
    detailBytes.length === 0 ||
    detailBytes.length > MAX_SUBMIT_REJECTION_DETAIL_BYTES
  ) {
    throw invalid("rejection detail is empty or exceeds 256 bytes");
  }
  let detail: string;
  try {
    detail = new TextDecoder("utf-8", { fatal: true }).decode(detailBytes);
  } catch {
    throw invalid("rejection detail is not valid UTF-8");
  }
  if (/[\u0000-\u001f\u007f]/u.test(detail)) {
    throw invalid("rejection detail contains controls");
  }
  return { code, retryable: retryable === 1, detail };
}

function writeExecutionQuoteV1(
  writer: Writer,
  quote: ExecutionQuoteV1,
): void {
  writer.u8(quote.quoteVersion);
  writeFixed(writer, quote.chainId, 32, "ExecutionQuoteV1.chainId");
  writeFixed(writer, quote.entryPoint, 20, "ExecutionQuoteV1.entryPoint");
  writeFixed(writer, quote.exitAddress, 20, "ExecutionQuoteV1.exitAddress");
  writeFixed(writer, quote.clientIntentId, 32, "ExecutionQuoteV1.clientIntentId");
  writeFixed(writer, quote.paymentAdapter, 20, "ExecutionQuoteV1.paymentAdapter");
  writeFixed(writer, quote.paymentId, 32, "ExecutionQuoteV1.paymentId");
  writeFixed(writer, quote.feeAsset, 20, "ExecutionQuoteV1.feeAsset");
  writeFixed(writer, quote.exitFee, 32, "ExecutionQuoteV1.exitFee");
  writeFixed(writer, quote.networkFee, 32, "ExecutionQuoteV1.networkFee");
  writeFixed(writer, quote.paymentGasLimit, 32, "ExecutionQuoteV1.paymentGasLimit");
  writeFixed(writer, quote.actionTarget, 20, "ExecutionQuoteV1.actionTarget");
  writeFixed(writer, quote.actionCalldataHash, 32, "ExecutionQuoteV1.actionCalldataHash");
  writeFixed(writer, quote.actionGasLimit, 32, "ExecutionQuoteV1.actionGasLimit");
  writeFixed(writer, quote.trackedAssetsHash, 32, "ExecutionQuoteV1.trackedAssetsHash");
  writeFixed(writer, quote.maximumTransactionGas, 32, "ExecutionQuoteV1.maximumTransactionGas");
  writeFixed(writer, quote.maximumFeePerGas, 32, "ExecutionQuoteV1.maximumFeePerGas");
  writeFixed(writer, quote.returnDataLimit, 32, "ExecutionQuoteV1.returnDataLimit");
  writer.u64(quote.validAfterUnix);
  writer.u64(quote.validUntilUnix);
  writeFixed(writer, quote.quoteNonce, 32, "ExecutionQuoteV1.quoteNonce");
}

function readExecutionQuoteV1(reader: Reader): ExecutionQuoteV1 {
  return {
    quoteVersion: reader.u8(),
    chainId: reader.fixedBytes(32),
    entryPoint: reader.fixedBytes(20),
    exitAddress: reader.fixedBytes(20),
    clientIntentId: reader.fixedBytes(32),
    paymentAdapter: reader.fixedBytes(20),
    paymentId: reader.fixedBytes(32),
    feeAsset: reader.fixedBytes(20),
    exitFee: reader.fixedBytes(32),
    networkFee: reader.fixedBytes(32),
    paymentGasLimit: reader.fixedBytes(32),
    actionTarget: reader.fixedBytes(20),
    actionCalldataHash: reader.fixedBytes(32),
    actionGasLimit: reader.fixedBytes(32),
    trackedAssetsHash: reader.fixedBytes(32),
    maximumTransactionGas: reader.fixedBytes(32),
    maximumFeePerGas: reader.fixedBytes(32),
    returnDataLimit: reader.fixedBytes(32),
    validAfterUnix: reader.u64(),
    validUntilUnix: reader.u64(),
    quoteNonce: reader.fixedBytes(32),
  };
}

function writeFixed(
  writer: Writer,
  value: Uint8Array,
  length: number,
  name: string,
): void {
  assertLen(value, length, name);
  writer.fixedBytes(value);
}

export function decodeSubmitTransactionResponse(
  bytes: Uint8Array,
): SubmitTransactionResponse {
  if (startsWith(bytes, SUBMIT_ERROR_PREFIX)) {
    return decodeSubmitRejection(bytes);
  }
  if (bytes.length === 32) {
    return {
      status: "submitted",
      transactionHash: `0x${bytesToHex(bytes)}`,
    };
  }
  throw invalidSubmitResponse("expected a 32-byte hash or typed rejection");
}

function decodeSubmitRejection(bytes: Uint8Array): SubmitTransactionResponse {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidSubmitResponse("rejection is not valid UTF-8");
  }

  const encoded = text.slice("tx_error:".length);
  const separator = encoded.indexOf(":");
  if (separator <= 0) {
    throw invalidSubmitResponse("rejection is missing its code or detail");
  }

  const code = encoded.slice(0, separator);
  if (!SUBMIT_REJECTION_CODES.some((candidate) => candidate === code)) {
    throw invalidSubmitResponse("rejection code is unsupported");
  }

  const detail = encoded.slice(separator + 1);
  if (detail.length === 0 || /[\u0000-\u001f\u007f]/u.test(detail)) {
    throw invalidSubmitResponse("rejection detail is empty or contains controls");
  }
  if (new TextEncoder().encode(detail).length > MAX_SUBMIT_REJECTION_DETAIL_BYTES) {
    throw invalidSubmitResponse("rejection detail exceeds 256 bytes");
  }

  return {
    status: "rejected",
    code: code as SubmitRejectionCode,
    detail,
  };
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return (
    bytes.length >= prefix.length &&
    prefix.every((byte, index) => bytes[index] === byte)
  );
}

function invalidSubmitResponse(message: string): NoxClientError {
  return new NoxClientError(
    `Invalid submit transaction response: ${message}`,
    NoxClientErrorCode.DecryptionFailed,
  );
}

function invalidV2Outcome(message: string): NoxClientError {
  return new NoxClientError(
    `Invalid PaidTransactionOutcomeV2: ${message}`,
    NoxClientErrorCode.DecryptionFailed,
  );
}

function invalidQuoteOutcome(message: string): NoxClientError {
  return new NoxClientError(
    `Invalid PaidQuoteOutcomeV2: ${message}`,
    NoxClientErrorCode.DecryptionFailed,
  );
}

function invalidV2Encoding(message: string): NoxClientError {
  return new NoxClientError(
    `Invalid paid-v2 encoding: ${message}`,
    NoxClientErrorCode.PacketBuildFailed,
  );
}

function checkVersion(bytes: Uint8Array): void {
  if (bytes.length === 0) {
    throw new NoxClientError(
      "Cannot decode empty payload bytes",
      NoxClientErrorCode.DecryptionFailed,
    );
  }
  const ver = bytes[0]!;
  if (ver !== PAYLOAD_VERSION) {
    throw new NoxClientError(
      `Unsupported payload version ${ver} (expected ${PAYLOAD_VERSION})`,
      NoxClientErrorCode.DecryptionFailed,
    );
  }
}

class Writer {
  private readonly chunks: Uint8Array[] = [];
  private totalLen = 0;

  u8(v: number): void {
    this.raw(new Uint8Array([v & 0xff]));
  }

  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.raw(b);
  }

  u64(v: bigint): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    this.raw(b);
  }

  bytes(v: Uint8Array): void {
    this.u64(BigInt(v.length));
    if (v.length > 0) this.raw(v);
  }

  fixedBytes(v: Uint8Array): void {
    if (v.length > 0) this.raw(v);
  }

  string(v: string): void {
    this.bytes(new TextEncoder().encode(v));
  }

  optString(v: string | null): void {
    if (v === null) {
      this.u8(0);
    } else {
      this.u8(1);
      this.string(v);
    }
  }

  private raw(chunk: Uint8Array): void {
    this.chunks.push(new Uint8Array(chunk));
    this.totalLen += chunk.length;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.totalLen);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

class Reader {
  private pos: number;
  private readonly view: DataView;
  private readonly buf: Uint8Array;

  constructor(bytes: Uint8Array, offset = 0) {
    this.buf = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = offset;
  }

  private ensure(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new NoxClientError(
        `Unexpected end of payload at offset ${this.pos} (need ${n} more bytes, have ${this.buf.length - this.pos})`,
        NoxClientErrorCode.DecryptionFailed,
      );
    }
  }

  u8(): number {
    this.ensure(1);
    return this.view.getUint8(this.pos++);
  }

  u32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u64(): bigint {
    this.ensure(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }

  bytes(): Uint8Array {
    const len = Number(this.u64());
    this.ensure(len);
    const slice = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  fixedBytes(n: number): Uint8Array {
    this.ensure(n);
    const slice = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  optString(): string | null {
    return this.u8() === 0 ? null : this.string();
  }

  expectEnd(typeName: string): void {
    if (this.pos !== this.buf.length) {
      throw new NoxClientError(
        `${typeName} has ${this.buf.length - this.pos} trailing bytes`,
        NoxClientErrorCode.DecryptionFailed,
      );
    }
  }
}

function writeFragmentWire(w: Writer, f: FragmentWire): void {
  w.u64(f.messageId);
  w.u32(f.totalFragments);
  w.u32(f.sequence);
  w.bytes(f.data);
  if (f.fec === null) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u32(f.fec.dataShardCount);
    w.u64(BigInt(f.fec.originalDataLen));
  }
}

function readFragmentWire(r: Reader): FragmentWire {
  const messageId = r.u64();
  const totalFragments = r.u32();
  const sequence = r.u32();
  const data = r.bytes();
  const fecTag = r.u8();
  const fec: FecInfo | null =
    fecTag === 1
      ? { dataShardCount: r.u32(), originalDataLen: Number(r.u64()) }
      : null;
  return { messageId, totalFragments, sequence, data, fec };
}

// SURBs are opaque bincode blobs from WASM - written inline (no length prefix)
function writeSurbOpaque(w: Writer, surb: Uint8Array): void {
  w.fixedBytes(surb);
}

function writeRelayerPayload(w: Writer, p: RelayerPayload): void {
  switch (p.tag) {
    case "SubmitTransaction":
      w.u32(0);
      assertLen(p.to, 20, "RelayerPayload.SubmitTransaction.to");
      w.fixedBytes(p.to);
      w.bytes(p.data);
      return;
    case "Dummy":
      w.u32(1);
      w.bytes(p.padding);
      return;
    case "Heartbeat":
      w.u32(2);
      w.u64(p.id);
      w.u64(p.timestamp);
      return;
    case "Fragment":
      w.u32(3);
      writeFragmentWire(w, p.frag);
      return;
    case "AnonymousRequest":
      w.u32(4);
      w.bytes(p.inner);
      w.u64(BigInt(p.replySurbs.length));
      for (const surb of p.replySurbs) writeSurbOpaque(w, surb);
      return;
    case "ServiceResponse":
      w.u32(5);
      w.u64(p.requestId);
      writeFragmentWire(w, p.fragment);
      return;
    case "NeedMoreSurbs":
      w.u32(6);
      w.u64(p.requestId);
      w.u32(p.fragmentsRemaining);
      return;
  }
}

function readRelayerPayload(r: Reader): RelayerPayload {
  const variant = r.u32();
  switch (variant) {
    case 0:
      return { tag: "SubmitTransaction", to: r.fixedBytes(20), data: r.bytes() };
    case 1:
      return { tag: "Dummy", padding: r.bytes() };
    case 2:
      return { tag: "Heartbeat", id: r.u64(), timestamp: r.u64() };
    case 3:
      return { tag: "Fragment", frag: readFragmentWire(r) };
    case 4: {
      // Client only encodes this variant; decoding non-empty SURBs not implemented
      const inner = r.bytes();
      const count = Number(r.u64());
      if (count > 0) {
        throw new NoxClientError(
          "Cannot decode AnonymousRequest with non-empty reply_surbs in TypeScript " +
          "(inline Surb struct parsing not implemented - client only encodes this variant)",
          NoxClientErrorCode.DecryptionFailed,
        );
      }
      return { tag: "AnonymousRequest", inner, replySurbs: [] };
    }
    case 5:
      return {
        tag: "ServiceResponse",
        requestId: r.u64(),
        fragment: readFragmentWire(r),
      };
    case 6:
      return {
        tag: "NeedMoreSurbs",
        requestId: r.u64(),
        fragmentsRemaining: r.u32(),
      };
    default:
      throw new NoxClientError(
        `Unknown RelayerPayload variant index ${variant}`,
        NoxClientErrorCode.DecryptionFailed,
      );
  }
}

function writeServiceRequest(w: Writer, req: ServiceRequest): void {
  switch (req.tag) {
    case "Echo":
      w.u32(0);
      w.bytes(req.data);
      return;
    case "HttpRequest":
      w.u32(1);
      w.string(req.method);
      w.string(req.url);
      w.u64(BigInt(req.headers.length));
      for (const [k, v] of req.headers) {
        w.string(k);
        w.string(v);
      }
      w.bytes(req.body);
      return;
    case "RpcRequest":
      w.u32(2);
      w.string(req.method);
      w.bytes(req.params);
      w.u64(req.id);
      w.optString(req.rpcUrl);
      return;
    case "SubmitTransaction":
      w.u32(3);
      assertLen(req.to, 20, "ServiceRequest.SubmitTransaction.to");
      w.fixedBytes(req.to);
      w.bytes(req.data);
      return;
    case "BroadcastSignedTransaction":
      w.u32(4);
      w.bytes(req.signedTx);
      w.optString(req.rpcUrl);
      w.optString(req.rpcMethod);
      return;
    case "ReplenishSurbs":
      w.u32(5);
      w.u64(req.requestId);
      w.u64(BigInt(req.surbs.length));
      for (const surb of req.surbs) writeSurbOpaque(w, surb);
      return;
    case "PaidTransactionV2":
      w.u32(6);
      w.u64(req.chainId);
      assertLen(
        req.entryPoint,
        20,
        "ServiceRequest.PaidTransactionV2.entryPoint",
      );
      w.fixedBytes(req.entryPoint);
      w.bytes(req.calldata);
      assertLen(
        req.executionId,
        32,
        "ServiceRequest.PaidTransactionV2.executionId",
      );
      w.fixedBytes(req.executionId);
      w.u64(req.validUntilUnix);
      return;
    case "PaidQuoteRequestV2":
      w.u32(7);
      w.u64(req.chainId);
      writeFixed(w, req.entryPoint, 20, "PaidQuoteRequestV2.entryPoint");
      writeFixed(w, req.clientIntentId, 32, "PaidQuoteRequestV2.clientIntentId");
      writeFixed(w, req.paymentAdapter, 20, "PaidQuoteRequestV2.paymentAdapter");
      writeFixed(w, req.paymentId, 32, "PaidQuoteRequestV2.paymentId");
      writeFixed(w, req.feeAsset, 20, "PaidQuoteRequestV2.feeAsset");
      w.u64(req.paymentGasLimit);
      writeFixed(w, req.actionTarget, 20, "PaidQuoteRequestV2.actionTarget");
      writeFixed(w, req.actionCalldataHash, 32, "PaidQuoteRequestV2.actionCalldataHash");
      w.u64(req.actionGasLimit);
      writeFixed(w, req.trackedAssetsHash, 32, "PaidQuoteRequestV2.trackedAssetsHash");
      w.u64(req.maximumTransactionGas);
      w.u32(req.returnDataLimit);
      w.u64(req.validUntilUnix);
      return;
  }
  return assertNever(req);
}

function readServiceRequest(r: Reader): ServiceRequest {
  const variant = r.u32();
  switch (variant) {
    case 0:
      return { tag: "Echo", data: r.bytes() };
    case 1: {
      const method = r.string();
      const url = r.string();
      const headerCount = Number(r.u64());
      const headers: [string, string][] = [];
      for (let i = 0; i < headerCount; i++) headers.push([r.string(), r.string()]);
      return { tag: "HttpRequest", method, url, headers, body: r.bytes() };
    }
    case 2:
      return {
        tag: "RpcRequest",
        method: r.string(),
        params: r.bytes(),
        id: r.u64(),
        rpcUrl: r.optString(),
      };
    case 3:
      return { tag: "SubmitTransaction", to: r.fixedBytes(20), data: r.bytes() };
    case 4:
      return {
        tag: "BroadcastSignedTransaction",
        signedTx: r.bytes(),
        rpcUrl: r.optString(),
        rpcMethod: r.optString(),
      };
    case 5: {
      const requestId = r.u64();
      const count = Number(r.u64());
      if (count > 0) {
        throw new NoxClientError(
          "Cannot decode ReplenishSurbs with non-empty surbs in TypeScript " +
          "(inline Surb struct parsing not implemented - client only encodes this variant)",
          NoxClientErrorCode.DecryptionFailed,
        );
      }
      return { tag: "ReplenishSurbs", requestId, surbs: [] };
    }
    case 6:
      return {
        tag: "PaidTransactionV2",
        chainId: r.u64(),
        entryPoint: r.fixedBytes(20),
        calldata: r.bytes(),
        executionId: r.fixedBytes(32),
        validUntilUnix: r.u64(),
      };
    case 7:
      return {
        tag: "PaidQuoteRequestV2",
        chainId: r.u64(),
        entryPoint: r.fixedBytes(20),
        clientIntentId: r.fixedBytes(32),
        paymentAdapter: r.fixedBytes(20),
        paymentId: r.fixedBytes(32),
        feeAsset: r.fixedBytes(20),
        paymentGasLimit: r.u64(),
        actionTarget: r.fixedBytes(20),
        actionCalldataHash: r.fixedBytes(32),
        actionGasLimit: r.u64(),
        trackedAssetsHash: r.fixedBytes(32),
        maximumTransactionGas: r.u64(),
        returnDataLimit: r.u32(),
        validUntilUnix: r.u64(),
      };
    default:
      throw new NoxClientError(
        `Unknown ServiceRequest variant index ${variant}`,
        NoxClientErrorCode.DecryptionFailed,
      );
  }
}

function assertNever(value: never): never {
  throw new NoxClientError(
    `Unsupported service request: ${String(value)}`,
    NoxClientErrorCode.PacketBuildFailed,
  );
}

export interface RpcResponse {
  id: bigint;
  result: { ok: true; data: Uint8Array } | { ok: false; error: string };
}

/** Decode a bincode-serialized `RpcResponse`. */
export function decodeRpcResponse(bytes: Uint8Array): RpcResponse {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  const id = view.getBigUint64(offset, true);
  offset += 8;

  const tag = view.getUint32(offset, true);
  offset += 4;

  const len = Number(view.getBigUint64(offset, true));
  offset += 8;
  const payload = bytes.slice(offset, offset + len);

  if (tag === 0) {
    return { id, result: { ok: true, data: payload } };
  } else {
    const error = new TextDecoder().decode(payload);
    return { id, result: { ok: false, error } };
  }
}

function assertLen(v: Uint8Array, expected: number, name: string): void {
  if (v.length !== expected) {
    throw new NoxClientError(
      `${name} must be exactly ${expected} bytes, got ${v.length}`,
      NoxClientErrorCode.PacketBuildFailed,
    );
  }
}
