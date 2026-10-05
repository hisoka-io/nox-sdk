/**
 * S1 discovery in the worker on the real SDK: empty config on the bundle's
 * anchors, gateways, bridges, chain checks through the in-memory mixnet to a
 * fake registry, the learned-anchor cache (written after a verified check,
 * used on the next boot, ignored when poisoned) and snapshot-only discovery.
 * Global `fetch` and `WebSocket` throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoxClient, type KpsBootstrap, type PinnedSnapshot, type ServiceRequest } from "@hisoka-io/nox-client";
import { runNoxWorker } from "../src/core.js";
import { LEARNED_CACHE_KEY } from "../src/storage.js";
import { FakeHarness } from "./helpers/fake-harness.js";
import { FakeNoxNetwork, fakeWasm } from "./helpers/fake-nox-network.js";
import { certhashFor, exitReply, FIXTURE_PROVIDERS, kpsAddressFor, makeBootstrap, makePinned, memberAddress } from "./helpers/fixtures.js";
import { RegistryRpc } from "./helpers/registry-rpc.js";

const ambientFetch = vi.fn(() => {
  throw new Error("the worker must never call the global fetch");
});

beforeEach(() => {
  ambientFetch.mockClear();
  vi.stubGlobal("fetch", ambientFetch);
  vi.stubGlobal("WebSocket", class {
    constructor() {
      throw new Error("the worker must never open a WebSocket");
    }
  });
});

const clients: NoxClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.unstubAllGlobals();
});

/** `<ip>:<port>:<certhash>` of member `index` after it moved to another IP and port. */
function movedAddress(index: number, port: number): string {
  return `198.51.100.${index}:${port}:${certhashFor(`node-${index}`)}`;
}

interface Bed {
  pinned: PinnedSnapshot;
  network: FakeNoxNetwork;
  rpc: RegistryRpc;
  harness: FakeHarness;
  client(): NoxClient;
}

function boot(config: unknown, options: { bootstrap?: (pinned: PinnedSnapshot) => KpsBootstrap; store?: Map<string, Uint8Array>; prepare?: (bed: Omit<Bed, "harness" | "client">) => void } = {}): Bed {
  const pinned = makePinned();
  const rpc = new RegistryRpc(pinned);
  const providers = new Set(FIXTURE_PROVIDERS);
  const exit = (request: ServiceRequest): Uint8Array => {
    if (request.tag === "HttpRequest" && providers.has(request.url)) {
      return exitReply(200, [["content-type", "application/json"]], rpc.answer(new TextDecoder().decode(request.body)));
    }
    return exitReply(200, [["content-type", "application/json"]], '{"jsonrpc":"2.0","id":1,"result":"0x1"}');
  };
  const network = new FakeNoxNetwork(pinned, exit);
  network.registryView = () => rpc.view();
  network.observedBlock = () => rpc.blockNumber + 5;
  options.prepare?.({ pinned, network, rpc });
  const harness = new FakeHarness(config, network.kps);
  for (const [key, value] of options.store ?? []) harness.store.set(key, value);
  let latest: NoxClient | undefined;
  void runNoxWorker(harness.api, {
    snapshot: pinned,
    bootstrap: (options.bootstrap ?? makeBootstrap)(pinned),
    loadWasm: async () => fakeWasm(),
    connect: async (clientConfig) => {
      const client = await NoxClient.connect(clientConfig);
      clients.push(client);
      latest = client;
      return client;
    },
  });
  return {
    pinned,
    network,
    rpc,
    harness,
    client: () => {
      if (latest === undefined) throw new Error("not connected");
      return latest;
    },
  };
}

function logged(harness: FakeHarness, event: string): number {
  return harness.events(event).length;
}

async function untilLogged(harness: FakeHarness, event: string): Promise<void> {
  await vi.waitFor(() => expect(logged(harness, event)).toBeGreaterThan(0), { timeout: 10_000, interval: 20 });
}

function runCheck(client: NoxClient): Promise<boolean> {
  return (Reflect.get(client, "_runChainCheck") as (reason: string, force: boolean) => Promise<boolean>).call(client, "test", true);
}

