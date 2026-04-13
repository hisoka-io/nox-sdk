/**
 * HTTP transport unit tests.
 *
 * Tests: postPacket, pollResponses.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  postPacket,
  pollResponses,
  SPHINX_PACKET_SIZE,
} from "../src/transport.js";
import { NoxClientError } from "../src/types.js";

describe("postPacket", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const validPacket = new Uint8Array(SPHINX_PACKET_SIZE);

  it("succeeds with 32768-byte packet", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await expect(postPacket("http://entry.test", validPacket)).resolves.toBeUndefined();
  });

  it("throws PacketBuildFailed when packet is wrong size", async () => {
    const badPacket = new Uint8Array(100);
    await expect(postPacket("http://entry.test", badPacket)).rejects.toThrow(
      `exactly ${SPHINX_PACKET_SIZE} bytes`,
    );
  });

  it("throws PacketBuildFailed on zero-length packet", async () => {
    await expect(
      postPacket("http://entry.test", new Uint8Array(0)),
    ).rejects.toThrow(NoxClientError);
  });

  it("strips trailing slash from entry URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;

    await postPacket("http://entry.test/", validPacket);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://entry.test/api/v1/packets",
      expect.any(Object),
    );
  });

  it("throws TransportFailed on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(postPacket("http://entry.test", validPacket)).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  it("throws TransportFailed on HTTP 500", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(postPacket("http://entry.test", validPacket)).rejects.toThrow(
      "HTTP 500",
    );
  });

  it("sends correct Content-Type header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;

    await postPacket("http://entry.test", validPacket);
    const call = fetchMock.mock.calls[0]!;
    expect(call[1].headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("sends POST method", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock;

    await postPacket("http://entry.test", validPacket);
    const call = fetchMock.mock.calls[0]!;
    expect(call[1].method).toBe("POST");
  });
});

describe("pollResponses", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns items on 200 OK with valid array", async () => {
    const items = [
      { id: "surb-001", data: [1, 2, 3] },
      { id: "surb-002", data: [4, 5, 6] },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(items),
    });

    const result = await pollResponses("http://entry.test");
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("surb-001");
    expect(result[1]!.data).toEqual([4, 5, 6]);
  });

  it("returns empty array on 204 No Content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await pollResponses("http://entry.test");
    expect(result).toEqual([]);
  });

  it("throws TransportFailed on HTTP 500", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(pollResponses("http://entry.test")).rejects.toThrow("HTTP 500");
  });

  it("throws TransportFailed on invalid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad")),
    });

    await expect(pollResponses("http://entry.test")).rejects.toThrow("invalid JSON");
  });

  it("throws TransportFailed when response body is not an array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ not: "an array" }),
    });

    await expect(pollResponses("http://entry.test")).rejects.toThrow(
      "expected JSON array",
    );
  });

  it("throws TransportFailed when item is missing id field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ data: [1, 2] }]),
    });

    await expect(pollResponses("http://entry.test")).rejects.toThrow(
      "missing required fields",
    );
  });

  it("throws TransportFailed when item is missing data field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([{ id: "test" }]),
    });

    await expect(pollResponses("http://entry.test")).rejects.toThrow(
      "missing required fields",
    );
  });

  it("throws TransportFailed on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("timeout"));

    await expect(pollResponses("http://entry.test")).rejects.toThrow("timeout");
  });

  it("strips trailing slash from entry URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });
    globalThis.fetch = fetchMock;

    await pollResponses("http://entry.test/");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://entry.test/api/v1/responses/pending",
      expect.any(Object),
    );
  });

  it("handles empty array response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });

    const result = await pollResponses("http://entry.test");
    expect(result).toEqual([]);
  });
});
