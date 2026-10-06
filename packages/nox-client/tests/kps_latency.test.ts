/**
 * Latency work over KPS: claim protocol v2 (binary batch, retain, ack,
 * long-poll) with v1 fallback, data-first claims, concurrent claims, lost
 * reply recovery, the resend policy (hedge, lost-reply resend, transport
 * budget, same-entry fallback), the claim lane and standby failover.
 * Global `fetch` and `WebSocket` throw: KPS mode must never reach them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoxClient } from "../src/client.js";
import { decodeHttpResponse } from "../src/http_response.js";
import {
  CLAIM_BINARY_MEDIA_TYPE,
  claimReplies,
  decodeBase64,
  decodeBinaryClaim,
  encodeBinaryClaim,
} from "../src/transport.js";
import { RESEND_FAST } from "../src/resend.js";
import { LatencyTracker, resolveResendPolicy } from "../src/resend.js";
import { resolveReplyClaimSettings, surbIdOfItem } from "../src/reply_claims.js";
import { NoxClientErrorCode, type NoxClientConfig, type NoxLogLevel, type PinnedSnapshot } from "../src/types.js";
import { FakeKpsNetwork, kpsAddressFor, type FakeReply } from "./helpers/fake_kps.js";
import { FakeMixnet, encodeExitHttpResponse, fakeWasmBindings } from "./helpers/fake_mixnet.js";
import { DEFAULT_MEMBERS, makePinned, served } from "./helpers/pinned_fixture.js";

interface LogEntry {
  level: NoxLogLevel;
  event: string;
  fields: Readonly<Record<string, string | number | boolean>> | undefined;
}

const OK_BODY = '{"jsonrpc":"2.0","id":1,"result":"0x10"}';

function bed(pinned: PinnedSnapshot = makePinned(), wasm = fakeWasmBindings()) {
  const network = new FakeKpsNetwork();
  const logs: LogEntry[] = [];
  const mixnet = new FakeMixnet(
    () => served(pinned, Math.floor(Date.now() / 1000), {}),
    () => encodeExitHttpResponse(200, [["content-type", "application/json"]], OK_BODY),
  );
  network.route(undefined, mixnet.handler);
  const config = (extra: Partial<NoxClientConfig> = {}, kps: Record<string, unknown> = {}): NoxClientConfig => ({
    mode: "kps",
    wasm,
    timeoutMs: 3_000,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    kps: { dial: network.dial, pinned, topologySources: 1, claimIntervalMs: 10, ...kps },
    ...extra,
  });
  return { pinned, network, logs, mixnet, config };
}

const clients: NoxClient[] = [];

async function connect(config: NoxClientConfig): Promise<NoxClient> {
  const client = await NoxClient.connect(config);
  clients.push(client);
  return client;
}

function get(client: NoxClient, path = "/", options: Parameters<NoxClient["httpRequest"]>[4] = {}): Promise<Uint8Array> {
  return client.httpRequest("GET", `https://example.test${path}`, [], new Uint8Array(0), options);
}

function body(reply: Uint8Array): string {
  return new TextDecoder().decode(decodeHttpResponse(reply).body);
}

function events(logs: LogEntry[], name: string): LogEntry[] {
  return logs.filter((entry) => entry.event === name);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("KPS mode must never call the global fetch");
  }));
  vi.stubGlobal("WebSocket", class {
    constructor() {
      throw new Error("KPS mode must never open a WebSocket");
    }
  });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("binary claim batch", () => {
  it("round-trips items and the reclaimed flag in the nox claim-batch layout", () => {
    const items = [
      { id: "reply-0-" + "ab".repeat(16), data: new Uint8Array([1, 2, 3]), reclaimed: false },
      { id: "c", data: new Uint8Array(0), reclaimed: true },
    ];
    const encoded = encodeBinaryClaim(items);
    // Layout check against nox crates/nox-node/src/ingress/claim.rs `batch_layout_is_exact`.
    expect(Array.from(encodeBinaryClaim([
      { id: "ab", data: new Uint8Array([1, 2, 3]) },
      { id: "c", data: new Uint8Array(0), reclaimed: true },
    ]))).toEqual([1, 0, 2, 0, 0, 2, 97, 98, 0, 0, 0, 3, 1, 2, 3, 1, 0, 1, 99, 0, 0, 0, 0]);
    expect(Array.from(encodeBinaryClaim([]))).toEqual([1, 0, 0]);
    expect(decodeBinaryClaim(encoded)).toEqual(items);
  });

  it("rejects truncated, trailing, unknown-version and empty-ID batches with the offset", () => {
    const good = encodeBinaryClaim([{ id: "x", data: new Uint8Array([9, 9]) }]);
    expect(() => decodeBinaryClaim(good.slice(0, good.length - 1))).toThrow(/truncated item 0 data/);
    expect(() => decodeBinaryClaim(new Uint8Array([...good, 0]))).toThrow(/after the last item/);
    expect(() => decodeBinaryClaim(new Uint8Array([2, 0, 0]))).toThrow(/unknown batch version 2/);
    expect(() => decodeBinaryClaim(new Uint8Array([1, 0, 1, 0, 0, 0]))).toThrow(/empty ID/);
    expect(() => decodeBinaryClaim(new Uint8Array([1, 0]))).toThrow(/truncated header/);
  });

  it("decodes standard padded base64", () => {
    for (const [text, bytes] of [["", ""], ["Zg==", "f"], ["Zm8=", "fo"], ["Zm9vYmFy", "foobar"]] as const) {
      expect(new TextDecoder().decode(decodeBase64(text)!)).toBe(bytes);
    }
    expect(Array.from(decodeBase64("+/+/")!)).toEqual([0xfb, 0xff, 0xbf]);
    expect(decodeBase64("Zg=")).toBeNull();
    expect(decodeBase64("Z!==")).toBeNull();
  });

  it("maps item IDs to the SURB ID they answer", () => {
    const id = "0f".repeat(16);
    expect(surbIdOfItem(id)).toBe(id);
    expect(surbIdOfItem(`reply-0-${id}`)).toBe(id);
    expect(surbIdOfItem("echo-1-xyz")).toBeNull();
  });
});

describe("claimReplies negotiation", () => {
  const ids = ["aa".repeat(16)];

  it("asks for the batch, retain, acks and a wait in the body and Accept", async () => {
    let seen: { headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      seen = { headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response(null, { status: 204 });
    };
    await claimReplies("kps:x", ids, { timeoutMs: 1_000, fetchImpl, binary: true, retain: true, ack: ["bb".repeat(16)], waitMs: 500 });
    expect(seen?.body).toEqual({ surb_ids: ids, encoding: "binary", retain: true, ack: ["bb".repeat(16)], wait_ms: 500 });
    expect(seen?.headers["Accept"]).toContain(CLAIM_BINARY_MEDIA_TYPE);
  });

  it("never asks for a wait without retain (the entry would not honour it)", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    };
    await claimReplies("kps:x", ids, { timeoutMs: 1_000, fetchImpl, waitMs: 500 });
    expect(sent).toEqual({ surb_ids: ids });
  });

  it("reads a v1 JSON answer, a v2 base64 answer and a v2 binary answer by Content-Type", async () => {
    const answers: Response[] = [
      new Response(JSON.stringify([{ id: "r-1", data: [1, 2] }]), { status: 200, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify([{ id: "r-2", data_b64: "AwQ=", reclaimed: true }]), {
        status: 200,
        headers: { "content-type": "application/json", "x-nox-claim-version": "2" },
      }),
      new Response(encodeBinaryClaim([{ id: "r-3", data: new Uint8Array([5]) }]), {
        status: 200,
        headers: { "content-type": CLAIM_BINARY_MEDIA_TYPE, "x-nox-claim-wait-max-ms": "8000" },
      }),
    ];
    const fetchImpl = async (): Promise<Response> => answers.shift()!;
    const v1 = await claimReplies("kps:x", ids, { timeoutMs: 1_000, fetchImpl, binary: true });
    expect(v1).toMatchObject({ format: "json", v2: false });
    expect(Array.from(v1.items[0]!.data)).toEqual([1, 2]);
    const b64 = await claimReplies("kps:x", ids, { timeoutMs: 1_000, fetchImpl, binary: true });
    expect(b64).toMatchObject({ format: "base64", v2: true });
    expect(b64.items[0]).toMatchObject({ id: "r-2", reclaimed: true });
    expect(Array.from(b64.items[0]!.data)).toEqual([3, 4]);
    const batch = await claimReplies("kps:x", ids, { timeoutMs: 1_000, fetchImpl, binary: true });
    expect(batch).toMatchObject({ format: "binary", v2: true, waitMaxMs: 8_000 });
    expect(Array.from(batch.items[0]!.data)).toEqual([5]);
  });

  it("fails a claim that outlives its timeout with TRANSPORT_FAILED", async () => {
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    await expect(claimReplies("kps:x", ids, { timeoutMs: 20, fetchImpl })).rejects.toMatchObject({
      code: NoxClientErrorCode.TransportFailed,
    });
  });
});

describe("claims over KPS against v1 and v2 entries", () => {
  it("serves calls from a v1 entry (rc.6) with the JSON fallback", async () => {
    const t = bed();
    const client = await connect(t.config());
    expect(body(await get(client))).toBe(OK_BODY);
    const claim = t.mixnet.claimLog[0]!;
    expect(claim.body["encoding"]).toBe("binary");
    expect(claim.body["retain"]).toBe(true);
  });

  it("gets the binary batch from a v2 entry and acks what arrived", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    t.mixnet.parity = true;
    const client = await connect(t.config());
    for (let i = 0; i < 3; i++) expect(body(await get(client, `/${i}`))).toBe(OK_BODY);
    // Received replies and the unused parity blocks are acked, so the entry frees them.
    await vi.waitFor(() => {
      const acked = new Set(t.mixnet.claimLog.flatMap((claim) => claim.ack));
      expect(acked.size).toBeGreaterThanOrEqual(4);
    });
    const parityBlocks = t.mixnet.claimLog.flatMap((claim) => claim.ack).filter((id) => !t.mixnet.claimLog.some((claim) => claim.ids.includes(id)));
    expect(parityBlocks.length).toBeGreaterThan(0);
    for (const id of parityBlocks) expect(t.mixnet.holds(id)).toBe(false);
  });

  it("long-polls a v2 entry behind a relay that lists claim-v2: one held claim instead of a poll every tick", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    t.mixnet.relayClaimV2 = true;
    t.mixnet.claimWaitMaxMs = 1_500;
    t.mixnet.replyDelayMs = 400;
    const client = await connect(t.config({ replyClaims: { waitMs: 2_000 } }));
    // The first call learns the relay's capability; the second one long-polls.
    await get(client, "/warm");
    t.mixnet.claimLog.length = 0;
    expect(body(await get(client))).toBe(OK_BODY);
    // With 10 ms polling, 400 ms would take dozens of claims; the long-poll takes one or two.
    const withIds = t.mixnet.claimLog.filter((claim) => claim.ids.length > 0);
    expect(withIds.length).toBeLessThanOrEqual(3);
    // Capped by the relay's claimWaitMaxMs.
    expect(withIds[0]!.body["wait_ms"]).toBe(1_500);
    expect(events(t.logs, "claim.relay")[0]?.fields).toMatchObject({ claimV2: true, waitMaxMs: 1_500 });
  });

  it("keeps one claim slot free of long-polls: held claims for lost replies never delay a new call", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    t.mixnet.relayClaimV2 = true;
    t.mixnet.claimWaitMaxMs = 3_000;
    let calls = 0;
    // Calls 2 and 3 lose their reply in the mixnet; the others answer.
    t.mixnet.exit = () => {
      calls += 1;
      return calls === 2 || calls === 3 ? null : encodeExitHttpResponse(200, [], OK_BODY);
    };
    const client = await connect(t.config(
      { timeoutMs: 4_000, replyClaims: { waitMs: 3_000, maxClaimsInFlight: 2, maxIdsPerClaim: 1 } },
    ));
    await get(client, "/warm");
    const lost = [get(client, "/lost-1", { retry: "none" }), get(client, "/lost-2", { retry: "none" })];
    for (const call of lost) call.catch(() => undefined);
    await vi.waitFor(() => expect(calls).toBe(3));
    await vi.waitFor(() => {
      expect(t.mixnet.claimLog.some((claim) => Number(claim.body["wait_ms"] ?? 0) > 0)).toBe(true);
    });
    const started = Date.now();
    expect(body(await get(client, "/fresh", { retry: "none" }))).toBe(OK_BODY);
    expect(Date.now() - started).toBeLessThan(1_500);
    await Promise.allSettled(lost);
  });

  it("never asks a relay without claim-v2 (rc.6 nox-kps) to hold a claim", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    t.mixnet.replyDelayMs = 100;
    const client = await connect(t.config({ replyClaims: { waitMs: 2_000 } }));
    await get(client, "/1");
    expect(body(await get(client, "/2"))).toBe(OK_BODY);
    expect(t.mixnet.claimLog.every((claim) => claim.body["wait_ms"] === undefined)).toBe(true);
    expect(t.mixnet.claimLog.some((claim) => claim.body["retain"] === true)).toBe(true);
  });
});

describe("request timing", () => {
  it("logs upload, wait, claim, download and decode durations per request (info, no IDs)", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    const client = await connect(t.config());
    await get(client);
    const timing = events(t.logs, "request.timing")[0];
    expect(timing?.level).toBe("info");
    for (const field of ["totalMs", "uploadMs", "waitMs", "claimMs", "downloadMs", "decodeMs", "claimBytes"]) {
      expect(typeof timing?.fields?.[field]).toBe("number");
    }
    expect(timing?.fields?.["format"]).toBe("binary");
    expect(JSON.stringify(timing?.fields)).not.toMatch(/[0-9a-f]{32}|kps:|https:/);
  });
});

describe("first-arrival claims", () => {
  it("long-polls the data block and its replica together on a v2 entry, so a lost data item costs no parity wait", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    t.mixnet.relayClaimV2 = true;
    t.mixnet.claimWaitMaxMs = 2_000;
    t.mixnet.parity = true;
    const client = await connect(t.config({ replyClaims: { waitMs: 2_000, parityFallbackMs: 2_000 } }));
    await get(client, "/warm", { minSurbs: 2, expectedResponseBytes: 1_000 });
    t.mixnet.dropData = true;
    t.mixnet.replyDelayMs = 100;
    t.mixnet.claimLog.length = 0;
    const started = Date.now();
    expect(body(await get(client, "/", { minSurbs: 2, expectedResponseBytes: 1_000, retry: "none" }))).toBe(OK_BODY);
    expect(Date.now() - started).toBeLessThan(1_500);
    const first = t.mixnet.claimLog.find((claim) => claim.ids.length > 0);
    expect(first?.ids).toHaveLength(2);
    expect(Number(first?.body["wait_ms"])).toBeGreaterThan(0);
    // The block that was not needed is acked on a later claim.
    await vi.waitFor(() => {
      const acked = new Set(t.mixnet.claimLog.flatMap((claim) => claim.ack));
      expect(first!.ids.every((id) => acked.has(id))).toBe(true);
    });
  });

  it("keeps data-first on entries that do not hold claims (v1, or a relay without claim-v2)", async () => {
    for (const relay of [false, true]) {
      const t = bed();
      t.mixnet.claimProtocol = relay ? "v2" : "v1";
      t.mixnet.parity = true;
      const client = await connect(t.config({ replyClaims: { waitMs: 2_000 } }));
      await get(client, "/1", { minSurbs: 2, expectedResponseBytes: 1_000 });
      t.mixnet.claimLog.length = 0;
      await get(client, "/2", { minSurbs: 2, expectedResponseBytes: 1_000 });
      expect(Math.max(...t.mixnet.claimLog.map((claim) => claim.ids.length))).toBe(1);
    }
  });

  it("can be turned off with replyClaims.firstArrival", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    t.mixnet.relayClaimV2 = true;
    t.mixnet.parity = true;
    const client = await connect(t.config({ replyClaims: { waitMs: 2_000, firstArrival: false } }));
    await get(client, "/1", { minSurbs: 2, expectedResponseBytes: 1_000 });
    t.mixnet.claimLog.length = 0;
    await get(client, "/2", { minSurbs: 2, expectedResponseBytes: 1_000 });
    expect(Math.max(...t.mixnet.claimLog.map((claim) => claim.ids.length))).toBe(1);
  });
});

describe("relay capability probe", () => {
  it("retries a failed /metadata.json probe instead of polling for the rest of the session", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    t.mixnet.relayClaimV2 = true;
    t.mixnet.claimWaitMaxMs = 1_500;
    let metadataRequests = 0;
    t.network.route(undefined, (request) => {
      if (request.path === "/metadata.json") {
        metadataRequests += 1;
        if (metadataRequests === 1) return { status: 503, body: "busy" };
      }
      return t.mixnet.handler(request);
    });
    const client = await connect(t.config({ replyClaims: { waitMs: 2_000 } }));
    await get(client, "/1");
    expect(events(t.logs, "claim.probe.retry")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    await get(client, "/2");
    t.mixnet.claimLog.length = 0;
    await get(client, "/3");
    expect(metadataRequests).toBe(2);
    expect(t.mixnet.claimLog.some((claim) => Number(claim.body["wait_ms"] ?? 0) > 0)).toBe(true);
  }, 15_000);

  it("treats a relay without /metadata.json as one without claim-v2 (no retries)", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    let metadataRequests = 0;
    t.network.route(undefined, (request) => {
      if (request.path === "/metadata.json") {
        metadataRequests += 1;
        return { status: 404, body: "not found" };
      }
      return t.mixnet.handler(request);
    });
    const client = await connect(t.config({ replyClaims: { waitMs: 2_000 } }));
    await get(client, "/1");
    await get(client, "/2");
    expect(metadataRequests).toBe(1);
    expect(events(t.logs, "claim.probe.retry")).toHaveLength(0);
    expect(t.mixnet.claimLog.every((claim) => claim.body["wait_ms"] === undefined)).toBe(true);
  });
});

describe("data-first claims", () => {
  it("claims only the data block while the reply is on time; parity stays unclaimed", async () => {
    const t = bed();
    t.mixnet.parity = true;
    const client = await connect(t.config());
    await get(client, "/", { minSurbs: 2, expectedResponseBytes: 1_000 });
    expect(t.mixnet.surbCounts).toEqual([2]);
    const claimedIds = new Set(t.mixnet.claimLog.flatMap((claim) => claim.ids));
    expect(claimedIds.size).toBe(1);
  });

  it("claims parity after parityFallbackMs when the data block is lost in the mixnet", async () => {
    const t = bed();
    t.mixnet.parity = true;
    t.mixnet.dropData = true;
    const client = await connect(t.config({ replyClaims: { parityFallbackMs: 150 } }));
    const started = Date.now();
    expect(body(await get(client, "/", { minSurbs: 2, expectedResponseBytes: 1_000, retry: "none" }))).toBe(OK_BODY);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(new Set(t.mixnet.claimLog.flatMap((claim) => claim.ids)).size).toBe(2);
  });
});

describe("concurrent calls", () => {
  it("answers 5 parallel calls while one claim hangs", async () => {
    const t = bed();
    const client = await connect(t.config());
    const entryAddress = client.entryUrl.slice("kps:".length);
    let hung = false;
    t.network.route(entryAddress, (request) => {
      if (request.path === "/api/v1/responses/claim" && !hung) {
        hung = true;
        return { hang: true };
      }
      return t.mixnet.handler(request);
    });
    const blocked = get(client, "/blocked", { retry: "none", timeoutMs: 600 });
    await vi.waitFor(() => expect(hung).toBe(true));
    const replies = await Promise.all([1, 2, 3, 4, 5].map((i) => get(client, `/${i}`, { retry: "none" })));
    expect(replies.map(body)).toEqual(Array(5).fill(OK_BODY));
    await expect(blocked).rejects.toMatchObject({ code: NoxClientErrorCode.ResponseTimeout });
  });

  it("keeps at most replyClaims.maxClaimsInFlight claims open per entry", async () => {
    const t = bed();
    t.mixnet.replyDelayMs = 200;
    const client = await connect(t.config({ replyClaims: { jsonMaxClaimsInFlight: 2, jsonMaxIdsPerClaim: 1 } }));
    const entryAddress = client.entryUrl.slice("kps:".length);
    let open = 0;
    let peak = 0;
    t.network.route(entryAddress, async (request) => {
      if (request.path !== "/api/v1/responses/claim" || isWarmupClaim(request.body)) return t.mixnet.handler(request);
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 30));
      open -= 1;
      return t.mixnet.handler(request);
    });
    await Promise.all([1, 2, 3, 4].map((i) => get(client, `/${i}`, { retry: "none" })));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("claim size per entry protocol", () => {
  it("v1 entry: one ID per claim and at most two claims in flight (115 KB JSON replies)", async () => {
    const t = bed();
    t.mixnet.replyDelayMs = 150;
    const client = await connect(t.config());
    const entryAddress = client.entryUrl.slice("kps:".length);
    let open = 0;
    let peak = 0;
    t.network.route(entryAddress, async (request) => {
      if (request.path !== "/api/v1/responses/claim" || isWarmupClaim(request.body)) return t.mixnet.handler(request);
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open -= 1;
      return t.mixnet.handler(request);
    });
    await Promise.all([1, 2, 3, 4, 5].map((i) => get(client, `/${i}`, { retry: "none" })));
    expect(peak).toBeLessThanOrEqual(2);
    expect(Math.max(...t.mixnet.claimLog.map((claim) => claim.ids.length))).toBe(1);
  });

  it("v2 entry: batches IDs once the entry answered v2", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    t.mixnet.replyDelayMs = 150;
    const client = await connect(t.config());
    await get(client, "/warm");
    t.mixnet.claimLog.length = 0;
    await Promise.all([1, 2, 3, 4, 5].map((i) => get(client, `/${i}`, { retry: "none" })));
    expect(Math.max(...t.mixnet.claimLog.map((claim) => claim.ids.length))).toBeGreaterThan(1);
  });
});

/** Route the entry so the first claim that carries a reply is cut mid-transfer (after the entry took it). */
function cutFirstReply(t: ReturnType<typeof bed>, entryAddress: string): { cut: () => boolean } {
  let cut = false;
  t.network.route(entryAddress, async (request) => {
    const reply = await t.mixnet.handler(request);
    if (!cut && request.path === "/api/v1/responses/claim" && "status" in reply && reply.status === 200) {
      const length = typeof reply.body === "string" ? reply.body.length : reply.body?.length ?? 0;
      if (length > 2) {
        cut = true;
        return { raw: "HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\npartial" } satisfies FakeReply;
      }
    }
    return reply;
  });
  return { cut: () => cut };
}

