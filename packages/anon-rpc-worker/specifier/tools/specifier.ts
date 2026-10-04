// Read-only inspection of a deployed specifier: what a harness sees (through the harness's own reader), which
// contract the runtime code is, who can change it, and whether the code can write state at all.

import { getAddress, keccak256 } from "ethers";
import type { Artifact } from "./artifacts.ts";
import { MAINNET_REFERENCE_CODEHASH } from "./constants.ts";
import { decodeAddressWord, OWNER_CALLDATA } from "./deployment.ts";
import { CodeError, equalBytes, fillImmutables, hexToBytes, stateChangingOpcodes } from "./evm.ts";
import { readSpecifier } from "./harness.ts";
import { checkResolvers, DEFAULT_RESOLVER_POLICY, type ResolverReport } from "./resolvers.ts";
import { expectHex, harnessProvider, hexToBigInt, RpcError, toQuantity, type RpcClient } from "./rpc.ts";

export type ContractKind = "reference WorkerSpecifier" | "ImmutableWorkerSpecifier" | "unrecognized";

export type OwnerInfo =
  | { kind: "none" }
  | { kind: "renounced" }
  | { kind: "eoa"; address: string; delegatedTo: string | null }
  | { kind: "contract"; address: string; codehash: string }
  | { kind: "unreadable"; reason: string };

export type SpecifierInspection = {
  address: string;
  chainId: bigint;
  blockNumber: bigint;
  workerHash: string;
  resolvers: string[];
  runtimeBytes: number;
  runtimeCodehash: string;
  contract: ContractKind;
  owner: OwnerInfo;
  updatePolicy: string;
  /** Names of state-changing opcodes in the runtime code, or a parse failure note for foreign code. */
  stateChangingOpcodes: string[];
  resolverReport: ResolverReport;
};

export type KnownArtifacts = { reference: Artifact; immutable: Artifact };

export class InspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InspectionError";
  }
}

const EIP7702_PREFIX = "0xef0100";

async function readOwner(rpc: RpcClient, address: string, block: `0x${string}`): Promise<OwnerInfo> {
  let ret: `0x${string}`;
  try {
    ret = expectHex(await rpc.request("eth_call", [{ to: address, data: OWNER_CALLDATA }, block]), "owner()");
  } catch (e) {
    return { kind: "unreadable", reason: e instanceof Error ? e.message : String(e) };
  }
  const owner = decodeAddressWord(ret);
  if (BigInt(owner) === 0n) return { kind: "renounced" };
  const code = expectHex(await rpc.request("eth_getCode", [owner, block]), `eth_getCode(${owner})`);
  if (code === "0x") return { kind: "eoa", address: owner, delegatedTo: null };
  if (code.toLowerCase().startsWith(EIP7702_PREFIX) && code.length === 2 + 23 * 2) {
    return { kind: "eoa", address: owner, delegatedTo: getAddress(`0x${code.slice(8)}`) };
  }
  return { kind: "contract", address: owner, codehash: keccak256(code) };
}

function describePolicy(contract: ContractKind, owner: OwnerInfo, opcodes: readonly string[]): string {
  if (contract === "ImmutableWorkerSpecifier") {
    return "immutable: no owner and no setters; a new worker version ships at a new address";
  }
  if (contract === "reference WorkerSpecifier") {
    switch (owner.kind) {
      case "renounced":
        return "frozen: ownership renounced, workerHash() can never change";
      case "eoa":
        return `owner-updatable: EOA ${owner.address}${owner.delegatedTo === null ? "" : ` (EIP-7702 delegated to ${owner.delegatedTo})`} can repoint this address with setWorker()`;
      case "contract":
        return `owner-updatable through contract ${owner.address} (codehash ${owner.codehash}); its own rules (e.g. Safe threshold, timelock delay) govern setWorker()`;
      case "none":
      case "unreadable":
        return "owner-updatable reference contract, but owner() could not be read";
    }
  }
  return opcodes.length === 0
    ? "unrecognized contract whose runtime code cannot change state"
    : `unrecognized contract; its runtime code contains ${opcodes.join(", ")}, read its verified source`;
}

export async function inspectSpecifier(
  rpc: RpcClient,
  address: string,
  artifacts: KnownArtifacts,
): Promise<SpecifierInspection> {
  let checksummed: string;
  try {
    checksummed = getAddress(address);
  } catch {
    throw new InspectionError(`"${address}" is not an Ethereum address`);
  }
  const chainId = hexToBigInt(await rpc.request("eth_chainId"), "eth_chainId");
  const blockNumber = hexToBigInt(await rpc.request("eth_blockNumber"), "eth_blockNumber");
  const block = toQuantity(blockNumber);

  const code = expectHex(await rpc.request("eth_getCode", [checksummed, block]), "eth_getCode");
  if (code === "0x")
    throw new InspectionError(`no contract at ${checksummed} on chain ${chainId} (block ${blockNumber})`);

  // Exactly the two eth_calls and the decoding a wallet's harness performs (block tag "latest").
  let spec: { workerHash: string; resolvers: string[] };
  try {
    spec = await readSpecifier(harnessProvider(rpc), checksummed);
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new InspectionError(
      `the reference harness cannot read ${checksummed}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const runtime = hexToBytes(code);
  const runtimeCodehash = keccak256(code);
  let contract: ContractKind = "unrecognized";
  if (
    runtimeCodehash === MAINNET_REFERENCE_CODEHASH ||
    equalBytes(runtime, hexToBytes(artifacts.reference.deployedBytecode))
  ) {
    contract = "reference WorkerSpecifier";
  } else {
    const expected = fillImmutables(
      hexToBytes(artifacts.immutable.deployedBytecode),
      artifacts.immutable.immutableRanges,
      hexToBytes(spec.workerHash),
    );
    if (equalBytes(runtime, expected)) contract = "ImmutableWorkerSpecifier";
  }

  let opcodes: string[];
  try {
    opcodes = stateChangingOpcodes(runtime);
  } catch (e) {
    opcodes = [`<not solc output: ${e instanceof CodeError ? e.message : String(e)}>`];
  }

  const owner: OwnerInfo =
    contract === "ImmutableWorkerSpecifier" ? { kind: "none" } : await readOwner(rpc, checksummed, block);

  return {
    address: checksummed,
    chainId,
    blockNumber,
    workerHash: spec.workerHash,
    resolvers: spec.resolvers,
    runtimeBytes: runtime.length,
    runtimeCodehash,
    contract,
    owner,
    updatePolicy: describePolicy(contract, owner, opcodes),
    stateChangingOpcodes: opcodes,
    resolverReport: checkResolvers(spec.resolvers, spec.workerHash, {
      ...DEFAULT_RESOLVER_POLICY,
      allowUnknownKinds: true,
    }),
  };
}
