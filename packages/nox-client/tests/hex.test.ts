import { describe, expect, it } from "vitest";
import { hexToBytes } from "../src/utils.js";
import { NoxClientErrorCode } from "../src/types.js";

describe("hexToBytes", () => {
  it("accepts canonical even-length hex with an optional prefix", () => {
    expect(hexToBytes("0x00aBff")).toEqual(new Uint8Array([0, 0xab, 0xff]));
    expect(hexToBytes("00abff")).toEqual(new Uint8Array([0, 0xab, 0xff]));
  });

  it.each(["0x0", "abc", "0xgg", "-1", "0X12", "0x 12"])(
    "rejects malformed input %s",
    (value) => {
      expect(() => hexToBytes(value)).toThrow();
      try {
        hexToBytes(value);
      } catch (error) {
        expect(error).toMatchObject({ code: NoxClientErrorCode.InvalidConfig });
      }
    },
  );
});
