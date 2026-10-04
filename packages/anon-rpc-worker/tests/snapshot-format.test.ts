import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SNAPSHOT_PATH } from "../scripts/lib/paths.mjs";
import {
  canonicalJson,
  loadSnapshotSchema,
  MEMBER_KEYS,
  type NoxAnonRpcSnapshot,
  serializeSnapshot,
  SNAPSHOT_FORMAT,
  SNAPSHOT_KEYS,
  SNAPSHOT_LIMITS,
  validateSnapshotDocument,
} from "../scripts/lib/snapshot-format.mjs";
import { main as verifySnapshot } from "../scripts/verify-snapshot.mjs";

const committedText = readFileSync(SNAPSHOT_PATH, "utf8");

function fresh(): NoxAnonRpcSnapshot {
  return JSON.parse(committedText) as NoxAnonRpcSnapshot;
}

function problemsOf(doc: unknown): string {
  try {
    validateSnapshotDocument(doc);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("the committed snapshot", () => {
  it("is valid, canonical and of the live registry", () => {
    const snapshot = validateSnapshotDocument(fresh());
    expect(serializeSnapshot(snapshot)).toBe(committedText);
    expect(snapshot.format).toBe(SNAPSHOT_FORMAT);
    expect(snapshot.chainId).toBe(421614);
    expect(snapshot.registry).toBe("0xf7bff88a1412054a001dc4b8acbddad6f9b26cb6");
    expect(snapshot.relayerCount).toBe(10);
    expect(snapshot.fingerprint).toBe("14ca3b69d6defe50fe55b6d332e6c9734db74f460ce5a8ac280c651724147c75");
  });

  it("passes the offline verifier", async () => {
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try {
      expect(await verifySnapshot(["--offline"])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
  });
});

describe("the JSON Schema file", () => {
  it("lists the same keys and bounds as the validator", () => {
    const schema = loadSnapshotSchema() as {
      required: string[];
      properties: Record<string, { maximum?: number; maxItems?: number }>;
      $defs: { member: { required: string[]; properties: Record<string, { maxLength?: number; maxItems?: number; items?: { maxLength?: number } }> } };
    };
    expect(schema.required).toEqual([...SNAPSHOT_KEYS]);
    expect(Object.keys(schema.properties)).toEqual([...SNAPSHOT_KEYS]);
    expect(schema.$defs.member.required).toEqual([...MEMBER_KEYS]);
    expect(Object.keys(schema.$defs.member.properties)).toEqual([...MEMBER_KEYS]);
    expect(schema.properties["members"]?.maxItems).toBe(SNAPSHOT_LIMITS.maxMembers);
    expect(schema.properties["relayerCount"]?.maximum).toBe(SNAPSHOT_LIMITS.maxMembers);
    expect(schema.properties["powDifficulty"]?.maximum).toBe(SNAPSHOT_LIMITS.maxPowDifficulty);
    expect(schema.$defs.member.properties["url"]?.maxLength).toBe(SNAPSHOT_LIMITS.maxUrlLength);
    expect(schema.$defs.member.properties["capabilities"]?.maxItems).toBe(SNAPSHOT_LIMITS.maxCapabilities);
    expect(schema.$defs.member.properties["capabilities"]?.items?.maxLength).toBe(SNAPSHOT_LIMITS.maxCapabilityLength);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and ends with one newline", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: "x" } })).toBe(
      '{\n  "a": {\n    "c": "x",\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });
});

describe("validateSnapshotDocument", () => {
  const address = fresh().members[3]?.address ?? "";

  it.each<[string, (doc: NoxAnonRpcSnapshot & Record<string, unknown>) => void, RegExp]>([
    ["an unknown top-level field", (doc) => { doc["generatedAt"] = "2026-10-04"; }, /snapshot has unknown field "generatedAt"/u],
    ["a missing field", (doc) => { delete (doc as Partial<NoxAnonRpcSnapshot>).blockHash; }, /snapshot is missing "blockHash"/u],
    ["another format", (doc) => { (doc as { format: string }).format = "nox-registry-snapshot/1"; }, /format must be/u],
    ["an uppercase registry", (doc) => { doc.registry = doc.registry.toUpperCase().replace("0X", "0x"); }, /registry must be a lowercase 0x address/u],
    ["a 0x fingerprint", (doc) => { doc.fingerprint = `0x${doc.fingerprint.slice(2)}`; }, /fingerprint must be 64 lowercase hex/u],
    ["a PoW difficulty out of range", (doc) => { doc.powDifficulty = 17; }, /powDifficulty must be an integer in 0..16/u],
    ["a member role out of range", (doc) => { (doc.members[3] as { role: number }).role = 4; }, new RegExp(`members\\[3\\] \\(${address}\\)\\.role must be 1, 2 or 3`, "u")],
    ["a member with an extra field", (doc) => { (doc.members[3] as unknown as Record<string, unknown>)["kps"] = null; }, new RegExp(`members\\[3\\] \\(${address}\\) has unknown field "kps"`, "u")],
    ["a duplicate capability", (doc) => { (doc.members[3] as { capabilities: string[] }).capabilities = ["surb_v2", "surb_v2"]; }, /capabilities must be at most 32 unique strings/u],
    ["unsorted capabilities", (doc) => { (doc.members[0] as { capabilities: string[] }).capabilities = ["surb_v2", "paid_v2"]; }, /capabilities must be sorted/u],
    ["a wrong relayer count", (doc) => { doc.relayerCount = 9; }, /relayerCount 9 differs from the 10 members/u],
    ["members out of order", (doc) => { doc.members.reverse(); }, /not in strictly ascending address order/u],
    ["a fingerprint the SDK does not compute", (doc) => { doc.fingerprint = "00".repeat(32); }, /differs from the SDK fingerprint/u],
    ["a layer the SDK does not assign", (doc) => {
      const member = doc.members.find((entry) => entry.role === 2);
      if (member !== undefined) member.layer = 0;
    }, /the SDK assigns layer 2/u],
  ])("rejects %s, naming the field", (_label, mutate, expected) => {
    const doc = fresh() as NoxAnonRpcSnapshot & Record<string, unknown>;
    mutate(doc);
    expect(problemsOf(doc)).toMatch(expected);
  });
});
