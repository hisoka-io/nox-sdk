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
  PAYLOAD_VERSION,
} from "../src/bincode.js";
import type { ServiceRequest, RelayerPayload } from "../src/bincode.js";
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
