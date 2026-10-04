import { afterEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_BUNDLE, SAMPLE_HASH, SAMPLE_KPS_IPV4 } from "../itest/sample.ts";
import { allHttpsMatch, checkAvailability } from "./availability.ts";

const GOOD = "https://good.example/w.js";
const TAMPERED = "https://tampered.example/w.js";
const DOWN = "https://down.example/w.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkAvailability", () => {
  it("fetches each https: entry through the harness and classifies the result", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url === GOOD) return new Response(SAMPLE_BUNDLE);
        if (url === TAMPERED) return new Response(new TextEncoder().encode("other bytes"));
        return new Response("gone", { status: 404 });
      }),
    );
    const results = await checkAvailability(SAMPLE_HASH, [SAMPLE_KPS_IPV4, GOOD, TAMPERED, DOWN], {
      maxBytes: 1024,
    });
    expect(results.map((r) => r.status)).toEqual(["not-checked", "match", "mismatch", "unreachable"]);
    expect(results[1]?.detail).toBe(`${SAMPLE_BUNDLE.byteLength} bytes, keccak256 = workerHash`);
    expect(results[3]?.detail).toMatch(/HTTP 404/);
    expect(requested).toEqual([GOOD, TAMPERED, DOWN]);
    expect(allHttpsMatch(results)).toBe(false);
    expect(allHttpsMatch(results.slice(0, 2))).toBe(true);
  });

  it("counts only kps: entries as acceptably unchecked", async () => {
    const results = await checkAvailability(SAMPLE_HASH, [SAMPLE_KPS_IPV4, "HTTPS://good.example/w.js"], {
      maxBytes: 1024,
    });
    expect(results.map((r) => r.status)).toEqual(["not-checked", "not-checked"]);
    expect(allHttpsMatch(results)).toBe(false);
    expect(allHttpsMatch(results.slice(0, 1))).toBe(true);
  });

  it("applies the body cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(4096))),
    );
    const [result] = await checkAvailability(SAMPLE_HASH, [GOOD], { maxBytes: 1024 });
    expect(result?.status).toBe("unreachable");
    expect(result?.detail).toMatch(/bundle cap/);
  });
});
