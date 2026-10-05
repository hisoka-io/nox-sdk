/**
 * S1 chain check rules (PROPOSAL §2.2, §2.6): request shape, partial answers,
 * byte-identical agreement, closure, implementation guard, log scan, pairing
 * and the membership a verified read gives (floor, probation, removal floor).
 */
import { describe, expect, it } from "vitest";
import {
  DiscoveryError,
  EIP1967_IMPLEMENTATION_SLOT,
  answersAgree,
  checkBlockWindow,
  choosePairs,
  closeMembership,
  membershipFromChain,
  parseFinalizedBlock,
  parseRegistrationLogs,
  parseRegistryAnswer,
  mergeBatchReplies,
  planBodies,
  planBody,
  rankChainCandidates,
  registrationLogsBody,
  registryReadPlan,
  runChainCheck,
  type ChainCheckContext,
  type ChainMembership,
  type FinalizedBlock,
} from "../src/kps/discovery.js";
import { DISCOVERY_LIMITS, DISCOVERY_LOG_SCAN, DISCOVERY_PAIRING_BUDGET } from "../src/kps/constants.js";
import { FakeRegistryChain } from "./helpers/fake_chain.js";
import { FIXTURE_PROVIDERS, makeBootstrap, makePinned, memberAddress, PINNED_BLOCK, served } from "./helpers/pinned_fixture.js";
import { kpsAddressFor } from "./helpers/fake_kps.js";
import { primaryLayerForRole } from "../src/topology.js";
import type { MemberFirstSeen, PinnedMember } from "../src/types.js";

const pinned = makePinned();
const bootstrap = makeBootstrap(pinned);
const EXITS = ["0xexit-a", "0xexit-b", "0xexit-c"];

function blockOf(chain: FakeRegistryChain): FinalizedBlock {
  return { hash: chain.blockHash, number: chain.blockNumber, timestamp: chain.blockTimestamp };
}

function newMember(index: number, role: 1 | 2 | 3 = 1): PinnedMember {
  const address = memberAddress(index);
  return {
    address,
    sphinxKey: index.toString(16).padStart(2, "0").repeat(32),
    url: `/ip4/10.0.1.${index}/tcp/15000/p2p/12D3KooWNew${index}`,
    ingressUrl: "",
    metadataUrl: `kps:${kpsAddressFor(index)}/metadata.json`,
    stake: "1000",
    role,
    layer: primaryLayerForRole(address, role) as 0 | 1 | 2,
    status: 1,
    frozen: false,
    capabilities: [],
  };
}

/** A context over one chain per provider URL; `chains` defaults to the same chain for every provider. */
function context(
  chain: FakeRegistryChain,
  extra: Partial<ChainCheckContext> & { chains?: Map<string, FakeRegistryChain>; failExit?: string } = {},
): ChainCheckContext & { sent: { exit: string; url: string }[] } {
  const sent: { exit: string; url: string }[] = [];
  let seed = 7;
  const { chains, failExit, ...rest } = extra;
  return {
    bootstrap,
    providers: FIXTURE_PROVIDERS,
    quorum: 2,
    exits: EXITS,
    candidates: pinned.members.map((member) => member.address),
    core: pinned.members.map((member) => member.address),
    minBlock: PINNED_BLOCK,
    logsFromBlock: PINNED_BLOCK,
    nowUnix: Math.floor(Date.now() / 1000),
    randomIndex: (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    },
    avoid: { exits: new Set(), providers: new Set() },
    send: async (exit, url, body) => {
      sent.push({ exit, url });
      if (exit === failExit) throw new Error("exit unreachable");
      return (chains?.get(url) ?? chain).answer(body);
    },
    sent,
    ...rest,
  };
}

