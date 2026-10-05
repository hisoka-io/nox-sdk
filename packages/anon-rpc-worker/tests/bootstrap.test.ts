/**
 * The committed discovery bootstrap (`snapshot/nox-bootstrap.json`): verifies
 * against the committed snapshot with the SDK's own verifier, names the three
 * default anchors on their Elastic IPs (D-21, D-22) and RPC providers of
 * different organisations, with the production policy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_POLICY_DEFAULTS,
  parseKpsAddress,
  rpcProviderKey,
  verifyBootstrap,
  type PinnedSnapshot,
} from "@hisoka-io/nox-client";
import { BOOTSTRAP_PATH, SNAPSHOT_PATH } from "../scripts/lib/paths.mjs";
import { canonicalJson } from "../scripts/lib/snapshot-format.mjs";

const text = readFileSync(BOOTSTRAP_PATH, "utf8");
const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as PinnedSnapshot;

describe("committed bootstrap", () => {
  it("is canonical JSON and verifies against the committed snapshot", () => {
    expect(canonicalJson(JSON.parse(text))).toBe(text);
    const bootstrap = verifyBootstrap(JSON.parse(text), snapshot);
    expect(bootstrap.chainId).toBe(421614);
    expect(bootstrap.registry).toBe("0xf7bff88a1412054a001dc4b8acbddad6f9b26cb6");
    expect(bootstrap.registryImpl).toBe("0x7285125cfdcb6337aaed2d56d4fe99f870ede2a2");
    expect(bootstrap.policy).toEqual(DISCOVERY_POLICY_DEFAULTS);
  });

  it("names nox-1, nox-2 and nox-8 on their Elastic IPs with their KPS certhashes", () => {
    const anchors = (JSON.parse(text) as { anchors: string[] }).anchors.map(parseKpsAddress);
    expect(anchors.map((anchor) => [anchor.host, anchor.port])).toEqual([
      ["100.56.0.72", 15005],
      ["3.232.137.146", 15005],
      ["18.215.18.61", 15005],
    ]);
    expect(anchors.map((anchor) => anchor.certhash)).toEqual([
      "uEiBVDwIs40bsslDkM-BYb2AOHw3PHe70_bj5U_09r7vdIQ",
      "uEiDGVPDwsQ96ri9T5WLR6jZov_9LW-gRAgs-DN9FyKuHuw",
      "uEiCStd3rfGTo0ts0lSUw5f22u93O3PLCZVWWQIv_MXHm7w",
    ]);
  });

  it("reads the registry from the official endpoint plus keyless providers of other organisations", () => {
    const urls = (JSON.parse(text) as { registryRpcUrls: string[] }).registryRpcUrls;
    // Checked 2026-10-05 through the live exits: `finalized`, EIP-1898 reads at that block, 20-call batches.
    expect(urls).toEqual(["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-testnet.api.pocket.network"]);
    expect(new Set(urls.map(rpcProviderKey)).size).toBe(urls.length);
    expect(urls.every((url) => url.startsWith("https://") && !/key|token/iu.test(url))).toBe(true);
  });
});
