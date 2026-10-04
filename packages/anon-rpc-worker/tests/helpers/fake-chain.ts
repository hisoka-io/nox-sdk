// An in-process JSON-RPC endpoint that serves a NoxRegistry state, for the
// snapshot tests. It answers the calls make-snapshot.mjs, verify-snapshot.mjs
// and the SDK's on-chain verifier make: eth_chainId, eth_getBlockByNumber,
// eth_getCode, eth_getLogs and eth_call (relayerCount, topologyFingerprint,
// relayers, getNodeRole), single or batched.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keccak256, toUtf8Bytes, zeroPadValue } from "ethers";
import { registryInterface } from "../../scripts/lib/registry.mjs";

export interface FakeMember {
  address: string;
  sphinxKey: string;
  url: string;
  ingressUrl: string;
  metadataUrl: string;
  stake: string;
  role: number;
  status: number;
  frozen: boolean;
  isRegistered: boolean;
}

export interface FakeChainOptions {
  chainId: number;
  registry: string;
  fromBlock: number;
  head: number;
  safe: number;
  /** Hashes for specific blocks; others are derived from the number. */
  blockHashes?: Record<number, string>;
  members: FakeMember[];
  fingerprint: string;
  /** Oldest block whose state the endpoint serves (archive: fromBlock). */
  oldestStateBlock?: number;
  /** Blocks at which the registry emitted some other event. */
  otherEventBlocks?: number[];
  /** Largest eth_getLogs span accepted; larger spans get a JSON-RPC error. */
  maxLogSpan?: number;
  /** When set, every eth_call is answered with this JSON-RPC error message. */
  callError?: string;
  /** Message for state reads below oldestStateBlock (default: Nitro's wording). */
  missingStateMessage?: (block: number) => string;
}

type JsonRpcRequest = { id: unknown; method: string; params: unknown[] };

const iface = registryInterface();

export class FakeChain {
  readonly options: FakeChainOptions;
  readonly calls: string[] = [];
  private server: Server | undefined;
  url = "";

  constructor(options: FakeChainOptions) {
    this.options = options;
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void readBody(request).then((body) => {
        const parsed: unknown = JSON.parse(body);
        const reply = Array.isArray(parsed)
          ? parsed.map((item) => this.answer(item as JsonRpcRequest))
          : this.answer(parsed as JsonRpcRequest);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/rpc`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  blockHash(number: number): string {
    return this.options.blockHashes?.[number] ?? keccak256(toUtf8Bytes(`fake-block-${number}`));
  }

  private answer(request: JsonRpcRequest): unknown {
    this.calls.push(request.method);
    try {
      return { jsonrpc: "2.0", id: request.id, result: this.result(request.method, request.params) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } };
    }
  }

  private blockNumber(tag: unknown): number {
    if (tag === "latest") return this.options.head;
    if (tag === "safe" || tag === "finalized") return this.options.safe;
    if (typeof tag === "string" && tag.startsWith("0x")) return Number.parseInt(tag, 16);
    throw new Error(`unsupported block tag ${String(tag)}`);
  }

  private stateAt(tag: unknown): number {
    const number = this.blockNumber(tag);
    if (number > this.options.head) throw new Error(`block ${number} is in the future`);
    if (number < (this.options.oldestStateBlock ?? this.options.fromBlock)) {
      throw new Error(
        this.options.missingStateMessage?.(number) ??
          `historical state ${keccak256(toUtf8Bytes(`fake-state-${number}`)).slice(2)} is not available`,
      );
    }
    return number;
  }

  private result(method: string, params: unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return `0x${this.options.chainId.toString(16)}`;
      case "eth_blockNumber":
        return `0x${this.options.head.toString(16)}`;
      case "eth_getBlockByNumber": {
        const number = this.blockNumber(params[0]);
        if (number > this.options.head) return null;
        return { number: `0x${number.toString(16)}`, hash: this.blockHash(number), timestamp: `0x${(1_790_000_000 + number).toString(16)}` };
      }
      case "eth_getCode":
        this.stateAt(params[1]);
        return params[0] === this.options.registry ? "0x6080604052" : "0x";
      case "eth_getLogs":
        return this.logs(params[0] as { address: string; fromBlock: string; toBlock: string; topics?: string[] });
      case "eth_call":
        return this.call(params[0] as { to: string; data: string }, params[1]);
      default:
        throw new Error(`method ${method} is not served`);
    }
  }

  private logs(filter: { address: string; fromBlock: string; toBlock: string; topics?: string[] }): unknown[] {
    const from = Number.parseInt(filter.fromBlock, 16);
    const to = Number.parseInt(filter.toBlock, 16);
    if (this.options.maxLogSpan !== undefined && to - from + 1 > this.options.maxLogSpan) {
      throw new Error(`ranges over ${this.options.maxLogSpan} blocks are not supported`);
    }
    if (filter.address !== this.options.registry) return [];
    const logs: Array<{ block: number; topics: string[] }> = [];
    this.options.members.forEach((member, index) => {
      const event = member.stake === "0" ? "PrivilegedRelayerRegistered" : "RelayerRegistered";
      const topic = iface.getEvent(event)?.topicHash ?? "";
      logs.push({ block: this.options.fromBlock + 1 + index, topics: [topic, zeroPadValue(member.address, 32)] });
    });
    for (const block of this.options.otherEventBlocks ?? []) {
      logs.push({ block, topics: [keccak256(toUtf8Bytes("MetadataUrlUpdated(address,string)"))] });
    }
    const wanted = filter.topics?.[0];
    return logs
      .filter((log) => log.block >= from && log.block <= to && (wanted === undefined || log.topics[0] === wanted))
      .map((log) => ({
        address: this.options.registry,
        topics: log.topics,
        data: "0x",
        blockNumber: `0x${log.block.toString(16)}`,
        removed: false,
      }));
  }

  private call(tx: { to: string; data: string }, tag: unknown): string {
    if (this.options.callError !== undefined) throw new Error(this.options.callError);
    this.stateAt(tag);
    if (tx.to !== this.options.registry) throw new Error("execution reverted");
    const parsed = iface.parseTransaction({ data: tx.data });
    if (parsed === null) throw new Error("unknown selector");
    const registered = this.options.members.filter((member) => member.isRegistered);
    switch (parsed.name) {
      case "relayerCount":
        return iface.encodeFunctionResult("relayerCount", [registered.length]);
      case "topologyFingerprint":
        return iface.encodeFunctionResult("topologyFingerprint", [`0x${this.options.fingerprint}`]);
      case "relayers": {
        const address = String(parsed.args[0]).toLowerCase();
        const member = this.options.members.find((candidate) => candidate.address === address);
        if (member === undefined) {
          return iface.encodeFunctionResult("relayers", [`0x${"00".repeat(32)}`, "", "", "", 0, 0, false, 0, false]);
        }
        return iface.encodeFunctionResult("relayers", [
          `0x${member.sphinxKey}`,
          member.url,
          member.ingressUrl,
          member.metadataUrl,
          BigInt(member.stake),
          0,
          member.isRegistered,
          member.status,
          member.frozen,
        ]);
      }
      case "getNodeRole": {
        const address = String(parsed.args[0]).toLowerCase();
        const member = this.options.members.find((candidate) => candidate.address === address);
        return iface.encodeFunctionResult("getNodeRole", [member?.role ?? 0]);
      }
      default:
        throw new Error(`function ${parsed.name} is not served`);
    }
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
