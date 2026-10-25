import { describe, expect, it } from "vitest";
import { computeTopologyFingerprint } from "../src/topology.js";
import type { RelayerNode } from "../src/types.js";

/**
 * Live NoxRegistry members at Arbitrum Sepolia block 316,207,920 and the
 * registry's `topologyFingerprint()` at that block (the anon-rpc worker
 * snapshot). nox-wasm checks the same vector in `topology_fingerprint`.
 */
const LIVE_MEMBERS = [
  "0x03a42846c18b99c453a49d7fce69f336f865c48b",
  "0x074a13b271b73eb5c0c44e2037d035e7eef4a462",
  "0x1efa385556a6e8643df0033048ba1dd67ec43f93",
  "0x3e98ee4572741fd932e031ac60e79f7c012758be",
  "0x6774ca4baf6fff84f02898a3dee4299ed1f5ab4e",
  "0x74486dc1ac551e5cd3f4eef80727cc9d50d3abe9",
  "0x862d6b1105bde9d64dc5182fe3cd9d09f6f37463",
  "0x8c9fb3e9fe537067c8430480f80a4a5b9a12be1a",
  "0xbeb31ac0c57b3765cb855fa02081eadb9edb2426",
  "0xf8681a0acb60effcd9c169226e6f9c1ae9dd7894",
];
const LIVE_FINGERPRINT = "14ca3b69d6defe50fe55b6d332e6c9734db74f460ce5a8ac280c651724147c75";

function nodes(addresses: readonly string[]): RelayerNode[] {
  return addresses.map((address) => ({
    address,
    sphinx_key: "00".repeat(32),
    url: "",
    stake: "0",
    last_seen: 0,
    is_privileged: false,
    layer: 0,
    role: 1,
  }));
}

describe("computeTopologyFingerprint golden vectors", () => {
  it("equals the registry fingerprint of the live members", () => {
    expect(computeTopologyFingerprint(nodes(LIVE_MEMBERS))).toBe(LIVE_FINGERPRINT);
    expect(computeTopologyFingerprint(nodes(LIVE_MEMBERS.map((a) => a.toUpperCase().replace("0X", "0x"))))).toBe(
      LIVE_FINGERPRINT,
    );
  });

  it("matches the two-address vector shared with nox-wasm", () => {
    const pair = ["0x1234567890abcdef1234567890abcdef12345678", "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"];
    expect(computeTopologyFingerprint(nodes(pair))).toBe(
      "4ef26622b39ecd0690c95f5f4c4041c6b3abd01f375c52ae08f3036b798cd11b",
    );
    expect(computeTopologyFingerprint(nodes([pair[0]!, pair[0]!]))).toBe("00".repeat(32));
  });
});
