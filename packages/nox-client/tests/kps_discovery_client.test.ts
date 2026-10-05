/**
 * `NoxClient` in KPS mode with run-time discovery (S1, PROPOSAL §2.2), end to
 * end over the in-memory KPS network and a fake registry chain reached
 * through the fake mixnet's exit: default anchors, gateways, bridges, learned
 * anchors, chain checks (location changes, new members on probation,
 * disagreement, stale documents) and option validation. Global `fetch` and
 * `WebSocket` throw in every test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoxClient } from "../src/client.js";
import { primaryLayerForRole } from "../src/topology.js";
import {
  NoxClientErrorCode,
  type KpsDiscoveryOptions,
  type NoxClientConfig,
  type NoxLogLevel,
  type PinnedMember,
  type PinnedSnapshot,
  type TopologyNode,
  type VerifiedDiscovery,
} from "../src/types.js";
import { FakeRegistryChain } from "./helpers/fake_chain.js";
import { FakeKpsNetwork, json, kpsAddressFor, type FakeHandler } from "./helpers/fake_kps.js";
import { FakeMixnet, encodeExitHttpResponse, fakeWasmBindings } from "./helpers/fake_mixnet.js";
import {
  FIXTURE_PROVIDERS,
  makeBootstrap,
  makePinned,
  memberAddress,
  served,
  type ServedSpec,
} from "./helpers/pinned_fixture.js";

interface LogEntry {
  level: NoxLogLevel;
  event: string;
  fields: Readonly<Record<string, string | number | boolean>> | undefined;
}

interface Bed {
  pinned: PinnedSnapshot;
  network: FakeKpsNetwork;
  mixnet: FakeMixnet;
  /** Chain per provider URL (all the same object unless a test splits them). */
  chains: Map<string, FakeRegistryChain>;
  chain: FakeRegistryChain;
  logs: LogEntry[];
  servedSpec: ServedSpec;
  /** Member each KPS address serves for (its `/metadata.json` node). */
  nodeAt: Map<string, string>;
  providerRequests: number;
  config(discovery?: Partial<KpsDiscoveryOptions>, extra?: Partial<NoxClientConfig>): NoxClientConfig;
}

/** The chain's members as a snapshot-shaped list, for node-served documents of the current registry. */
function registryView(pinned: PinnedSnapshot, chain: FakeRegistryChain): PinnedSnapshot {
  const members: PinnedMember[] = [...chain.members.values()]
    .sort((left, right) => (left.address < right.address ? -1 : 1))
    .map((member) => ({
      address: member.address,
      sphinxKey: member.sphinxKey,
      url: member.url,
      ingressUrl: member.ingressUrl,
      metadataUrl: member.metadataUrl,
      stake: member.stake,
      role: member.role as 1 | 2 | 3,
      layer: primaryLayerForRole(member.address, member.role) as 0 | 1 | 2,
      status: member.status as 1 | 2,
      frozen: member.frozen,
      capabilities: [],
    }));
  return { ...pinned, members };
}

