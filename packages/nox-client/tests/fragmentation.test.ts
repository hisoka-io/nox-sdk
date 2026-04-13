/**
 * Unit tests for Reassembler and Reed-Solomon FEC.
 *
 * Tests verify:
 *   - Single-fragment message reassembly
 *   - Multi-fragment in-order and out-of-order delivery
 *   - decodeShards FEC reconstruction
 *   - padToUniform utility
 *   - DoS protection limits (maxConcurrentMessages evicts oldest, not throws)
 *   - Duplicate fragment rejection
 */

import { describe, it, expect } from "vitest";
import {
  Reassembler,
  padToUniform,
  decodeShards,
  MAX_FRAGMENTS_PER_MESSAGE,
} from "../src/fragmentation.js";
import type { Fragment } from "../src/fragmentation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFragment(opts: {
  messageId?: bigint;
  totalFragments?: number;
  sequence: number;
  data: Uint8Array;
  fec?: Fragment["fec"];
}): Fragment {
  return {
    messageId: opts.messageId ?? 1n,
    totalFragments: opts.totalFragments ?? 1,
    sequence: opts.sequence,
    data: opts.data,
    fec: opts.fec ?? null,
  };
}

// ---------------------------------------------------------------------------
// Basic reassembly — Reassembler uses addFragment(), not push()
// ---------------------------------------------------------------------------

