// The local NoxRegistry and log fixture against a real anvil (skipped when
// anvil is not on PATH): deployment behind the proxy, privileged registration,
// the on-chain fingerprint, and eth_getLogs sizes.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, keccakHex } from "../../src/abi.js";
import { mineBlocks, startAnvil, type AnvilChain } from "../../src/anvil.js";
import { deployLogFixture } from "../../src/chain-fixture.js";
import { loadConfig } from "../../src/config.js";
import { TestbedError } from "../../src/errors.js";
import { jsonRpc } from "../../src/jsonrpc.js";
import {
  deployLocalRegistry,
  forceUnregister,
  registerMember,
  registerMembers,
  relayerCount,
  topologyFingerprint,
  updateMetadataUrl,
  type RegistryMember,
} from "../../src/registry.js";
import { startRpcForwarder } from "../../src/rpc-forwarder.js";
import { encodeCall } from "../../src/abi.js";

const config = loadConfig();
const hasAnvil = spawnSync(config.anvil.bin, ["--version"], { stdio: "ignore" }).status === 0;

function member(id: number, metadataUrl: string): RegistryMember {
  return {
    address: `0x${(0xb0_0000 + id).toString(16).padStart(40, "0")}`,
    sphinxKey: `${(id + 1).toString(16).padStart(2, "0")}${"ab".repeat(31)}`,
    url: `/ip4/127.0.0.1/tcp/${27_000 + 10 * id}/p2p/12D3KooWEAZ7G2SyC6aFP3KdJ6Hbaets1sW7biY6P3u3oN77CRMK`,
    ingressUrl: `http://127.0.0.1:${27_002 + 10 * id}`,
    metadataUrl,
    role: id === 1 ? 2 : 1,
  };
}

/** XOR of keccak256(address bytes), as NoxRegistry._xorAddressIntoFingerprint computes it. */
function expectedFingerprint(addresses: readonly string[]): string {
  const out = new Uint8Array(32);
  for (const address of addresses) {
    hexToBytes(keccakHex(hexToBytes(address))).forEach((byte, i) => {
      out[i] = (out[i] ?? 0) ^ byte;
    });
  }
  return bytesToHex(out);
}

describe.skipIf(!hasAnvil)("local NoxRegistry on anvil", () => {
  let chain: AnvilChain;

  beforeAll(async () => {
    chain = await startAnvil(config.anvil, {
      label: "unit-registry",
      chainId: 31_337,
      logDir: mkdtempSync(join(tmpdir(), "e2e-registry-")),
      slotsInAnEpoch: 1,
    });
  });

  afterAll(async () => {
    await chain.stop();
  });

  it("deploys behind the proxy, registers members and matches the fingerprint", async () => {
    const registry = await deployLocalRegistry(chain.url, chain.account, chain.chainId);
    expect(registry.address).toMatch(/^0x[0-9a-f]{40}$/u);
    expect(registry.address).not.toBe(registry.implementation);
    const members = [member(0, "kps:127.0.0.1:27005:uEiA/metadata.json"), member(1, "")];
    const block = await registerMembers(chain.url, registry, members);
    expect(block).toBeGreaterThan(registry.deployBlock);
    expect(await relayerCount(chain.url, registry.address)).toBe(2n);
    expect(await topologyFingerprint(chain.url, registry.address)).toBe(expectedFingerprint(members.map((m) => m.address)));
    // A second registration of the same member reverts (AlreadyRegistered).
    await expect(registerMembers(chain.url, registry, [members[0]!])).rejects.toThrow(TestbedError);
  });

  it("lets a member move its KPS address itself, and the admin remove and re-register it", async () => {
    const registry = await deployLocalRegistry(chain.url, chain.account, chain.chainId);
    const members = [member(0, "kps:127.0.0.1:27005:uEiA/metadata.json"), member(1, "")];
    await registerMembers(chain.url, registry, members);
    const moved = "kps:127.0.0.1:28005:uEiA/metadata.json";
    await updateMetadataUrl(chain.url, registry.address, members[0]!.address, moved);
    const profile = String(await jsonRpc(chain.url, "eth_call", [
      { to: registry.address, data: encodeCall("relayers(address)", [{ type: "address", value: members[0]!.address }]) },
      "latest",
    ]));
    expect(Buffer.from(profile.slice(2), "hex").toString("latin1")).toContain(moved);
    await forceUnregister(chain.url, registry, members[1]!.address);
    expect(await relayerCount(chain.url, registry.address)).toBe(1n);
    await registerMember(chain.url, registry, members[1]!);
    expect(await relayerCount(chain.url, registry.address)).toBe(2n);
    expect(await topologyFingerprint(chain.url, registry.address)).toBe(expectedFingerprint(members.map((m) => m.address)));
  });

  it("keeps finalized two blocks behind latest, and the forwarder serves the same chain", async () => {
    await mineBlocks(chain.url, 5);
    const latest = Number.parseInt(String(await jsonRpc(chain.url, "eth_blockNumber")), 16);
    const finalized = (await jsonRpc(chain.url, "eth_getBlockByNumber", ["finalized", false])) as { number: string; hash: string };
    expect(Number.parseInt(finalized.number, 16)).toBe(latest - 2);
    const forwarder = await startRpcForwarder(chain.url);
    try {
      const viaForwarder = (await jsonRpc(forwarder.url, "eth_getBlockByNumber", ["finalized", false])) as { hash: string };
      expect(viaForwarder.hash).toBe(finalized.hash);
      expect(forwarder.forwarded()).toBe(1);
    } finally {
      await forwarder.close();
    }
  });

  it("emits Ping and Blob logs of the requested size", async () => {
    const fixture = await deployLogFixture(chain.url, chain.account, { pings: 2, blobsPerTx: 2, blobTxs: 1, blobBytes: 1_000 });
    const logs = (await jsonRpc(chain.url, "eth_getLogs", [{
      address: fixture.emitter,
      fromBlock: `0x${fixture.blobs.fromBlock.toString(16)}`,
      toBlock: `0x${fixture.blobs.toBlock.toString(16)}`,
    }])) as { data: string }[];
    expect(logs).toHaveLength(2);
    // ABI bytes: offset word, length word, 1,000 bytes padded to 1,024.
    expect((logs[0]!.data.length - 2) / 2).toBe(32 + 32 + 1_024);
    expect(fixture.pings.count).toBe(2);
    expect(fixture.pings.toBlock).toBeLessThan(fixture.blobs.fromBlock);
  });
});
