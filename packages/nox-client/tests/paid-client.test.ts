import { Wallet } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionQuoteV1,
  PaidQuoteRequestV2,
  PaidQuoteOutcomeV2,
} from "../src/bincode.js";
import {
  hashExecutionQuoteV1,
  fetchPaidChainTimestamp,
  quoteTypedData,
  validateIssuedPaidQuote,
  validatePaidQuoteRequest,
} from "../src/paid.js";
import type { TopologyNode } from "../src/types.js";

const ENTRY_POINT_GAS_RESERVE = 250_000n;

function bytes(value: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function word(value: bigint): Uint8Array {
  const encoded = new Uint8Array(32);
  new DataView(encoded.buffer).setBigUint64(24, value, false);
  return encoded;
}

function request(validUntilUnix = 1_800_000_000n): PaidQuoteRequestV2 {
  return {
    chainId: 421_614n,
    entryPoint: bytes(0x11, 20),
    clientIntentId: bytes(0x33, 32),
    paymentAdapter: bytes(0x44, 20),
    paymentId: bytes(0x55, 32),
    feeAsset: bytes(0x66, 20),
    paymentGasLimit: 500_000n,
    actionTarget: bytes(0x77, 20),
    actionCalldataHash: bytes(0x88, 32),
    actionGasLimit: 700_000n,
    trackedAssetsHash: bytes(0x99, 32),
    maximumTransactionGas: 1_450_000n,
    returnDataLimit: 256,
    validUntilUnix,
  };
}

function quote(exitAddress: Uint8Array): ExecutionQuoteV1 {
  return {
    quoteVersion: 1,
    chainId: word(421_614n),
    entryPoint: bytes(0x11, 20),
    exitAddress,
    clientIntentId: bytes(0x33, 32),
    paymentAdapter: bytes(0x44, 20),
    paymentId: bytes(0x55, 32),
    feeAsset: bytes(0x66, 20),
    exitFee: word(77n),
    networkFee: word(8n),
    paymentGasLimit: word(500_000n),
    actionTarget: bytes(0x77, 20),
    actionCalldataHash: bytes(0x88, 32),
    actionGasLimit: word(700_000n),
    trackedAssetsHash: bytes(0x99, 32),
    maximumTransactionGas: word(1_450_000n),
    maximumFeePerGas: word(123n),
    returnDataLimit: word(256n),
    validAfterUnix: 1_799_999_900n,
    validUntilUnix: 1_800_000_000n,
    quoteNonce: word(1n),
  };
}

function selectedExit(address: string): TopologyNode {
  return {
    id: address,
    address: "https://entry.test",
    routingAddress: "/ip4/127.0.0.1/tcp/9000",
    publicKey: bytes(0xaa, 32),
    layer: 2,
    role: 2,
  };
}

describe("paid quote validation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses the canonical RPC block timestamp instead of the client wall clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: { timestamp: "0x6b49d200" },
      }),
    });

    await expect(
      fetchPaidChainTimestamp("https://rpc.test", 1_000),
    ).resolves.toBe(1_800_000_000n);
  });

  it("rejects a malformed RPC block timestamp", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: { timestamp: "1800000000" } }),
    });
    await expect(
      fetchPaidChainTimestamp("https://rpc.test", 1_000),
    ).rejects.toThrow("canonical hex u64");
  });

  it("redacts RPC URLs from bounded transport errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error("connect failed at https://rpc.test/private-credential"),
    );
    const failure = await fetchPaidChainTimestamp(
      "https://rpc.test/private-credential",
      1_000,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("[redacted URL]");
    expect(message).not.toContain("private-credential");
    expect(message.length).toBeLessThan(220);
  });
  it("matches the Rust and Solidity EIP-712 digest", () => {
    expect(hashExecutionQuoteV1(quote(bytes(0x22, 20)))).toBe(
      "0x1ca9c5897f8242ac75faa99ea8d1830af6ca67fd93197b8b993919d87f2306a5",
    );
  });

  it("rejects malformed request fields and gas bounds", () => {
    const malformed = request();
    malformed.clientIntentId.fill(0);
    expect(() => validatePaidQuoteRequest(malformed, 1_799_999_900n)).toThrow(
      "clientIntentId",
    );

    const insufficientGas = request();
    Object.assign(insufficientGas, {
      maximumTransactionGas:
        insufficientGas.paymentGasLimit +
        insufficientGas.actionGasLimit +
        ENTRY_POINT_GAS_RESERVE -
        1n,
    });
    expect(() =>
      validatePaidQuoteRequest(insufficientGas, 1_799_999_900n),
    ).toThrow("maximumTransactionGas");
  });

  it("accepts a selected-exit signature and returns a detached route pin", async () => {
    const wallet = new Wallet(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412ef50c3c0fba7c8",
    );
    const exitAddress = Uint8Array.from(Buffer.from(wallet.address.slice(2), "hex"));
    const executionQuote = quote(exitAddress);
    const typed = quoteTypedData(executionQuote);
    const exitSignature = Uint8Array.from(
      Buffer.from((await wallet.signTypedData(typed.domain, typed.types, typed.value)).slice(2), "hex"),
    );
    const outcome: PaidQuoteOutcomeV2 = {
      status: "issued",
      quote: executionQuote,
      executionId: Uint8Array.from(
        Buffer.from(hashExecutionQuoteV1(executionQuote).slice(2), "hex"),
      ),
      exitSignature,
    };
    const node = selectedExit(wallet.address.toLowerCase());

    const issued = validateIssuedPaidQuote(
      outcome,
      request(),
      node,
      1_799_999_950n,
    );

    expect(issued.selectedExit).toEqual(node);
    expect(issued.selectedExit).not.toBe(node);
  });

  it("rejects quote mutation, wrong route, expiry, and invalid signer", async () => {
    const wallet = new Wallet(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412ef50c3c0fba7c8",
    );
    const exitAddress = Uint8Array.from(Buffer.from(wallet.address.slice(2), "hex"));
    const executionQuote = quote(exitAddress);
    const typed = quoteTypedData(executionQuote);
    const signature = Uint8Array.from(
      Buffer.from((await wallet.signTypedData(typed.domain, typed.types, typed.value)).slice(2), "hex"),
    );
    const outcome: PaidQuoteOutcomeV2 = {
      status: "issued",
      quote: executionQuote,
      executionId: Uint8Array.from(
        Buffer.from(hashExecutionQuoteV1(executionQuote).slice(2), "hex"),
      ),
      exitSignature: signature,
    };

    expect(() =>
      validateIssuedPaidQuote(
        outcome,
        request(),
        selectedExit(`0x${"12".repeat(20)}`),
        1_799_999_950n,
      ),
    ).toThrow("selected exit");
    expect(() =>
      validateIssuedPaidQuote(
        outcome,
        request(),
        selectedExit(wallet.address),
        1_799_999_899n,
      ),
    ).toThrow("not active");
    expect(() =>
      validateIssuedPaidQuote(
        outcome,
        request(),
        selectedExit(wallet.address),
        1_800_000_001n,
      ),
    ).toThrow("expired");

    const mutated: PaidQuoteOutcomeV2 = {
      ...outcome,
      quote: { ...outcome.quote, exitFee: word(78n) },
    };
    expect(() =>
      validateIssuedPaidQuote(
        mutated,
        request(),
        selectedExit(wallet.address),
        1_799_999_950n,
      ),
    ).toThrow("executionId");

    const invalidSigner: PaidQuoteOutcomeV2 = {
      ...outcome,
      exitSignature: bytes(0xcd, 65),
    };
    expect(() =>
      validateIssuedPaidQuote(
        invalidSigner,
        request(),
        selectedExit(wallet.address),
        1_799_999_950n,
      ),
    ).toThrow("signature");
  });
});
