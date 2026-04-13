import type { PathHop } from "./types.js";
import { NoxClientError, NoxClientErrorCode } from "./types.js";
import {
  encodeRelayerPayload,
  encodeServiceRequest,
} from "./bincode.js";
import { postPacket } from "./transport.js";
import type { SurbPool } from "./surb_pool.js";
import { buildSphinxPacket } from "./utils.js";

/** Stores forward paths and drives SURB replenishment on demand. */
export class ReplenishmentManager {
  readonly paths = new Map<bigint, PathHop[]>();

  stashPath(requestId: bigint, path: PathHop[]): void {
    this.paths.set(requestId, path);
  }

  clearPath(requestId: bigint): void {
    this.paths.delete(requestId);
  }

  hasPendingPath(requestId: bigint): boolean {
    return this.paths.has(requestId);
  }

  /** Generate fresh SURBs and send a ReplenishSurbs packet to the entry node. */
  async handleNeedMoreSurbs(opts: {
    wasm: Record<string, unknown>;
    clientRequestId: bigint;
    serverRequestId: bigint;
    fragmentsRemaining: number;
    surbPool: SurbPool;
    entryUrl: string;
    powDifficulty: number;
    minSurbs?: number;
  }): Promise<void> {
    const {
      wasm,
      clientRequestId,
      serverRequestId,
      fragmentsRemaining,
      surbPool,
      entryUrl,
      powDifficulty,
      minSurbs = 3,
    } = opts;

    const forwardPath = this.paths.get(clientRequestId);
    if (forwardPath === undefined) {
      throw new NoxClientError(
        `NeedMoreSurbs: no stashed path for request ${clientRequestId}`,
        NoxClientErrorCode.InvalidConfig,
      );
    }

    const returnPath = buildReturnPath(forwardPath);

    const MAX_SURBS_PER_PACKET = 40; // ~700 bytes/SURB, ~31KB max payload
    const surbCount = Math.min(
      Math.max(fragmentsRemaining, minSurbs),
      MAX_SURBS_PER_PACKET,
    );

    // SURBs keyed to client ID for pool matching; wire message uses server ID
    const surbBlobs = surbPool.generate(
      wasm,
      returnPath,
      clientRequestId,
      surbCount,
    );

    const innerBytes = encodeServiceRequest({
      tag: "ReplenishSurbs",
      requestId: serverRequestId,
      surbs: surbBlobs,
    });

    const payloadBytes = encodeRelayerPayload({
      tag: "AnonymousRequest",
      inner: innerBytes,
      replySurbs: [],
    });

    const packet = buildSphinxPacket(wasm, forwardPath, payloadBytes, powDifficulty);
    await postPacket(entryUrl, packet);
  }

  /** Send multiple ReplenishSurbs packets in a burst to cover all remaining fragments. */
  async burstReplenish(opts: {
    wasm: Record<string, unknown>;
    clientRequestId: bigint;
    serverRequestId: bigint;
    packetsNeeded: number;
    surbsPerPacket: number;
    surbPool: SurbPool;
    entryUrl: string;
    powDifficulty: number;
  }): Promise<void> {
    const {
      wasm,
      clientRequestId,
      serverRequestId,
      packetsNeeded,
      surbsPerPacket,
      surbPool,
      entryUrl,
      powDifficulty,
    } = opts;

    const forwardPath = this.paths.get(clientRequestId);
    if (forwardPath === undefined) {
      throw new NoxClientError(
        `burstReplenish: no stashed path for request ${clientRequestId}`,
        NoxClientErrorCode.InvalidConfig,
      );
    }

    const returnPath = buildReturnPath(forwardPath);

    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 200;

    const packets: Uint8Array[] = [];

    for (let i = 0; i < packetsNeeded; i++) {
      const surbBlobs = surbPool.generate(
        wasm,
        returnPath,
        clientRequestId,
        surbsPerPacket,
      );

      const innerBytes = encodeServiceRequest({
        tag: "ReplenishSurbs",
        requestId: serverRequestId,
        surbs: surbBlobs,
      });

      const payloadBytes = encodeRelayerPayload({
        tag: "AnonymousRequest",
        inner: innerBytes,
        replySurbs: [],
      });

      packets.push(
        buildSphinxPacket(wasm, forwardPath, payloadBytes, powDifficulty),
      );
    }

    for (let start = 0; start < packets.length; start += BATCH_SIZE) {
      const batch = packets.slice(start, start + BATCH_SIZE);
      await Promise.all(batch.map((pkt) => postPacket(entryUrl, pkt)));

      if (start + BATCH_SIZE < packets.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
  }
}

/** Forward [Entry, Mix, Exit] → Return [Mix, Entry] (exclude exit, reverse). */
export function buildReturnPath(forwardPath: PathHop[]): PathHop[] {
  if (forwardPath.length <= 1) {
    return [...forwardPath].reverse();
  }
  return [...forwardPath.slice(0, forwardPath.length - 1)].reverse();
}

