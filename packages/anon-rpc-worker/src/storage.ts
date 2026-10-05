/**
 * The worker's storage use (ARCHITECTURE §4.10, PROPOSAL §2.8, ADR-17 change):
 *
 * - a cache of the pinned members that recent served topologies removed, so
 *   the next boot tries them last as anchors (`nox/v1/removed`);
 * - the learned-anchor cache (`nox/v1/anchors`): KPS addresses that verified
 *   chain checks confirmed for members, with the block they were read at, and
 *   when each member outside the snapshot was first seen (its probation
 *   start). The next boot tries learned addresses after the anchors, and the
 *   SDK uses one only after the node's `/metadata.json` names the same member.
 *
 * Both are public network state, identical for every user at a given time.
 * Nothing user-specific is stored: no entry choice, no SURBs, no keys, no
 * call history. Storage is plaintext and visible to the host, and survives
 * specifier updates, hence the versioned keys and the snapshot or registry
 * binding. Every read validates the whole record and ignores it on any
 * problem, so a damaged or tampered cache costs at most a slower boot.
 */
import {
  isKpsAddress,
  type LearnedAnchor,
  type MemberFirstSeen,
  type VerifiedDiscovery,
} from "@hisoka-io/nox-client";
import type { StorageApi } from "./spec-types.js";

/** The one key the worker writes. */
export const REMOVAL_CACHE_KEY = "nox/v1/removed";
/** A cache older than this is ignored and overwritten. */
export const REMOVAL_CACHE_MAX_AGE_SECONDS = 86_400;
/** At most one write per this interval, and only when the set changed. */
export const REMOVAL_CACHE_WRITE_INTERVAL_MS = 60_000;
/** Upper bound on cached addresses (the pinned snapshot holds at most 256 members). */
export const REMOVAL_CACHE_MAX_ENTRIES = 256;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/u;

export interface RemovalCache {
  /** Identifies the pinned snapshot the cache belongs to. */
  readonly snapshot: string;
  readonly block: number;
  readonly removed: readonly string[];
  /** Unix seconds of the write. */
  readonly at: number;
}

/**
 * Read the cache for `snapshotId`. Returns `[]` on any problem: absent,
 * unreadable, another snapshot, too old, or malformed.
 */
export async function readRemovalCache(
  storage: StorageApi | undefined,
  snapshotId: string,
  nowUnix: number,
): Promise<string[]> {
  if (storage === undefined) return [];
  let raw: Uint8Array | undefined;
  try {
    raw = await storage.get(REMOVAL_CACHE_KEY);
  } catch {
    return [];
  }
  if (raw === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null) return [];
  const record = value as Partial<Record<keyof RemovalCache, unknown>>;
  if (record.snapshot !== snapshotId) return [];
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return [];
  if (record.at > nowUnix || nowUnix - record.at > REMOVAL_CACHE_MAX_AGE_SECONDS) return [];
  if (!Array.isArray(record.removed) || record.removed.length > REMOVAL_CACHE_MAX_ENTRIES) return [];
  const removed = record.removed.filter((entry): entry is string => typeof entry === "string" && ADDRESS_RE.test(entry));
  return removed.length === record.removed.length ? removed : [];
}

/** Write the cache. Best effort: storage failures are reported to the caller and never fatal. */
export async function writeRemovalCache(storage: StorageApi, cache: RemovalCache): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    snapshot: cache.snapshot,
    block: cache.block,
    removed: [...cache.removed].sort(),
    at: cache.at,
  }));
  await storage.set(REMOVAL_CACHE_KEY, bytes);
}

/**
 * Writes the removal cache at most once per interval and only when the
 * removed set changed since the last write.
 */
export class RemovalCacheWriter {
  private lastKey: string;
  private lastWriteMs = Number.NEGATIVE_INFINITY;
  private writing = false;

  /** `stored` is what the cache holds now (what `readRemovalCache` returned). */
  constructor(
    private readonly storage: StorageApi | undefined,
    private readonly snapshotId: string,
    private readonly block: number,
    stored: readonly string[],
    private readonly intervalMs: number = REMOVAL_CACHE_WRITE_INTERVAL_MS,
  ) {
    this.lastKey = [...stored].sort().join(",");
  }