describe("registry read plan and parsing", () => {
  it("pins every call to the finalized block hash and is deterministic for a candidate set", () => {
    const chain = new FakeRegistryChain(pinned);
    const block = blockOf(chain);
    const plan = registryReadPlan(pinned.registry, block, [memberAddress(3), memberAddress(1), memberAddress(1)]);
    expect(plan.candidates).toEqual([memberAddress(1), memberAddress(3)]);
    expect(plan.calls.map((call) => call.method)).toEqual([
      "eth_getBlockByHash",
      "eth_chainId",
      "eth_getStorageAt",
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
      "eth_call",
    ]);
    const pinnedCalls = plan.calls.filter((call) => call.method === "eth_call" || call.method === "eth_getStorageAt");
    for (const call of pinnedCalls) {
      expect(call.params.at(-1)).toEqual({ blockHash: block.hash, requireCanonical: true });
    }
    expect(plan.calls[2]!.params[1]).toBe(EIP1967_IMPLEMENTATION_SLOT);
    const again = registryReadPlan(pinned.registry, block, [memberAddress(1), memberAddress(3)]);
    expect(planBody(again)).toBe(planBody(plan));
  });

  it("parses a full answer and keeps only registered candidates", () => {
    const chain = new FakeRegistryChain(pinned);
    const plan = registryReadPlan(pinned.registry, blockOf(chain), [...pinned.members.map((m) => m.address), memberAddress(77)]);
    const answer = parseRegistryAnswer(plan, chain.answer(planBody(plan)));
    expect(answer.chainId).toBe(421614);
    expect(answer.implementation).toBe(bootstrap.registryImpl);
    expect(answer.relayerCount).toBe(pinned.members.length);
    expect(answer.members.size).toBe(pinned.members.length);
    expect(answer.members.has(memberAddress(77))).toBe(false);
    expect(answer.members.get(memberAddress(6))).toMatchObject({ role: 2, status: 1, frozen: false, sphinxKey: "06".repeat(32) });
    const membership = closeMembership(answer, bootstrap);
    expect(membership.registered.map((member) => member.address)).toEqual(pinned.members.map((member) => member.address));
    expect(membership.fingerprint).toBe(pinned.fingerprint);
  });

  it("treats an error item, a missing id or a non-array reply as a partial answer", () => {
    const chain = new FakeRegistryChain(pinned);
    const plan = registryReadPlan(pinned.registry, blockOf(chain), pinned.members.map((m) => m.address));
    chain.failMethod = "eth_getStorageAt";
    expect(() => parseRegistryAnswer(plan, chain.answer(planBody(plan)))).toThrow(
      expect.objectContaining({ kind: "partial", message: expect.stringMatching(/call 3 failed/u) }),
    );
    chain.failMethod = undefined;
    const full = JSON.parse(chain.answer(planBody(plan))) as unknown[];
    expect(() => parseRegistryAnswer(plan, JSON.stringify(full.slice(0, -1)))).toThrow(/missing/u);
    expect(() => parseRegistryAnswer(plan, JSON.stringify(full[0]))).toThrow(/not a JSON array/u);
    expect(() => parseRegistryAnswer(plan, "<html>")).toThrow(/not JSON/u);
    expect(() => parseRegistryAnswer(plan, JSON.stringify([...full, full[0]]))).toThrow(/answered twice/u);
  });

  it("refuses an answer about another block than the pinned one", () => {
    const chain = new FakeRegistryChain(pinned);
    const plan = registryReadPlan(pinned.registry, blockOf(chain), pinned.members.map((m) => m.address));
    chain.tamper = (method, _params, result) =>
      method === "eth_getBlockByHash" ? { ...(result as object), timestamp: "0x1" } : result;
    expect(() => parseRegistryAnswer(plan, chain.answer(planBody(plan)))).toThrow(/another block/u);
  });

  it("splits a plan into batches of at most 20 calls and merges the replies in order", () => {
    const chain = new FakeRegistryChain(pinned);
    const plan = registryReadPlan(pinned.registry, blockOf(chain), pinned.members.map((m) => m.address));
    const bodies = planBodies(plan);
    expect(bodies.map((body) => (JSON.parse(body) as unknown[]).length)).toEqual([20, 1]);
    const merged = mergeBatchReplies(bodies.map((body) => chain.answer(body)));
    expect(parseRegistryAnswer(plan, merged).canonical).toBe(parseRegistryAnswer(plan, chain.answer(planBody(plan))).canonical);
    expect(mergeBatchReplies(['[{"id":1}]', '{"error":"limit"}'])).toBe('{"error":"limit"}');
    expect(() => parseRegistryAnswer(plan, mergeBatchReplies(['[]', "<html>"]))).toThrow(/not JSON/u);
  });

  it("agrees only on byte-identical values", () => {
    const chain = new FakeRegistryChain(pinned);
    const plan = registryReadPlan(pinned.registry, blockOf(chain), pinned.members.map((m) => m.address));
    const honest = parseRegistryAnswer(plan, chain.answer(planBody(plan)));
    // Field order and extra block fields do not matter; values do.
    const reordered = parseRegistryAnswer(plan, JSON.stringify((JSON.parse(chain.answer(planBody(plan))) as unknown[]).reverse()));
    expect(answersAgree([honest, reordered])).toBe(true);
    chain.update(memberAddress(2), { url: "/ip4/203.0.113.9/tcp/1/p2p/x" });
    const lying = parseRegistryAnswer(plan, chain.answer(planBody(plan)));
    expect(answersAgree([honest, lying])).toBe(false);
    expect(answersAgree([])).toBe(false);
  });

  it("closes the set only when registered candidates match relayerCount and the fingerprint", () => {
    const chain = new FakeRegistryChain(pinned);
    chain.put(newMember(9));
    const known = pinned.members.map((m) => m.address);
    const plan = registryReadPlan(pinned.registry, blockOf(chain), known);
    const hidden = parseRegistryAnswer(plan, chain.answer(planBody(plan)));
    expect(() => closeMembership(hidden, bootstrap)).toThrow(expect.objectContaining({ kind: "incomplete" }));
    const full = registryReadPlan(pinned.registry, blockOf(chain), [...known, memberAddress(9)]);
    expect(closeMembership(parseRegistryAnswer(full, chain.answer(planBody(full))), bootstrap).registered).toHaveLength(9);
    chain.countOverride = 8;
    expect(() => closeMembership(parseRegistryAnswer(full, chain.answer(planBody(full))), bootstrap)).toThrow(
      expect.objectContaining({ kind: "fingerprint" }),
    );
  });

  it("refuses an unknown implementation or another chain", () => {
    const chain = new FakeRegistryChain(pinned);
    chain.implementation = "0x00000000000000000000000000000000000000aa";
    const plan = registryReadPlan(pinned.registry, blockOf(chain), pinned.members.map((m) => m.address));
    expect(() => closeMembership(parseRegistryAnswer(plan, chain.answer(planBody(plan))), bootstrap)).toThrow(
      expect.objectContaining({ kind: "implementation" }),
    );
    const other = new FakeRegistryChain(pinned);
    other.blockTimestamp = chain.blockTimestamp;
    other.chainId = 1;
    expect(() => closeMembership(parseRegistryAnswer(plan, other.answer(planBody(plan))), bootstrap)).toThrow(
      expect.objectContaining({ kind: "chain-id" }),
    );
  });

  it("checks the finalized block against the snapshot block, its age and the clock", () => {
    const now = 2_000_000_000;
    const at = (number: number, timestamp: number): FinalizedBlock => ({ hash: `0x${"11".repeat(32)}`, number, timestamp });
    const ctx = { minBlock: PINNED_BLOCK, nowUnix: now, bootstrap };
    expect(() => checkBlockWindow(at(PINNED_BLOCK, now - 60), ctx)).not.toThrow();
    expect(() => checkBlockWindow(at(PINNED_BLOCK - 1, now), ctx)).toThrow(/before block/u);
    expect(() => checkBlockWindow(at(PINNED_BLOCK + 1, now - 3_601), ctx)).toThrow(/old/u);
    expect(() => checkBlockWindow(at(PINNED_BLOCK + 1, now + 601), ctx)).toThrow(/future/u);
    expect(parseFinalizedBlock('{"jsonrpc":"2.0","id":1,"result":{"hash":"0xABAB' + "ab".repeat(30) + '","number":"0x10","timestamp":"0x20"}}'))
      .toEqual({ hash: `0x${"ab".repeat(32)}`, number: 16, timestamp: 32 });
    expect(() => parseFinalizedBlock('{"jsonrpc":"2.0","id":1,"result":null}')).toThrow(DiscoveryError);
  });

  it("scans registration logs in bounded chunks", () => {
    const { body, chunks } = registrationLogsBody(pinned.registry, 100, 100 + DISCOVERY_LOG_SCAN.chunkBlocks);
    expect(chunks).toBe(2);
    const calls = JSON.parse(body) as { params: [{ fromBlock: string; toBlock: string; topics: string[][] }] }[];
    expect(calls[0]!.params[0].topics[0]).toHaveLength(2);
    expect(Number.parseInt(calls[1]!.params[0].fromBlock, 16)).toBe(100 + DISCOVERY_LOG_SCAN.chunkBlocks);
    expect(() => registrationLogsBody(pinned.registry, 0, DISCOVERY_LOG_SCAN.chunkBlocks * (DISCOVERY_LOG_SCAN.maxChunks + 1)))
      .toThrow(expect.objectContaining({ kind: "incomplete" }));
    const chain = new FakeRegistryChain(pinned);
    chain.put(newMember(9), PINNED_BLOCK + 5);
    const scan = registrationLogsBody(pinned.registry, PINNED_BLOCK, chain.blockNumber);
    expect(parseRegistrationLogs(chain.answer(scan.body), scan.chunks).addresses).toEqual([memberAddress(9)]);
  });
});

