// make-snapshot.mjs and verify-snapshot.mjs against an in-process registry
// endpoint that serves the state recorded in the committed snapshot.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as makeSnapshot } from "../scripts/make-snapshot.mjs";
import { recordedBlockProblems, main as verifySnapshot } from "../scripts/verify-snapshot.mjs";
import { writeHashFile } from "../scripts/hash.mjs";
import { SNAPSHOT_PATH } from "../scripts/lib/paths.mjs";
import { isMissingStateError } from "../scripts/lib/registry.mjs";
import { createRpcClient, RpcError } from "../scripts/lib/rpc.mjs";
import { canonicalJson, type NoxAnonRpcSnapshot } from "../scripts/lib/snapshot-format.mjs";
import { FakeChain, type FakeChainOptions, type FakeMember } from "./helpers/fake-chain.js";

const committedText = readFileSync(SNAPSHOT_PATH, "utf8");
const committed = JSON.parse(committedText) as NoxAnonRpcSnapshot;
const FROM_BLOCK = 312_414_608;

function chainOptions(overrides: Partial<FakeChainOptions> = {}): FakeChainOptions {
  const members: FakeMember[] = committed.members.map((member) => ({
    address: member.address,
    sphinxKey: member.sphinxKey,
    url: member.url,
    ingressUrl: member.ingressUrl,
    metadataUrl: member.metadataUrl,
    stake: member.stake,
    role: member.role,
    status: member.status,
    frozen: member.frozen,
    isRegistered: true,
  }));
  // A node that registered and later left: its log stays, it is not a member.
  members.push({
    address: "0x00000000000000000000000000000000000000aa",
    sphinxKey: "11".repeat(32),
    url: "/ip4/192.0.2.1/tcp/15000",
    ingressUrl: "",
    metadataUrl: "",
    stake: "0",
    role: 1,
    status: 0,
    frozen: false,
    isRegistered: false,
  });
  return {
    chainId: committed.chainId,
    registry: committed.registry,
    fromBlock: FROM_BLOCK,
    head: committed.blockNumber + 100,
    safe: committed.blockNumber + 50,
    blockHashes: { [committed.blockNumber]: committed.blockHash },
    members,
    fingerprint: committed.fingerprint,
    ...overrides,
  };
}

let dir: string;
let output: string[];
const chains: FakeChain[] = [];

async function startChain(options: FakeChainOptions): Promise<FakeChain> {
  const chain = new FakeChain(options);
  await chain.start();
  chains.push(chain);
  return chain;
}

/** A copy of the committed snapshot with some fields changed and a matching hash record. */
async function tamperedCopy(change: (snapshot: NoxAnonRpcSnapshot) => void): Promise<string> {
  const tampered = JSON.parse(committedText) as NoxAnonRpcSnapshot;
  change(tampered);
  const copy = join(dir, "nox-snapshot.json");
  writeFileSync(copy, canonicalJson(tampered));
  await writeHashFile(copy);
  return copy;
}

function stdout(): string {
  return output.join("");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nox-snapshot-test-"));
  output = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(chains.splice(0).map((chain) => chain.stop()));
  rmSync(dir, { recursive: true, force: true });
});

