// Transaction payloads for publishing a specifier: creation code with ABI-encoded constructor arguments, and the
// owner calls of the reference contract. Encoding uses ethers' AbiCoder; the integration tests decode the result
// through the reference harness after deploying it.

import { AbiCoder, Interface, getAddress, keccak256 } from "ethers";
import type { Artifact } from "./artifacts.ts";

export const ZERO_HASH = `0x${"00".repeat(32)}`;

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

const REFERENCE_OWNER_ABI = new Interface([
  "function setWorker(bytes32 workerHash_, string[] workerResolvers_)",
  "function transferOwnership(address newOwner)",
  "function renounceOwnership()",
  "function owner() view returns (address)",
]);

export function normalizeHash(value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new PayloadError(`worker hash must be 32 bytes of hex, got "${value}"`);
  const hash = value.toLowerCase() as `0x${string}`;
  if (hash === ZERO_HASH) throw new PayloadError("worker hash is zero; no bundle hashes to zero");
  return hash;
}

export function constructorArguments(workerHash: string, resolvers: readonly string[]): `0x${string}` {
  return AbiCoder.defaultAbiCoder().encode(["bytes32", "string[]"], [workerHash, resolvers]) as `0x${string}`;
}

/** Creation code for a deployment transaction: the contract's bytecode followed by its constructor arguments. */
export function creationCode(artifact: Artifact, workerHash: string, resolvers: readonly string[]): `0x${string}` {
  return `${artifact.bytecode}${constructorArguments(workerHash, resolvers).slice(2)}`;
}

export function codeKeccak(code: string): `0x${string}` {
  return keccak256(code) as `0x${string}`;
}

export function setWorkerCalldata(workerHash: string, resolvers: readonly string[]): `0x${string}` {
  return REFERENCE_OWNER_ABI.encodeFunctionData("setWorker", [workerHash, resolvers]) as `0x${string}`;
}

export function transferOwnershipCalldata(newOwner: string): `0x${string}` {
  return REFERENCE_OWNER_ABI.encodeFunctionData("transferOwnership", [getAddress(newOwner)]) as `0x${string}`;
}

export function renounceOwnershipCalldata(): `0x${string}` {
  return REFERENCE_OWNER_ABI.encodeFunctionData("renounceOwnership", []) as `0x${string}`;
}

export const OWNER_CALLDATA = REFERENCE_OWNER_ABI.encodeFunctionData("owner", []) as `0x${string}`;

export function decodeAddressWord(ret: string): `0x${string}` {
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(ret)) {
    throw new PayloadError(`expected one ABI-encoded address word, got ${ret.slice(0, 80)}`);
  }
  return getAddress(`0x${ret.slice(26)}`) as `0x${string}`;
}
