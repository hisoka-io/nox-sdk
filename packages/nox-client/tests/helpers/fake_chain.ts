/**
 * A NoxRegistry behind an EIP-1967 proxy on a fake chain that answers the
 * JSON-RPC calls the S1 chain check sends (single calls and batches):
 * `eth_getBlockByNumber("finalized")`, `eth_getBlockByHash`, `eth_chainId`,
 * `eth_getStorageAt` (implementation slot), `eth_call` (`relayerCount`,
 * `topologyFingerprint`, `relayers`, `getNodeRole`) and `eth_getLogs`
 * (registration events). Members and the block move under test control, and
 * `tamper` lets one provider lie.
 */
import { AbiCoder, Interface, keccak256 } from "ethers";
import { computeTopologyFingerprint } from "../../src/topology.js";
import { EIP1967_IMPLEMENTATION_SLOT, REGISTRATION_TOPICS } from "../../src/kps/discovery.js";
import type { PinnedMember, PinnedSnapshot } from "../../src/types.js";

const REGISTRY = new Interface([
  "function topologyFingerprint() view returns (bytes32)",
  "function relayerCount() view returns (uint256)",
  "function relayers(address) view returns (bytes32 sphinxKey,string url,string ingressUrl,string metadataUrl,uint256 stakedAmount,uint256 unlockTime,bool isRegistered,uint8 status,bool frozen)",
  "function getNodeRole(address) view returns (uint8)",
]);

export const REGISTRY_IMPL = "0x7285125cfdcb6337aaed2d56d4fe99f870ede2a2";

/** One clock for every fake chain in a test run, so two chains at the same height describe the same block. */
const EPOCH = Math.floor(Date.now() / 1000) - 60;

export interface ChainMember {
  address: string;
  sphinxKey: string;
  url: string;
  ingressUrl: string;
  metadataUrl: string;
  stake: string;
  role: number;
  status: number;
  frozen: boolean;
  /** Block of the registration event. */
  registeredAt: number;
}

interface RpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

export class FakeRegistryChain {
  readonly members = new Map<string, ChainMember>();
  chainId: number;
  implementation = REGISTRY_IMPL;
  blockNumber: number;
  /** Explicit timestamp; default: one second per block from the shared epoch. */
  private timestampOverride: number | undefined;
  private readonly baseBlock: number;
  /** Requests seen, by method. */
  readonly calls: string[] = [];
  /** Rewrite one result before it is sent (lying provider). */
  tamper: ((method: string, params: unknown[], result: unknown) => unknown) | undefined;
  /** Answer this method with a JSON-RPC error. */
  failMethod: string | undefined;
  /** Leave relayerCount at this value regardless of members (hidden member tests). */
  countOverride: number | undefined;
  /** Largest batch answered; a larger one gets one JSON-RPC error object (as Tenderly's gateway answers 429). */
  maxBatch: number | undefined;

  constructor(
    pinned: PinnedSnapshot,
    readonly registry = pinned.registry,
  ) {
    this.chainId = pinned.chainId;
    this.blockNumber = pinned.blockNumber + 100;
    this.baseBlock = this.blockNumber;
    for (const member of pinned.members) this.put(member, pinned.blockNumber - 1);
  }

  /** Register or update a member (profile fields as in the snapshot). */
  put(member: PinnedMember | ChainMember, registeredAt = this.blockNumber): void {
    this.members.set(member.address, {
      address: member.address,
      sphinxKey: member.sphinxKey,
      url: member.url,
      ingressUrl: member.ingressUrl,
      metadataUrl: member.metadataUrl,
      stake: member.stake,
      role: member.role,
      status: member.status,
      frozen: member.frozen,
      registeredAt: "registeredAt" in member ? member.registeredAt : registeredAt,
    });
  }

  remove(address: string): void {
    this.members.delete(address);
  }

  update(address: string, change: Partial<ChainMember>): void {
    const member = this.members.get(address);
    if (member === undefined) throw new Error(`no member ${address}`);
    this.members.set(address, { ...member, ...change });
  }

  get blockTimestamp(): number {
    return this.timestampOverride ?? EPOCH + (this.blockNumber - this.baseBlock);
  }

  set blockTimestamp(value: number) {
    this.timestampOverride = value;
  }

  /** Move the finalized head forward. */
  advance(blocks = 10): void {
    this.blockNumber += blocks;
  }

