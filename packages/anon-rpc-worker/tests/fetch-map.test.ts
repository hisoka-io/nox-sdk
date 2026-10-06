import { describe, expect, it } from "vitest";
import type { HttpRequestOptions } from "@hisoka-io/nox-client";
import {
  MAX_REDIRECT_HOPS,
  RESPONSE_ENVELOPE_ALLOWANCE,
  mapClientError,
  prepareRequest,
  redirectedRequest,
  defaultReplyEncoding,
  inflateReply,
  sendPrepared,
  toAnonResponse,
  type FetchSettings,
  type NoxHttpPort,
} from "../src/fetch-map.js";
import type { AnonRequestInit } from "../src/spec-types.js";
import { gzipSync } from "node:zlib";
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

  it("keeps header order and duplicates, drops hop and identifying fields, sets the reply encoding", async () => {
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
      ["accept-encoding", "gzip"],
    ]);
    const identity = await prepareRequest("https://example.test/", { headers: [["Accept-Encoding", "br"]] }, {
      ...SETTINGS,
      acceptEncoding: "identity",
    }, signal());
    expect(identity.headers).toEqual([["accept-encoding", "identity"]]);
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
      // The SDK's real nesting: client error → packet error → transport error → { phase, kpsCode }.
      ["TRANSPORT_FAILED", new Error("packet", { cause: new Error("transport", { cause: { phase: "read", kpsCode: "timeout" } }) }), "timeout"],
      ["TRANSPORT_FAILED", new Error("packet", { cause: new Error("transport", { cause: { phase: "dial", kpsCode: "network-error" } }) }), "network-error"],
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
});

describe("gzip replies", () => {
  const budget = { signal: new AbortController().signal, remainingMs: () => 25_000 };
  const logs = encoder.encode(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: Array.from({ length: 200 }, (_, i) => ({ address: "0x" + "ab".repeat(20), topics: ["0x" + i.toString(16).padStart(64, "0")], data: "0x" })),
  }));

  it("asks upstreams for gzip where the runtime can inflate", () => {
    expect(typeof DecompressionStream).toBe("function");
    expect(defaultReplyEncoding()).toBe("gzip");
  });

  it("inflates a gzip body end to end and drops content-encoding", async () => {
    const packed = gzipSync(logs);
    expect(packed.length * 5).toBeLessThan(logs.length);
    const target: NoxHttpPort = {
      httpRequest: async () => exitReply(200, [["Content-Encoding", "gzip"], ["content-type", "application/json"]], packed),
    };
    const prepared = await prepareRequest("https://rpc.test/", {
      method: "POST",
      headers: [["content-type", "application/json"]],
      body: encoder.encode('{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{}]}'),
    }, SETTINGS, new AbortController().signal);
    const response = await sendPrepared(prepared, target, { ...SETTINGS, maxResponseBytes: 1_000_000 }, budget);
    expect(response.body).toEqual(logs);
    expect(response.headers).toEqual([["content-type", "application/json"]]);
  });

  it("leaves identity replies unchanged and drops the header on an empty gzip body", async () => {
    const plain = { status: 200, headers: [["x", "1"]] as [string, string][], body: logs, truncated: false };
    expect(await inflateReply(plain, 1_000_000)).toBe(plain);
    const empty = await inflateReply({ ...plain, headers: [["content-encoding", "gzip"]], body: new Uint8Array(0) }, 10);
    expect(empty.headers).toEqual([]);
  });

  it("stops inflating past maxResponseBytes (a small reply cannot expand without bound)", async () => {
    const bomb = gzipSync(new Uint8Array(4_000_000));
    expect(bomb.length).toBeLessThan(10_000);
    await expect(inflateReply(
      { status: 200, headers: [["content-encoding", "gzip"]], body: bomb, truncated: false },
      65_536,
    )).rejects.toMatchObject({ code: "too-large" });
  });

  it("refuses a corrupt gzip body and codings it cannot inflate", async () => {
    const corrupt = gzipSync(logs).slice(0, 40);
    await expect(inflateReply(
      { status: 200, headers: [["content-encoding", "gzip"]], body: corrupt, truncated: false },
      1_000_000,
    )).rejects.toMatchObject({ code: "protocol-error" });
    const target: NoxHttpPort = { httpRequest: async () => exitReply(200, [["content-encoding", "br"]], "x") };
    const prepared = await prepareRequest("https://rpc.test/", undefined, SETTINGS, new AbortController().signal);
    await expect(sendPrepared(prepared, target, SETTINGS, budget)).rejects.toMatchObject({ code: "protocol-error" });
  });
});

