import { describe, expect, it } from "vitest";
import { prepareRequest, type FetchSettings } from "../src/fetch-map.js";
import { LOCAL_ANSWER_MAX_ENTRIES, LocalAnswers } from "../src/local-answers.js";
import { runNoxWorker, type WorkerDeps } from "../src/core.js";
import type { AnonFetchResponse } from "../src/spec-types.js";
import { FakeHarness, idleKps } from "./helpers/fake-harness.js";
import { FakeClient, exitReply, makeBootstrap, makePinned, scriptedConnect } from "./helpers/fixtures.js";

const SETTINGS: FetchSettings = { attemptTimeoutMs: 12_000, maxRequestBytes: 65_536, maxResponseBytes: 1_000_000 };
const URL_A = "https://rpc.example.test/";
const HASH = "0x" + "ab".repeat(32);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function prepare(body: unknown, url = URL_A, headers: [string, string][] = []) {
  return prepareRequest(url, {
    method: "POST",
    headers: [["content-type", "application/json"], ...headers],
    body: encoder.encode(JSON.stringify(body)),
  }, SETTINGS, new AbortController().signal);
}

function reply(result: unknown, id: unknown = 1): AnonFetchResponse {
  return {
    status: 200,
    headers: [["content-type", "application/json"], ["date", "x"]],
    body: encoder.encode(JSON.stringify({ jsonrpc: "2.0", id, result })),
  };
}

function call(method: string, params: unknown[], id: unknown = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

describe("LocalAnswers", () => {
  it("memoises eth_chainId per URL after a second matching answer, with the caller's id", async () => {
    const answers = new LocalAnswers();
    const first = await prepare(call("eth_chainId", []));
    expect(answers.lookup(first)).toBeUndefined();
    expect(answers.observe(first, reply("0x1"))).toBe("verify");
    expect(answers.lookup(first)).toBeUndefined();
    expect(answers.observe(first, reply("0x1"))).toBeUndefined();
    const later = await prepare(call("eth_chainId", [], "abc"));
    const hit = answers.lookup(later);
    expect(hit?.kind).toBe("memo");
    expect(JSON.parse(decoder.decode(hit!.response.body as Uint8Array))).toEqual({ jsonrpc: "2.0", id: "abc", result: "0x1" });
    expect(hit?.response.headers).toEqual([["content-type", "application/json"]]);
    expect(answers.lookup(await prepare(call("eth_chainId", []), "https://other.test/"))).toBeUndefined();
  });

  it("never keeps an empty list for a block-hash read (the upstream may not have the block yet)", async () => {
    const answers = new LocalAnswers();
    for (const body of [call("eth_getLogs", [{ blockHash: HASH }]), call("eth_getBlockReceipts", [HASH])]) {
      const request = await prepare(body);
      answers.observe(request, reply([]));
      answers.observe(request, reply([]));
      expect(answers.lookup(request)).toBeUndefined();
    }
    expect(answers.size).toBe(0);
  });

  it("drops a memo whose check disagrees", async () => {
    const answers = new LocalAnswers();
    const request = await prepare(call("net_version", []));
    answers.observe(request, reply("1"));
    answers.observe(request, reply("5"));
    expect(answers.lookup(request)).toBeUndefined();
    expect(answers.size).toBe(0);
  });

  it("serves block-hash reads after two matching answers and never block-number reads", async () => {
    const answers = new LocalAnswers();
    const cases = [
      call("eth_getBlockByHash", [HASH, false]),
      call("eth_getLogs", [{ blockHash: HASH, address: "0x" + "11".repeat(20) }]),
      call("eth_getBalance", ["0x" + "22".repeat(20), { blockHash: HASH }]),
      call("eth_call", [{ to: "0x" + "33".repeat(20), data: "0x" }, { blockHash: HASH }]),
      call("eth_getBlockReceipts", [HASH]),
    ];
    for (const body of cases) {
      const request = await prepare(body);
      expect(answers.observe(request, reply({ ok: body.method }))).toBeUndefined();
      expect(answers.lookup(request)).toBeUndefined();
      answers.observe(request, reply({ ok: body.method }));
      expect(answers.lookup(request)?.kind).toBe("block-hash");
    }
    const never = [
      call("eth_getBlockByNumber", ["0x10", false]),
      call("eth_getBalance", ["0x" + "22".repeat(20), "latest"]),
      call("eth_getBalance", ["0x" + "22".repeat(20), { blockHash: HASH, requireCanonical: true }]),
      call("eth_getLogs", [{ blockHash: HASH, fromBlock: "0x1" }]),
      call("eth_blockNumber", []),
      call("eth_sendRawTransaction", ["0x00"]),
    ];
    for (const body of never) {
      const request = await prepare(body);
      answers.observe(request, reply("0x1"));
      answers.observe(request, reply("0x1"));
      expect(answers.lookup(request)).toBeUndefined();
    }
  });

  it("keeps no errors, null results, batches or no-cache requests", async () => {
    const answers = new LocalAnswers();
    const request = await prepare(call("eth_getBlockByHash", [HASH, false]));
    const error = { status: 200, headers: [], body: encoder.encode('{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x"}}') };
    answers.observe(request, error);
    answers.observe(request, error);
    answers.observe(request, reply(null));
    answers.observe(request, reply(null));
    expect(answers.lookup(request)).toBeUndefined();
    const batch = await prepare([call("eth_chainId", []), call("eth_chainId", [], 2)]);
    expect(answers.observe(batch, reply("0x1"))).toBeUndefined();
    const noCache = await prepare(call("eth_chainId", []), URL_A, [["Cache-Control", "no-cache"]]);
    expect(answers.observe(noCache, reply("0x1"))).toBeUndefined();
    expect(answers.size).toBe(0);
  });

  it("bounds the number of answers held", async () => {
    const answers = new LocalAnswers();
    for (let i = 0; i < LOCAL_ANSWER_MAX_ENTRIES + 10; i++) {
      const hash = "0x" + i.toString(16).padStart(64, "0");
      answers.observe(await prepare(call("eth_getBlockByHash", [hash, false])), reply({ i }));
    }
    expect(answers.size).toBe(LOCAL_ANSWER_MAX_ENTRIES);
  });
});

describe("worker-local answers in the worker", () => {
  it("answers eth_chainId locally after the background check, so later calls send nothing", async () => {
    const pinned = makePinned();
    const harness = new FakeHarness(undefined, idleKps());
    const client = new FakeClient(pinned, () =>
      exitReply(200, [["content-type", "application/json"]], '{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}'));
    const scripted = scriptedConnect(client);
    const deps: WorkerDeps = {
      snapshot: pinned,
      bootstrap: makeBootstrap(pinned),
      loadWasm: async () => ({ marker: true }),
      connect: scripted.connect,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    };
    void runNoxWorker(harness.api, deps);
    await harness.ready;
    const chainId = (id: number) => harness.fetch(URL_A, {
      method: "POST",
      headers: [["content-type", "application/json"]],
      body: encoder.encode(JSON.stringify(call("eth_chainId", [], id))),
    });
    expect((await chainId(1)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.requests).toHaveLength(2);
    const local = await chainId(7);
    expect(client.requests).toHaveLength(2);
    const body = await new Response(local.body as BodyInit).json();
    expect(body).toEqual({ jsonrpc: "2.0", id: 7, result: "0xaa36a7" });
  });
});
