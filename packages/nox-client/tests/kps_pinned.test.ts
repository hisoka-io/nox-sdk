import { describe, expect, it } from "vitest";
import {
  applyServedTopologies,
  eligiblePinnedMembers,
  formsRoute,
  kpsTopologyNodes,
  pinnedPowDifficulty,
  verifyPinnedSnapshot,
  type ApplyServedOptions,
} from "../src/kps/pinned.js";
import { primaryLayerForRole } from "../src/topology.js";
import { NoxClientError, NoxClientErrorCode, type PinnedSnapshot } from "../src/types.js";
import { kpsAddressFor } from "./helpers/fake_kps.js";
import { PINNED_BLOCK, makePinned, memberAddress, served, type ServedSpec } from "./helpers/pinned_fixture.js";

const NOW = 1_800_000_000;
const OPTIONS: ApplyServedOptions = { clockSkewToleranceSeconds: 600, livenessMaxAgeSeconds: 180 };

function expectInvalid(pinned: unknown, pattern: RegExp): void {
  try {
    verifyPinnedSnapshot(pinned as PinnedSnapshot);
  } catch (error) {
    expect(error).toBeInstanceOf(NoxClientError);
    expect((error as NoxClientError).code).toBe(NoxClientErrorCode.TopologyVerificationFailed);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error("expected the pinned snapshot to be rejected");
}

describe("verifyPinnedSnapshot", () => {
  it("accepts a well-formed snapshot", () => {
    expect(() => verifyPinnedSnapshot(makePinned())).not.toThrow();
  });

  it("rejects a changed member address (fingerprint) before any network use", () => {
    const pinned = makePinned();
    const tampered = structuredClone(pinned);
    tampered.members[0]!.address = memberAddress(1).replace(/1$/u, "0");
    expectInvalid(tampered, /fingerprint mismatch/u);
  });

  it("rejects unknown and missing fields", () => {
    expectInvalid({ ...makePinned(), extra: 1 }, /unknown field "extra"/u);
    const missing: Record<string, unknown> = { ...makePinned() };
    delete missing["blockHash"];
    expectInvalid(missing, /missing "blockHash"/u);
    const pinned = makePinned();
    expectInvalid({ ...pinned, members: [{ ...pinned.members[0], note: "x" }, ...pinned.members.slice(1)] }, /unknown field "note"/u);
  });

  it("rejects malformed field values", () => {
    const pinned = makePinned();
    expectInvalid({ ...pinned, format: "nox-anon-rpc-snapshot/2" }, /format/u);
    expectInvalid({ ...pinned, registry: pinned.registry.toUpperCase() }, /registry/u);
    expectInvalid({ ...pinned, blockNumber: 0 }, /blockNumber/u);
    expectInvalid({ ...pinned, powDifficulty: 17 }, /powDifficulty/u);
    expectInvalid({ ...pinned, fingerprint: `0x${pinned.fingerprint}` }, /fingerprint/u);
    expectInvalid({ ...pinned, relayerCount: pinned.members.length + 1 }, /relayerCount/u);
    const badKey = structuredClone(pinned);
    badKey.members[0]!.sphinxKey = "zz".repeat(32);
    expectInvalid(badKey, /sphinxKey/u);
    const badLayer = structuredClone(pinned);
    const exit = badLayer.members.find((member) => member.role === 2)!;
    exit.layer = 1;
    expectInvalid(badLayer, /primary layer|layer/u);
    const dupCaps = structuredClone(pinned);
    dupCaps.members[0]!.capabilities = ["surb_v2", "surb_v2"];
    expectInvalid(dupCaps, /capabilities/u);
  });

  it("rejects members out of canonical order", () => {
    const pinned = makePinned();
    const reordered = { ...pinned, members: [...pinned.members].reverse() };
    expectInvalid(reordered, /sorted by address/u);
  });

  it("rejects non-object input", () => {
    expectInvalid(null, /not an object/u);
    expectInvalid([], /not an object/u);
  });
});

describe("applyServedTopologies (removals only)", () => {
  const pinned = makePinned();
  const all = pinned.members.map((member) => member.address);
  const stranger = () => {
    const address = memberAddress(200);
    return {
      address,
      sphinx_key: "ee".repeat(32),
      url: "/ip4/10.9.9.9/tcp/15000",
      stake: "0",
      last_seen: 0,
      is_privileged: true,
      layer: primaryLayerForRole(address, 1),
      role: 1,
      ingress_url: "https://stranger.test",
      metadata_url: `kps:${kpsAddressFor(200)}/metadata.json`,
    };
  };

  it("keeps every pinned eligible member when a source reports them online", () => {
    const result = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(1), snapshot: served(pinned, NOW) }], NOW, OPTIONS);
    expect(result.sourcesAccepted).toBe(1);
    expect(result.members.map((node) => node.address)).toEqual(all);
    expect(result.removed).toEqual([]);
    expect(result.floorApplied).toBe(false);
  });

  it("removes nothing on one source's word, however much it omits (single-source rule)", () => {
    const document = served(pinned, NOW, {
      add: [stranger()],
      omit: [2],
      offline: [3],
      mutate: (node, index) => (index === 4 ? { ...node, sphinx_key: "ff".repeat(32) } : node),
    });
    const result = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(1), snapshot: document }], NOW, OPTIONS);
    expect(result.sourcesAccepted).toBe(1);
    expect(result.removalQuorum).toBe(false);
    expect(result.ignoredAdditions).toBe(1);
    expect(result.removed).toEqual([]);
    expect(result.members.map((node) => node.address)).toEqual(all);
  });

  it("ignores additions and removes changed profiles, omissions and offline members two anchors agree on", () => {
    const document = served(pinned, NOW, {
      add: [stranger()],
      omit: [2],
      offline: [3],
      mutate: (node, index) => (index === 4 ? { ...node, sphinx_key: "ff".repeat(32) } : node),
    });
    const result = applyServedTopologies(
      pinned,
      [{ anchor: kpsAddressFor(1), snapshot: document }, { anchor: kpsAddressFor(6), snapshot: document }],
      NOW,
      OPTIONS,
    );
    expect(result.removalQuorum).toBe(true);
    expect(result.ignoredAdditions).toBe(1);
    expect(result.removed.sort()).toEqual([memberAddress(2), memberAddress(3), memberAddress(4)]);
    expect(result.members.map((node) => node.address)).not.toContain(memberAddress(200));
    expect(result.members).toHaveLength(pinned.members.length - 3);
  });

  it("counts the same anchor twice as one source", () => {
    const document = served(pinned, NOW, { offline: [2, 3, 4] });
    const result = applyServedTopologies(
      pinned,
      [{ anchor: kpsAddressFor(1), snapshot: document }, { anchor: kpsAddressFor(1), snapshot: document }],
      NOW,
      OPTIONS,
    );
    expect(result.sourcesAccepted).toBe(2);
    expect(result.removalQuorum).toBe(false);
    expect(result.removed).toEqual([]);
  });

  it("lets a single-entry gateway remove nothing, even when it lists only colluders as online", () => {
    // The wallet's only gateway (member 1) claims the fleet is itself, one relay and one exit.
    const colluders = served(pinned, NOW, { offline: [2, 3, 4, 7, 8] });
    const result = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(1), snapshot: colluders }], NOW, {
      ...OPTIONS,
      entryAddresses: new Set([kpsAddressFor(1)]),
    });
    expect(result.removalQuorum).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.members.map((node) => node.address)).toEqual(all);
  });

  it("refuses to let one source shrink any layer to one node", () => {
    // Only exit 6 left online: one entry, one mix and one exit.
    const shrink = served(pinned, NOW, { offline: [1, 2, 3, 4, 5, 7, 8] });
    const single = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(1), snapshot: shrink }], NOW, OPTIONS);
    expect(single.removed).toEqual([]);
    expect(single.floorApplied).toBe(false);
    expect(single.members.map((node) => node.address)).toEqual(all);
  });

  it("keeps every layer at the floor even when two sources agree to shrink it to one node", () => {
    const shrink = served(pinned, NOW, { offline: [1, 2, 3, 4, 5, 7, 8] });
    const result = applyServedTopologies(
      pinned,
      [{ anchor: kpsAddressFor(1), snapshot: shrink }, { anchor: kpsAddressFor(2), snapshot: shrink }],
      NOW,
      OPTIONS,
    );
    expect(result.floorApplied).toBe(true);
    expect(result.floorLayers).toEqual(["entry", "mix", "exit"]);
    expect(result.removed).toEqual([]);
    expect(result.members.map((node) => node.address)).toEqual(all);
  });

  it("applies the entry floor to the entries the client may use", () => {
    const entryAddresses = new Set([kpsAddressFor(1), kpsAddressFor(2), kpsAddressFor(3)]);
    const document = served(pinned, NOW, { offline: [1, 2] });
    const result = applyServedTopologies(
      pinned,
      [{ anchor: kpsAddressFor(1), snapshot: document }, { anchor: kpsAddressFor(3), snapshot: document }],
      NOW,
      { ...OPTIONS, entryAddresses },
    );
    expect(result.floorLayers).toEqual(["entry"]);
    expect(result.removed).toEqual([]);
  });

  it("treats a changed KPS identity (metadataUrl) as absent", () => {
    const document = served(pinned, NOW, {
      mutate: (node, index) => (index === 5 ? { ...node, metadata_url: `kps:${kpsAddressFor(99)}/metadata.json` } : node),
    });
    const result = applyServedTopologies(
      pinned,
      [{ anchor: kpsAddressFor(1), snapshot: document }, { anchor: kpsAddressFor(6), snapshot: document }],
      NOW,
      OPTIONS,
    );
    expect(result.removed).toEqual([memberAddress(5)]);
  });

  it("needs every accepted source to agree before removing a member", () => {
    const result = applyServedTopologies(
      pinned,
      [
        { anchor: kpsAddressFor(1), snapshot: served(pinned, NOW, { offline: [2] }) },
        { anchor: kpsAddressFor(3), snapshot: served(pinned, NOW) },
      ],
      NOW,
      OPTIONS,
    );
    expect(result.sourcesAccepted).toBe(2);
    expect(result.removed).toEqual([]);
    const agreed = applyServedTopologies(
      pinned,
      [
        { anchor: kpsAddressFor(1), snapshot: served(pinned, NOW, { offline: [2] }) },
        { anchor: kpsAddressFor(3), snapshot: served(pinned, NOW, { omit: [2] }) },
      ],
      NOW,
      OPTIONS,
    );
    expect(agreed.removed).toEqual([memberAddress(2)]);
  });

  it("rejects stale, future, inconsistent and anchor-less documents", () => {
    const cases = [
      { snapshot: served(pinned, NOW, { blockNumber: PINNED_BLOCK - 1 }), reason: /before the snapshot block/u },
      { snapshot: served(pinned, NOW, { timestamp: NOW - 181 - 600 }), reason: /outside/u },
      { snapshot: served(pinned, NOW, { timestamp: NOW + 601 }), reason: /outside/u },
      { snapshot: { ...served(pinned, NOW), fingerprint: "00".repeat(32) }, reason: /self-consistent/u },
      { snapshot: served(pinned, NOW, { omit: [1] }), reason: /anchor's own member/u },
    ];
    for (const { snapshot, reason } of cases) {
      const result = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(1), snapshot }], NOW, OPTIONS);
      expect(result.sourcesAccepted).toBe(0);
      expect(result.rejected[0]?.reason).toMatch(reason);
      expect(result.members.map((node) => node.address)).toEqual(all);
    }
    const foreign = applyServedTopologies(pinned, [{ anchor: kpsAddressFor(77), snapshot: served(pinned, NOW) }], NOW, OPTIONS);
    expect(foreign.rejected[0]?.reason).toMatch(/not a pinned member/u);
  });

  it("keeps the previous members of a layer that two sources would push below the floor", () => {
    const toRelayer = (member: (typeof pinned.members)[number]) => ({
      address: member.address,
      sphinx_key: member.sphinxKey,
      url: member.url,
      stake: member.stake,
      last_seen: 0,
      is_privileged: true,
      layer: member.layer,
      role: member.role,
      ingress_url: member.ingressUrl,
      metadata_url: member.metadataUrl,
    });
    // Previous working set: relays 1-4 and exits 6-7 (relay 5 and exit 8 removed earlier).
    const previous = eligiblePinnedMembers(pinned)
      .filter((member) => member.address !== memberAddress(5) && member.address !== memberAddress(8))
      .map(toRelayer);
    const both = (offline: number[]) => [
      { anchor: kpsAddressFor(1), snapshot: served(pinned, NOW, { offline }) },
      { anchor: kpsAddressFor(2), snapshot: served(pinned, NOW, { offline }) },
    ];
    // Exit 8 is online in both documents; exits 6 and 7 come back from the previous set.
    const result = applyServedTopologies(pinned, both([6, 7]), NOW, { ...OPTIONS, previous });
    expect(result.floorApplied).toBe(true);
    expect(result.floorLayers).toEqual(["exit"]);
    expect(result.members.map((node) => node.address)).toEqual(all);
    // Without exit 7 in the previous set only exit 6 returns; relay 5 stays removed.
    const shorter = applyServedTopologies(pinned, both([5, 6, 7]), NOW, {
      ...OPTIONS,
      previous: previous.filter((node) => node.address !== memberAddress(7)),
    });
    expect(shorter.floorLayers).toEqual(["exit"]);
    expect(shorter.removed.sort()).toEqual([memberAddress(5), memberAddress(7)]);
  });

  describe("stale only on registry evidence, never on liveness alone", () => {
    const exits = pinned.members.flatMap((member, offset) => (member.role === 2 ? [offset + 1] : []));
    const exitAddresses = exits.map((index) => memberAddress(index));
    const two = (left: ServedSpec = {}, right: ServedSpec = left) => [
      { anchor: kpsAddressFor(1), snapshot: served(pinned, NOW, left) },
      { anchor: kpsAddressFor(2), snapshot: served(pinned, NOW, right) },
    ];

    it("declares the snapshot stale when two sources agree every exit left the registry", () => {
      expect(() => applyServedTopologies(pinned, two({ omit: exits }), NOW, OPTIONS)).toThrow(
        expect.objectContaining({ code: NoxClientErrorCode.TopologyStale, message: expect.stringMatching(/exit/u) }),
      );
    });

    it("declares the snapshot stale when two sources agree every exit changed its profile", () => {
      const rotated: ServedSpec = {
        mutate: (node, index) => (exits.includes(index) ? { ...node, sphinx_key: "ff".repeat(32) } : node),
      };
      expect(() => applyServedTopologies(pinned, two(rotated), NOW, OPTIONS)).toThrow(
        expect.objectContaining({ code: NoxClientErrorCode.TopologyStale }),
      );
    });

    it("keeps the exits when two sources list them all but report them offline (mesh re-forming)", () => {
      const result = applyServedTopologies(pinned, two({ offline: exits }), NOW, OPTIONS);
      expect(result.offlineLayers).toEqual(["exit"]);
      expect(result.floorLayers).toEqual(["exit"]);
      expect(result.members.map((node) => node.address)).toEqual(expect.arrayContaining(exitAddresses));
      expect(result.removed).toEqual([]);
      expect(formsRoute(pinned, result.members)).toBe(true);
    });

    it("keeps the exits when one source reports them offline and the other omits them", () => {
      const result = applyServedTopologies(pinned, two({ offline: exits }, { omit: exits }), NOW, OPTIONS);
      expect(result.offlineLayers).toEqual(["exit"]);
      expect(result.members.map((node) => node.address)).toEqual(expect.arrayContaining(exitAddresses));
    });

    it("restores only the previous working set's exits for an offline layer", () => {
      const previous = applyServedTopologies(pinned, two({ omit: [exits[0]!] }), NOW, OPTIONS).members;
      expect(previous.map((node) => node.address)).not.toContain(exitAddresses[0]);
      const result = applyServedTopologies(pinned, two({ offline: exits }), NOW, { ...OPTIONS, previous });
      expect(result.offlineLayers).toEqual(["exit"]);
      expect(result.removed).toEqual([exitAddresses[0]]);
    });

    it("falls back to the listed members when the previous set has none of the offline layer", () => {
      const previous = applyServedTopologies(pinned, two(), NOW, OPTIONS).members.filter(
        (node) => !exitAddresses.includes(node.address),
      );
      const result = applyServedTopologies(pinned, two({ offline: exits }), NOW, { ...OPTIONS, previous });
      expect(result.offlineLayers).toEqual(["exit"]);
      expect(result.members.map((node) => node.address)).toEqual(expect.arrayContaining(exitAddresses));
    });

    it("reports no offline layer while a layer has an online member", () => {
      const result = applyServedTopologies(pinned, two({ offline: exits.slice(1) }), NOW, OPTIONS);
      expect(result.offlineLayers).toEqual([]);
      expect(result.floorLayers).toEqual(["exit"]);
    });
  });

  it("never routes over ineligible pinned members", () => {
    const withFrozen = makePinned([{ role: 1 }, { role: 1, frozen: true }, { role: 1 }, { role: 2 }, { role: 2, status: 2 }]);
    const result = applyServedTopologies(withFrozen, [{ anchor: kpsAddressFor(1), snapshot: served(withFrozen, NOW) }], NOW, OPTIONS);
    expect(result.members.map((node) => node.address)).toEqual([
      memberAddress(1),
      memberAddress(3),
      memberAddress(4),
      memberAddress(5),
    ]);
  });
});

