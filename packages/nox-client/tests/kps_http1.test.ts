import { describe, expect, it } from "vitest";
import {
  MAX_INTERIM_RESPONSES,
  encodeKpsHttpRequest,
  parseResponseHead,
  readKpsHttpResponseBody,
  readKpsHttpResponseHead,
} from "../src/kps/http1.js";
import { NoxKpsError } from "../src/kps/errors.js";
import { certhashFor } from "./helpers/fake_kps.js";

const CERTHASH = certhashFor("node-1");
const LIMITS = { maxHeadBytes: 16 * 1024, maxBodyBytes: 1024 };
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** A reader over fixed chunks, like the readable half of a KPS stream. */
function readerOf(...chunks: (string | Uint8Array)[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  }).getReader();
}

async function readResponse(method: string, ...chunks: (string | Uint8Array)[]) {
  const reader = readerOf(...chunks);
  const { head, rest } = await readKpsHttpResponseHead(reader, LIMITS);
  const body = await readKpsHttpResponseBody(reader, head, rest, method, LIMITS);
  return { head, body: text(body) };
}

async function expectRejects(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof NoxKpsError && error.code === code,
  );
}

describe("encodeKpsHttpRequest", () => {
  it("writes Host = certhash and Content-Length for a POST body", () => {
    const body = new Uint8Array([1, 2, 3]);
    const bytes = encodeKpsHttpRequest({
      method: "POST",
      path: "/api/v1/packets",
      certhash: CERTHASH,
      headers: [["Content-Type", "application/octet-stream"]],
      body,
    });
    const head = text(bytes.subarray(0, bytes.length - 3));
    expect(head).toBe(
      `POST /api/v1/packets HTTP/1.1\r\nHost: ${CERTHASH}\r\nContent-Type: application/octet-stream\r\nContent-Length: 3\r\n\r\n`,
    );
    expect([...bytes.subarray(bytes.length - 3)]).toEqual([1, 2, 3]);
  });

  it("sends Content-Length: 0 for a bodyless POST and none for GET", () => {
    const post = text(encodeKpsHttpRequest({ method: "POST", path: "/x", certhash: CERTHASH, headers: [], body: null }));
    expect(post).toContain("Content-Length: 0\r\n");
    const get = text(encodeKpsHttpRequest({ method: "GET", path: "/topology", certhash: CERTHASH, headers: [], body: null }));
    expect(get).toBe(`GET /topology HTTP/1.1\r\nHost: ${CERTHASH}\r\n\r\n`);
  });

  it("keeps duplicate headers in order", () => {
    const bytes = encodeKpsHttpRequest({
      method: "POST",
      path: "/x",
      certhash: CERTHASH,
      headers: [["X-A", "1"], ["X-A", "2"]],
      body: new Uint8Array(0),
    });
    expect(text(bytes)).toContain("X-A: 1\r\nX-A: 2\r\n");
  });

  it("refuses managed fields, bad tokens, header injection and GET bodies", () => {
    const base = { method: "POST", path: "/x", certhash: CERTHASH, body: null };
    for (const headers of [
      [["Host", "evil"]],
      [["Content-Length", "5"]],
      [["Transfer-Encoding", "chunked"]],
      [["Connection", "keep-alive"]],
      [["Upgrade", "websocket"]],
      [["Expect", "100-continue"]],
      [["Bad Name", "x"]],
      [["X-Ok", "a\r\nInjected: 1"]],
      [["X-Ok", "café"]],
    ] as [string, string][][]) {
      expect(() => encodeKpsHttpRequest({ ...base, headers })).toThrow(NoxKpsError);
    }
    expect(() => encodeKpsHttpRequest({ ...base, method: "PO ST", headers: [] })).toThrow(NoxKpsError);
    expect(() =>
      encodeKpsHttpRequest({ method: "GET", path: "/x", certhash: CERTHASH, headers: [], body: new Uint8Array(1) })
    ).toThrow(/must not carry a body/u);
  });
});

