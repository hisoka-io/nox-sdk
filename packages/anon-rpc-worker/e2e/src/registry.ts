// A real NoxRegistry on the upstream anvil chain (TEST-PLAN chain bed, folded
// into bed L): deployed behind an ERC1967 proxy before the mesh starts, so every
// node's chain observer follows it, then filled with the mesh's own nodes
// (`registerPrivileged`, the bootstrap path the fleet uses) once each node's
// nox-kps address is known. The worker's snapshot is then generated from this
// registry by the release tooling (`scripts/make-snapshot.mjs`), and the nodes
// serve `/topology` documents at the observed block with the same profiles.

import { decodeBytes32, encodeArgs, encodeCall, selector } from "./abi.js";
import { TestbedError } from "./errors.js";
import { expectHex, jsonRpc } from "./jsonrpc.js";
import { delay } from "./process.js";
import { deployContract, loadArtifact, sendTransaction } from "./tx.js";

/** NoxRegistry.MIN_UNSTAKE_DELAY (1 day); `initialize` refuses less. */
const UNSTAKE_DELAY_SECS = 86_400;
/** Smallest stake values `initialize` accepts; the bed registers privileged (zero-stake) members only. */
const MIN_STAKE = 1;
const TOPOLOGY_POLL_MS = 250;
const TOPOLOGY_FETCH_TIMEOUT_MS = 2_000;

export interface LocalRegistry {
  /** Proxy address (lowercase), the address nodes, snapshot and SDK use. */
  readonly address: string;
  readonly implementation: string;
  readonly chainId: number;
  /** Block of the proxy deployment (the snapshot's log scan starts here). */
  readonly deployBlock: number;
  /** Unlocked anvil account holding every registry role. */
  readonly admin: string;
}

export interface RegistryMember {
  readonly address: string;
  /** 64 hex, with or without 0x. */
  readonly sphinxKey: string;
  /** libp2p multiaddr. */
  readonly url: string;
  readonly ingressUrl: string;
  readonly metadataUrl: string;
  readonly role: 1 | 2 | 3;
}

/** Deploy the NoxRegistry implementation and an initialised ERC1967 proxy in front of it. */
export async function deployLocalRegistry(rpcUrl: string, admin: string, chainId: number): Promise<LocalRegistry> {
  const implementation = await deployContract(rpcUrl, admin, loadArtifact("NoxRegistry"));
  const init = encodeCall(
    "initialize((uint48,address,address,uint256,uint256,uint256,address,address,address))",
    [
      { type: "uint", value: 0 }, // initialAdminDelay
      { type: "address", value: admin }, // initialAdmin
      // registerPrivileged never moves tokens; any non-zero address satisfies the check.
      { type: "address", value: admin }, // stakingToken
      { type: "uint", value: MIN_STAKE }, // minStake
      { type: "uint", value: UNSTAKE_DELAY_SECS }, // unstakeDelay
      { type: "uint", value: MIN_STAKE }, // minStakeFloor
      { type: "address", value: admin }, // slasher
      { type: "address", value: admin }, // configManager
      { type: "address", value: admin }, // upgrader
    ],
  );
  const proxyArgs = encodeArgs([
    { type: "address", value: implementation },
    { type: "bytes", value: init },
  ]);
  const proxyArtifact = loadArtifact("ERC1967Proxy");
  const deploy = await sendTransaction(
    rpcUrl,
    { from: admin, data: proxyArtifact.bytecode + proxyArgs.slice(2) },
    "deploy NoxRegistry proxy",
  );
  if (deploy.contractAddress === undefined) {
    throw new TestbedError("rpc", `NoxRegistry proxy deployment ${deploy.transactionHash} has no contractAddress`);
  }
  const address = deploy.contractAddress.toLowerCase();
  const count = await relayerCount(rpcUrl, address);
  if (count !== 0n) throw new TestbedError("rpc", `fresh NoxRegistry at ${address} reports ${count} relayers`);
  return { address, implementation, chainId, deployBlock: deploy.blockNumber, admin };
}

export async function relayerCount(rpcUrl: string, registry: string): Promise<bigint> {
  const ret = expectHex(
    await jsonRpc(rpcUrl, "eth_call", [{ to: registry, data: selector("relayerCount()") }, "latest"]),
    "relayerCount()",
  );
  return BigInt(ret === "0x" ? 0 : ret);
}

export async function topologyFingerprint(rpcUrl: string, registry: string): Promise<string> {
  const ret = expectHex(
    await jsonRpc(rpcUrl, "eth_call", [{ to: registry, data: selector("topologyFingerprint()") }, "latest"]),
    "topologyFingerprint()",
  );
  return decodeBytes32(ret).slice(2);
}

/** `registerPrivileged` one member from the admin; returns the block. */
export async function registerMember(rpcUrl: string, registry: LocalRegistry, member: RegistryMember): Promise<number> {
  const key = member.sphinxKey.startsWith("0x") ? member.sphinxKey : `0x${member.sphinxKey}`;
  const data = encodeCall("registerPrivileged(address,bytes32,string,string,string,uint8)", [
    { type: "address", value: member.address },
    { type: "bytes32", value: key },
    { type: "string", value: member.url },
    { type: "string", value: member.ingressUrl },
    { type: "string", value: member.metadataUrl },
    { type: "uint", value: member.role },
  ]);
  const receipt = await sendTransaction(
    rpcUrl,
    { from: registry.admin, to: registry.address, data },
    `registerPrivileged(${member.address})`,
  );
  return receipt.blockNumber;
}