describe("lost replies", () => {
  it("v2 entry: a cut claim is claimed again and the same reply returns (no resend)", async () => {
    const t = bed();
    t.mixnet.claimProtocol = "v2";
    const client = await connect(t.config());
    const route = cutFirstReply(t, client.entryUrl.slice("kps:".length));
    expect(body(await get(client, "/", { retry: "none" }))).toBe(OK_BODY);
    expect(route.cut()).toBe(true);
    expect(t.mixnet.served).toHaveLength(1);
    expect(events(t.logs, "claim.failed")).toHaveLength(1);
    expect(events(t.logs, "claim.recovered")).toHaveLength(1);
  });

  it("v1 entry with parity: the re-claim takes the parity block (no resend)", async () => {
    const t = bed();
    t.mixnet.parity = true;
    const client = await connect(t.config());
    cutFirstReply(t, client.entryUrl.slice("kps:".length));
    expect(body(await get(client, "/", { retry: "none", minSurbs: 2 }))).toBe(OK_BODY);
    expect(t.mixnet.served).toHaveLength(1);
  });

  it("v1 entry, reply destroyed: logs reply.lost and resends at once with the fast policy", async () => {
    const t = bed();
    const client = await connect(t.config({ resend: RESEND_FAST, replyClaims: { lostReplyGraceMs: 100 }, timeoutMs: 5_000 }));
    cutFirstReply(t, client.entryUrl.slice("kps:".length));
    const started = Date.now();
    expect(body(await get(client, "/", { minSurbs: 1 }))).toBe(OK_BODY);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(t.mixnet.served).toHaveLength(2);
    expect(events(t.logs, "reply.lost")).toHaveLength(1);
    expect(events(t.logs, "call.resend")[0]?.fields).toMatchObject({ reason: "lost-reply" });
  });

  it("v1 entry, reply destroyed, default policy: the call waits for its timeout as in 0.6", async () => {
    const t = bed();
    const client = await connect(t.config({ replyClaims: { lostReplyGraceMs: 50 }, timeoutMs: 400 }));
    cutFirstReply(t, client.entryUrl.slice("kps:".length));
    await expect(get(client, "/", { minSurbs: 1, retry: "none" })).rejects.toMatchObject({
      code: NoxClientErrorCode.ResponseTimeout,
    });
    expect(events(t.logs, "reply.lost")).toHaveLength(1);
    expect(events(t.logs, "call.resend")).toHaveLength(0);
  });
});