describe("worker discovery", () => {
  it("boots an empty config on the bundle's default anchors and verifies the registry through the mixnet", async () => {
    const anchor = movedAddress(1, 16005);
    const bed = boot(undefined, {
      bootstrap: (pinned) => makeBootstrap(pinned, { anchors: [anchor] }),
      prepare: ({ network }) => network.nodeAt.set(anchor, memberAddress(1)),
    });
    await bed.harness.ready;
    expect(bed.network.dials[0]).toBe(anchor);
    await untilLogged(bed.harness, "discovery.verified");
    expect(bed.rpc.requests).toBeGreaterThanOrEqual(3);
    expect(bed.harness.failures).toEqual([]);
    expect(ambientFetch).not.toHaveBeenCalled();
  });

  it("writes chain-confirmed addresses to the learned-anchor cache and the next boot dials them", async () => {
    const first = boot({ topologySources: 2 });
    await first.harness.ready;
    // Member 2 moves (updateMetadataUrl from its own key); the next check confirms it.
    const moved = movedAddress(2, 17005);
    first.network.nodeAt.set(moved, memberAddress(2));
    first.rpc.update(memberAddress(2), { metadataUrl: `kps:${moved}/metadata.json` });
    first.rpc.advance();
    await untilLogged(first.harness, "discovery.verified");
    expect(await runCheck(first.client())).toBe(true);
    await vi.waitFor(() => {
      const raw = first.harness.store.get(LEARNED_CACHE_KEY);
      expect(raw).toBeDefined();
      const cache = JSON.parse(new TextDecoder().decode(raw!)) as { anchors: { address: string; member: string }[] };
      expect(cache.anchors).toContainEqual(expect.objectContaining({ address: moved, member: memberAddress(2) }));
    }, { timeout: 5_000, interval: 20 });
    // The KPS address of member 2 in this session already follows the chain.
    expect(first.client().nodes.find((node) => node.id === memberAddress(2))?.address).toBe(`kps:${moved}`);

    // A new worker of the same bundle: the default anchor and every snapshot address are
    // unreachable, so it boots only through the learned address of the moved member.
    const blocked = movedAddress(9, 19005);
    const second = boot({ topologySources: 1 }, {
      bootstrap: (pinned) => makeBootstrap(pinned, { anchors: [blocked] }),
      store: first.harness.store,
      prepare: ({ network, pinned }) => {
        network.refused.add(blocked);
        for (let index = 1; index <= pinned.members.length; index++) network.refused.add(kpsAddressFor(index));
        network.nodeAt.set(moved, memberAddress(2));
      },
    });
    await second.harness.ready;
    expect(second.network.dials[0]).toBe(blocked);
    expect(second.network.dials).toContain(moved);
    expect(second.client().entryUrl).toBe(`kps:${moved}`);
    const learned = second.harness.events("boot.learned")[0]?.args[2] as { anchors: number };
    expect(learned.anchors).toBeGreaterThanOrEqual(1);
  });

  it("ignores a poisoned learned-anchor cache and boots normally", async () => {
    const poisoned = new TextEncoder().encode(JSON.stringify({
      registry: "421614:0xf7bff88a1412054a001dc4b8acbddad6f9b26cb6",
      anchors: [{ address: "203.0.113.66:15005:" + certhashFor("evil"), member: "0xEVIL", block: 1, blockHash: "0x00", at: 1 }],
      firstSeen: [],
    }));
    const bed = boot({ topologySources: 1, discovery: "snapshot" }, { store: new Map([[LEARNED_CACHE_KEY, poisoned]]) });
    await bed.harness.ready;
    expect(bed.network.dials.some((address) => address.startsWith("203.0.113.66"))).toBe(false);
    const learned = bed.harness.events("boot.learned")[0]?.args[2] as { anchors: number };
    expect(learned.anchors).toBe(0);
  });

  it("refuses a learned anchor whose node now names another member", async () => {
    const swapped = movedAddress(3, 18005);
    const record = {
      registry: "421614:0xf7bff88a1412054a001dc4b8acbddad6f9b26cb6",
      anchors: [{ address: swapped, member: memberAddress(3), block: 315_453_500, blockHash: `0x${"ab".repeat(32)}`, at: Math.floor(Date.now() / 1000) - 10 }],
      firstSeen: [],
    };
    const bed = boot({ topologySources: 2, discovery: "snapshot" }, {
      store: new Map([[LEARNED_CACHE_KEY, new TextEncoder().encode(JSON.stringify(record))]]),
      prepare: ({ network }) => network.nodeAt.set(swapped, memberAddress(4)),
    });
    await bed.harness.ready;
    expect(bed.network.dials[0]).toBe(swapped);
    expect(bed.client().nodes.some((node) => node.address === `kps:${swapped}`)).toBe(false);
  });

  it("bridges: dials only the bridges, even after a chain check", async () => {
    const bridge = movedAddress(1, 20005);
    const bridgeB = movedAddress(6, 20005);
    const bed = boot({ bridges: [bridge, bridgeB] }, {
      bootstrap: (pinned) => makeBootstrap(pinned, { anchors: [kpsAddressFor(2)] }),
      prepare: ({ network }) => {
        network.nodeAt.set(bridge, memberAddress(1));
        network.nodeAt.set(bridgeB, memberAddress(6));
      },
    });
    await bed.harness.ready;
    await untilLogged(bed.harness, "discovery.verified");
    expect(new Set(bed.network.dials)).toEqual(new Set([bridge, bridgeB]));
  });

  it("snapshot-only discovery never reaches an RPC provider", async () => {
    const bed = boot({ discovery: "snapshot", topologySources: 1 });
    await bed.harness.ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bed.rpc.requests).toBe(0);
    expect(logged(bed.harness, "discovery.verified")).toBe(0);
  });
});
