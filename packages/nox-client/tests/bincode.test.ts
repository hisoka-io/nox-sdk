/**
 * Unit tests for the bincode v1 encoder/decoder.
 *
 * Tests verify round-trip encode→decode for every `ServiceRequest` variant
 * and the `RelayerPayload` variants the client sends/receives.
 */

import { describe, it, expect } from "vitest";
import {
  encodeServiceRequest,
  decodeServiceRequest,
  encodeRelayerPayload,
  decodeRelayerPayload,
  decodeSubmitTransactionResponse,
  decodePaidTransactionOutcomeV2,
  decodePaidQuoteOutcomeV2,
  encodePaidTransactionOutcomeV2,
  encodePaidQuoteOutcomeV2,
  PAYLOAD_VERSION,
} from "../src/bincode.js";
import type {
  PaidTransactionOutcomeV2,
  PaidQuoteOutcomeV2,
  ServiceRequest,
  RelayerPayload,
} from "../src/bincode.js";
import { NoxClientError, NoxClientErrorCode } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rt(req: ServiceRequest): ServiceRequest {
  return decodeServiceRequest(encodeServiceRequest(req));
}

function rtPayload(p: RelayerPayload): RelayerPayload {
  return decodeRelayerPayload(encodeRelayerPayload(p));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// ---------------------------------------------------------------------------
// ServiceRequest round-trips
// ---------------------------------------------------------------------------

describe("bincode ServiceRequest", () => {
  it("Echo round-trips", () => {
    const req: ServiceRequest = {
      tag: "Echo",
      data: new Uint8Array([1, 2, 3, 4, 5]),
    };
    const got = rt(req);
    expect(got.tag).toBe("Echo");
    if (got.tag !== "Echo") return;
    expect(Array.from(got.data)).toEqual([1, 2, 3, 4, 5]);
  });

  it("Echo with empty data round-trips", () => {
    const req: ServiceRequest = { tag: "Echo", data: new Uint8Array(0) };
    const got = rt(req);
    expect(got.tag).toBe("Echo");
    if (got.tag !== "Echo") return;
    expect(got.data.length).toBe(0);
  });

  it("HttpRequest round-trips", () => {
    const req: ServiceRequest = {
      tag: "HttpRequest",
      method: "GET",
      url: "https://example.com/api",
      headers: [
        ["Content-Type", "application/json"],
        ["X-Request-ID", "abc123"],
      ],
      body: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    };
    const got = rt(req);
    expect(got.tag).toBe("HttpRequest");
    if (got.tag !== "HttpRequest") return;
    expect(got.method).toBe("GET");
    expect(got.url).toBe("https://example.com/api");
    expect(got.headers).toEqual([
      ["Content-Type", "application/json"],
      ["X-Request-ID", "abc123"],
    ]);
    expect(Array.from(got.body)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("RpcRequest round-trips (rpcUrl null)", () => {
    const req: ServiceRequest = {
      tag: "RpcRequest",
      method: "eth_call",
      params: new Uint8Array([7, 8, 9]),
      id: 42n,
      rpcUrl: null,
    };
    const got = rt(req);
    expect(got.tag).toBe("RpcRequest");
    if (got.tag !== "RpcRequest") return;
    expect(got.method).toBe("eth_call");
    expect(got.id).toBe(42n);
    expect(got.rpcUrl).toBeNull();
  });

  it("RpcRequest round-trips (rpcUrl present)", () => {
    const req: ServiceRequest = {
      tag: "RpcRequest",
      method: "eth_blockNumber",
      params: new Uint8Array(0),
      id: 99n,
      rpcUrl: "https://mainnet.infura.io/v3/key",
    };
    const got = rt(req);
    expect(got.tag).toBe("RpcRequest");
    if (got.tag !== "RpcRequest") return;
    expect(got.rpcUrl).toBe("https://mainnet.infura.io/v3/key");
  });

  it("SubmitTransaction round-trips", () => {
    const to = new Uint8Array(20).fill(0xab);
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    const req: ServiceRequest = { tag: "SubmitTransaction", to, data };
    const got = rt(req);
    expect(got.tag).toBe("SubmitTransaction");
    if (got.tag !== "SubmitTransaction") return;
    expect(Array.from(got.to)).toEqual(Array.from(to));
    expect(Array.from(got.data)).toEqual([0x01, 0x02, 0x03]);
  });

  it("SubmitTransaction keeps the legacy wire bytes", () => {
    const to = new Uint8Array(20).fill(0xab);
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    expect(
      Array.from(
        encodeServiceRequest({ tag: "SubmitTransaction", to, data }),
      ),
    ).toEqual([
      1,
      3, 0, 0, 0,
      ...new Array<number>(20).fill(0xab),
      3, 0, 0, 0, 0, 0, 0, 0,
      1, 2, 3,
    ]);
  });

  it("BroadcastSignedTransaction round-trips (all null)", () => {
    const req: ServiceRequest = {
      tag: "BroadcastSignedTransaction",
      signedTx: new Uint8Array([0xff, 0xfe]),
      rpcUrl: null,
      rpcMethod: null,
    };
    const got = rt(req);
    expect(got.tag).toBe("BroadcastSignedTransaction");
    if (got.tag !== "BroadcastSignedTransaction") return;
    expect(got.rpcUrl).toBeNull();
    expect(got.rpcMethod).toBeNull();
  });

  it("BroadcastSignedTransaction round-trips (with overrides)", () => {
    const req: ServiceRequest = {
      tag: "BroadcastSignedTransaction",
      signedTx: new Uint8Array([0xca, 0xfe]),
      rpcUrl: "https://rpc.example.com",
      rpcMethod: "eth_sendRawTransaction",
    };
    const got = rt(req);
    expect(got.tag).toBe("BroadcastSignedTransaction");
    if (got.tag !== "BroadcastSignedTransaction") return;
    expect(got.rpcUrl).toBe("https://rpc.example.com");
    expect(got.rpcMethod).toBe("eth_sendRawTransaction");
  });

  it("ReplenishSurbs round-trips (no SURBs)", () => {
    const req: ServiceRequest = {
      tag: "ReplenishSurbs",
      requestId: 100n,
      surbs: [],
    };
    const got = rt(req);
    expect(got.tag).toBe("ReplenishSurbs");
    if (got.tag !== "ReplenishSurbs") return;
    expect(got.requestId).toBe(100n);
    expect(got.surbs).toHaveLength(0);
  });

  it("ReplenishSurbs encode-only (non-empty SURBs)", () => {
    // SURB bytes are written inline (no per-element length prefix) to match
    // Rust bincode `Vec<Surb>` encoding.  The TS decoder cannot parse inline
    // Surb structs, so we only verify encoding succeeds and produces the
    // expected wire layout: [version][u32 variant=5][u64 requestId][u64 count][surb1][surb2]
    const surb1 = new Uint8Array(10).fill(0x11);
    const surb2 = new Uint8Array(8).fill(0x22);
    const req: ServiceRequest = {
      tag: "ReplenishSurbs",
      requestId: 999n,
      surbs: [surb1, surb2],
    };
    const encoded = encodeServiceRequest(req);
    // Version byte + u32(5) + u64(999) + u64(2) + 10 bytes + 8 bytes = 1 + 4 + 8 + 8 + 10 + 8 = 39
    expect(encoded.length).toBe(39);
    expect(encoded[0]).toBe(1); // version
    // Verify surb bytes are inline (no length prefix): bytes at offset 21 should be surb1[0]=0x11
    expect(encoded[21]).toBe(0x11);
    // surb2 starts at offset 31, first byte should be 0x22
    expect(encoded[31]).toBe(0x22);
  });

  it("PaidTransactionV2 matches the Rust ordinal-6 golden", () => {
    const request: ServiceRequest = {
      tag: "PaidTransactionV2",
      chainId: 421_614n,
      entryPoint: new Uint8Array(20).fill(1),
      calldata: new Uint8Array([2, 3]),
      executionId: new Uint8Array(32).fill(4),
      validUntilUnix: 1_800_000_000n,
    };
    const encoded = encodeServiceRequest(request);
    expect(hex(encoded)).toBe(
      "0106000000ee6e060000000000010101010101010101010101010101010101010102000000000000000203040404040404040404040404040404040404040404040404040404040404040400d2496b00000000",
    );
    expect(decodeServiceRequest(encoded)).toEqual(request);
    expect(() =>
      decodeServiceRequest(new Uint8Array([...encoded, 0])),
    ).toThrow("trailing bytes");
  });

  it("PaidQuoteRequestV2 matches the Rust ordinal-7 golden", () => {
    const request: ServiceRequest = {
      tag: "PaidQuoteRequestV2",
      chainId: 421_614n,
      entryPoint: new Uint8Array(20).fill(1),
      clientIntentId: new Uint8Array(32).fill(2),
      paymentAdapter: new Uint8Array(20).fill(3),
      paymentId: new Uint8Array(32).fill(4),
      feeAsset: new Uint8Array(20).fill(5),
      paymentGasLimit: 500_000n,
      actionTarget: new Uint8Array(20).fill(6),
      actionCalldataHash: new Uint8Array(32).fill(7),
      actionGasLimit: 700_000n,
      trackedAssetsHash: new Uint8Array(32).fill(8),
      maximumTransactionGas: 1_500_000n,
      returnDataLimit: 256,
      validUntilUnix: 1_800_000_000n,
    };
    const encoded = encodeServiceRequest(request);
    expect(hex(encoded)).toBe(
      "0107000000ee6e0600000000000101010101010101010101010101010101010101020202020202020202020202020202020202020202020202020202020202020203030303030303030303030303030303030303030404040404040404040404040404040404040404040404040404040404040404050505050505050505050505050505050505050520a10700000000000606060606060606060606060606060606060606070707070707070707070707070707070707070707070707070707070707070760ae0a0000000000080808080808080808080808080808080808080808080808080808080808080860e31600000000000001000000d2496b00000000",
    );
    expect(decodeServiceRequest(encoded)).toEqual(request);
  });
});

describe("PaidQuoteOutcomeV2", () => {
  it("pins rejected bytes and round-trips", () => {
    const outcome: PaidQuoteOutcomeV2 = {
      status: "rejected",
      code: "WrongChain",
      retryable: false,
      detail: "wrong chain",
    };
    const encoded = encodePaidQuoteOutcomeV2(outcome);
    expect(hex(encoded)).toBe(
      "010100000001000000000b0000000000000077726f6e6720636861696e",
    );
    expect(decodePaidQuoteOutcomeV2(encoded)).toEqual(outcome);
  });

  it("round-trips an issued quote in Solidity field order", () => {
    const word = (value: number): Uint8Array => {
      const bytes = new Uint8Array(32);
      new DataView(bytes.buffer).setBigUint64(24, BigInt(value), false);
      return bytes;
    };
    const outcome: PaidQuoteOutcomeV2 = {
      status: "issued",
      quote: {
        quoteVersion: 1,
        chainId: word(421_614),
        entryPoint: new Uint8Array(20).fill(0x11),
        exitAddress: new Uint8Array(20).fill(0x22),
        clientIntentId: new Uint8Array(32).fill(0x33),
        paymentAdapter: new Uint8Array(20).fill(0x44),
        paymentId: new Uint8Array(32).fill(0x55),
        feeAsset: new Uint8Array(20).fill(0x66),
        exitFee: word(77),
        networkFee: word(8),
        paymentGasLimit: word(500_000),
        actionTarget: new Uint8Array(20).fill(0x77),
        actionCalldataHash: new Uint8Array(32).fill(0x88),
        actionGasLimit: word(700_000),
        trackedAssetsHash: new Uint8Array(32).fill(0x99),
        maximumTransactionGas: word(1_450_000),
        maximumFeePerGas: word(123),
        returnDataLimit: word(256),
        validAfterUnix: 1_799_999_900n,
        validUntilUnix: 1_800_000_000n,
        quoteNonce: word(1),
      },
      executionId: new Uint8Array(32).fill(0xab),
      exitSignature: new Uint8Array(65).fill(0xcd),
    };
    const encoded = encodePaidQuoteOutcomeV2(outcome);
    expect(hex(encoded)).toBe(
      "0100000000010000000000000000000000000000000000000000000000000000000000066eee111111111111111111111111111111111111111122222222222222222222222222222222222222223333333333333333333333333333333333333333333333333333333333333333444444444444444444444444444444444444444455555555555555555555555555555555555555555555555555555555555555556666666666666666666666666666666666666666000000000000000000000000000000000000000000000000000000000000004d0000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000007a1207777777777777777777777777777777777777777888888888888888888888888888888888888888888888888888888888888888800000000000000000000000000000000000000000000000000000000000aae6099999999999999999999999999999999999999999999999999999999999999990000000000000000000000000000000000000000000000000000000000162010000000000000000000000000000000000000000000000000000000000000007b00000000000000000000000000000000000000000000000000000000000001009cd1496b0000000000d2496b000000000000000000000000000000000000000000000000000000000000000000000001abababababababababababababababababababababababababababababababab4100000000000000cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    );
    expect(decodePaidQuoteOutcomeV2(encoded)).toEqual(outcome);
  });

  it("rejects a non-canonical exit signature length", () => {
    const bytes = new Uint8Array([
      1,
      0, 0, 0, 0,
      1,
      ...new Uint8Array(532),
      ...new Uint8Array(32),
      64, 0, 0, 0, 0, 0, 0, 0,
      ...new Uint8Array(64),
    ]);
    expect(() => decodePaidQuoteOutcomeV2(bytes)).toThrow(
      "exit signature must be 65 bytes",
    );
  });
});

describe("PaidTransactionOutcomeV2", () => {
  it("pins submitted bytes and round-trips", () => {
    const outcome: PaidTransactionOutcomeV2 = {
      status: "submitted",
      executionId: new Uint8Array(32).fill(7),
      transactionHash: new Uint8Array(32).fill(8),
    };
    const encoded = encodePaidTransactionOutcomeV2(outcome);
    expect(hex(encoded)).toBe(
      `0100000000${"07".repeat(32)}${"08".repeat(32)}`,
    );
    expect(decodePaidTransactionOutcomeV2(encoded)).toEqual(outcome);
  });

  it("pins rejected bytes and round-trips", () => {
    const outcome: PaidTransactionOutcomeV2 = {
      status: "rejected",
      executionId: new Uint8Array(32).fill(7),
      code: "WrongChain",
      retryable: false,
      detail: "request chain does not match exit chain",
    };
    const encoded = encodePaidTransactionOutcomeV2(outcome);
    expect(hex(encoded)).toBe(
      "0101000000010707070707070707070707070707070707070707070707070707070707070707010000000027000000000000007265717565737420636861696e20646f6573206e6f74206d61746368206578697420636861696e",
    );
    expect(decodePaidTransactionOutcomeV2(encoded)).toEqual(outcome);
  });
});

describe("submit transaction response", () => {
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

  it("decodes a 32-byte submitted transaction hash", () => {
    expect(decodeSubmitTransactionResponse(new Uint8Array(32).fill(0xab))).toEqual({
      status: "submitted",
      transactionHash: `0x${"ab".repeat(32)}`,
    });
  });

  it("decodes a bounded typed legacy rejection", () => {
    expect(
      decodeSubmitTransactionResponse(
        encode("tx_error:UNPROFITABLE:payment is below the required margin"),
      ),
    ).toEqual({
      status: "rejected",
      code: "UNPROFITABLE",
      detail: "payment is below the required margin",
    });
  });

  it("does not mistake a 32-byte rejection for a transaction hash", () => {
    expect(
      decodeSubmitTransactionResponse(
        encode("tx_error:SUBMISSION:twelve-bytes"),
      ),
    ).toEqual({
      status: "rejected",
      code: "SUBMISSION",
      detail: "twelve-bytes",
    });
  });

  it("accepts 256 detail bytes and rejects 257", () => {
    expect(
      decodeSubmitTransactionResponse(
        encode(`tx_error:SUBMISSION:${"x".repeat(256)}`),
      ),
    ).toEqual({
      status: "rejected",
      code: "SUBMISSION",
      detail: "x".repeat(256),
    });
    expect(() =>
      decodeSubmitTransactionResponse(
        encode(`tx_error:SUBMISSION:${"x".repeat(257)}`),
      ),
    ).toThrowError(NoxClientError);
  });

  it.each([
    new Uint8Array(31),
    encode("tx_error:UNKNOWN:detail"),
    encode("tx_error:SUBMISSION:"),
    encode("tx_error:SUBMISSION:bad\u007fdetail"),
    new Uint8Array([0xff]),
  ])("rejects malformed response %#", (response) => {
    expect(() => decodeSubmitTransactionResponse(response)).toThrowError(
      expect.objectContaining({ code: NoxClientErrorCode.DecryptionFailed }),
    );
  });
});

// ---------------------------------------------------------------------------
// RelayerPayload round-trips
// ---------------------------------------------------------------------------

describe("bincode RelayerPayload", () => {
  it("version byte is prepended", () => {
    const enc = encodeRelayerPayload({
      tag: "Dummy",
      padding: new Uint8Array(0),
    });
    expect(enc[0]).toBe(PAYLOAD_VERSION);
  });

  it("Dummy round-trips", () => {
    const padding = new Uint8Array(64).fill(0xaa);
    const got = rtPayload({ tag: "Dummy", padding });
    expect(got.tag).toBe("Dummy");
    if (got.tag !== "Dummy") return;
    expect(got.padding.length).toBe(64);
    expect(got.padding[0]).toBe(0xaa);
  });

  it("Heartbeat round-trips", () => {
    const got = rtPayload({
      tag: "Heartbeat",
      id: 12345678901234n,
      timestamp: 9999999999n,
    });
    expect(got.tag).toBe("Heartbeat");
    if (got.tag !== "Heartbeat") return;
    expect(got.id).toBe(12345678901234n);
    expect(got.timestamp).toBe(9999999999n);
  });

  it("NeedMoreSurbs round-trips", () => {
    const got = rtPayload({
      tag: "NeedMoreSurbs",
      requestId: 77n,
      fragmentsRemaining: 5,
    });
    expect(got.tag).toBe("NeedMoreSurbs");
    if (got.tag !== "NeedMoreSurbs") return;
    expect(got.requestId).toBe(77n);
    expect(got.fragmentsRemaining).toBe(5);
  });

  it("ServiceResponse round-trips (no FEC)", () => {
    const got = rtPayload({
      tag: "ServiceResponse",
      requestId: 42n,
      fragment: {
        messageId: 1n,
        totalFragments: 3,
        sequence: 0,
        data: new Uint8Array([10, 20, 30]),
        fec: null,
      },
    });
    expect(got.tag).toBe("ServiceResponse");
    if (got.tag !== "ServiceResponse") return;
    expect(got.requestId).toBe(42n);
    expect(got.fragment.messageId).toBe(1n);
    expect(got.fragment.sequence).toBe(0);
    expect(got.fragment.fec).toBeNull();
    expect(Array.from(got.fragment.data)).toEqual([10, 20, 30]);
  });

  it("ServiceResponse round-trips (with FEC)", () => {
    // FecInfo in FragmentWire has { dataShardCount, originalDataLen }
    const got = rtPayload({
      tag: "ServiceResponse",
      requestId: 1n,
      fragment: {
        messageId: 55n,
        totalFragments: 5,
        sequence: 2,
        data: new Uint8Array([0xff]),
        fec: { dataShardCount: 3, originalDataLen: 90 },
      },
    });
    expect(got.tag).toBe("ServiceResponse");
    if (got.tag !== "ServiceResponse") return;
    expect(got.fragment.fec).not.toBeNull();
    expect(got.fragment.fec?.dataShardCount).toBe(3);
    expect(got.fragment.fec?.originalDataLen).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("bincode error handling", () => {
  it("rejects empty bytes", () => {
    expect(() => decodeRelayerPayload(new Uint8Array(0))).toThrowError(
      NoxClientError,
    );
  });

  it("rejects wrong version byte", () => {
    const bad = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00]);
    expect(() => decodeRelayerPayload(bad)).toThrow(
      /Unsupported payload version/,
    );
  });

  it("NoxClientError has correct code", () => {
    try {
      decodeRelayerPayload(new Uint8Array(0));
    } catch (err) {
      expect(err).toBeInstanceOf(NoxClientError);
      const e = err as NoxClientError;
      expect(e.code).toBe(NoxClientErrorCode.DecryptionFailed);
    }
  });
});
