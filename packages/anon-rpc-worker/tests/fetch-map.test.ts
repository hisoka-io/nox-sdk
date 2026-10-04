import { describe, expect, it } from "vitest";
import type { HttpRequestOptions } from "@hisoka-io/nox-client";
import {
  RESPONSE_ENVELOPE_ALLOWANCE,
  mapClientError,
  prepareRequest,
  sendPrepared,
  toAnonResponse,
  type FetchSettings,
  type NoxHttpPort,
} from "../src/fetch-map.js";
import type { AnonRequestInit } from "../src/spec-types.js";
import { exitReply } from "./helpers/fixtures.js";

const SETTINGS: FetchSettings = { attemptTimeoutMs: 12_000, maxRequestBytes: 1_024, maxResponseBytes: 65_536 };
const encoder = new TextEncoder();

function signal(): AbortSignal {
  return new AbortController().signal;
}

function prepare(url: string, init?: AnonRequestInit) {
  return prepareRequest(url, init, SETTINGS, signal());
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("request mapping", () => {
  it("accepts only absolute http(s) URLs and drops the fragment", async () => {
    await expectCode(prepare("/relative"), "unsupported");
    await expectCode(prepare("ftp://example.test/"), "unsupported");
    await expectCode(prepare(""), "unsupported");
    await expectCode(prepare(`https://example.test/${"a".repeat(9_000)}`), "too-large");
    expect((await prepare("https://example.test/path?q=1#frag")).url).toBe("https://example.test/path?q=1");
  });

  it("defaults to GET, upper-cases standard methods and refuses bad or forbidden ones", async () => {
    expect((await prepare("https://example.test/")).method).toBe("GET");
    expect((await prepare("https://example.test/", { method: "post" })).method).toBe("POST");
    expect((await prepare("https://example.test/", { method: "patch" })).method).toBe("patch");
    await expectCode(prepare("https://example.test/", { method: "GE T" }), "unsupported");
    await expectCode(prepare("https://example.test/", { method: "connect" }), "unsupported");
  });

  it("keeps header order and duplicates, drops hop and identifying fields, forces identity encoding", async () => {
    const request = await prepare("https://example.test/", {
      method: "POST",
      headers: [
        ["X-A", "1"],
        ["Host", "evil.test"],
        ["x-a", "2"],
        ["Cookie", "id=1"],
        ["User-Agent", "wallet/1"],
        ["Proxy-Authorization", "x"],
        ["Accept-Encoding", "gzip"],
        ["Content-Type", "application/json"],
        ["Authorization", "Bearer t"],
      ],
      body: encoder.encode("{}"),
    });
    expect(request.headers).toEqual([
      ["X-A", "1"],
      ["x-a", "2"],
      ["Content-Type", "application/json"],
      ["Authorization", "Bearer t"],
      ["accept-encoding", "identity"],
    ]);
  });

  it("refuses invalid header names and values", async () => {
    await expectCode(prepare("https://example.test/", { headers: [["Bad Name", "x"]] }), "unsupported");
    await expectCode(prepare("https://example.test/", { headers: [["X", "a\r\nInjected: 1"]] }), "unsupported");
    await expectCode(prepare("https://example.test/", { headers: "x" as unknown as [string, string][] }), "unsupported");
  });

  it("copies byte bodies, buffers stream bodies and enforces the request cap", async () => {
    const bytes = encoder.encode('{"a":1}');
    const request = await prepare("https://example.test/", { method: "POST", body: bytes });
    expect(request.body).toEqual(bytes);
    expect(request.body.buffer).not.toBe(bytes.buffer);
    const streamed = await prepare("https://example.test/", {
      method: "POST",
      body: streamOf([encoder.encode("ab"), encoder.encode("cd")]),
    });
    expect(new TextDecoder().decode(streamed.body)).toBe("abcd");
    await expectCode(prepare("https://example.test/", { method: "POST", body: new Uint8Array(2_000) }), "too-large");
    await expectCode(
      prepare("https://example.test/", { method: "POST", body: streamOf([new Uint8Array(600), new Uint8Array(600)]) }),
      "too-large",
    );
    await expectCode(prepare("https://example.test/", { method: "GET", body: bytes }), "unsupported");
  });

  it("stops reading a stream body when the call aborts", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("aborted"), { code: "cancelled" });
    const pending = prepareRequest(
      "https://example.test/",
      { method: "POST", body: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }) },
      SETTINGS,
      controller.signal,
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("refuses an unknown redirect mode", async () => {
    await expectCode(prepare("https://example.test/", { redirect: "auto" as "follow" }), "unsupported");
  });
});