describe("make-snapshot.mjs", () => {
  it("regenerates the committed snapshot byte for byte, from two agreeing endpoints", async () => {
    const a = await startChain(chainOptions());
    const b = await startChain(chainOptions());
    const out = join(dir, "nox-snapshot.json");
    const code = await makeSnapshot(["--rpc", a.url, "--rpc", b.url, "--block", String(committed.blockNumber), "--out", out]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(committedText);
    expect(readFileSync(`${out}.keccak256`, "utf8")).toBe(readFileSync(`${SNAPSHOT_PATH}.keccak256`, "utf8"));
    expect(stdout()).toContain("members      10 (10 eligible for routing, 0 with a KPS endpoint)");
    expect(stdout()).toContain("(all agree)");
  });

  it("gives identical bytes on a second run at the same block", async () => {
    const chain = await startChain(chainOptions());
    const first = join(dir, "first.json");
    const second = join(dir, "second.json");
    await makeSnapshot(["--rpc", chain.url, "--block", String(committed.blockNumber), "--out", first]);
    await makeSnapshot(["--rpc", chain.url, "--block", String(committed.blockNumber), "--out", second]);
    expect(readFileSync(second)).toEqual(readFileSync(first));
  });

  it("defaults to the finalized block", async () => {
    const chain = await startChain(chainOptions({ safe: committed.blockNumber }));
    const out = join(dir, "snapshot.json");
    await makeSnapshot(["--rpc", chain.url, "--out", out]);
    expect(readFileSync(out, "utf8")).toBe(committedText);
  });

  it("records a published KPS address and reports members without one", async () => {
    const certhash = `u${Buffer.concat([Buffer.from([0x12, 0x20]), Buffer.alloc(32, 7)]).toString("base64url")}`;
    const options = chainOptions();
    const first = options.members[0] as FakeMember;
    first.metadataUrl = `kps:3.239.73.249:15005:${certhash}/metadata.json`;
    const second = options.members[1] as FakeMember;
    second.metadataUrl = "kps:3.239.73.249:15005:not-a-certhash/metadata.json";
    const chain = await startChain(options);
    const out = join(dir, "snapshot.json");
    await makeSnapshot(["--rpc", chain.url, "--block", String(committed.blockNumber), "--out", out]);
    const snapshot = JSON.parse(readFileSync(out, "utf8")) as NoxAnonRpcSnapshot;
    expect(snapshot.members[0]?.metadataUrl).toBe(first.metadataUrl);
    expect(stdout()).toContain("1 with a KPS endpoint");
    expect(stdout()).toContain(`no KPS endpoint: ${second.address} (metadataUrl starts with "kps:" but certhash must be`);
    expect(stdout()).not.toContain(`no KPS endpoint: ${first.address}`);
  });

  it("refuses a block above the safe block unless asked", async () => {
    const chain = await startChain(chainOptions());
    const args = ["--rpc", chain.url, "--block", String(committed.blockNumber + 90), "--out", join(dir, "s.json")];
    await expect(makeSnapshot(args)).rejects.toMatchObject({ code: "block-unsafe" });
    await expect(makeSnapshot([...args, "--allow-unsafe-block"])).resolves.toBe(0);
  });

  it("fails when two endpoints disagree", async () => {
    const a = await startChain(chainOptions());
    const changed = chainOptions();
    (changed.members[3] as FakeMember).ingressUrl = "https://elsewhere.example";
    const b = await startChain(changed);
    await expect(
      makeSnapshot(["--rpc", a.url, "--rpc", b.url, "--block", String(committed.blockNumber), "--out", join(dir, "s.json")]),
    ).rejects.toMatchObject({ code: "providers-disagree" });
  });

  it("fails when the endpoint serves another chain", async () => {
    const chain = await startChain(chainOptions({ chainId: 1 }));
    await expect(makeSnapshot(["--rpc", chain.url, "--out", join(dir, "s.json")])).rejects.toMatchObject({ code: "chain-mismatch" });
  });

  it("fails when the log scan misses registrations", async () => {
    const chain = await startChain(chainOptions());
    const networks = join(dir, "networks.json");
    writeFileSync(
      networks,
      JSON.stringify({
        late: { chain_id: committed.chainId, registry: committed.registry, from_block: FROM_BLOCK + 5, pow_difficulty: 1 },
      }),
    );
    await expect(
      makeSnapshot(["--rpc", chain.url, "--network", "late", "--networks", networks, "--block", String(committed.blockNumber), "--out", join(dir, "s.json")]),
    ).rejects.toMatchObject({ code: "registry-inconsistent" });
  });

  it("narrows eth_getLogs spans the endpoint rejects", async () => {
    const chain = await startChain(chainOptions({ maxLogSpan: 400_000 }));
    const out = join(dir, "snapshot.json");
    await makeSnapshot(["--rpc", chain.url, "--block", String(committed.blockNumber), "--out", out]);
    expect(readFileSync(out, "utf8")).toBe(committedText);
  });

  it("refuses capability hints for an address that is not a member", async () => {
    const chain = await startChain(chainOptions());
    const capabilities = join(dir, "capabilities.json");
    writeFileSync(
      capabilities,
      JSON.stringify({ format: "nox-capabilities/1", source: "test", members: { "0x00000000000000000000000000000000000000aa": ["surb_v2"] } }),
    );
    await expect(
      makeSnapshot(["--rpc", chain.url, "--capabilities", capabilities, "--block", String(committed.blockNumber), "--out", join(dir, "s.json")]),
    ).rejects.toThrow(/not a registry member/u);
  });
});

describe("verify-snapshot.mjs", () => {
  it("matches the committed snapshot against the chain at its block", async () => {
    const chain = await startChain(chainOptions());
    expect(await verifySnapshot(["--rpc", chain.url])).toBe(0);
    expect(stdout()).toContain("MATCH, the chain at block");
  });

  it("names the member and field when the chain differs", async () => {
    const options = chainOptions();
    const member = options.members[2] as FakeMember;
    member.sphinxKey = "ab".repeat(32);
    const chain = await startChain(options);
    expect(await verifySnapshot(["--rpc", chain.url])).toBe(1);
    expect(stdout()).toContain(`member ${member.address}.sphinxKey: snapshot`);
  });

  it("names the member and field of a tampered copy with a matching hash record", async () => {
    const chain = await startChain(chainOptions());
    const tampered = JSON.parse(committedText) as NoxAnonRpcSnapshot;
    const member = tampered.members[4];
    if (member === undefined) throw new Error("fixture has fewer than five members");
    member.url = "/ip4/198.51.100.7/tcp/15000/p2p/12D3KooWBSxJfPWDy62QV9dLFszXsGXmZZbPhWUcTxVFLMm4V58u";
    const copy = join(dir, "nox-snapshot.json");
    writeFileSync(copy, canonicalJson(tampered));
    await writeHashFile(copy);
    expect(await verifySnapshot(["--snapshot", copy, "--rpc", chain.url])).toBe(1);
    expect(stdout()).toContain(`member ${member.address}.url: snapshot`);
  });

  it("rejects an edited copy whose hash record was not updated", async () => {
    const copy = join(dir, "nox-snapshot.json");
    writeFileSync(copy, committedText.replace('"powDifficulty": 1', '"powDifficulty": 2'));
    writeFileSync(`${copy}.keccak256`, readFileSync(`${SNAPSHOT_PATH}.keccak256`));
    await expect(verifySnapshot(["--snapshot", copy, "--offline"])).rejects.toThrow(/does not match its \.keccak256 record/u);
  });

  it("falls back to the latest state when the endpoint keeps no history", async () => {
    const chain = await startChain(chainOptions({ oldestStateBlock: committed.blockNumber + 90 }));
    expect(await verifySnapshot(["--rpc", chain.url])).toBe(0);
    expect(stdout()).toContain("MATCH (fallback: no state at block");
  });

  it("fails the fallback when the registry emitted events after the snapshot block", async () => {
    const chain = await startChain(
      chainOptions({ oldestStateBlock: committed.blockNumber + 90, otherEventBlocks: [committed.blockNumber + 5] }),
    );
    expect(await verifySnapshot(["--rpc", chain.url])).toBe(1);
    expect(stdout()).toContain("1 registry event(s) since the snapshot block");
  });

  it("fails the fallback on a forged blockHash at the real block", async () => {
    const chain = await startChain(chainOptions({ oldestStateBlock: committed.blockNumber + 90 }));
    const forged = `0x${"cd".repeat(32)}`;
    const copy = await tamperedCopy((snapshot) => {
      snapshot.blockHash = forged;
    });
    expect(await verifySnapshot(["--snapshot", copy, "--rpc", chain.url])).toBe(1);
    expect(stdout()).toContain("MISMATCH, the recorded block fails the header checks");
    expect(stdout()).toContain(`blockHash: snapshot "${forged}", chain "${committed.blockHash}" at block ${committed.blockNumber}`);
    expect(stdout()).not.toContain("MATCH (fallback");
  });

  it("fails the fallback on a blockNumber above the latest block", async () => {
    const options = chainOptions({ oldestStateBlock: committed.blockNumber + 90 });
    const chain = await startChain(options);
    const future = 999_999_999;
    const copy = await tamperedCopy((snapshot) => {
      snapshot.blockNumber = future;
      snapshot.blockHash = `0x${"ab".repeat(32)}`;
    });
    expect(await verifySnapshot(["--snapshot", copy, "--rpc", chain.url])).toBe(1);
    expect(stdout()).toContain(`blockNumber: snapshot ${future} is above the chain's latest block ${options.head}`);
    expect(stdout()).not.toContain("MATCH (fallback");
  });

  it("fails the fallback on a blockNumber above the safe block", async () => {
    const options = chainOptions({ oldestStateBlock: committed.blockNumber + 95 });
    const chain = await startChain(options);
    const unsafe = committed.blockNumber + 70;
    const copy = await tamperedCopy((snapshot) => {
      snapshot.blockNumber = unsafe;
      snapshot.blockHash = chain.blockHash(unsafe);
    });
    // The exact-block read refuses a block above the safe block outright.
    await expect(verifySnapshot(["--snapshot", copy, "--rpc", chain.url])).rejects.toMatchObject({ code: "block-unsafe" });
  });

  it("names a recorded block above the safe block in the header checks", async () => {
    const options = chainOptions();
    const chain = await startChain(options);
    const unsafe = committed.blockNumber + 70;
    const rpc = createRpcClient({ url: chain.url, retries: 0 });
    const result = await recordedBlockProblems(rpc, { ...committed, blockNumber: unsafe, blockHash: chain.blockHash(unsafe) });
    expect(result.problems).toEqual([
      `blockNumber: snapshot ${unsafe} is above the chain's safe block ${options.safe}, so a reorg can still replace it`,
    ]);
    expect((await recordedBlockProblems(rpc, committed)).problems).toEqual([]);
  });

  it("does not fall back on a JSON-RPC error that is not missing state", async () => {
    const chain = await startChain(
      chainOptions({ oldestStateBlock: committed.blockNumber + 90, callError: "rate limit exceeded, retry in 1s" }),
    );
    await expect(verifySnapshot(["--rpc", chain.url])).rejects.toMatchObject({ code: "state-read-failed" });
    expect(stdout()).not.toContain("fallback");
  });

  it("falls back on Geth's missing trie node error as well", async () => {
    const chain = await startChain(
      chainOptions({
        oldestStateBlock: committed.blockNumber + 90,
        missingStateMessage: () => `missing trie node ${"ef".repeat(32)} (path ) state ${"ef".repeat(32)} is not available`,
      }),
    );
    expect(await verifySnapshot(["--rpc", chain.url])).toBe(0);
    expect(stdout()).toContain("its header there has the recorded hash and is at or below the safe block");
  });

  it("classifies missing-state JSON-RPC errors by message", () => {
    const rpcError = (message: string): RpcError =>
      new RpcError(`eth_call to https://x failed with JSON-RPC error -32000: ${message}`, "rpc", { rpcCode: -32000, rpcMessage: message });
    for (const message of [
      "historical state 5fcc40cf6b7b58ad78e4e6f0a8f303008c93e561b6eb3c85283b9fee1774e2c3 is not available",
      "missing trie node 1234 (path ) <nil>",
      "required historical state unavailable (reexec=128)",
      "header not found",
      "state at block #315527209 is pruned",
      "No state available for block 0xabc",
    ]) {
      expect(isMissingStateError(rpcError(message)), message).toBe(true);
    }
    for (const message of ["execution reverted", "rate limit exceeded", "daily request count exceeded, request rate limited"]) {
      expect(isMissingStateError(rpcError(message)), message).toBe(false);
    }
    expect(isMissingStateError(new RpcError("historical state x is not available", "transport"))).toBe(false);
    expect(isMissingStateError(new Error("missing trie node"))).toBe(false);
  });

  it("applies the release gate", async () => {
    expect(await verifySnapshot(["--offline", "--release"])).toBe(1);
    expect(stdout()).toContain("release gate (document only, the chain was not read): FAIL");
    const all = committed.members.map((member) => member.address).join(",");
    output.length = 0;
    expect(await verifySnapshot(["--offline", "--release", "--allow-missing-kps", all])).toBe(0);
    expect(stdout()).toContain("release gate (document only, the chain was not read): pass");
  });

  it("passes the release gate against the chain only through two providers", async () => {
    const all = committed.members.map((member) => member.address).join(",");
    const a = await startChain(chainOptions());
    const b = await startChain(chainOptions());
    output.length = 0;
    expect(await verifySnapshot(["--rpc", a.url, "--release", "--allow-missing-kps", all])).toBe(1);
    expect(stdout()).toContain("read through 1 provider(s); a release snapshot needs 2");
    output.length = 0;
    expect(await verifySnapshot(["--rpc", a.url, "--rpc", b.url, "--release", "--allow-missing-kps", all])).toBe(0);
    expect(stdout()).toContain("release gate: pass");
    expect(stdout()).not.toContain("FAIL");
  });
});