describe("runChainCheck", () => {
  it("verifies with two different exits and two different providers that agree", async () => {
    const chain = new FakeRegistryChain(pinned);
    const ctx = context(chain);
    const outcome = await runChainCheck(ctx);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(new Set(outcome.pairs.map((pair) => pair.exit)).size).toBe(2);
    expect(new Set(outcome.pairs.map((pair) => pair.provider)).size).toBe(2);
    expect(outcome.membership.registered).toHaveLength(8);
    expect(outcome.attempts).toBe(1);
    // One finalized-block call, then the 21-call read in two batches (20 + 1) per pair.
    expect(ctx.sent).toHaveLength(5);
  });

  it("keeps every request within a 20-call batch cap, so capped providers still answer", async () => {
    const chain = new FakeRegistryChain(pinned);
    chain.maxBatch = 20;
    for (const index of [9, 10, 11, 12, 13]) chain.put(newMember(index), PINNED_BLOCK - 5);
    const candidates = [...chain.members.keys()];
    const outcome = await runChainCheck(context(chain, { candidates }));
    expect(outcome.kind).toBe("verified");
    if (outcome.kind === "verified") expect(outcome.membership.registered).toHaveLength(13);
  });

  it("discards disagreeing answers, never merges them, and tries another pairing", async () => {
    const honest = new FakeRegistryChain(pinned);
    const liar = new FakeRegistryChain(pinned);
    liar.update(memberAddress(6), { metadataUrl: `kps:${kpsAddressFor(66)}/metadata.json` });
    const chains = new Map([
      [FIXTURE_PROVIDERS[0]!, honest],
      [FIXTURE_PROVIDERS[1]!, liar],
      [FIXTURE_PROVIDERS[2]!, honest],
    ]);
    // randomIndex 0 orders the providers b, c, a: the first pairing includes the liar.
    const ctx = context(honest, { chains, randomIndex: () => 0 });
    const outcome = await runChainCheck(ctx);
    expect(outcome).toMatchObject({ kind: "verified", attempts: 2 });
    if (outcome.kind !== "verified") return;
    expect(outcome.pairs.map((pair) => pair.provider)).not.toContain(FIXTURE_PROVIDERS[1]);
    const member = outcome.membership.registered.find((m) => m.address === memberAddress(6));
    expect(member?.metadataUrl).toBe(pinned.members[5]!.metadataUrl);
    expect(ctx.avoid.providers.has("provider-b.test")).toBe(true);
  });

  it("reports disagreement when every pairing disagrees", async () => {
    const chains = new Map(FIXTURE_PROVIDERS.map((url, index) => {
      const chain = new FakeRegistryChain(pinned);
      chain.update(memberAddress(1), { url: `/ip4/10.9.9.${index}/tcp/1/p2p/x` });
      return [url, chain] as const;
    }));
    const outcome = await runChainCheck(context(chains.get(FIXTURE_PROVIDERS[0]!)!, { chains }));
    expect(outcome).toMatchObject({ kind: "disagreement", attempts: DISCOVERY_PAIRING_BUDGET });
  });

  it("does not use partial answers: a failing pair is avoided and another pairing verifies", async () => {
    const good = new FakeRegistryChain(pinned);
    const pruned = new FakeRegistryChain(pinned);
    pruned.failMethod = "eth_call";
    const chains = new Map([
      [FIXTURE_PROVIDERS[0]!, pruned],
      [FIXTURE_PROVIDERS[1]!, good],
      [FIXTURE_PROVIDERS[2]!, good],
    ]);
    const ctx = context(good, { chains });
    const outcome = await runChainCheck(ctx);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind === "verified") expect(outcome.pairs.map((pair) => pair.provider)).not.toContain(FIXTURE_PROVIDERS[0]);
  });

  it("avoids an exit that fails and verifies through the others", async () => {
    const chain = new FakeRegistryChain(pinned);
    const ctx = context(chain, { failExit: EXITS[0]! });
    const outcome = await runChainCheck(ctx);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind === "verified") expect(outcome.pairs.map((pair) => pair.exit)).not.toContain(EXITS[0]);
  });

  it("waits when fewer distinct exits or providers than the quorum are available", async () => {
    const chain = new FakeRegistryChain(pinned);
    expect((await runChainCheck(context(chain, { exits: [EXITS[0]!] }))).kind).toBe("insufficient");
    expect((await runChainCheck(context(chain, {
      providers: ["https://a.same-org.test/1", "https://b.same-org.test/2"],
    }))).kind).toBe("insufficient");
    expect(choosePairs({ ...context(chain), quorum: 3 })).toHaveLength(3);
  });

  it("refuses a stale finalized block from the first pair and retries elsewhere", async () => {
    const fresh = new FakeRegistryChain(pinned);
    const stale = new FakeRegistryChain(pinned);
    stale.blockNumber = PINNED_BLOCK - 5;
    const chains = new Map([
      [FIXTURE_PROVIDERS[0]!, fresh],
      [FIXTURE_PROVIDERS[1]!, stale],
      [FIXTURE_PROVIDERS[2]!, fresh],
    ]);
    // randomIndex 0 starts the first pairing at provider b, the stale one.
    const ctx = context(fresh, { chains, randomIndex: () => 0 });
    const outcome = await runChainCheck(ctx);
    expect(outcome).toMatchObject({ kind: "verified", attempts: 2 });
    expect(ctx.avoid.providers.has("provider-b.test")).toBe(true);
  });

  it("rejects without retrying when the proxy points at an unknown implementation", async () => {
    const chain = new FakeRegistryChain(pinned);
    chain.implementation = "0x00000000000000000000000000000000000000bb";
    const outcome = await runChainCheck(context(chain));
    expect(outcome).toMatchObject({ kind: "rejected", reason: "implementation" });
  });

  it("completes a set that served documents did not name from the registration logs", async () => {
    const chain = new FakeRegistryChain(pinned);
    chain.put(newMember(9, 2), PINNED_BLOCK + 50);
    const outcome = await runChainCheck(context(chain));
    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.logScan).toBe(true);
    expect(outcome.membership.registered.map((member) => member.address)).toContain(memberAddress(9));
  });

  it("reports incomplete when even the logs do not close the set", async () => {
    const chain = new FakeRegistryChain(pinned);
    chain.put(newMember(9), PINNED_BLOCK - 10);
    const outcome = await runChainCheck(context(chain));
    expect(outcome.kind).toBe("incomplete");
  });
});