describe("KPS-HTTP/1 response parsing", () => {
  it("reads a head split across chunks and an EOF-delimited body", async () => {
    const { head, body } = await readResponse(
      "POST",
      "HTTP/1.1 202 Acc",
      "epted\r\ncontent-length: 21\r\n",
      "\r\nhttp-0000000000000001",
    );
    expect(head.status).toBe(202);
    expect(head.reason).toBe("Accepted");
    expect(head.headers).toEqual([["content-length", "21"]]);
    expect(body).toBe("http-0000000000000001");
  });

  it("accepts a status line without a reason phrase and a body without Content-Length", async () => {
    const { head, body } = await readResponse("GET", "HTTP/1.1 200\r\n\r\n", "abc", "def");
    expect(head.status).toBe(200);
    expect(head.reason).toBe("");
    expect(body).toBe("abcdef");
  });

  it("skips interim 1xx heads but abandons a 101 upgrade", async () => {
    const { head } = await readResponse("GET", "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
    expect(head.status).toBe(200);
    await expectRejects(readResponse("GET", "HTTP/1.1 101 Switching\r\nupgrade: websocket\r\n\r\n"), "protocol-error");
    const flood = "HTTP/1.1 100 Continue\r\n\r\n".repeat(MAX_INTERIM_RESPONSES + 1);
    await expectRejects(readResponse("GET", `${flood}HTTP/1.1 200 OK\r\n\r\n`), "protocol-error");
  });

  it("abandons Transfer-Encoding, obs-fold, duplicate Content-Length and malformed lines", async () => {
    for (const head of [
      "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n",
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: identity\r\n\r\n",
      "HTTP/1.1 200 OK\r\nx-a: 1\r\n continued\r\n\r\n",
      "HTTP/1.1 200 OK\r\ncontent-length: 1\r\ncontent-length: 1\r\n\r\nx",
      "HTTP/1.1 200 OK\r\ncontent-length: 1, 1\r\n\r\nx",
      "HTTP/1.1 200 OK\r\ncontent-length: -1\r\n\r\n",
      "HTTP/1.1 200 OK\r\nbad header\r\n\r\n",
      "HTTP/1.1 200 OK\r\nname : value\r\n\r\n",
      "HTTP/1.1 200 OK\r\nx: a\nb\r\n\r\n",
      "HTTP/1.0 200 OK\r\n\r\n",
      "HTTP/2 200\r\n\r\n",
      "HTTP/1.1 999 Nope\r\n\r\n",
      "HTTP/1.1 20 Short\r\n\r\n",
      "garbage\r\n\r\n",
    ]) {
      await expectRejects(readResponse("GET", head), "protocol-error");
    }
  });

  it("checks Content-Length against the EOF-delimited body", async () => {
    await expectRejects(readResponse("GET", "HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nabc"), "protocol-error");
    await expectRejects(readResponse("GET", "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nabc"), "protocol-error");
    const { body } = await readResponse("GET", "HTTP/1.1 200 OK\r\ncontent-length: 3\r\n\r\nabc");
    expect(body).toBe("abc");
  });

  it("requires 204, 304 and HEAD responses to be empty", async () => {
    const { head, body } = await readResponse("POST", "HTTP/1.1 204 No Content\r\n\r\n");
    expect(head.status).toBe(204);
    expect(body).toBe("");
    await expectRejects(readResponse("POST", "HTTP/1.1 204 No Content\r\n\r\nnull"), "protocol-error");
    const headResponse = await readResponse("HEAD", "HTTP/1.1 200 OK\r\ncontent-length: 99\r\n\r\n");
    expect(headResponse.body).toBe("");
  });

  it("enforces the head and body caps", async () => {
    const huge = `HTTP/1.1 200 OK\r\nx: ${"a".repeat(LIMITS.maxHeadBytes)}\r\n\r\n`;
    await expectRejects(readResponse("GET", huge), "too-large");
    await expectRejects(readResponse("GET", `HTTP/1.1 200 OK\r\n${"x: y\r\n".repeat(4000)}`), "too-large");
    await expectRejects(
      readResponse("GET", "HTTP/1.1 200 OK\r\n\r\n", "a".repeat(LIMITS.maxBodyBytes + 1)),
      "too-large",
    );
    await expectRejects(
      readResponse("GET", `HTTP/1.1 200 OK\r\ncontent-length: ${LIMITS.maxBodyBytes + 1}\r\n\r\n`),
      "too-large",
    );
  });

  it("reports a stream that ends before or inside the head", async () => {
    await expectRejects(readResponse("GET"), "protocol-error");
    await expectRejects(readResponse("GET", "HTTP/1.1 200 OK\r\n"), "protocol-error");
  });

  it("lowercases header names and keeps duplicates in order", () => {
    const head = parseResponseHead(new TextEncoder().encode("HTTP/1.1 200 OK\r\nX-A: 1\r\nx-a:  2 \r\nVary: a"));
    expect(head.headers).toEqual([["x-a", "1"], ["x-a", "2"], ["vary", "a"]]);
  });
});