  /** Record the current removed set; resolves `true` when a write happened. */
  async update(removed: readonly string[], nowMs: number): Promise<boolean> {
    if (this.storage === undefined || this.writing) return false;
    const sorted = [...removed].sort();
    const key = sorted.join(",");
    if (key === this.lastKey || nowMs - this.lastWriteMs < this.intervalMs) return false;
    this.writing = true;
    try {
      await writeRemovalCache(this.storage, {
        snapshot: this.snapshotId,
        block: this.block,
        removed: sorted,
        at: Math.floor(nowMs / 1000),
      });
      this.lastKey = key;
      this.lastWriteMs = nowMs;
      return true;
    } finally {
      this.writing = false;
    }
  }
}

/** Key of the learned-anchor cache. */
export const LEARNED_CACHE_KEY = "nox/v1/anchors";
/** Most learned anchors kept. */
export const LEARNED_CACHE_MAX_ANCHORS = 32;
/** Most first-seen records kept (the registry holds at most 256 members). */
export const LEARNED_CACHE_MAX_FIRST_SEEN = 256;
/** A learned anchor older than this is dropped. */
export const LEARNED_CACHE_MAX_AGE_SECONDS = 30 * 86_400;
/** At most one write per this interval, and only when the content changed. */
export const LEARNED_CACHE_WRITE_INTERVAL_MS = 60_000;

const HASH_RE = /^0x[0-9a-f]{64}$/u;

/** One learned anchor as stored. */
export interface StoredAnchor {
  readonly address: string;
  readonly member: string;
  /** Finalized block of the chain check that confirmed it. */
  readonly block: number;
  readonly blockHash: string;
  /** Unix seconds of the write. */
  readonly at: number;
}

export interface LearnedCache {
  /** `<chainId>:<registry>`: the registry the records belong to. */
  readonly registry: string;
  readonly anchors: readonly StoredAnchor[];
  readonly firstSeen: readonly MemberFirstSeen[];
}

/** What a boot may use from the learned-anchor cache. */
export interface LearnedForBoot {
  readonly learned: LearnedAnchor[];
  readonly firstSeen: MemberFirstSeen[];
}

/** Registry binding of the learned-anchor cache. */
export function learnedCacheRegistry(chainId: number, registry: string): string {
  return `${chainId}:${registry}`;
}

/**
 * Read the learned-anchor cache. Returns nothing usable on any problem:
 * absent, unreadable, another registry, more records than allowed, or any
 * malformed record (a tampered cache is ignored whole, never half-trusted).
 * Anchors older than `LEARNED_CACHE_MAX_AGE_SECONDS`, dated in the future,
 * read before the snapshot block or for members outside `eligible` are left
 * out; first-seen records before the snapshot block or in the future too.
 */
export async function readLearnedCache(
  storage: StorageApi | undefined,
  registry: string,
  snapshotBlock: number,
  eligible: ReadonlySet<string>,
  nowUnix: number,
): Promise<LearnedForBoot> {
  const empty: LearnedForBoot = { learned: [], firstSeen: [] };
  if (storage === undefined) return empty;
  let raw: Uint8Array | undefined;
  try {
    raw = await storage.get(LEARNED_CACHE_KEY);
  } catch {
    return empty;
  }
  if (raw === undefined) return empty;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return empty;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return empty;
  const record = value as Partial<Record<keyof LearnedCache, unknown>>;
  if (record.registry !== registry) return empty;
  const anchors = record.anchors;
  const firstSeen = record.firstSeen;
  if (!Array.isArray(anchors) || anchors.length > LEARNED_CACHE_MAX_ANCHORS) return empty;
  if (!Array.isArray(firstSeen) || firstSeen.length > LEARNED_CACHE_MAX_FIRST_SEEN) return empty;
  if (!anchors.every(isStoredAnchor) || !firstSeen.every(isFirstSeen)) return empty;
  const seenAddresses = new Set<string>();
  const learned: LearnedAnchor[] = [];
  for (const anchor of anchors as StoredAnchor[]) {
    if (anchor.at > nowUnix || nowUnix - anchor.at > LEARNED_CACHE_MAX_AGE_SECONDS) continue;
    if (anchor.block < snapshotBlock || !eligible.has(anchor.member) || seenAddresses.has(anchor.address)) continue;
    seenAddresses.add(anchor.address);
    learned.push({ address: anchor.address, member: anchor.member });
  }
  const seenMembers = new Set<string>();
  const records: MemberFirstSeen[] = [];
  for (const entry of firstSeen as MemberFirstSeen[]) {
    if (entry.block < snapshotBlock || entry.time > nowUnix || seenMembers.has(entry.address)) continue;
    seenMembers.add(entry.address);
    records.push({ address: entry.address, block: entry.block, time: entry.time });
  }
  return { learned, firstSeen: records };
}