describe("bounded chain-check candidates (one anchor cannot flood the providers)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const fake = (index: number): string => `0x${(0xf000_0000 + index).toString(16).padStart(40, "0")}`;
  /** A self-consistent document from `anchor` that lists the pinned members plus `count` fake addresses. */
  function flood(count: number, anchor = kpsAddressFor(1)) {
    const template = served(pinned, NOW).nodes[0]!;
    const add = Array.from({ length: count }, (_, index) => ({ ...template, address: fake(index) }));
    return { anchor, snapshot: served(pinned, NOW, { add }) };
  }
  let seed = 11;
  const randomIndex = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const core = pinned.members.map((member) => member.address);

  it("ranks the core set first, then multi-anchor addresses, and stays within the bound", () => {
    const corroborated = memberAddress(40);
    const template = served(pinned, NOW).nodes[0]!;
    const withNew = (anchor: string) => ({
      anchor,
      snapshot: served(pinned, NOW, { add: [{ ...template, address: corroborated }] }),
    });
    const ranked = rankChainCandidates({
      core,
      served: [flood(20_000), withNew(kpsAddressFor(2)), withNew(kpsAddressFor(3))],
      minSources: 2,
      max: DISCOVERY_LIMITS.maxCandidates,
      randomIndex,
    });
    expect(ranked).toHaveLength(DISCOVERY_LIMITS.maxCandidates);
    expect(ranked.slice(0, core.length)).toEqual([...core].sort());
    expect(ranked[core.length]).toBe(corroborated);
    expect(new Set(ranked).size).toBe(ranked.length);
  });

  it("keeps every address when the documents fit, and counts one anchor once however often it serves", () => {
    const ranked = rankChainCandidates({
      core,
      served: [flood(3), flood(3)],
      minSources: 2,
      max: DISCOVERY_LIMITS.maxCandidates,
      randomIndex,
    });
    expect(ranked).toEqual([...[...core].sort(), fake(0), fake(1), fake(2)]);
  });

  it("refuses a read plan over the bound", () => {
    const chain = new FakeRegistryChain(pinned);
    const many = Array.from({ length: DISCOVERY_LIMITS.maxCandidates + 1 }, (_, index) => fake(index));
    expect(() => registryReadPlan(pinned.registry, blockOf(chain), many)).toThrow(expect.objectContaining({ kind: "incomplete" }));
  });

  it("an anchor serving 20,000 extra addresses costs at most the bounded read per pair", async () => {
    const chain = new FakeRegistryChain(pinned);
    const candidates = rankChainCandidates({ core, served: [flood(20_000)], minSources: 2, max: DISCOVERY_LIMITS.maxCandidates, randomIndex });
    const ctx = context(chain, { candidates });
    const outcome = await runChainCheck(ctx);
    expect(outcome.kind).toBe("verified");
    if (outcome.kind === "verified") expect(outcome.membership.registered).toHaveLength(pinned.members.length);
    // 1 finalized-block request, then per pair ceil((5 + 2 * 256) / 20) = 26 batches.
    const perPair = Math.ceil((5 + 2 * DISCOVERY_LIMITS.maxCandidates) / 20);
    expect(ctx.sent.length).toBeLessThanOrEqual(1 + 2 * perPair);
    // Unranked input over the bound is cut to the bound as well.
    const raw = context(chain, { candidates: [...core, ...Array.from({ length: 5_000 }, (_, index) => fake(index))] });
    expect((await runChainCheck(raw)).kind).toBe("verified");
    expect(raw.sent.length).toBeLessThanOrEqual(1 + 2 * perPair);
  });

  it("after a log scan reads only the core set plus logged registrations, dropping served-only addresses", async () => {
    const chain = new FakeRegistryChain(pinned);
    chain.put(newMember(9, 2), PINNED_BLOCK + 50);
    const extras = Array.from({ length: 200 }, (_, index) => fake(index));
    const ctx = context(chain, { candidates: [...core, ...extras] });
    const outcome = await runChainCheck(ctx);
    expect(outcome).toMatchObject({ kind: "verified", logScan: true });
    if (outcome.kind === "verified") expect(outcome.membership.registered.map((m) => m.address)).toContain(memberAddress(9));
  });
});

