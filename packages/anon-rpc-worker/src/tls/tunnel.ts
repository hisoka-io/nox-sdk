/**
 * One TLS tunnel through one Nox exit (E2E TLS design §2.5): the exit holds a
 * TCP connection to the upstream and relays TLS records both ways; this side
 * numbers the writes, reorders the reply parts and decides when to send
 * another copy.
 *
 * - Stop-and-wait: one unconfirmed `seq` at a time. Any part or rejection for
 *   a `seq` confirms it.
 * - Every copy of a `seq` carries identical `data` (the exit writes each `seq`
 *   once), goes to the same exit, and avoids the previous copy's entry and mix.
 * - Downstream bytes are numbered from 0; parts are reordered by offset and
 *   only contiguous bytes reach TLS. `ackOffset` is the contiguous point.
 * - Another copy goes out on `NeedSurbs` or `Expired`, and, at most
 *   `maxCopies` times per exchange, after silence or a gap that stays open.
 * - `fin` is a hint: only the TLS session and HTTP framing decide that a
 *   response is complete.
 */
import {
  decodeTunnelReplyV1,
  TUNNEL_ID_LEN,
  type TopologyNode,
  type TunnelRejectCodeV1,
  type TunnelReplyV1,
  type TunnelRequestV1,
  type TunnelSendHandle,
  type TunnelSendOptions,
} from "@hisoka-io/nox-client";

/** The slice of `NoxClient` tunnels use. */
export interface TunnelPort {
  tunnelExits(): TopologyNode[];
  tunnelSend(exit: TopologyNode, request: TunnelRequestV1, options: TunnelSendOptions): TunnelSendHandle;
}

/** Copy timing; `copyAfterMs` is read at each use (it follows the observed p95). */
export interface CopyPolicy {
  copyAfterMs(): number;
  readonly gapMs: number;
  readonly maxCopies: number;
}

/** Longest hold the exit honours (`max_hold_ms`). */
export const MAX_HOLD_MS = 30_000;
/** Shortest hold the exit honours (`min_hold_ms`). */
export const MIN_HOLD_MS = 1_000;
/** A copy keeps listening this long past its hold, for parts still in the mixnet. */
export const REPLY_GRACE_MS = 5_000;

/** The exit refused an exchange. */
export class TunnelRejectedError extends Error {
  constructor(
    readonly code: TunnelRejectCodeV1,
    readonly retryable: boolean,
    readonly seq: number,
    /** True when exactly one copy of `seq` went out, so this rejection proves it was never written. */
    readonly soleCopy: boolean,
    detail: string,
  ) {
    super(`The tunnel exit refused seq ${seq}: ${code}${detail === "" ? "" : ` (${detail})`}`);
    this.name = "TunnelRejectedError";
  }
}

/** No part of an open arrived within the open timeout. */
export class TunnelOpenTimeoutError extends Error {
  constructor(readonly afterMs: number) {
    super(`The tunnel exit did not answer the open within ${afterMs} ms`);
    this.name = "TunnelOpenTimeoutError";
  }
}

/** The exchange ran out of time before its job was done. */
export class TunnelTimeoutError extends Error {
  constructor(readonly seq: number, readonly confirmed: boolean) {
    super(`Tunnel exchange seq ${seq} did not finish before the call deadline${confirmed ? "" : " (no reply at all)"}`);
    this.name = "TunnelTimeoutError";
  }
}

/** A reply part that does not decode: the exit or the path is broken. */
export class TunnelProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TunnelProtocolError";
  }
}

export interface ExchangeSpec {
  /** TLS records to write upstream. */
  readonly data: Uint8Array;
  /** Reply blocks per copy. */
  readonly surbs: number;
  /** Half-close the upstream after writing. */
  readonly close?: boolean;
  /** Absolute time (ms) the exchange must finish by. */
  readonly deadlineAt: number;
  /** Spares and teardowns: not a wallet call. */
  readonly background: boolean;
  /** Aborts the exchange; its reason is the rejection. */
  readonly signal?: AbortSignal;
  /** Fail with `TunnelOpenTimeoutError` when nothing at all arrived in this long. */
  readonly openTimeoutMs?: number;
  /** Checked after each delivery: true ends the exchange. */
  satisfied(): boolean;
}

