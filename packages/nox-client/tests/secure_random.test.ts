import { afterEach, describe, expect, it, vi } from "vitest";

import { getCrypto, secureRandomIndex, secureRandomUnit } from "../src/utils.js";

describe("secure random sampling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires the platform Web Crypto API instead of importing a Node fallback", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => getCrypto()).toThrow("Web Crypto API is required");
  });

  it("rejection-samples an unbiased array index", () => {
    const samples = [0xffff_ffff, 5];
    const fill = (target: Uint32Array): Uint32Array => {
      target[0] = samples.shift()!;
      return target;
    };
    expect(secureRandomIndex(3, fill)).toBe(2);
    expect(samples).toHaveLength(0);
  });

  it("returns an open-interval unit sample", () => {
    const fill = (target: Uint32Array): Uint32Array => {
      target[0] = 0;
      target[1] = 0;
      return target;
    };
    const sample = secureRandomUnit(fill);
    expect(sample).toBeGreaterThan(0);
    expect(sample).toBeLessThan(1);
  });

  it.each([0, -1, 2 ** 32 + 1])("rejects invalid index bound %s", (length) => {
    expect(() => secureRandomIndex(length)).toThrow("length");
  });
});
