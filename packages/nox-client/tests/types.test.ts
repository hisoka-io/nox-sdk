/**
 * Types and error handling unit tests.
 */
import { describe, it, expect } from "vitest";
import { NoxClientError, NoxClientErrorCode } from "../src/types.js";

describe("NoxClientError", () => {
  it("constructs with message and code", () => {
    const err = new NoxClientError("test error", NoxClientErrorCode.TopologyFetchFailed);
    expect(err.message).toBe("test error");
    expect(err.code).toBe(NoxClientErrorCode.TopologyFetchFailed);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NoxClientError);
  });

  it("constructs with optional cause", () => {
    const cause = new Error("original");
    const err = new NoxClientError("wrapped", NoxClientErrorCode.TransportFailed, cause);
    expect(err.cause).toBe(cause);
  });

  it("has correct name", () => {
    const err = new NoxClientError("test", NoxClientErrorCode.ResponseTimeout);
    expect(err.name).toBe("NoxClientError");
  });

  it("is throwable and catchable", () => {
    expect(() => {
      throw new NoxClientError("boom", NoxClientErrorCode.PacketBuildFailed);
    }).toThrow(NoxClientError);
  });

  it("toString includes code", () => {
    const err = new NoxClientError("test msg", NoxClientErrorCode.NoNodesAvailable);
    const str = String(err);
    expect(str).toContain("test msg");
  });
});

describe("NoxClientErrorCode", () => {
  it("has all expected codes", () => {
    expect(NoxClientErrorCode.TopologyFetchFailed).toBeDefined();
    expect(NoxClientErrorCode.TransportFailed).toBeDefined();
    expect(NoxClientErrorCode.ResponseTimeout).toBeDefined();
    expect(NoxClientErrorCode.PacketBuildFailed).toBeDefined();
    expect(NoxClientErrorCode.NoNodesAvailable).toBeDefined();
    expect(NoxClientErrorCode.WasmNotInitialized).toBeDefined();
    expect(NoxClientErrorCode.InvalidConfig).toBeDefined();
  });

  it("codes are unique strings", () => {
    const codes = Object.values(NoxClientErrorCode);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});