/**
 * The cache content for a verified chain check: chain-confirmed KPS
 * addresses (snapshot members first, then by address, at most
 * `LEARNED_CACHE_MAX_ANCHORS`) and the first-seen records.
 */
export function learnedCacheFrom(registry: string, state: VerifiedDiscovery, nowUnix: number): LearnedCache {
  const anchors = state.members
    .filter((member) => member.kpsAddress !== null)
    .sort((left, right) => Number(right.floor) - Number(left.floor) || (left.address < right.address ? -1 : 1))
    .slice(0, LEARNED_CACHE_MAX_ANCHORS)
    .map((member): StoredAnchor => ({
      address: member.kpsAddress as string,
      member: member.address,
      block: state.blockNumber,
      blockHash: state.blockHash,
      at: nowUnix,
    }));
  const firstSeen = [...state.firstSeen]
    .sort((left, right) => (left.address < right.address ? -1 : 1))
    .slice(0, LEARNED_CACHE_MAX_FIRST_SEEN);
  return { registry, anchors, firstSeen };
}

/** Write the learned-anchor cache. Best effort: storage failures reach the caller and are never fatal. */
export async function writeLearnedCache(storage: StorageApi, cache: LearnedCache): Promise<void> {
  await storage.set(LEARNED_CACHE_KEY, new TextEncoder().encode(JSON.stringify(cache)));
}

/** Writes the learned-anchor cache at most once per interval and only when its content changed. */
export class LearnedCacheWriter {
  private lastKey = "";
  private lastWriteMs = Number.NEGATIVE_INFINITY;
  private writing = false;

  constructor(
    private readonly storage: StorageApi | undefined,
    private readonly registry: string,
    private readonly intervalMs: number = LEARNED_CACHE_WRITE_INTERVAL_MS,
  ) {}

  /** Record a verified chain check; resolves `true` when a write happened. */
  async update(state: VerifiedDiscovery, nowMs: number): Promise<boolean> {
    if (this.storage === undefined || this.writing) return false;
    const cache = learnedCacheFrom(this.registry, state, Math.floor(nowMs / 1000));
    const key = JSON.stringify({ anchors: cache.anchors.map((a) => [a.address, a.member]), firstSeen: cache.firstSeen });
    if (key === this.lastKey || nowMs - this.lastWriteMs < this.intervalMs) return false;
    this.writing = true;
    try {
      await writeLearnedCache(this.storage, cache);
      this.lastKey = key;
      this.lastWriteMs = nowMs;
      return true;
    } finally {
      this.writing = false;
    }
  }
}

function isStoredAnchor(value: unknown): value is StoredAnchor {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["address"] === "string" && isKpsAddress(record["address"]) &&
    typeof record["member"] === "string" && ADDRESS_RE.test(record["member"]) &&
    isSafeNonNegative(record["block"]) &&
    typeof record["blockHash"] === "string" && HASH_RE.test(record["blockHash"]) &&
    isSafeNonNegative(record["at"]);
}

function isFirstSeen(value: unknown): value is MemberFirstSeen {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["address"] === "string" && ADDRESS_RE.test(record["address"]) &&
    isSafeNonNegative(record["block"]) && isSafeNonNegative(record["time"]);
}

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