describe("resend policy", () => {
  it("hedges a slow call: a second copy at hedgeAfterMs, the first reply wins", async () => {
    const t = bed();
    let calls = 0;
    t.mixnet.exit = () => {
      calls += 1;
      // The first copy is dropped by the exit; the hedge answers.
      return calls === 1 ? null : encodeExitHttpResponse(200, [], OK_BODY);
    };
    const client = await connect(t.config({ resend: { hedgeAfterMs: 200 }, timeoutMs: 5_000 }));
    const started = Date.now();
    expect(body(await get(client))).toBe(OK_BODY);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toBe(2);
    expect(events(t.logs, "call.resend")[0]?.fields).toMatchObject({ reason: "hedge" });
  });

  it("never hedges a request that may not be resent", async () => {
    const t = bed();
    t.mixnet.exit = () => null;
    const client = await connect(t.config({ resend: { hedgeAfterMs: 50 } }));
    await expect(get(client, "/", { retry: "none", timeoutMs: 300 })).rejects.toMatchObject({
      code: NoxClientErrorCode.ResponseTimeout,
    });
    expect(t.mixnet.served).toHaveLength(1);
  });

  it("counts transport-failure resends apart from the timeout resend", async () => {
    const t = bed();
    const client = await connect(
      t.config({ resend: { transportResends: 2 } }, { entries: [kpsAddressFor(1), kpsAddressFor(2), kpsAddressFor(3)], topologySources: 2 }),
    );
    let failures = 0;
    for (const index of [1, 2, 3]) {
      t.network.route(kpsAddressFor(index), (request) => {
        if (request.path === "/api/v1/packets" && failures < 2) {
          failures += 1;
          return { raw: "garbage" };
        }
        return t.mixnet.handler(request);
      });
    }
    let exits = 0;
    t.mixnet.exit = () => {
      exits += 1;
      return exits === 1 ? null : encodeExitHttpResponse(200, [], OK_BODY);
    };
    // Two transport failures, then a timeout, then a reply: four copies, one call.
    expect(body(await get(client, "/", { timeoutMs: 300 }))).toBe(OK_BODY);
    expect(failures).toBe(2);
    expect(exits).toBe(2);
  });

  it("resends through the same entry when it is the only one (single bridge), v2 reply blocks", async () => {
    const pinned = makePinned(DEFAULT_MEMBERS.map((spec) => ({ ...spec, capabilities: ["surb_v2"] })));
    const t = bed(pinned, fakeWasmBindings({ v2: true }));
    let exits = 0;
    t.mixnet.exit = () => {
      exits += 1;
      return exits === 1 ? null : encodeExitHttpResponse(200, [], OK_BODY);
    };
    const only = [kpsAddressFor(1)];
    const legacy = await connect(t.config({}, { entries: only }));
    await expect(get(legacy, "/", { timeoutMs: 300 })).rejects.toMatchObject({ code: NoxClientErrorCode.ResponseTimeout });
    expect(exits).toBe(1);

    exits = 0;
    const fast = await connect(t.config({ resend: { sameEntryFallback: true } }, { entries: only }));
    expect(body(await get(fast, "/", { timeoutMs: 300 }))).toBe(OK_BODY);
    expect(exits).toBe(2);
    const packets = t.network.requests.filter((request) => request.path === "/api/v1/packets").slice(-2);
    expect(packets.every((request) => request.address === kpsAddressFor(1))).toBe(true);
  });

  it("validates the policy and the adaptive hedge delay", () => {
    expect(() => resolveResendPolicy({ transportResends: 9 })).toThrow(/transportResends/);
    expect(() => resolveResendPolicy({ hedgeAdaptive: 1 as unknown as boolean })).toThrow(/boolean/);
    expect(() => resolveResendPolicy({ nope: 1 } as never)).toThrow(/not a resend setting/);
    expect(() => resolveReplyClaimSettings({ maxIdsPerClaim: 0 })).toThrow(/positive/);
    const tracker = new LatencyTracker();
    expect(tracker.hedgeDelay(RESEND_FAST, 12_000)).toBe(3_000);
    for (let i = 0; i < 19; i++) tracker.record(900);
    expect(tracker.hedgeDelay(RESEND_FAST, 12_000)).toBe(3_000);
    tracker.record(9_000);
    tracker.record(9_000);
    expect(tracker.hedgeDelay(RESEND_FAST, 12_000)).toBe(9_000);
    expect(tracker.hedgeDelay(RESEND_FAST, 5_000)).toBe(4_999);
  });
});