function bed(pinned: PinnedSnapshot = makePinned()): Bed {
  const network = new FakeKpsNetwork();
  const logs: LogEntry[] = [];
  const chain = new FakeRegistryChain(pinned);
  const nodeAt = new Map<string, string>();
  pinned.members.forEach((member, offset) => nodeAt.set(kpsAddressFor(offset + 1), member.address));
  const result: Bed = {
    pinned,
    network,
    chain,
    chains: new Map(FIXTURE_PROVIDERS.map((url) => [url, chain])),
    logs,
    servedSpec: {},
    nodeAt,
    providerRequests: 0,
    mixnet: undefined as unknown as FakeMixnet,
    config: (discovery = {}, extra = {}) => ({
      mode: "kps",
      wasm: fakeWasmBindings(),
      timeoutMs: 2_000,
      log: (level, event, fields) => logs.push({ level, event, fields }),
      kps: {
        dial: network.dial,
        pinned,
        topologySources: 2,
        discovery: { bootstrap: makeBootstrap(pinned), ...discovery },
      },
      ...extra,
    }),
  };
  result.mixnet = new FakeMixnet(
    () => served(registryView(pinned, result.chain), Math.floor(Date.now() / 1000), {
      // Nodes follow the latest block; the finalized block the chain check reads lags behind.
      blockNumber: result.chain.blockNumber + 5,
      ...result.servedSpec,
    }),
    (request) => {
      if (request.tag === "HttpRequest") {
        const chainFor = result.chains.get(request.url);
        if (chainFor !== undefined) {
          result.providerRequests += 1;
          return encodeExitHttpResponse(200, [["content-type", "application/json"]], chainFor.answer(new TextDecoder().decode(request.body)));
        }
      }
      return encodeExitHttpResponse(200, [["content-type", "application/json"]], '{"jsonrpc":"2.0","id":1,"result":"0x10"}');
    },
  );
  const handler: FakeHandler = (request) => {
    if (request.method === "GET" && request.path === "/metadata.json") {
      const node = nodeAt.get(request.address);
      return node === undefined ? { status: 404, body: "no node" } : json(200, { protocol: "nox-kps-http/1", node });
    }
    return result.mixnet.handler(request);
  };
  network.route(undefined, handler);
  return result;
}

const clients: NoxClient[] = [];

async function connect(config: NoxClientConfig): Promise<NoxClient> {
  const client = await NoxClient.connect(config);
  clients.push(client);
  return client;
}

function entryOf(client: NoxClient, member: string): string | undefined {
  return client.nodes.find((node) => node.id === member)?.address;
}

async function waitForLog(t: Bed, event: string, count = 1): Promise<LogEntry> {
  await vi.waitFor(() => {
    expect(t.logs.filter((entry) => entry.event === event).length).toBeGreaterThanOrEqual(count);
  }, { timeout: 5_000, interval: 10 });
  return t.logs.filter((entry) => entry.event === event)[count - 1]!;
}