describe("sending", () => {
  function port(reply: Uint8Array | Error): NoxHttpPort & { options: HttpRequestOptions[] } {
    const options: HttpRequestOptions[] = [];
    return {
      options,
      httpRequest: async (_method, _url, _headers, _body, opts) => {
        options.push(opts);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
  }
  const budget = (remaining = 25_000) => ({ signal: signal(), remainingMs: () => remaining });

  it("sizes and retries small reads, and caps the reply at the response limit plus framing", async () => {
    const target = port(exitReply(200, [], "{}"));
    const request = await prepare("https://rpc.test/", {
      method: "POST",
      headers: [["content-type", "application/json"]],
      body: encoder.encode('{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[]}'),
    });
    await sendPrepared(request, target, SETTINGS, budget());
    expect(target.options[0]).toMatchObject({
      timeoutMs: 12_000,
      expectedResponseBytes: 30_000,
      retry: "route",
      minSurbs: 2,
      opKey: "http:jsonrpc:eth_call",
      maxResponseBytes: SETTINGS.maxResponseBytes + RESPONSE_ENVELOPE_ALLOWANCE,
    });
  });

  it("gives writes and large reads one attempt with the whole remaining deadline", async () => {
    for (const body of [
      '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}',
      '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{}]}',
    ]) {
      const target = port(exitReply(200, [], "{}"));
      await sendPrepared(await prepare("https://rpc.test/", { method: "POST", body: encoder.encode(body) }), target, SETTINGS, budget(20_000));
      expect(target.options[0]).toMatchObject({ timeoutMs: 20_000, retry: "none" });
    }
  });

  it("lets the adaptive budget size non-JSON-RPC requests", async () => {
    const target = port(exitReply(200, [], "ok"));
    await sendPrepared(await prepare("https://example.test/"), target, SETTINGS, budget());
    expect(target.options[0]?.expectedResponseBytes).toBeUndefined();
    expect(target.options[0]).toMatchObject({ opKey: "http:other", retry: "route" });
  });

  it("refuses to send once the deadline has passed", async () => {
    const target = port(exitReply(200, [], "{}"));
    await expectCode(sendPrepared(await prepare("https://example.test/"), target, SETTINGS, budget(0)), "timeout");
    expect(target.options).toHaveLength(0);
  });

  it("maps an undecodable exit reply to protocol-error", async () => {
    await expectCode(sendPrepared(await prepare("https://example.test/"), port(new Uint8Array([1, 2])), SETTINGS, budget()), "protocol-error");
  });

  it("maps client failures to call codes", () => {
    const cases: [string, unknown, string][] = [
      ["RESPONSE_TIMEOUT", undefined, "timeout"],
      ["TRANSPORT_FAILED", { kpsCode: "timeout", phase: "read" }, "timeout"],
      ["TRANSPORT_FAILED", { phase: "dial" }, "network-error"],
      ["KPS_UNAVAILABLE", undefined, "network-error"],
      ["NO_NODES_AVAILABLE", undefined, "network-error"],
      ["TOPOLOGY_STALE", undefined, "network-error"],
      ["RESPONSE_TOO_LARGE", undefined, "too-large"],
      ["DECRYPTION_FAILED", undefined, "protocol-error"],
      ["WASM_NOT_INITIALIZED", undefined, "internal-error"],
    ];
    for (const [code, cause, expected] of cases) {
      expect(mapClientError(Object.assign(new Error("x"), { code, cause })).code).toBe(expected);
    }
  });
});

describe("response mapping", () => {
  const request = { url: "https://example.test/", redirect: "follow" as const };

  it("keeps status and body, filters hop headers and sorts by name", () => {
    const body = encoder.encode("hello");
    const response = toAnonResponse(
      {
        status: 201,
        headers: [["X-Z", "1"], ["Content-Type", "text/plain"], ["Content-Length", "5"], ["Set-Cookie", "a=b"], ["Connection", "close"]],
        body,
        truncated: false,
      },
      request,
      SETTINGS,
    );
    expect(response.status).toBe(201);
    expect(response.headers).toEqual([["content-type", "text/plain"], ["x-z", "1"]]);
    expect(response.body).toEqual(body);
    expect((response.body as Uint8Array).buffer).not.toBe(body.buffer);
    expect(response.url).toBe("https://example.test/");
  });

  it("drops header pairs a Response cannot carry", () => {
    const response = toAnonResponse(
      { status: 200, headers: [["bad name", "x"], ["ok", "fine"]], body: new Uint8Array(0), truncated: false },
      request,
      SETTINGS,
    );
    expect(response.headers).toEqual([["ok", "fine"]]);
  });

  it("refuses truncated, oversize, encoded and out-of-range replies", () => {
    const base = { status: 200, headers: [] as [string, string][], body: new Uint8Array(0), truncated: false };
    expect(() => toAnonResponse({ ...base, truncated: true }, request, SETTINGS)).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(() => toAnonResponse({ ...base, body: new Uint8Array(70_000) }, request, SETTINGS)).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(() => toAnonResponse({ ...base, headers: [["Content-Encoding", "gzip"]] }, request, SETTINGS)).toThrow(expect.objectContaining({ code: "protocol-error" }));
    expect(() => toAnonResponse({ ...base, status: 101 }, request, SETTINGS)).toThrow(expect.objectContaining({ code: "protocol-error" }));
    expect(() => toAnonResponse({ ...base, status: 600 }, request, SETTINGS)).toThrow(expect.objectContaining({ code: "protocol-error" }));
    expect(toAnonResponse({ ...base, headers: [["content-encoding", "identity"]] }, request, SETTINGS).headers).toEqual([]);
  });

  it("returns redirects unchanged for follow and manual, and refuses them for error", () => {
    const reply = { status: 302, headers: [["location", "https://other.test/"]] as [string, string][], body: new Uint8Array(0), truncated: false };
    expect(toAnonResponse(reply, { ...request, redirect: "follow" }, SETTINGS).status).toBe(302);
    expect(toAnonResponse(reply, { ...request, redirect: "manual" }, SETTINGS).status).toBe(302);
    expect(() => toAnonResponse(reply, { ...request, redirect: "error" }, SETTINGS)).toThrow(expect.objectContaining({ code: "unsupported" }));
  });
});
