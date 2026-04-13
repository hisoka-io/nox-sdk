/**
 * Seed node resolution unit tests.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveSeedUrl } from "../src/seeder.js";

describe("resolveSeedUrl", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns user seed when it responds OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await resolveSeedUrl(["http://my-seed.test"]);
    expect(result).toBe("http://my-seed.test");
  });

  it("tries second user seed when first fails", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;

    const result = await resolveSeedUrl([
      "http://bad-seed.test",
      "http://good-seed.test",
    ]);
    expect(result).toBe("http://good-seed.test");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to DNS seed when user seeds all fail", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("api.hisoka.io/seed")) {
        return Promise.resolve({ ok: true, status: 200 });
      }
      return Promise.reject(new Error("fail"));
    });

    const result = await resolveSeedUrl(["http://bad.test"]);
    expect(result).toBe("https://api.hisoka.io/seed");
  });

  it("returns null when all seeds fail", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("fail"));

    const result = await resolveSeedUrl(["http://bad.test"]);
    expect(result).toBeNull();
  });

  it("strips /topology suffix from user-provided URLs", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await resolveSeedUrl(["http://seed.test/topology"]);
    expect(result).toBe("http://seed.test");
  });

  it("handles non-200 response by trying next seed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;

    const result = await resolveSeedUrl([
      "http://down.test",
      "http://up.test",
    ]);
    expect(result).toBe("http://up.test");
  });

  it("uses default empty array when no user seeds provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await resolveSeedUrl();
    expect(result).toBe("https://api.hisoka.io/seed");
  });
});