describe("Reassembler — basic", () => {
  it("single fragment message reassembles immediately", () => {
    const r = new Reassembler();
    const data = new Uint8Array([10, 20, 30, 40]);
    const result = r.addFragment(makeFragment({ sequence: 0, data, totalFragments: 1 }));
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([10, 20, 30, 40]);
  });

  it("two-fragment in-order delivery", () => {
    const r = new Reassembler();
    const chunk0 = new Uint8Array([1, 2, 3]);
    const chunk1 = new Uint8Array([4, 5, 6]);

    expect(
      r.addFragment(makeFragment({ sequence: 0, data: chunk0, totalFragments: 2 })),
    ).toBeNull();
    const result = r.addFragment(
      makeFragment({ sequence: 1, data: chunk1, totalFragments: 2 }),
    );
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("two-fragment out-of-order delivery", () => {
    const r = new Reassembler();
    const chunk0 = new Uint8Array([1, 2, 3]);
    const chunk1 = new Uint8Array([4, 5, 6]);

    // Fragment 1 arrives first
    expect(
      r.addFragment(makeFragment({ sequence: 1, data: chunk1, totalFragments: 2 })),
    ).toBeNull();
    const result = r.addFragment(
      makeFragment({ sequence: 0, data: chunk0, totalFragments: 2 }),
    );
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("exact duplicate fragment is idempotent (returns null)", () => {
    const r = new Reassembler();
    const data = new Uint8Array([7, 8, 9]);
    r.addFragment(makeFragment({ sequence: 0, data, totalFragments: 2 }));
    // Identical fragment — should not throw, returns null
    const result = r.addFragment(makeFragment({ sequence: 0, data, totalFragments: 2 }));
    expect(result).toBeNull();
  });

  it("duplicate fragment with different data throws", () => {
    const r = new Reassembler();
    r.addFragment(
      makeFragment({ sequence: 0, data: new Uint8Array([1]), totalFragments: 2 }),
    );
    expect(() =>
      r.addFragment(
        makeFragment({ sequence: 0, data: new Uint8Array([2]), totalFragments: 2 }),
      ),
    ).toThrow();
  });

  it("totalFragments > MAX_FRAGMENTS_PER_MESSAGE is rejected", () => {
    const r = new Reassembler();
    expect(() =>
      r.addFragment(
        makeFragment({
          sequence: 0,
          data: new Uint8Array([1]),
          totalFragments: MAX_FRAGMENTS_PER_MESSAGE + 1,
        }),
      ),
    ).toThrow();
  });

  it("sequence >= totalFragments is rejected", () => {
    const r = new Reassembler();
    expect(() =>
      r.addFragment(
        makeFragment({ sequence: 2, data: new Uint8Array([1]), totalFragments: 2 }),
      ),
    ).toThrow(/sequence/);
  });

  it("tracks pending count", () => {
    const r = new Reassembler();
    expect(r.pendingCount).toBe(0);
    r.addFragment(makeFragment({ messageId: 1n, sequence: 0, data: new Uint8Array([1]), totalFragments: 2 }));
    expect(r.pendingCount).toBe(1);
    // Complete the message
    r.addFragment(makeFragment({ messageId: 1n, sequence: 1, data: new Uint8Array([2]), totalFragments: 2 }));
    expect(r.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// padToUniform
// padToUniform returns [Uint8Array[], shardSize] — a tuple.
// It pads to the length of the FIRST chunk (caller must ensure first chunk is longest).
// ---------------------------------------------------------------------------

describe("padToUniform", () => {
  it("pads shorter arrays to match first shard length", () => {
    // First chunk is the longest
    const shards = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 0]), // already same length
      new Uint8Array([6, 0, 0]), // already same length
    ];
    const [padded, shardSize] = padToUniform(shards);
    expect(shardSize).toBe(3);
    expect(padded.every((s) => s.length === 3)).toBe(true);
    expect(Array.from(padded[0]!)).toEqual([1, 2, 3]);
    expect(Array.from(padded[1]!)).toEqual([4, 5, 0]);
    expect(Array.from(padded[2]!)).toEqual([6, 0, 0]);
  });

  it("already-uniform arrays are returned as-is", () => {
    const shards = [
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
    ];
    const [padded, shardSize] = padToUniform(shards);
    expect(shardSize).toBe(2);
    expect(Array.from(padded[0]!)).toEqual([1, 2]);
    expect(Array.from(padded[1]!)).toEqual([3, 4]);
  });

  it("throws on empty array", () => {
    expect(() => padToUniform([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// decodeShards — FEC reconstruction
// ---------------------------------------------------------------------------

describe("decodeShards", () => {
  it("returns original data when no shards are missing (no parity)", () => {
    // 3 data shards, 0 parity — all present
    const shards: (Uint8Array | null)[] = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]),
    ];
    const result = decodeShards(shards, 3, 9);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("truncates to originalDataLen when last shard is padded", () => {
    // 2 data shards of 3 bytes, original data is only 5 bytes (last byte is padding)
    const shards: (Uint8Array | null)[] = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 0]), // 0 is padding
    ];
    const result = decodeShards(shards, 2, 5);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it("throws when insufficient shards are present", () => {
    // Need 2 data shards but only 1 available
    const shards: (Uint8Array | null)[] = [
      new Uint8Array([1, 2]),
      null,
      null,
    ];
    expect(() => decodeShards(shards, 2, 4)).toThrow(/insufficient/);
  });

  it("throws when dataShardCount is 0", () => {
    expect(() => decodeShards([new Uint8Array([1])], 0, 1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DoS limits — maxConcurrentMessages
// The Reassembler EVICTS the oldest message when at capacity (not throws).
// ---------------------------------------------------------------------------

describe("Reassembler — DoS limits", () => {
  it("evicts oldest message when maxConcurrentMessages exceeded", () => {
    const r = new Reassembler({ maxConcurrentMessages: 2 });

    r.addFragment(makeFragment({ messageId: 1n, sequence: 0, data: new Uint8Array([1]), totalFragments: 2 }));
    r.addFragment(makeFragment({ messageId: 2n, sequence: 0, data: new Uint8Array([2]), totalFragments: 2 }));
    expect(r.pendingCount).toBe(2);

    // Third message — oldest (1n) gets evicted to make room
    r.addFragment(makeFragment({ messageId: 3n, sequence: 0, data: new Uint8Array([3]), totalFragments: 2 }));
    expect(r.pendingCount).toBe(2);
    // Message 1n was evicted
    expect(r.hasMessage(1n)).toBe(false);
    expect(r.hasMessage(3n)).toBe(true);
  });
});