describe("routing nodes from the pinned set", () => {
  it("gives kps: entry endpoints only to allowed KPS-capable members, with capability hints", () => {
    const pinned = makePinned([
      { role: 1 },
      { role: 1, kps: false },
      { role: 1, capabilities: ["surb_v2"] },
      { role: 2, capabilities: ["surb_v2", "paid_v2"] },
    ]);
    const members = eligiblePinnedMembers(pinned);
    const relayers = applyServedTopologies(pinned, [], NOW, OPTIONS).members;
    expect(relayers).toHaveLength(members.length);
    const nodes = kpsTopologyNodes(pinned, relayers, new Set([kpsAddressFor(1), kpsAddressFor(4)]));
    expect(nodes.map((node) => node.address)).toEqual([
      `kps:${kpsAddressFor(1)}`,
      "",
      "",
      `kps:${kpsAddressFor(4)}`,
    ]);
    expect(nodes[3]?.capabilities).toEqual(["surb_v2", "paid_v2"]);
    expect(nodes[1]?.routingAddress).toBe(pinned.members[1]?.url);
    const unrestricted = kpsTopologyNodes(pinned, relayers);
    expect(unrestricted.filter((node) => node.address.startsWith("kps:"))).toHaveLength(3);
  });

  it("checks that a member set can form a route under the entry rule", () => {
    const pinned = makePinned();
    const relayers = applyServedTopologies(pinned, [], NOW, OPTIONS).members;
    expect(formsRoute(pinned, relayers)).toBe(true);
    expect(formsRoute(pinned, relayers, new Set())).toBe(false);
    expect(formsRoute(pinned, relayers.filter((node) => node.role === 1))).toBe(false);
  });

  it("takes the highest PoW difficulty, capped at 16", () => {
    const pinned = makePinned();
    expect(pinnedPowDifficulty(pinned, [])).toBe(1);
    expect(pinnedPowDifficulty(pinned, [served(pinned, NOW, { powDifficulty: 3 })])).toBe(3);
    expect(pinnedPowDifficulty(pinned, [served(pinned, NOW, { powDifficulty: 40 })])).toBe(16);
  });
});
