/**
 * Reply claims: which SURB IDs to claim from which entry, and when.
 *
 * - Concurrent: an entry may have several claims in flight; an ID is never in
 *   two claims at once, so a slow claim only holds its own replies.
 * - Data first: a reply's data fragments travel on the first reply blocks of
 *   a request and its parity on the last ones (the exit pairs fragments with
 *   blocks in order). A request claims its first block only; once a fragment
 *   names the data shard count, it claims every data block; parity blocks are
 *   claimed only after `parityFallbackMs`, or after a claim carrying the
 *   request failed (the parity then rebuilds a lost data fragment).
 * - Claim protocol v2 (nox `docs/claim-api.md`): claims ask for the binary
 *   batch and `retain`, so a v2 entry keeps returned replies re-claimable for
 *   its claim grace; delivered replies, and the unused blocks of settled
 *   requests, are acked on the next claim to that entry (or on an ack-only
 *   claim when none is due). v1 entries ignore every v2 field.
 * - Long-poll: claims ask the entry to hold them open up to `waitMs`, only
 *   where the path is known to relay long-polls: over KPS when the relay's
 *   `/metadata.json` lists `claim-v2` with `limits.claimWaitMaxMs` above 0
 *   (an older relay would hold a general upstream slot and time out at 10 s),
 *   directly once the entry answered with `x-nox-claim-wait-max-ms`. The
 *   wait is capped by both. Elsewhere the tick keeps polling.
 * - Lost replies: a claim that fails after it was sent may have taken replies
 *   with it (v1 entries delete on claim). Its IDs, parity included, are
 *   claimed again at once (v2 entries return the same replies); a request
 *   that still has nothing `lostReplyGraceMs` later is reported lost.
 */
import { claimReplies, type ClaimedItem, type ClaimFormat, type ClaimTiming } from "./transport.js";
import type { FragmentWire } from "./bincode.js";
import {
  NoxClientError,
  NoxClientErrorCode,
  type NoxFetch,
  type NoxLogSink,
  type ReplyClaimSettings,
} from "./types.js";

export type { ReplyClaimSettings } from "./types.js";

/** Defaults in KPS mode (the anon-rpc worker's mode). */
export const REPLY_CLAIM_DEFAULTS: Readonly<ReplyClaimSettings> = Object.freeze({
  intervalMs: 200,
  claimTimeoutMs: 10_000,
  claimTimeoutPerIdMs: 2_500,
  maxIdsPerClaim: 4,
  maxClaimsInFlight: 4,
  waitMs: 4_000,
  binary: true,
  retain: true,
  parityFallbackMs: 2_000,
  lostReplyGraceMs: 1_500,
});

/** Acks held per entry before the oldest are dropped (the entry's grace frees unacked replies anyway). */
export const MAX_PENDING_ACKS = 512;

/** Most acks in one claim: the `nox-kps` limit on ack IDs per claim. */
export const MAX_ACKS_PER_CLAIM = 128;

/** Classic mode: the same, without long-poll and with the larger 0.6 claim window. */
export const CLASSIC_REPLY_CLAIM_DEFAULTS: Readonly<ReplyClaimSettings> = Object.freeze({
  ...REPLY_CLAIM_DEFAULTS,
  waitMs: 0,
  maxIdsPerClaim: 128,
});

/** A 204 that came back after at least this share of `waitMs` means the entry held the claim. */
const LONG_POLL_HELD_SHARE = 0.75;

/** What the scheduler needs from the client. */
export interface ReplyClaimHost {
  /** IDs of `requestId` still waiting for a reply, in generation order. */
  activeIds(requestId: bigint): readonly string[];
  /** True while the request waits for its reply. */
  isPending(requestId: bigint): boolean;
  /** `fetch` used for claims to `entryUrl`. */
  fetchFor(entryUrl: string): NoxFetch;
  /** Decrypt and dispatch one claimed reply. */
  deliver(item: ClaimedItem, claim: DeliveredClaim): void;
  /** A request's reply is presumed lost (see the module comment). */
  onLost(requestId: bigint): void;
  /** Entry label for logs (never the URL). */
  label(entryUrl: string): string;
  /**
   * The longest long-poll the path to `entryUrl` relays (0: none), from the
   * relay's capability document. Absent: decided from the entry's own
   * `x-nox-claim-wait-max-ms` header (direct connections).
   */
  probeWaitMaxMs?(entryUrl: string): Promise<number>;
  readonly log: NoxLogSink | undefined;
}