/** `registerPrivileged` every member from the admin; returns the block of the last registration. */
export async function registerMembers(
  rpcUrl: string,
  registry: LocalRegistry,
  members: readonly RegistryMember[],
): Promise<number> {
  let last = registry.deployBlock;
  for (const member of members) {
    last = Math.max(last, await registerMember(rpcUrl, registry, member));
  }
  const count = await relayerCount(rpcUrl, registry.address);
  if (count !== BigInt(members.length)) {
    throw new TestbedError("rpc", `NoxRegistry ${registry.address} has ${count} relayers after registering ${members.length}`);
  }
  return last;
}

interface ServedNode {
  readonly address?: unknown;
  readonly metadata_url?: unknown;
}

/**
 * Wait until every topology URL serves a document observed at `minBlock` or
 * later in which each member carries its registry metadataUrl.
 */
export async function waitForServedRegistry(
  topologyUrls: readonly string[],
  members: readonly RegistryMember[],
  minBlock: number,
  timeoutMs: number,
): Promise<void> {
  const want = new Map(members.map((member) => [member.address.toLowerCase(), member.metadataUrl]));
  const deadline = Date.now() + timeoutMs;
  for (const url of topologyUrls) {
    let last = "no reply yet";
    for (;;) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(TOPOLOGY_FETCH_TIMEOUT_MS) });
        const doc = (await response.json()) as { block_number?: unknown; nodes?: readonly ServedNode[] };
        const block = typeof doc.block_number === "number" ? doc.block_number : 0;
        const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
        const stale = [...want].filter(([address, metadata]) =>
          !nodes.some((node) => String(node.address).toLowerCase() === address && (node.metadata_url ?? "") === metadata)
        );
        if (block >= minBlock && stale.length === 0) break;
        last = `block ${block} (want >= ${minBlock}), ${stale.length} member(s) without their registry metadataUrl`;
      } catch (error) {
        last = String(error);
      }
      if (Date.now() > deadline) {
        throw new TestbedError("timeout", `${url} did not serve the registry topology within ${timeoutMs} ms: ${last}`);
      }
      await delay(TOPOLOGY_POLL_MS);
    }
  }
}

/** Balance given to an impersonated member so it can pay for its own transactions (100 ETH). */
const MEMBER_GAS_BALANCE = `0x${(100n * 10n ** 18n).toString(16)}`;

/**
 * Send a transaction as `member` (anvil impersonation): the registry's
 * self-service calls (`updateUrl`, `updateMetadataUrl`) must come from the
 * node's own key, which the mesh's synthetic addresses do not have.
 */
async function sendAsMember(rpcUrl: string, member: string, to: string, data: string, what: string): Promise<number> {
  await jsonRpc(rpcUrl, "anvil_setBalance", [member, MEMBER_GAS_BALANCE]);
  await jsonRpc(rpcUrl, "anvil_impersonateAccount", [member]);
  try {
    return (await sendTransaction(rpcUrl, { from: member, to, data }, what)).blockNumber;
  } finally {
    await jsonRpc(rpcUrl, "anvil_stopImpersonatingAccount", [member]);
  }
}

/** `updateMetadataUrl(metadataUrl)` from the member's own address (an operator moving its KPS endpoint). */
export async function updateMetadataUrl(rpcUrl: string, registry: string, member: string, metadataUrl: string): Promise<number> {
  const data = encodeCall("updateMetadataUrl(string)", [{ type: "string", value: metadataUrl }]);
  return sendAsMember(rpcUrl, member, registry, data, `updateMetadataUrl(${member})`);
}

/** `forceUnregister(member)` from the registry admin; returns the block. */
export async function forceUnregister(rpcUrl: string, registry: LocalRegistry, member: string): Promise<number> {
  const data = encodeCall("forceUnregister(address)", [{ type: "address", value: member }]);
  const receipt = await sendTransaction(rpcUrl, { from: registry.admin, to: registry.address, data }, `forceUnregister(${member})`);
  return receipt.blockNumber;
}

/** Member profiles each topology URL serves, keyed by lowercase address, once every URL serves at or after `minBlock`. */
export async function waitForServedState(
  topologyUrls: readonly string[],
  minBlock: number,
  timeoutMs: number,
  accept: (nodes: ReadonlyMap<string, { readonly metadataUrl: string }>) => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const url of topologyUrls) {
    let last = "no reply yet";
    for (;;) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(TOPOLOGY_FETCH_TIMEOUT_MS) });
        const doc = (await response.json()) as { block_number?: unknown; nodes?: readonly ServedNode[] };
        const block = typeof doc.block_number === "number" ? doc.block_number : 0;
        const nodes = new Map((Array.isArray(doc.nodes) ? doc.nodes : []).map((node) => [
          String(node.address).toLowerCase(),
          { metadataUrl: typeof node.metadata_url === "string" ? node.metadata_url : "" },
        ]));
        if (block >= minBlock && accept(nodes)) break;
        last = `block ${block} (want >= ${minBlock}), ${nodes.size} member(s), state not reached yet`;
      } catch (error) {
        last = String(error);
      }
      if (Date.now() > deadline) {
        throw new TestbedError("timeout", `${url} did not serve the expected registry state within ${timeoutMs} ms: ${last}`);
      }
      await delay(TOPOLOGY_POLL_MS);
    }
  }
}
