import type { TopologyNode, PathHop } from "./types.js";
import { encodeRelayerPayload } from "./bincode.js";
import { postPacket } from "./transport.js";
import { bytesToHex, getCrypto, buildSphinxPacket } from "./utils.js";
import { layersForRole } from "./topology.js";

export interface CoverTrafficConfig {
  /** Packets per second (Poisson λ_P). 0 = disabled. Default: 1.0. */
  lambdaP?: number;
  /** Max random padding bytes per dummy packet. Default: 512. */
  maxPaddingBytes?: number;
  /** PoW difficulty for dummy packets. Default: 0. */
  powDifficulty?: number;
}

/** Emits dummy Sphinx packets at a Poisson rate to hide real traffic timing. */
export class CoverTrafficController {
  private running = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;

  private readonly getNodes: () => TopologyNode[];
  private readonly getEntryUrl: () => string;
  private readonly getWasm: () => Record<string, unknown> | null;
  private readonly getPowDifficulty: () => number;

  private lambdaP = 1.0;
  private maxPaddingBytes = 512;
  private powDifficulty = 0;

  constructor(opts: {
    getNodes: () => TopologyNode[];
    getEntryUrl: () => string;
    getWasm: () => Record<string, unknown> | null;
    getPowDifficulty: () => number;
  }) {
    this.getNodes = opts.getNodes;
    this.getEntryUrl = opts.getEntryUrl;
    this.getWasm = opts.getWasm;
    this.getPowDifficulty = opts.getPowDifficulty;
  }

  /** Start emitting cover packets. Safe to call multiple times. */
  start(config: CoverTrafficConfig = {}): void {
    this.lambdaP = Math.max(0, config.lambdaP ?? 1.0);
    this.maxPaddingBytes = Math.max(0, config.maxPaddingBytes ?? 512);
    this.powDifficulty = config.powDifficulty ?? this.getPowDifficulty();

    this.stop();

    if (this.lambdaP <= 0) return;

    this.running = true;
    this._scheduleNext();
  }

  /** Stop emitting cover packets. */
  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  private _scheduleNext(): void {
    if (!this.running) return;
    const delaySecs = sampleExp(this.lambdaP);
    const delayMs = Math.round(delaySecs * 1000);
    this.timerId = setTimeout(() => {
      void this._fire();
    }, delayMs);
  }

  private async _fire(): Promise<void> {
    if (!this.running) return;

    try {
      await this._sendDummy();
    } catch {
    } finally {
      this._scheduleNext();
    }
  }

  private async _sendDummy(): Promise<void> {
    const wasm = this.getWasm();
    if (wasm === null) return;

    const nodes = this.getNodes();
    const path = selectCoverPath(nodes);
    if (path === null) return;

    const paddingLen = Math.floor(Math.random() * (this.maxPaddingBytes + 1));
    const padding = new Uint8Array(paddingLen);
    getCrypto().getRandomValues(padding);

    const payloadBytes = encodeRelayerPayload({
      tag: "Dummy",
      padding,
    });

    let packet: Uint8Array;
    try {
      packet = buildSphinxPacket(wasm, path, payloadBytes, this.powDifficulty);
    } catch {
      return;
    }

    const entryUrl = this.getEntryUrl();
    await postPacket(entryUrl, packet);
  }
}

export interface CoverClientAccessor {
  readonly nodes: TopologyNode[];
  readonly entryUrl: string;
  readonly wasm: Record<string, unknown> | null;
  readonly config: { powDifficulty: number };
}

/** Create a `CoverTrafficController` wired to a `NoxClient`-like accessor. */
export function createCoverController(
  client: CoverClientAccessor,
): CoverTrafficController {
  return new CoverTrafficController({
    getNodes: () => client.nodes,
    getEntryUrl: () => client.entryUrl,
    getWasm: () => client.wasm,
    getPowDifficulty: () => client.config.powDifficulty,
  });
}

function sampleExp(lambda: number): number {
  const u = Math.max(Number.EPSILON, Math.random());
  return -Math.log(u) / lambda;
}

function selectCoverPath(nodes: TopologyNode[]): PathHop[] | null {
  const entries = nodes.filter((n) => n.layer === 0);
  const mixes = nodes.filter((n) => n.layer === 1);
  const exits = nodes.filter((n) => n.layer === 2 && (n.role === 2 || n.role === 3));

  if (entries.length === 0 || exits.length === 0) return null;

  const entry = entries[Math.floor(Math.random() * entries.length)]!;

  const eligibleMixes = mixes.filter((n) => n.id !== entry.id);
  const mix = eligibleMixes.length > 0
    ? eligibleMixes[Math.floor(Math.random() * eligibleMixes.length)]!
    : null;

  const usedIds = new Set([entry.id, mix?.id].filter(Boolean) as string[]);
  const eligibleExits = exits.filter((n) => !usedIds.has(n.id));
  const exit = (eligibleExits.length > 0 ? eligibleExits : exits)[
    Math.floor(Math.random() * (eligibleExits.length > 0 ? eligibleExits : exits).length)
  ]!;

  const path: PathHop[] = [
    { pubKeyHex: hexU8(entry.publicKey), address: entry.routingAddress },
    ...(mix ? [{ pubKeyHex: hexU8(mix.publicKey), address: mix.routingAddress }] : []),
    { pubKeyHex: hexU8(exit.publicKey), address: exit.routingAddress },
  ];

  return path;
}

function hexU8(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