function newMember(index: number, role: 1 | 2 | 3): PinnedMember {
  const address = memberAddress(index);
  return {
    address,
    sphinxKey: index.toString(16).padStart(2, "0").repeat(32),
    url: `/ip4/10.0.2.${index}/tcp/15000/p2p/12D3KooWNew${index}`,
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

const ambientFetch = vi.fn(() => {
  throw new Error("KPS mode must never call the global fetch");
});

class AmbientWebSocket {
  constructor() {
    throw new Error("KPS mode must never open a WebSocket");
  }
}

beforeEach(() => {
  ambientFetch.mockClear();
  vi.stubGlobal("fetch", ambientFetch);
  vi.stubGlobal("WebSocket", AmbientWebSocket);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.unstubAllGlobals();
});

describe("KPS discovery: anchors", () => {
  it("boots an empty config on the bundle's default anchors, found by their /metadata.json", async () => {
    const t = bed();
    // Members 1 and 2 moved: the default anchors are their new addresses, unknown to the snapshot.
    const anchorA = kpsAddressFor(1, 16005);
    const anchorB = kpsAddressFor(2, 16005);
    t.nodeAt.set(anchorA, memberAddress(1));
    t.nodeAt.set(anchorB, memberAddress(2));
    const client = await connect(t.config({ bootstrap: makeBootstrap(t.pinned, { anchors: [anchorA, anchorB] }), chain: false }));
    expect(t.network.dials.slice(0, 2).sort()).toEqual([anchorA, anchorB].sort());
    expect(t.network.requests.filter((r) => r.path === "/metadata.json").map((r) => r.address).sort()).toEqual([anchorA, anchorB].sort());
    // The moved members are reachable at the anchors, not at their stale snapshot addresses.
    expect(entryOf(client, memberAddress(1))).toBe(`kps:${anchorA}`);
    expect(entryOf(client, memberAddress(2))).toBe(`kps:${anchorB}`);
    expect([`kps:${anchorA}`, `kps:${anchorB}`]).toContain(client.entryUrl);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("falls back to the snapshot's KPS addresses when every default anchor is blocked", async () => {
    const t = bed();
    const blocked = [kpsAddressFor(1, 16005), kpsAddressFor(2, 16005)];
    for (const address of blocked) t.network.refuse.add(address);
    const client = await connect(t.config({ bootstrap: makeBootstrap(t.pinned, { anchors: blocked }), chain: false }));
    expect(t.network.dials.slice(0, 2).sort()).toEqual([...blocked].sort());
    expect(client.entryUrl.startsWith("kps:10.0.0.")).toBe(true);
    expect(t.logs.filter((entry) => entry.event === "anchor.failed")).toHaveLength(2);
  });

  it("dials the wallet's gateways in place of the bundle's anchors", async () => {
    const t = bed();
    const bundleAnchor = kpsAddressFor(3, 16005);
    const gateway = kpsAddressFor(4, 17005);
    t.nodeAt.set(bundleAnchor, memberAddress(3));
    t.nodeAt.set(gateway, memberAddress(4));
    const client = await connect(t.config({
      bootstrap: makeBootstrap(t.pinned, { anchors: [bundleAnchor] }),
      gateways: [gateway],
      chain: false,
    }));
    expect(t.network.dials[0]).toBe(gateway);
    expect(t.network.dials).not.toContain(bundleAnchor);
    expect(entryOf(client, memberAddress(4))).toBe(`kps:${gateway}`);
  });

  it("refuses a gateway whose metadata names no eligible pinned member, and boots elsewhere", async () => {
    const t = bed();
    const impostor = kpsAddressFor(9, 18005);
    t.nodeAt.set(impostor, memberAddress(99));
    const client = await connect(t.config({ gateways: [impostor], chain: false }));
    expect(t.network.dials[0]).toBe(impostor);
    expect(client.nodes.some((node) => node.address === `kps:${impostor}`)).toBe(false);
    expect(t.logs.some((entry) => entry.event === "anchor.failed" && entry.fields?.["code"] === NoxClientErrorCode.TopologyVerificationFailed)).toBe(true);
  });

  it("bridges: dials only the bridges, never a published address, and routes entries only through them", async () => {
    const t = bed();
    const bridgeA = kpsAddressFor(1, 19005);
    const bridgeB = kpsAddressFor(6, 19005);
    t.nodeAt.set(bridgeA, memberAddress(1));
    t.nodeAt.set(bridgeB, memberAddress(6));
    const verified: VerifiedDiscovery[] = [];
    const client = await connect(t.config({
      bootstrap: makeBootstrap(t.pinned, { anchors: [kpsAddressFor(2, 16005)] }),
      bridges: [bridgeA, bridgeB],
      onVerified: (state) => verified.push(state),
    }));
    expect(new Set(t.network.dials)).toEqual(new Set([bridgeA, bridgeB]));
    const entries = client.nodes.filter((node) => node.address.length > 0).map((node) => node.address).sort();
    expect(entries).toEqual([`kps:${bridgeA}`, `kps:${bridgeB}`].sort());
    // The chain check runs through the bridge entry and still never adds a published address.
    await waitForLog(t, "discovery.verified");
    expect(verified).toHaveLength(1);
    const after = client.nodes.filter((node) => node.address.length > 0).map((node) => node.address).sort();
    expect(after).toEqual(entries);
    expect(new Set(t.network.dials)).toEqual(new Set([bridgeA, bridgeB]));
  });

  it("uses a learned anchor only when its /metadata.json confirms the member it was learned for", async () => {
    const t = bed();
    const honest = kpsAddressFor(5, 20005);
    const poisoned = kpsAddressFor(7, 20005);
    t.nodeAt.set(honest, memberAddress(5));
    t.nodeAt.set(poisoned, memberAddress(3));
    const client = await connect(t.config({
      bootstrap: makeBootstrap(t.pinned, { anchors: [] }),
      learned: [
        { address: poisoned, member: memberAddress(7) },
        { address: honest, member: memberAddress(5) },
      ],
      chain: false,
    }));
    expect(t.network.dials.slice(0, 2).sort()).toEqual([honest, poisoned].sort());
    expect(entryOf(client, memberAddress(5))).toBe(`kps:${honest}`);
    expect(client.nodes.some((node) => node.address === `kps:${poisoned}`)).toBe(false);
  });
});

describe("KPS discovery: chain checks", () => {
  it("picks up a member's new KPS address and url from the chain without a new bundle", async () => {
    const t = bed();
    const verified: VerifiedDiscovery[] = [];
    const client = await connect(t.config({ onVerified: (state) => verified.push(state) }));
    // Member 2 moves before the check: new KPS address and P2P url, signed on chain by its own key.
    const moved = kpsAddressFor(2, 21005);
    t.nodeAt.set(moved, memberAddress(2));
    t.chain.update(memberAddress(2), {
      metadataUrl: `kps:${moved}/metadata.json`,
      url: "/ip4/203.0.113.2/tcp/15000/p2p/12D3KooWNode2",
    });
    t.chain.advance();
    // A refresh (or the ready check) runs the chain check; trigger one directly.
    await (Reflect.get(client, "_runChainCheck") as (reason: string, force: boolean) => Promise<boolean>).call(client, "test", true);
    const event = t.logs.findLast((entry) => entry.event === "discovery.verified")!;
    expect(event.fields?.["moved"]).toBeGreaterThanOrEqual(1);
    expect(entryOf(client, memberAddress(2))).toBe(`kps:${moved}`);
    expect(client.nodes.find((node) => node.id === memberAddress(2))?.routingAddress).toBe("/ip4/203.0.113.2/tcp/15000/p2p/12D3KooWNode2");
    expect(verified.at(-1)?.members.find((member) => member.address === memberAddress(2))?.kpsAddress).toBe(moved);
    expect(t.providerRequests).toBeGreaterThanOrEqual(3);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("adds a newly registered member on probation, at most one per route", async () => {
    const t = bed();
    const client = await connect(t.config());
    await waitForLog(t, "discovery.verified");
    t.chain.put(newMember(9, 1));
    t.nodeAt.set(kpsAddressFor(9), memberAddress(9));
    t.chain.advance();
    // Node-served documents now list member 9 too (registryView follows the chain).
    await (Reflect.get(client, "_runChainCheck") as (reason: string, force: boolean) => Promise<boolean>).call(client, "test", true);
    const added = client.nodes.find((node) => node.id === memberAddress(9));
    expect(added?.probation).toBe(true);
    expect(added?.address).toBe(`kps:${kpsAddressFor(9)}`);
    const probation = await waitForLog(t, "discovery.probation");
    expect(probation.fields?.["members"]).toBe(1);
    const plan = Reflect.get(client, "_planRoute") as (exit: undefined, avoid: Set<string>) => { route: Record<"entry" | "mix" | "exit", TopologyNode> };
    for (let i = 0; i < 200; i++) {
      const { route } = plan.call(client, undefined, new Set());
      expect([route.entry, route.mix, route.exit].filter((hop) => hop.probation === true).length).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the snapshot floor when two providers disagree, and logs discovery.disagreement", async () => {
    const t = bed();
    const liar = new FakeRegistryChain(t.pinned);
    liar.put(newMember(9, 2));
    t.chains.set(FIXTURE_PROVIDERS[1]!, liar);
    const client = await connect(t.config({ registryRpcUrls: [FIXTURE_PROVIDERS[0]!, FIXTURE_PROVIDERS[1]!] }));
    await waitForLog(t, "discovery.disagreement");
    expect(t.logs.some((entry) => entry.event === "discovery.verified")).toBe(false);
    expect(client.nodes.map((node) => node.id)).not.toContain(memberAddress(9));
    expect(client.nodes).toHaveLength(t.pinned.members.length);
  });

  it("refuses a registry whose proxy points at an unknown implementation", async () => {
    const t = bed();
    t.chain.implementation = "0x00000000000000000000000000000000000000cc";
    const client = await connect(t.config());
    const rejected = await waitForLog(t, "discovery.rejected");
    expect(rejected.fields?.["cause"]).toBe("implementation");
    expect(client.nodes).toHaveLength(t.pinned.members.length);
  });

  it("removes members the chain no longer lists, above the per-layer floor", async () => {
    const t = bed();
    t.chain.remove(memberAddress(8));
    const client = await connect(t.config());
    await waitForLog(t, "discovery.verified");
    expect(client.nodes.map((node) => node.id)).not.toContain(memberAddress(8));
  });

  it("runs a chain check instead of failing when served documents would declare the snapshot stale", async () => {
    // Entries are relays only, so the refresh sources are never the exits that leave.
    const t = bed(makePinned([{ role: 1 }, { role: 1 }, { role: 1 }, { role: 1 }, { role: 1 }, { role: 2, kps: false }, { role: 2, kps: false }, { role: 2, kps: false }]));
    const client = await connect(t.config({}, { topologyRefreshMs: 50 }));
    await waitForLog(t, "discovery.verified");
    // Every snapshot exit leaves; two new exits register. Nodes serve the new registry.
    for (const index of [6, 7, 8]) t.chain.remove(memberAddress(index));
    t.chain.put(newMember(10, 2));
    t.chain.put(newMember(11, 2));
    for (const index of [10, 11]) t.nodeAt.set(kpsAddressFor(index), memberAddress(index));
    t.chain.advance();
    await waitForLog(t, "discovery.verified", 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(t.logs.some((entry) => entry.event === "topology.stale")).toBe(false);
    const exits = client.nodes.filter((node) => node.role === 2).map((node) => node.id);
    expect(exits).toEqual(expect.arrayContaining([memberAddress(10), memberAddress(11)]));
  });

  it("never reads the chain with discovery.chain false", async () => {
    const t = bed();
    await connect(t.config({ chain: false }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.providerRequests).toBe(0);
    expect(t.logs.some((entry) => entry.event.startsWith("discovery."))).toBe(false);
  });
});

describe("KPS discovery: options", () => {
  async function expectConfigError(config: NoxClientConfig, code: NoxClientErrorCode, pattern: RegExp): Promise<void> {
    await expect(NoxClient.connect(config)).rejects.toMatchObject({ code, message: expect.stringMatching(pattern) });
  }

  it("validates discovery options before any dial", async () => {
    const t = bed();
    const pinned = t.pinned;
    await expectConfigError(t.config({ gateways: [kpsAddressFor(1)], bridges: [kpsAddressFor(2)] }), NoxClientErrorCode.InvalidConfig, /exclude each other/u);
    await expectConfigError(t.config({ gateways: [] }), NoxClientErrorCode.InvalidConfig, /gateways must be a list of 1\.\.16/u);
    await expectConfigError(t.config({ bridges: ["1.2.3.4:5"] }), NoxClientErrorCode.InvalidConfig, /bridges\[0\]/u);
    await expectConfigError(t.config({ learned: [{ address: kpsAddressFor(1), member: "0xABC" }] }), NoxClientErrorCode.InvalidConfig, /learned\[0\]/u);
    await expectConfigError(
      t.config({ firstSeen: [{ address: memberAddress(9), block: pinned.blockNumber - 1, time: 1 }] }),
      NoxClientErrorCode.InvalidConfig,
      /firstSeen\[0\]/u,
    );
    await expectConfigError(t.config({ registryRpcUrls: ["http://evil.test/"] }), NoxClientErrorCode.InvalidConfig, /registryRpcUrls/u);
    await expectConfigError(t.config({ chainQuorum: 1 }), NoxClientErrorCode.InvalidConfig, /chainQuorum/u);
    await expectConfigError(t.config({ chain: "yes" as unknown as boolean }), NoxClientErrorCode.InvalidConfig, /chain must be a boolean/u);
    await expectConfigError(
      t.config({ bootstrap: { ...makeBootstrap(pinned), chainId: 1 } }),
      NoxClientErrorCode.TopologyVerificationFailed,
      /chainId/u,
    );
    await expectConfigError(t.config({ surprise: 1 } as Partial<KpsDiscoveryOptions>), NoxClientErrorCode.InvalidConfig, /not a discovery option/u);
    const withEntries = t.config();
    (withEntries.kps as unknown as Record<string, unknown>)["entries"] = [kpsAddressFor(1)];
    await expectConfigError(withEntries, NoxClientErrorCode.InvalidConfig, /exclude each other/u);
    expect(t.network.dials).toEqual([]);
  });
});