/** The claim exchange that carried a reply (for per-request phase timing). */
export interface DeliveredClaim {
  readonly timing: ClaimTiming;
  readonly format: ClaimFormat;
  /** Response body bytes of the whole claim. */
  readonly bytes: number;
  /** Replies in the claim. */
  readonly items: number;
}

interface Target {
  readonly requestId: bigint;
  readonly entryUrl: string;
  /** Reply block IDs in the order the exit uses them. */
  readonly initialIds: readonly string[];
  readonly sentAt: number;
  /** Blocks from the front claimed before the parity fallback. */
  dataWanted: number;
  /** Set when a claim carrying this request failed; cleared by a fragment. */
  suspectSince: number | undefined;
  lostReported: boolean;
}

interface EntryState {
  readonly inFlight: Set<string>;
  claims: number;
  /** Rotation start over targets, so a large request cannot starve the others. */
  cursor: number;
  /** Whether the entry held a claim open (long-poll), once observed. */
  longPoll: boolean | undefined;
  /** Whether the entry speaks claim protocol v2, once observed. */
  v2: boolean | undefined;
  /** The entry's longest honoured wait, once relayed. */
  waitMaxMs: number | undefined;
  /** The relay's longest relayed wait from its capability document; undefined until probed. */
  relayWaitMaxMs: number | undefined;
  /** A capability probe is running. */
  probing: boolean;
  /** SURB IDs to ack on the next claim (v2 entries only). */
  readonly acks: Set<string>;
}

/** Per-entry reply claim scheduling (see the module comment). */
export class ReplyClaimScheduler {
  private readonly targets = new Map<bigint, Target>();
  private readonly entries = new Map<string, EntryState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kickQueued = false;
  private closed = false;

