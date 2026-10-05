/**
 * A NoxRegistry behind an EIP-1967 proxy as a JSON-RPC responder, for the
 * worker's discovery tests: answers what the SDK's chain check sends through
 * an exit (finalized block, block by hash, chain id, implementation slot,
 * registry `eth_call`s, registration logs), single calls or batches.
 */
import {
  computeTopologyFingerprint,
  EIP1967_IMPLEMENTATION_SLOT,
  REGISTRATION_TOPICS,
  type PinnedMember,
  type PinnedSnapshot,
} from "@hisoka-io/nox-client";
import { AbiCoder, Interface, keccak256, toUtf8Bytes } from "ethers";

const REGISTRY = new Interface([
  "function topologyFingerprint() view returns (bytes32)",
  "function relayerCount() view returns (uint256)",
  "function relayers(address) view returns (bytes32 sphinxKey,string url,string ingressUrl,string metadataUrl,uint256 stakedAmount,uint256 unlockTime,bool isRegistered,uint8 status,bool frozen)",
  "function getNodeRole(address) view returns (uint8)",
]);

/** Implementation the fixture bootstrap expects. */
export const FIXTURE_IMPL = "0x7285125cfdcb6337aaed2d56d4fe99f870ede2a2";
const EPOCH = Math.floor(Date.now() / 1000) - 60;

type Member = Pick<PinnedMember, "address" | "sphinxKey" | "url" | "ingressUrl" | "metadataUrl" | "stake" | "role" | "status" | "frozen"> & {
  registeredAt: number;
};

interface Request {
  id: number;
  method: string;
  params: unknown[];
}

export class RegistryRpc {
  readonly members = new Map<string, Member>();
  blockNumber: number;
  /** Requests answered. */
  requests = 0;
  private readonly baseBlock: number;

  constructor(private readonly pinned: PinnedSnapshot) {
    this.blockNumber = pinned.blockNumber + 100;
    this.baseBlock = this.blockNumber;
    for (const member of pinned.members) this.members.set(member.address, { ...member, registeredAt: pinned.blockNumber - 1 });
  }

  get blockHash(): string {
    return keccak256(toUtf8Bytes(`block-${this.blockNumber}`));
  }

  get blockTimestamp(): number {
    return EPOCH + (this.blockNumber - this.baseBlock);
  }

  put(member: Omit<Member, "registeredAt">): void {
    this.members.set(member.address, { ...member, registeredAt: this.blockNumber });
  }

  update(address: string, change: Partial<Member>): void {
    const member = this.members.get(address);
    if (member === undefined) throw new Error(`no member ${address}`);
    this.members.set(address, { ...member, ...change });
  }

  advance(blocks = 10): void {
    this.blockNumber += blocks;
  }

  /** The current registry as a snapshot-shaped value, for node-served documents. */
  view(): PinnedMember[] {
    const byAddress = new Map(this.pinned.members.map((member) => [member.address, member]));
    return [...this.members.values()]
      .sort((left, right) => (left.address < right.address ? -1 : 1))
      .map((member) => ({ ...byAddress.get(member.address)!, ...member, capabilities: [] }) as PinnedMember);
  }

  answer(body: string): string {
    this.requests += 1;
    const parsed = JSON.parse(body) as Request | Request[];
    const one = (request: Request) => ({ jsonrpc: "2.0", id: request.id, result: this.result(request) });
    return JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed));
  }

  private block(): Record<string, string> {
    return {
      hash: this.blockHash,
      number: `0x${this.blockNumber.toString(16)}`,
      timestamp: `0x${this.blockTimestamp.toString(16)}`,
    };
  }

  private result(request: Request): unknown {
    switch (request.method) {
      case "eth_getBlockByNumber":
        return this.block();
      case "eth_getBlockByHash":
        return request.params[0] === this.blockHash ? this.block() : null;
      case "eth_chainId":
        return `0x${this.pinned.chainId.toString(16)}`;
      case "eth_getStorageAt":
        return request.params[1] === EIP1967_IMPLEMENTATION_SLOT ? `0x${"00".repeat(12)}${FIXTURE_IMPL.slice(2)}` : `0x${"00".repeat(32)}`;
      case "eth_call":
        return this.call((request.params[0] as { data: string }).data);
      case "eth_getLogs": {
        const filter = request.params[0] as { fromBlock: string; toBlock: string };
        const from = Number.parseInt(filter.fromBlock, 16);
        const to = Number.parseInt(filter.toBlock, 16);
        return [...this.members.values()]
          .filter((member) => member.registeredAt >= from && member.registeredAt <= to)
          .map((member, index) => ({
            blockNumber: `0x${member.registeredAt.toString(16)}`,
            logIndex: `0x${index.toString(16)}`,
            topics: [REGISTRATION_TOPICS[1], AbiCoder.defaultAbiCoder().encode(["address"], [member.address])],
            data: "0x",
          }));
      }
      default:
        throw new Error(`registry rpc: unexpected ${request.method}`);
    }
  }

  private call(data: string): string {
    const parsed = REGISTRY.parseTransaction({ data });
    if (parsed === null) throw new Error("registry rpc: unknown call");
    const member = parsed.args.length > 0 ? this.members.get(String(parsed.args[0]).toLowerCase()) : undefined;
    switch (parsed.name) {
      case "relayerCount":
        return REGISTRY.encodeFunctionResult("relayerCount", [this.members.size]);
      case "topologyFingerprint": {
        const nodes = [...this.members.values()].map((m) => ({
          address: m.address,
          sphinx_key: m.sphinxKey,
          url: m.url,
          stake: m.stake,
          last_seen: 0,
          is_privileged: true,
          layer: 0,
          role: m.role,
        }));
        return REGISTRY.encodeFunctionResult("topologyFingerprint", [`0x${computeTopologyFingerprint(nodes)}`]);
      }
      case "relayers":
        return member === undefined
          ? REGISTRY.encodeFunctionResult("relayers", [`0x${"00".repeat(32)}`, "", "", "", 0, 0, false, 0, false])
          : REGISTRY.encodeFunctionResult("relayers", [
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
      case "getNodeRole":
        return REGISTRY.encodeFunctionResult("getNodeRole", [member?.role ?? 0]);
      default:
        throw new Error(`registry rpc: unexpected ${parsed.name}`);
    }
  }
}