describe("redirects (ARCHITECTURE §4.5)", () => {
  interface Sent {
    method: string;
    url: string;
    headers: [string, string][];
    body: string;
  }

  /** A port that answers each URL from `routes` (default 200 "final") and records what it was sent. */
  function scripted(routes: Record<string, Uint8Array>): NoxHttpPort & { sent: Sent[] } {
    const sent: Sent[] = [];
    return {
      sent,
      httpRequest: async (method, url, headers, body) => {
        sent.push({ method, url, headers, body: new TextDecoder().decode(body) });
        return routes[url] ?? exitReply(200, [["content-type", "text/plain"]], "final");
      },
    };
  }
  const budget = (remaining = 25_000) => ({ signal: signal(), remainingMs: () => remaining });
  const to = (status: number, location: string) => exitReply(status, [["Location", location]], "moved");
  const rpcBody = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';

  it("follows a redirect by default and reports the final URL", async () => {
    const target = scripted({ "http://rpc.test/v1": to(301, "https://rpc.test/v1") });
    const response = await sendPrepared(await prepare("http://rpc.test/v1"), target, SETTINGS, budget());
    expect(response.status).toBe(200);
    expect(response.url).toBe("https://rpc.test/v1");
    expect(new TextDecoder().decode(response.body as Uint8Array)).toBe("final");
    expect(target.sent.map((entry) => entry.url)).toEqual(["http://rpc.test/v1", "https://rpc.test/v1"]);
  });

  it("resolves a relative Location against the current URL", async () => {
    const target = scripted({ "https://rpc.test/a/b": to(302, "../c?x=1#frag") });
    const response = await sendPrepared(await prepare("https://rpc.test/a/b"), target, SETTINGS, budget());
    expect(response.url).toBe("https://rpc.test/c?x=1");
  });

  it("turns POST into GET without a body on 301, 302 and 303, dropping body headers", async () => {
    for (const status of [301, 302, 303]) {
      const target = scripted({ "https://rpc.test/": to(status, "https://rpc.test/moved") });
      const request = await prepare("https://rpc.test/", {
        method: "POST",
        headers: [["content-type", "application/json"], ["x-keep", "1"]],
        body: encoder.encode(rpcBody),
      });
      await sendPrepared(request, target, SETTINGS, budget());
      const hop = target.sent[1];
      expect(hop?.method).toBe("GET");
      expect(hop?.body).toBe("");
      expect(hop?.headers.map(([name]) => name)).toEqual(["x-keep", "accept-encoding"]);
    }
  });

  it("turns PUT into GET only on 303", async () => {
    for (const [status, expected] of [[302, { method: "PUT", body: "data" }], [303, { method: "GET", body: "" }]] as const) {
      const target = scripted({ "https://rpc.test/": to(status, "https://rpc.test/moved") });
      await sendPrepared(await prepare("https://rpc.test/", { method: "PUT", body: encoder.encode("data") }), target, SETTINGS, budget());
      expect(target.sent[1]).toMatchObject(expected);
    }
  });

  it("keeps method and body on 307 and 308", async () => {
    for (const status of [307, 308]) {
      const target = scripted({ "https://rpc.test/": to(status, "https://rpc.test/moved") });
      await sendPrepared(
        await prepare("https://rpc.test/", { method: "POST", body: encoder.encode(rpcBody) }),
        target,
        SETTINGS,
        budget(),
      );
      expect(target.sent[1]).toMatchObject({ method: "POST", url: "https://rpc.test/moved", body: rpcBody });
    }
  });

  it("drops authorization and cookie on a cross-origin hop and keeps them on a same-origin one", async () => {
    const target = scripted({
      "https://rpc.test/a": to(307, "https://rpc.test/b"),
      "https://rpc.test/b": to(307, "https://other.test/c"),
    });
    await sendPrepared(
      await prepare("https://rpc.test/a", { headers: [["Authorization", "Bearer t"], ["x-keep", "1"]] }),
      target,
      SETTINGS,
      budget(),
    );
    expect(target.sent[1]?.headers).toContainEqual(["Authorization", "Bearer t"]);
    expect(target.sent[2]?.headers.map(([name]) => name.toLowerCase())).toEqual(["x-keep", "accept-encoding"]);
    const next = redirectedRequest(
      { ...(await prepare("https://rpc.test/")), headers: [["Cookie", "id=1"], ["authorization", "x"], ["x", "1"]] },
      308,
      "http://rpc.test/",
    );
    expect(next?.headers).toEqual([["x", "1"]]);
  });

  it(`follows at most ${MAX_REDIRECT_HOPS} redirects; the next one is a network-error`, async () => {
    const chain = (hops: number): Record<string, Uint8Array> => {
      const routes: Record<string, Uint8Array> = {};
      for (let index = 0; index < hops; index++) routes[`https://rpc.test/${index}`] = to(302, `/${index + 1}`);
      return routes;
    };
    const ok = scripted(chain(MAX_REDIRECT_HOPS));
    const response = await sendPrepared(await prepare("https://rpc.test/0"), ok, SETTINGS, budget());
    expect(response.url).toBe(`https://rpc.test/${MAX_REDIRECT_HOPS}`);
    expect(ok.sent).toHaveLength(MAX_REDIRECT_HOPS + 1);
    const tooMany = scripted(chain(MAX_REDIRECT_HOPS + 1));
    await expectCode(sendPrepared(await prepare("https://rpc.test/0"), tooMany, SETTINGS, budget()), "network-error");
    expect(tooMany.sent).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });

  it("refuses a target that is not http(s) or not a URL with network-error, without sending it", async () => {
    for (const location of ["ftp://rpc.test/file", "javascript:alert(1)", "http://[bad"]) {
      const target = scripted({ "https://rpc.test/": to(302, location) });
      await expectCode(sendPrepared(await prepare("https://rpc.test/"), target, SETTINGS, budget()), "network-error");
      expect(target.sent).toHaveLength(1);
    }
  });

  it("returns the 3xx unchanged for manual and refuses it with network-error for error", async () => {
    const manual = scripted({ "https://rpc.test/": to(301, "https://other.test/") });
    const response = await sendPrepared(await prepare("https://rpc.test/", { redirect: "manual" }), manual, SETTINGS, budget());
    expect(response.status).toBe(301);
    expect(response.url).toBe("https://rpc.test/");
    expect(response.headers).toContainEqual(["location", "https://other.test/"]);
    expect(manual.sent).toHaveLength(1);
    const refused = scripted({ "https://rpc.test/": to(308, "https://other.test/") });
    await expectCode(sendPrepared(await prepare("https://rpc.test/", { redirect: "error" }), refused, SETTINGS, budget()), "network-error");
    expect(refused.sent).toHaveLength(1);
  });

  it("returns non-redirect 3xx statuses and a redirect without Location as they came", async () => {
    for (const status of [300, 304]) {
      const target = scripted({ "https://rpc.test/": exitReply(status, [["location", "/x"]], "") });
      const response = await sendPrepared(await prepare("https://rpc.test/", { redirect: "error" }), target, SETTINGS, budget());
      expect(response.status).toBe(status);
      expect(target.sent).toHaveLength(1);
    }
    const missing = scripted({ "https://rpc.test/": exitReply(302, [], "") });
    expect((await sendPrepared(await prepare("https://rpc.test/"), missing, SETTINGS, budget())).status).toBe(302);
    expect(missing.sent).toHaveLength(1);
  });

  it("never re-issues eth_sendRawTransaction with a changed method, but keeps it on 307 and 308", async () => {
    const tx = '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}';
    for (const status of [301, 302, 303]) {
      const target = scripted({ "https://rpc.test/": to(status, "https://rpc.test/moved") });
      const response = await sendPrepared(
        await prepare("https://rpc.test/", { method: "POST", body: encoder.encode(tx) }),
        target,
        SETTINGS,
        budget(),
      );
      expect(response.status).toBe(status);
      expect(target.sent).toHaveLength(1);
    }
    const kept = scripted({ "https://rpc.test/": to(307, "https://rpc.test/moved") });
    await sendPrepared(await prepare("https://rpc.test/", { method: "POST", body: encoder.encode(tx) }), kept, SETTINGS, budget());
    expect(kept.sent[1]).toMatchObject({ method: "POST", body: tx });
  });

  it("stops with network-error when the deadline passes between hops", async () => {
    let remaining = 25_000;
    const target = scripted({ "https://rpc.test/": to(302, "/next") });
    const original = target.httpRequest;
    target.httpRequest = async (...args) => {
      const reply = await original(...args);
      remaining = 0;
      return reply;
    };
    await expectCode(
      sendPrepared(await prepare("https://rpc.test/"), target, SETTINGS, { signal: signal(), remainingMs: () => remaining }),
      "network-error",
    );
    expect(target.sent).toHaveLength(1);
  });

  it("re-profiles a hop that became a GET", async () => {
    const options: HttpRequestOptions[] = [];
    const target: NoxHttpPort = {
      httpRequest: async (_method, url, _headers, _body, opts) => {
        options.push(opts);
        return url === "https://rpc.test/" ? to(303, "/moved") : exitReply(200, [], "{}");
      },
    };
    await sendPrepared(
      await prepare("https://rpc.test/", { method: "POST", body: encoder.encode('{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{}]}') }),
      target,
      SETTINGS,
      budget(),
    );
    expect(options[0]).toMatchObject({ retry: "none", opKey: "http:jsonrpc:eth_getLogs" });
    expect(options[1]).toMatchObject({ retry: "route", opKey: "http:other" });
  });
});