  constructor(
    private readonly host: ReplyClaimHost,
    readonly settings: ReplyClaimSettings,
    /** Entries the scheduler leaves alone (claimed another way, e.g. a WebSocket). */
    private readonly skipEntry: (entryUrl: string) => boolean = () => false,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Start claiming a request's replies from `entryUrl`. */
  track(requestId: bigint, entryUrl: string, initialIds: readonly string[]): void {
    if (this.closed) return;
    this.targets.set(requestId, {
      requestId,
      entryUrl,
      initialIds: [...initialIds],
      sentAt: this.now(),
      dataWanted: 1,
      suspectSince: undefined,
      lostReported: false,
    });
    this.start();
    this.kick();
  }

  /** IDs of tracked requests claimed from `entryUrl`. */
  idsAt(entryUrl: string): string[] {
    const ids: string[] = [];
    for (const target of this.targets.values()) {
      if (target.entryUrl === entryUrl) ids.push(...this.host.activeIds(target.requestId));
    }
    return ids;
  }

  /** A fragment arrived: claim the rest of the data blocks, and the request is no longer suspect. */
  noteFragment(requestId: bigint, fragment: FragmentWire): void {
    const target = this.targets.get(requestId);
    if (target === undefined) return;
    target.suspectSince = undefined;
    const dataShards = fragment.fec !== null ? fragment.fec.dataShardCount : fragment.totalFragments;
    if (Number.isSafeInteger(dataShards) && dataShards > target.dataWanted) target.dataWanted = dataShards;
  }

  /** Stop the timer and drop every target. In-flight claims finish and are ignored. */
  close(): void {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.targets.clear();
    this.entries.clear();
  }

  /** One scheduling pass (the timer calls it; tests may too). */
  tick(): void {
    if (this.closed) return;
    const now = this.now();
    const byEntry = new Map<string, Target[]>();
    for (const target of [...this.targets.values()]) {
      if (!this.host.isPending(target.requestId)) {
        this.targets.delete(target.requestId);
        // Unused blocks (parity, a hedge's spare) need not wait at the entry.
        this.queueAcks(target.entryUrl, target.initialIds);
        continue;
      }
      this.checkLost(target, now);
      if (this.skipEntry(target.entryUrl)) continue;
      const list = byEntry.get(target.entryUrl);
      if (list === undefined) byEntry.set(target.entryUrl, [target]);
      else list.push(target);
    }
    for (const [entryUrl, targets] of byEntry) this.claimFrom(entryUrl, targets, now);
    this.flushAcks(byEntry);
    if (this.targets.size === 0 && ![...this.entries.values()].some((state) => state.acks.size > 0 || state.claims > 0)) {
      this.stop();
    }
  }

  private start(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = setInterval(() => this.tick(), this.settings.intervalMs);
  }

  /** A fresh request is claimed on the next turn, not a whole interval later. */
  private kick(): void {
    if (this.kickQueued) return;
    this.kickQueued = true;
    queueMicrotask(() => {
      this.kickQueued = false;
      this.tick();
    });
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private entryState(entryUrl: string): EntryState {
    let state = this.entries.get(entryUrl);
    if (state === undefined) {
      state = {
        inFlight: new Set(),
        claims: 0,
        cursor: 0,
        longPoll: undefined,
        v2: undefined,
        waitMaxMs: undefined,
        relayWaitMaxMs: undefined,
        probing: false,
        acks: new Set(),
      };
      this.probe(entryUrl, state);
      this.entries.set(entryUrl, state);
    }
    return state;
  }

  private wantedIds(target: Target, inFlight: ReadonlySet<string>, now: number): string[] {
    const active = this.host.activeIds(target.requestId);
    const fallback = target.suspectSince !== undefined || now - target.sentAt >= this.settings.parityFallbackMs;
    const deferred = fallback ? new Set<string>() : new Set(target.initialIds.slice(target.dataWanted));
    return active.filter((id) => !deferred.has(id) && !inFlight.has(id));
  }

  private claimFrom(entryUrl: string, targets: Target[], now: number): void {
    const state = this.entryState(entryUrl);
    const free = this.settings.maxClaimsInFlight - state.claims;
    if (free <= 0) return;
    targets.sort((left, right) => left.sentAt - right.sentAt);
    const start = state.cursor % targets.length;
    const ordered = [...targets.slice(start), ...targets.slice(0, start)];
    state.cursor = (start + 1) % Math.max(1, targets.length);
    const batches: { ids: string[]; requests: Set<bigint> }[] = [];
    let current: { ids: string[]; requests: Set<bigint> } = { ids: [], requests: new Set() };
    for (const target of ordered) {
      for (const id of this.wantedIds(target, state.inFlight, now)) {
        if (current.ids.length >= this.settings.maxIdsPerClaim) {
          batches.push(current);
          if (batches.length >= free) break;
          current = { ids: [], requests: new Set() };
        }
        current.ids.push(id);
        current.requests.add(target.requestId);
      }
      if (batches.length >= free) break;
    }
    if (current.ids.length > 0 && batches.length < free) batches.push(current);
    for (const batch of batches) void this.claim(entryUrl, state, batch.ids, batch.requests);
  }

  /** Ask the host once per entry how long a wait the path relays. */
  private probe(entryUrl: string, state: EntryState): void {
    const probe = this.host.probeWaitMaxMs;
    if (probe === undefined || this.settings.waitMs === 0 || !this.settings.retain) return;
    state.probing = true;
    probe.call(this.host, entryUrl).then(
      (ms) => {
        state.relayWaitMaxMs = Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
      },
      () => {
        state.relayWaitMaxMs = 0;
      },
    ).finally(() => {
      state.probing = false;
    });
  }

  /** Long-poll hold for the next claim to this entry (0 until the path is known to relay it). */
  private waitFor(state: EntryState): number {
    const settings = this.settings;
    if (settings.waitMs === 0 || !settings.retain) return 0;
    const relay = this.host.probeWaitMaxMs === undefined ? state.waitMaxMs : state.relayWaitMaxMs;
    if (relay === undefined || relay <= 0) return 0;
    return Math.min(settings.waitMs, relay, state.waitMaxMs ?? relay);
  }

  /** Queue acks for `entryUrl` (only entries known to speak v2 use them). */
  private queueAcks(entryUrl: string, ids: Iterable<string>): void {
    const state = this.entries.get(entryUrl);
    if (state?.v2 !== true || !this.settings.retain) return;
    for (const id of ids) {
      state.acks.add(id);
      if (state.acks.size > MAX_PENDING_ACKS) {
        const oldest = state.acks.values().next().value;
        if (oldest !== undefined) state.acks.delete(oldest);
      }
    }
  }

  private takeAcks(state: EntryState): string[] {
    const acks: string[] = [];
    for (const id of state.acks) {
      if (acks.length >= MAX_ACKS_PER_CLAIM) break;
      acks.push(id);
    }
    for (const id of acks) state.acks.delete(id);
    return acks;
  }

  /** Ack-only claims for v2 entries that have acks waiting and no claim this tick. */
  private flushAcks(claimedThisTick: ReadonlyMap<string, unknown>): void {
    for (const [entryUrl, state] of this.entries) {
      if (state.acks.size === 0 || state.v2 !== true || claimedThisTick.has(entryUrl)) continue;
      if (state.claims >= this.settings.maxClaimsInFlight) continue;
      void this.claim(entryUrl, state, [], new Set());
    }
  }

  private async claim(entryUrl: string, state: EntryState, ids: string[], requests: Set<bigint>): Promise<void> {
    const settings = this.settings;
    for (const id of ids) state.inFlight.add(id);
    state.claims += 1;
    const acks = this.takeAcks(state);
    const started = this.now();
    const waitMs = ids.length === 0 ? 0 : this.waitFor(state);
    const timeoutMs = settings.claimTimeoutMs + waitMs + settings.claimTimeoutPerIdMs * Math.max(0, ids.length - 1);
    let items: ClaimedItem[] = [];
    let delivered: DeliveredClaim | undefined;
    try {
      const outcome = await claimReplies(entryUrl, ids, {
        timeoutMs,
        fetchImpl: this.host.fetchFor(entryUrl),
        binary: settings.binary,
        retain: settings.retain,
        ack: acks,
        waitMs,
      });
      items = outcome.items;
      delivered = { timing: outcome.timing, format: outcome.format, bytes: outcome.bytes, items: items.length };
      if (outcome.v2 !== undefined) state.v2 = outcome.v2;
      if (outcome.waitMaxMs !== undefined) state.waitMaxMs = outcome.waitMaxMs;
      this.noteOutcome(entryUrl, state, outcome.format, outcome.bytes, ids.length, items, this.now() - started, waitMs);
    } catch (error) {
      // Acks that did not get through are sent again (re-acking is harmless).
      for (const id of acks) state.acks.add(id);
      this.noteFailure(entryUrl, ids, requests, error, this.now() - started, timeoutMs);
    } finally {
      for (const id of ids) state.inFlight.delete(id);
      state.claims -= 1;
    }
    if (this.closed || delivered === undefined) return;
    const received: string[] = [];
    for (const item of items) {
      const surbId = surbIdOfItem(item.id);
      if (surbId !== null) received.push(surbId);
      try {
        this.host.deliver(item, delivered);
      } catch {
        // One bad reply never stops the others.
      }
    }
    this.queueAcks(entryUrl, received);
    if (state.acks.size > 0) this.start();
  }

  private noteOutcome(
    entryUrl: string,
    state: EntryState,
    format: ClaimFormat,
    bytes: number,
    ids: number,
    items: readonly ClaimedItem[],
    ms: number,
    waitMs: number,
  ): void {
    if (ids > 0 && format === "empty" && waitMs > 0 && state.longPoll === undefined) {
      state.longPoll = ms >= waitMs * LONG_POLL_HELD_SHARE;
      emit(this.host.log, "info", "claim.mode", {
        entry: this.host.label(entryUrl),
        longPoll: state.longPoll,
        v2: state.v2 ?? "unknown",
      });
    }
    if (items.length > 0) {
      const reclaimed = items.filter((item) => item.reclaimed === true).length;
      emit(this.host.log, reclaimed > 0 ? "info" : "debug", reclaimed > 0 ? "claim.recovered" : "claim.ok", {
        entry: this.host.label(entryUrl),
        ids,
        items: items.length,
        reclaimed,
        bytes,
        format,
        ms,
      });
    }
  }

  private noteFailure(
    entryUrl: string,
    ids: readonly string[],
    requests: ReadonlySet<bigint>,
    error: unknown,
    ms: number,
    timeoutMs: number,
  ): void {
    const now = this.now();
    let marked = 0;
    for (const requestId of requests) {
      const target = this.targets.get(requestId);
      if (target === undefined) continue;
      target.suspectSince ??= now;
      marked += 1;
    }
    emit(this.host.log, "warn", "claim.failed", {
      entry: this.host.label(entryUrl),
      ids: ids.length,
      requests: marked,
      ms,
      timedOut: ms >= timeoutMs,
      phase: failurePhase(error),
      code: error instanceof NoxClientError ? error.code : NoxClientErrorCode.TransportFailed,
    });
  }

  private checkLost(target: Target, now: number): void {
    if (target.lostReported || target.suspectSince === undefined) return;
    if (now - target.suspectSince < this.settings.lostReplyGraceMs) return;
    target.lostReported = true;
    emit(this.host.log, "warn", "reply.lost", {
      entry: this.host.label(target.entryUrl),
      sinceSendMs: now - target.sentAt,
      sinceClaimFailedMs: now - target.suspectSince,
    });
    try {
      this.host.onLost(target.requestId);
    } catch {
      // The resend path reports its own failures.
    }
  }
}

/** Validate and fill reply claim settings. Throws `INVALID_CONFIG` naming the field. */
export function resolveReplyClaimSettings(
  overrides: Partial<ReplyClaimSettings> | undefined,
  base: Readonly<ReplyClaimSettings> = REPLY_CLAIM_DEFAULTS,
): ReplyClaimSettings {
  const settings: Record<string, number | boolean> = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in REPLY_CLAIM_DEFAULTS)) {
      throw new NoxClientError(`${key} is not a reply claim setting`, NoxClientErrorCode.InvalidConfig);
    }
    if (value === undefined) continue;
    if (key === "binary" || key === "retain") {
      if (typeof value !== "boolean") {
        throw new NoxClientError(`replyClaims.${key} must be a boolean`, NoxClientErrorCode.InvalidConfig);
      }
      settings[key] = value;
      continue;
    }
    const min = key === "waitMs" ? 0 : 1;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
      throw new NoxClientError(
        `replyClaims.${key} must be ${min === 0 ? "a non-negative" : "a positive"} safe integer`,
        NoxClientErrorCode.InvalidConfig,
      );
    }
    settings[key] = value;
  }
  return settings as unknown as ReplyClaimSettings;
}

const HEX32_RE = /^[0-9a-f]{32}$/u;

/** The SURB ID a claimed item answers: the ID itself or the 32-hex suffix after the last `-`. */
export function surbIdOfItem(itemId: string): string | null {
  const lower = itemId.toLowerCase();
  if (HEX32_RE.test(lower)) return lower;
  const suffix = lower.slice(lower.lastIndexOf("-") + 1);
  return HEX32_RE.test(suffix) ? suffix : null;
}

function failurePhase(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const phase = (current as { phase?: unknown }).phase;
    if (typeof phase === "string") return phase;
    current = (current as { cause?: unknown }).cause;
  }
  return "unknown";
}

function emit(
  log: NoxLogSink | undefined,
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, string | number | boolean>>,
): void {
  if (log === undefined) return;
  try {
    log(level, event, fields);
  } catch {
    // Diagnostics are best effort.
  }
}