describe("membership from a verified read", () => {
  const now = Math.floor(Date.now() / 1000);

  function verified(chain: FakeRegistryChain): ChainMembership {
    const plan = registryReadPlan(pinned.registry, blockOf(chain), [...chain.members.keys(), ...pinned.members.map((m) => m.address)]);
    return closeMembership(parseRegistryAnswer(plan, chain.answer(planBody(plan))), bootstrap);
  }

  it("keeps snapshot members as floor and takes their new location from the chain", () => {
    const chain = new FakeRegistryChain(pinned);
    chain.update(memberAddress(2), { url: "/ip4/203.0.113.2/tcp/15000/p2p/12D3KooWNode2", metadataUrl: `kps:${kpsAddressFor(2, 16005)}/metadata.json` });
    const result = membershipFromChain(pinned, verified(chain), new Map(), bootstrap.policy, now);
    const moved = result.members.find((member) => member.address === memberAddress(2))!;
    expect(moved).toMatchObject({ floor: true, probation: false, url: "/ip4/203.0.113.2/tcp/15000/p2p/12D3KooWNode2" });
    expect(moved.metadataUrl).toContain(":16005:");
    expect(result.members.every((member) => member.floor)).toBe(true);
    expect(result.probation).toEqual([]);
  });

  it("puts new members on probation from the block it first saw them, and ends it after the period", () => {
    const chain = new FakeRegistryChain(pinned);
    chain.put(newMember(9, 2));
    const first = membershipFromChain(pinned, verified(chain), new Map(), bootstrap.policy, now);
    expect(first.probation).toEqual([memberAddress(9)]);
    const seen = first.firstSeen.get(memberAddress(9))!;
    expect(seen).toEqual({ address: memberAddress(9), block: chain.blockNumber, time: chain.blockTimestamp });
    chain.advance(100);
    const later = membershipFromChain(pinned, verified(chain), first.firstSeen, bootstrap.policy, now + 3_600);
    expect(later.firstSeen.get(memberAddress(9))).toEqual(seen);
    expect(later.probation).toEqual([memberAddress(9)]);
    const graduated = membershipFromChain(pinned, verified(chain), first.firstSeen, bootstrap.policy, seen.time + bootstrap.policy.probationSeconds);
    expect(graduated.probation).toEqual([]);
    expect(graduated.members.find((member) => member.address === memberAddress(9))?.floor).toBe(false);
  });

  it("treats a rotated Sphinx key or a changed role as a new identity on probation", () => {
    const chain = new FakeRegistryChain(pinned);
    chain.update(memberAddress(3), { sphinxKey: "ee".repeat(32) });
    chain.update(memberAddress(4), { role: 3 });
    const result = membershipFromChain(pinned, verified(chain), new Map(), bootstrap.policy, now);
    expect(result.probation.sort()).toEqual([memberAddress(3), memberAddress(4)]);
    expect(result.members.find((member) => member.address === memberAddress(3))?.sphinxKey).toBe("ee".repeat(32));
  });

  it("drops ineligible members: frozen, unstaking is still eligible, invalid role", () => {
    const chain = new FakeRegistryChain(pinned);
    chain.update(memberAddress(1), { frozen: true });
    chain.update(memberAddress(2), { status: 2 });
    chain.update(memberAddress(5), { role: 7 });
    const addresses = membershipFromChain(pinned, verified(chain), new Map(), bootstrap.policy, now).members.map((m) => m.address);
    expect(addresses).not.toContain(memberAddress(1));
    expect(addresses).toContain(memberAddress(2));
    expect(addresses).not.toContain(memberAddress(5));
  });

  it("removal floor: a read that removes every snapshot exit keeps two of them", () => {
    const chain = new FakeRegistryChain(pinned);
    for (const index of [6, 7, 8]) chain.remove(memberAddress(index));
    chain.put(newMember(9, 2));
    const result = membershipFromChain(pinned, verified(chain), new Map(), bootstrap.policy, now);
    const exits = result.members.filter((member) => member.role === 2);
    expect(exits.filter((member) => member.floor).map((member) => member.address)).toEqual([memberAddress(6), memberAddress(7)]);
    expect(result.keptByFloor).toEqual([memberAddress(6), memberAddress(7)]);
    expect(exits.find((member) => member.address === memberAddress(9))?.probation).toBe(true);
  });

  it("removal floor: ordinary removals above the floor apply", () => {
    const chain = new FakeRegistryChain(pinned);
    chain.remove(memberAddress(8));
    chain.remove(memberAddress(1));
    const result = membershipFromChain(pinned, verified(chain), new Map(), bootstrap.policy, now);
    expect(result.members.map((member) => member.address)).not.toContain(memberAddress(8));
    expect(result.members.map((member) => member.address)).not.toContain(memberAddress(1));
    expect(result.keptByFloor).toEqual([]);
  });

  it("keeps an earlier first-seen record over the current block", () => {
    const chain = new FakeRegistryChain(pinned);
    chain.put(newMember(9));
    const earlier: MemberFirstSeen = { address: memberAddress(9), block: PINNED_BLOCK + 1, time: now - 2_000_000 };
    const result = membershipFromChain(pinned, verified(chain), new Map([[earlier.address, earlier]]), bootstrap.policy, now);
    expect(result.firstSeen.get(memberAddress(9))).toEqual(earlier);
    expect(result.probation).toEqual([]);
  });
});