describe("connections", () => {
  it("claims over a second connection with kps.claimLane", async () => {
    const t = bed();
    const client = await connect(t.config({}, { claimLane: true }));
    const entryAddress = client.entryUrl.slice("kps:".length);
    expect(body(await get(client, "/1"))).toBe(OK_BODY);
    await vi.waitFor(() => expect(t.network.dials.filter((address) => address === entryAddress)).toHaveLength(2));
    expect(body(await get(client, "/2"))).toBe(OK_BODY);
    const connections = t.network.connections.filter((conn) => conn.address === entryAddress);
    expect(connections).toHaveLength(2);
    // Packets stay on the first connection; claims use the second once it is up.
    expect(connections[1]!.streamsOpened).toBeGreaterThan(0);
  });

  it("fails over to the connected standby when the pinned connection closes (kps.standby)", async () => {
    const t = bed();
    const client = await connect(
      t.config({}, { standby: true, entries: [kpsAddressFor(1), kpsAddressFor(2)], topologySources: 2 }),
    );
    const first = client.entryUrl.slice("kps:".length);
    const other = first === kpsAddressFor(1) ? kpsAddressFor(2) : kpsAddressFor(1);
    await vi.waitFor(() => expect(t.network.connections.some((conn) => conn.address === other && conn.open)).toBe(true));
    for (const conn of t.network.connections) if (conn.address === first) conn.kill();
    await vi.waitFor(() => expect(client.entryUrl).toBe(`kps:${other}`));
    expect(events(t.logs, "entry.failover")).toHaveLength(1);
    const dialsBefore = t.network.dials.filter((address) => address === other).length;
    expect(body(await get(client))).toBe(OK_BODY);
    expect(t.network.dials.filter((address) => address === other)).toHaveLength(dialsBefore);
  });
});

/** The transport's send-window warm-up pads claims that name no reply; they are not scheduler claims. */
function isWarmupClaim(body: Uint8Array): boolean {
  const text = new TextDecoder().decode(body);
  return body.length >= 1_000 && /^\{"surb_ids":\[\]\}\s*$/u.test(text);
}
