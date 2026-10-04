// Calibration of the planner's gas numbers against real history: replaying the mainnet WorkerSpecifier
// transactions of the passthrough and tor-js specifiers on a local anvil chain must use exactly the gas their
// mainnet receipts show. If the build settings, the ABI encoding or the measurement drift, these numbers move.
//
// Source of the expected values: Ethereum mainnet receipts and WorkerUpdated logs, read 2026-10-03
// (passthrough 0x4fd77be3…8d27, tor-js 0x700dA319…659e).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAnvil, type Anvil } from "../tools/anvil.ts";
import { loadArtifact, type Artifact } from "../tools/artifacts.ts";
import { creationCode, setWorkerCalldata } from "../tools/deployment.ts";
import { hexToBigInt, waitForReceipt } from "../tools/rpc.ts";

type Worker = { hash: string; resolvers: readonly string[] };

const TORJS_CERT = "uEiBHwUMNRTetrbqScahm81Di57Xv2OphNrx-CurJGOq3ww";
const torjsKps = (path: string): string[] => [
  `kps:170.64.236.147:12298:${TORJS_CERT}/keccak/${path}`,
  `kps:[2400:6180:10:200::cca4:4000]:12298:${TORJS_CERT}/keccak/${path}`,
];

const PASSTHROUGH_DEPLOY: Worker = {
  hash: "0x194f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d",
  resolvers: [
    "https://raw.githubusercontent.com/privacy-ethereum/anon-rpc/keccak/19/4f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d",
  ],
};

const TORJS_V041 = "0x2332139f37b1e2c7a9713509f2bc2b48c71e89c2a20822472706bfa0a7ba2f57";
const TORJS_V041_PATH = "23/32139f37b1e2c7a9713509f2bc2b48c71e89c2a20822472706bfa0a7ba2f57";
const TORJS_V042_PATH = "e8/919c53b89d2328b1de33aedf573cef194b1ac7d582342004a6b3362e7aad3e";

const TORJS_DEPLOY: Worker = {
  hash: TORJS_V041,
  resolvers: [
    "https://cdn.jsdelivr.net/npm/tor-js@0.4.1/dist/anon-rpc-worker.js",
    "https://unpkg.com/tor-js@0.4.1/dist/anon-rpc-worker.js",
  ],
};

const TORJS_ADD_RESOLVERS: Worker = {
  hash: TORJS_V041,
  resolvers: [
    ...TORJS_DEPLOY.resolvers,
    `https://raw.githubusercontent.com/privacy-ethereum/tor-js/keccak/${TORJS_V041_PATH}`,
    ...torjsKps(TORJS_V041_PATH),
  ],
};

const TORJS_V042: Worker = {
  hash: "0xe8919c53b89d2328b1de33aedf573cef194b1ac7d582342004a6b3362e7aad3e",
  resolvers: [
    "https://cdn.jsdelivr.net/npm/tor-js@0.4.2/dist/anon-rpc-worker.js",
    "https://unpkg.com/tor-js@0.4.2/dist/anon-rpc-worker.js",
    `https://raw.githubusercontent.com/ethereum/tor-js/keccak/${TORJS_V042_PATH}`,
    ...torjsKps(TORJS_V042_PATH),
  ],
};

let anvil: Anvil;
let reference: Artifact;
let sender: string;

async function gasUsed(tx: { to?: string; data: string }): Promise<{ gas: bigint; created: string | null }> {
  const hash = await anvil.rpc.request("eth_sendTransaction", [{ from: sender, ...tx }]);
  if (typeof hash !== "string") throw new Error(`eth_sendTransaction returned ${JSON.stringify(hash)}`);
  const receipt = await waitForReceipt(anvil.rpc, hash, 15_000);
  if (receipt["status"] !== "0x1") throw new Error(`transaction reverted: ${JSON.stringify(receipt)}`);
  const created = typeof receipt["contractAddress"] === "string" ? receipt["contractAddress"] : null;
  return { gas: hexToBigInt(receipt["gasUsed"], "gasUsed"), created };
}

beforeAll(async () => {
  reference = await loadArtifact("reference");
  anvil = await startAnvil({ startTimeoutMs: 30_000, rpcTimeoutMs: 15_000 });
  const accounts = await anvil.rpc.request("eth_accounts");
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("anvil has no unlocked account");
  sender = accounts[0];
});

afterAll(async () => {
  await anvil?.stop();
});

describe("gas measured locally equals the mainnet receipts", () => {
  it("passthrough deployment: 1,088,838 gas (tx 0x8c244923…c43b)", async () => {
    const { gas } = await gasUsed({
      data: creationCode(reference, PASSTHROUGH_DEPLOY.hash, PASSTHROUGH_DEPLOY.resolvers),
    });
    expect(gas).toBe(1_088_838n);
  });

  it("tor-js deployment and both setWorker updates: 1,113,503 / 478,453 / 152,782 gas", async () => {
    const deploy = await gasUsed({ data: creationCode(reference, TORJS_DEPLOY.hash, TORJS_DEPLOY.resolvers) });
    expect(deploy.gas).toBe(1_113_503n);
    if (deploy.created === null) throw new Error("tor-js replay: no contract address");
    const added = await gasUsed({
      to: deploy.created,
      data: setWorkerCalldata(TORJS_ADD_RESOLVERS.hash, TORJS_ADD_RESOLVERS.resolvers),
    });
    expect(added.gas).toBe(478_453n);
    const v042 = await gasUsed({ to: deploy.created, data: setWorkerCalldata(TORJS_V042.hash, TORJS_V042.resolvers) });
    expect(v042.gas).toBe(152_782n);
  });
});