  get blockHash(): string {
    return keccak256(new TextEncoder().encode(`block-${this.blockNumber}`));
  }

  fingerprint(): string {
    return computeTopologyFingerprint([...this.members.values()].map((member) => ({
      address: member.address,
      sphinx_key: member.sphinxKey,
      url: member.url,
      stake: member.stake,
      last_seen: 0,
      is_privileged: true,
      layer: 0,
      role: member.role,
    })));
  }

  /** Answer one JSON-RPC body (object or batch). */
  answer(body: string): string {
    const parsed = JSON.parse(body) as RpcRequest | RpcRequest[];
    if (Array.isArray(parsed) && this.maxBatch !== undefined && parsed.length > this.maxBatch) {
      return JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } });
    }
    if (Array.isArray(parsed)) return JSON.stringify(parsed.map((request) => this.one(request)));
    return JSON.stringify(this.one(parsed));
  }

  private one(request: RpcRequest): Record<string, unknown> {
    this.calls.push(request.method);
    if (request.method === this.failMethod) {
      return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "historical state is not available" } };
    }
    let result = this.result(request);
    if (this.tamper !== undefined) result = this.tamper(request.method, request.params, result);
    return { jsonrpc: "2.0", id: request.id, result };
  }

  private block(): Record<string, unknown> {
    return {
      hash: this.blockHash,
      number: `0x${this.blockNumber.toString(16)}`,
      timestamp: `0x${this.blockTimestamp.toString(16)}`,
      parentHash: `0x${"00".repeat(32)}`,
      l1BlockNumber: "0x1",
    };
  }

  private result(request: RpcRequest): unknown {
    switch (request.method) {
      case "eth_getBlockByNumber":
        return this.block();
      case "eth_getBlockByHash":
        return request.params[0] === this.blockHash ? this.block() : null;
      case "eth_chainId":
        return `0x${this.chainId.toString(16)}`;
      case "eth_getStorageAt": {
        if (request.params[1] !== EIP1967_IMPLEMENTATION_SLOT) return `0x${"00".repeat(32)}`;
        return `0x${"00".repeat(12)}${this.implementation.slice(2)}`;
      }
      case "eth_call":
        return this.call((request.params[0] as { data: string }).data);
      case "eth_getLogs":
        return this.logs(request.params[0] as { fromBlock: string; toBlock: string });
      default:
        throw new Error(`fake chain: unexpected method ${request.method}`);
    }
  }

  private call(data: string): string {
    const parsed = REGISTRY.parseTransaction({ data });
    if (parsed === null) throw new Error("fake chain: unknown call");
    switch (parsed.name) {
      case "relayerCount":
        return REGISTRY.encodeFunctionResult("relayerCount", [this.countOverride ?? this.members.size]);
      case "topologyFingerprint":
        return REGISTRY.encodeFunctionResult("topologyFingerprint", [`0x${this.fingerprint()}`]);
      case "relayers": {
        const member = this.members.get(String(parsed.args[0]).toLowerCase());
        if (member === undefined) {
          return REGISTRY.encodeFunctionResult("relayers", [`0x${"00".repeat(32)}`, "", "", "", 0, 0, false, 0, false]);
        }
        return REGISTRY.encodeFunctionResult("relayers", [
          `0x${member.sphinxKey}`,
          member.url,
          member.ingressUrl,
          member.metadataUrl,
          BigInt(member.stake),
          0,
          true,
          member.status,
          member.frozen,
        ]);
      }
      case "getNodeRole": {
        const member = this.members.get(String(parsed.args[0]).toLowerCase());
        return REGISTRY.encodeFunctionResult("getNodeRole", [member?.role ?? 0]);
      }
      default:
        throw new Error(`fake chain: unexpected function ${parsed.name}`);
    }
  }

  private logs(filter: { fromBlock: string; toBlock: string }): unknown[] {
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = Number.parseInt(filter.toBlock, 16);
    return [...this.members.values()]
      .filter((member) => member.registeredAt >= from && member.registeredAt <= to)
      .map((member, index) => ({
        address: this.registry,
        blockNumber: `0x${member.registeredAt.toString(16)}`,
        logIndex: `0x${index.toString(16)}`,
        topics: [REGISTRATION_TOPICS[1], AbiCoder.defaultAbiCoder().encode(["address"], [member.address])],
        data: "0x",
      }));
  }
}
