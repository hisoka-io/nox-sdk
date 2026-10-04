import { describe, expect, it } from "vitest";
import { decodeHttpResponse } from "../src/http_response.js";
import { NoxClientError } from "../src/types.js";

/** Produced by bincode 1.3 `serialize` of nox-node's `SerializableHttpResponse`. */
const RUST_OK =
  "c80001000000000000000c00000000000000636f6e74656e742d7479706510000000000000006170706c69636174696f6e2f6a736f6e28000000000000007b226a736f6e727063223a22322e30222c226964223a312c22726573756c74223a2230783130227d00";
const RUST_ERROR =
  "f60100000000000000001a00000000000000557073747265616d2072657175657374206661696c65643a207801";

const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));

describe("decodeHttpResponse", () => {
  it("decodes the exit's bincode reply byte for byte", () => {
    const decoded = decodeHttpResponse(hex(RUST_OK));
    expect(decoded.status).toBe(200);
    expect(decoded.headers).toEqual([["content-type", "application/json"]]);
    expect(new TextDecoder().decode(decoded.body)).toBe('{"jsonrpc":"2.0","id":1,"result":"0x10"}');
    expect(decoded.truncated).toBe(false);
  });

  it("decodes an exit error reply with the truncated flag", () => {
    const decoded = decodeHttpResponse(hex(RUST_ERROR));
    expect(decoded.status).toBe(502);
    expect(decoded.headers).toEqual([]);
    expect(new TextDecoder().decode(decoded.body)).toBe("Upstream request failed: x");
    expect(decoded.truncated).toBe(true);
  });

  it("rejects truncated input, trailing bytes and invalid bools", () => {
    const ok = hex(RUST_OK);
    expect(() => decodeHttpResponse(ok.subarray(0, ok.length - 1))).toThrow(NoxClientError);
    expect(() => decodeHttpResponse(Uint8Array.from([...ok, 0]))).toThrow(/malformed exit HTTP reply: 1 trailing bytes/u);
    const badBool = Uint8Array.from(ok);
    badBool[badBool.length - 1] = 2;
    expect(() => decodeHttpResponse(badBool)).toThrow(/not a bool/u);
    expect(() => decodeHttpResponse(new Uint8Array(0))).toThrow(NoxClientError);
  });

  it("rejects header text that is not UTF-8", () => {
    const bytes = hex(RUST_OK);
    // First header name byte ("c" of content-type) replaced by 0xff.
    bytes[2 + 8 + 8] = 0xff;
    expect(() => decodeHttpResponse(bytes)).toThrow(/not UTF-8/u);
  });

  it("rejects a header count larger than the payload can hold", () => {
    const forged = new Uint8Array(2 + 8);
    forged.set([0xc8, 0x00]);
    new DataView(forged.buffer).setBigUint64(2, 0xffff_ffff_ffffn, true);
    expect(() => decodeHttpResponse(forged)).toThrow(NoxClientError);
  });
});