/** How an exchange ended: its job was done, or the upstream ended the stream. */
export type ExchangeOutcome = "satisfied" | "eof";

export interface TunnelDeps {
  readonly now: () => number;
  readonly randomBytes: (length: number) => Uint8Array;
}

/**
 * A tunnel to `host:port` through `exit`. `deliver` receives contiguous
 * downstream bytes in order (it feeds the TLS session and may throw).
 */
export class Tunnel {
  readonly id: Uint8Array;
  private nextSeq = 0;
  private contiguous = 0n;
  private readonly held = new Map<bigint, Uint8Array>();
  private eofAt: bigint | undefined;
  private ended = false;

  constructor(
    private readonly port: TunnelPort,
    readonly exit: TopologyNode,
    readonly host: string,
    readonly tcpPort: number,
    private readonly policy: CopyPolicy,
    private readonly deps: TunnelDeps,
    private readonly deliver: (bytes: Uint8Array) => void,
  ) {
    this.id = deps.randomBytes(TUNNEL_ID_LEN);
  }

  /** True once the upstream stream ended (every byte up to the exit's EOF delivered). */
  get eof(): boolean {
    return this.ended;
  }

  /** Short id prefix for debug logs. */
  get label(): string {
    return Array.from(this.id.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /** Sequence number the next exchange will use. */
  get seq(): number {
    return this.nextSeq;
  }

  /**
   * Run one exchange: a new `seq` carrying `spec.data`, copies as needed,
   * until `spec.satisfied()`, the end of the stream, a rejection, the
   * deadline or an abort.
   */
  exchange(spec: ExchangeSpec): Promise<ExchangeOutcome> {
    const seq = this.nextSeq++;
    const base = {
      tunnelId: this.id,
      seq,
      open: seq === 0 ? { host: this.host, port: this.tcpPort } : null,
      data: spec.data,
      close: spec.close === true,
    };
    const startedAt = this.deps.now();
    const listeners = new AbortController();

    return new Promise<ExchangeOutcome>((resolve, reject) => {
      let settled = false;
      let confirmed = false;
      let copiesSent = 0;
      let timedCopies = 0;
      let lastRoute: { entryId: string; mixId: string } | undefined;
      let silenceTimer: ReturnType<typeof setTimeout> | undefined;
      let gapTimer: ReturnType<typeof setTimeout> | undefined;
      let openTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (outcome: ExchangeOutcome | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(silenceTimer);
        clearTimeout(gapTimer);
        clearTimeout(openTimer);
        clearTimeout(deadlineTimer);
        spec.signal?.removeEventListener("abort", onAbort);
        listeners.abort();
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };

      const armSilence = (): void => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => timedCopy(), this.policy.copyAfterMs());
      };

      const timedCopy = (): void => {
        if (settled) return;
        if (timedCopies >= this.policy.maxCopies) return;
        timedCopies += 1;
        send();
      };

      const send = (): void => {
        if (settled) return;
        const remaining = spec.deadlineAt - this.deps.now();
        if (remaining <= 0) {
          finish(new TunnelTimeoutError(seq, confirmed));
          return;
        }
        const holdMs = Math.max(MIN_HOLD_MS, Math.min(MAX_HOLD_MS, remaining));
        const request: TunnelRequestV1 = { ...base, ackOffset: this.contiguous, holdMs };
        // A copy steers clear of the previous copy's entry and mix.
        const avoid = lastRoute === undefined ? new Set<string>() : new Set([lastRoute.entryId, lastRoute.mixId]);
        let handle: TunnelSendHandle;
        try {
          handle = this.port.tunnelSend(this.exit, request, {
            surbs: spec.surbs,
            timeoutMs: holdMs + REPLY_GRACE_MS,
            signal: listeners.signal,
            avoid,
            background: spec.background,
            onReply: (body) => onPart(body),
          });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        copiesSent += 1;
        lastRoute = { entryId: handle.entryId, mixId: handle.mixId };
        // A copy that could not be uploaded counts as silence: try another entry.
        handle.done.catch(() => {
          if (!settled && !listeners.signal.aborted && !confirmed) timedCopy();
        });
        armSilence();
      };

      const onPart = (body: Uint8Array): "more" | "done" => {
        if (settled) return "done";
        let reply: TunnelReplyV1;
        try {
          reply = decodeTunnelReplyV1(body);
        } catch (error) {
          finish(new TunnelProtocolError("A tunnel reply part does not decode", { cause: error }));
          return "done";
        }
        // A late part of an earlier exchange: already superseded.
        if (reply.seq !== seq) return "more";
        confirmed = true;
        clearTimeout(openTimer);
        if (reply.kind === "Rejected") {
          finish(new TunnelRejectedError(reply.code, reply.retryable, seq, copiesSent === 1, reply.detail));
          return "done";
        }
        try {
          this.accept(reply.offset, reply.data);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return "done";
        }
        if (reply.fin === "Eof") this.eofAt ??= reply.offset + BigInt(reply.data.length);
        if (this.eofAt !== undefined && this.contiguous >= this.eofAt) this.ended = true;
        if (spec.satisfied()) {
          finish("satisfied");
          return "done";
        }
        if (this.ended) {
          finish("eof");
          return "done";
        }
        if (this.held.size === 0) {
          clearTimeout(gapTimer);
          gapTimer = undefined;
        } else if (gapTimer === undefined) {
          gapTimer = setTimeout(() => {
            gapTimer = undefined;
            if (this.held.size > 0) timedCopy();
          }, this.policy.gapMs);
        }
        if (reply.fin === "NeedSurbs" || reply.fin === "Expired") send();
        else armSilence();
        return "more";
      };

      const onAbort = (): void => finish(spec.signal?.reason instanceof Error ? spec.signal.reason : new Error("Tunnel exchange aborted"));
      deadlineTimer = setTimeout(
        () => finish(new TunnelTimeoutError(seq, confirmed)),
        Math.max(0, spec.deadlineAt - startedAt),
      );
      if (spec.signal?.aborted === true) {
        onAbort();
        return;
      }
      spec.signal?.addEventListener("abort", onAbort, { once: true });
      if (spec.openTimeoutMs !== undefined) {
        const openTimeoutMs = spec.openTimeoutMs;
        openTimer = setTimeout(() => {
          if (!confirmed) finish(new TunnelOpenTimeoutError(openTimeoutMs));
        }, openTimeoutMs);
      }
      send();
    });
  }

  /**
   * Close the upstream write side after `data` (a close_notify), without
   * reply blocks and without waiting. Only after the last exchange was
   * confirmed, so the `seq` stays in step with the exit.
   */
  teardown(data: Uint8Array, deadlineAt: number): Promise<void> {
    const seq = this.nextSeq++;
    const holdMs = Math.max(MIN_HOLD_MS, Math.min(MAX_HOLD_MS, deadlineAt - this.deps.now()));
    const request: TunnelRequestV1 = {
      tunnelId: this.id,
      seq,
      open: null,
      ackOffset: this.contiguous,
      data,
      close: true,
      holdMs,
    };
    try {
      return this.port.tunnelSend(this.exit, request, { surbs: 0, timeoutMs: holdMs, background: true }).done;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Place one part: deliver what is contiguous, hold what lies beyond a gap. */
  private accept(offset: bigint, data: Uint8Array): void {
    const end = offset + BigInt(data.length);
    if (end <= this.contiguous) return;
    if (offset > this.contiguous) {
      const existing = this.held.get(offset);
      if (existing === undefined || existing.length < data.length) this.held.set(offset, data);
      return;
    }
    this.push(data.subarray(Number(this.contiguous - offset)));
    for (;;) {
      let advanced = false;
      for (const [heldOffset, heldData] of this.held) {
        if (heldOffset > this.contiguous) continue;
        this.held.delete(heldOffset);
        const heldEnd = heldOffset + BigInt(heldData.length);
        if (heldEnd > this.contiguous) this.push(heldData.subarray(Number(this.contiguous - heldOffset)));
        advanced = true;
      }
      if (!advanced) return;
    }
  }

  private push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.contiguous += BigInt(bytes.length);
    this.deliver(bytes);
  }
}
