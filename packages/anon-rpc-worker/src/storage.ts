/**
 * The worker's only storage use (ARCHITECTURE §4.10): a cache of the pinned
 * members that recent served topologies removed, so the next boot tries them
 * last as anchors. It only reorders anchors; it never adds or removes trust.
 *
 * It is network state, identical for every user at a given time. Nothing
 * user-specific is stored: no entry choice, no SURBs, no keys, no call
 * history. Storage is plaintext and visible to the host, and survives
 * specifier updates, hence the versioned key and the snapshot binding.
 */
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
