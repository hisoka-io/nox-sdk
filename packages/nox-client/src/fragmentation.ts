import { NoxClientError, NoxClientErrorCode } from "./types.js";

export const MAX_FRAGMENTS_PER_MESSAGE = 9_500; // ~275 MB at 30 KB/fragment
export const MAX_MESSAGE_SIZE = MAX_FRAGMENTS_PER_MESSAGE * 30 * 1024;
export const SURB_PAYLOAD_SIZE = 30 * 1024;

const DEFAULT_MAX_BUFFER_BYTES = 300 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 50;
const DEFAULT_STALE_MS = 120_000;

export interface FecInfo {
  dataShardCount: number;
  originalDataLen: number;
}

export interface Fragment {
  messageId: bigint;
  totalFragments: number;
  sequence: number;
  data: Uint8Array;
  fec: FecInfo | null;
}

export interface ReassemblerConfig {
  maxBufferBytes?: number;
  maxConcurrentMessages?: number;
  staleTimeoutMs?: number;
}

interface ReassemblyBuffer {
  fragments: Map<number, Fragment>;
  expectedTotal: number;
  receivedCount: number;
  bufferedBytes: number;
  createdAt: number;
  lastActivity: number;
  fecInfo: FecInfo | null;
}

function newBuffer(first: Fragment): ReassemblyBuffer {
  const now = Date.now();
  return {
    fragments: new Map(),
    expectedTotal: first.totalFragments,
    receivedCount: 0,
    bufferedBytes: 0,
    createdAt: now,
    lastActivity: now,
    fecInfo: first.fec,
  };
}

function estimateFragmentSize(f: Fragment): number {
  return 21 + f.data.length + (f.fec !== null ? 13 : 1);
}

function bufferIsComplete(buf: ReassemblyBuffer): boolean {
  if (buf.fecInfo !== null) {
    return buf.receivedCount >= buf.fecInfo.dataShardCount;
  }
  return buf.receivedCount === buf.expectedTotal;
}

function assemble(buf: ReassemblyBuffer): Uint8Array {
  if (buf.fecInfo === null) {
    const parts: Uint8Array[] = [];
    for (let seq = 0; seq < buf.expectedTotal; seq++) {
      const frag = buf.fragments.get(seq);
      if (frag !== undefined) parts.push(frag.data);
    }
    const total = parts.reduce((acc, p) => acc + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  const { dataShardCount, originalDataLen } = buf.fecInfo;
  const shards: (Uint8Array | null)[] = [];
  for (let seq = 0; seq < buf.expectedTotal; seq++) {
    const frag = buf.fragments.get(seq);
    shards.push(frag !== undefined ? frag.data : null);
  }
  return decodeShards(shards, dataShardCount, originalDataLen);
}

/** Reassembles fragments into complete messages, with optional Reed-Solomon FEC. */
export class Reassembler {
  private readonly buffers: Map<bigint, ReassemblyBuffer> = new Map();
  private totalBufferedBytes = 0;
  private readonly maxBufferBytes: number;
  private readonly maxConcurrentMessages: number;
  private readonly staleTimeoutMs: number;

  constructor(config: ReassemblerConfig = {}) {
    this.maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.maxConcurrentMessages = config.maxConcurrentMessages ?? DEFAULT_MAX_CONCURRENT;
    this.staleTimeoutMs = config.staleTimeoutMs ?? DEFAULT_STALE_MS;
  }

  /** Add a fragment. Returns reassembled message if complete, otherwise `null`. */
  addFragment(fragment: Fragment): Uint8Array | null {
    validateFragment(fragment);

    const { messageId, sequence } = fragment;

    const existing = this.buffers.get(messageId);
    if (existing !== undefined && existing.fragments.has(sequence)) {
      const stored = existing.fragments.get(sequence)!;
      if (!bytesEqual(stored.data, fragment.data)) {
        throw new NoxClientError(
          `Duplicate fragment seq=${sequence} for message ${messageId} has different data`,
          NoxClientErrorCode.DecryptionFailed,
        );
      }
      return null;
    }

    const fragSize = estimateFragmentSize(fragment);
    this.ensureCapacity(fragSize);

    let buf = this.buffers.get(messageId);
    if (buf === undefined) {
      buf = newBuffer(fragment);
      this.buffers.set(messageId, buf);
    }

    if (fragment.totalFragments !== buf.expectedTotal) {
      throw new NoxClientError(
        `Inconsistent totalFragments for message ${messageId}: expected ${buf.expectedTotal}, got ${fragment.totalFragments}`,
        NoxClientErrorCode.DecryptionFailed,
      );
    }

    if (fragment.fec !== null) {
      if (buf.fecInfo === null) {
        buf.fecInfo = fragment.fec;
      } else if (
        buf.fecInfo.dataShardCount !== fragment.fec.dataShardCount ||
        buf.fecInfo.originalDataLen !== fragment.fec.originalDataLen
      ) {
        throw new NoxClientError(
          `FEC mismatch for message ${messageId}: buffer has D=${buf.fecInfo.dataShardCount}, fragment has D=${fragment.fec.dataShardCount}`,
          NoxClientErrorCode.DecryptionFailed,
        );
      }
    }

    buf.lastActivity = Date.now();
    buf.fragments.set(sequence, fragment);
    buf.receivedCount++;
    buf.bufferedBytes += fragSize;
    this.totalBufferedBytes += fragSize;

    if (!bufferIsComplete(buf)) return null;

    this.buffers.delete(messageId);
    this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - buf.bufferedBytes);
    return assemble(buf);
  }

  /** Prune incomplete messages older than `timeoutMs`. Returns count pruned. */
  pruneStale(timeoutMs?: number): number {
    const timeout = timeoutMs ?? this.staleTimeoutMs;
    const cutoff = Date.now() - timeout;
    const stale: bigint[] = [];
    for (const [id, buf] of this.buffers) {
      if (buf.createdAt < cutoff) stale.push(id);
    }
    for (const id of stale) {
      const buf = this.buffers.get(id);
      if (buf !== undefined) {
        this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - buf.bufferedBytes);
        this.buffers.delete(id);
      }
    }
    return stale.length;
  }

  get bufferedBytes(): number {
    return this.totalBufferedBytes;
  }

  get pendingCount(): number {
    return this.buffers.size;
  }

  hasMessage(messageId: bigint): boolean {
    return this.buffers.has(messageId);
  }

  messageProgress(messageId: bigint): [number, number] | null {
    const buf = this.buffers.get(messageId);
    if (buf === undefined) return null;
    return [buf.receivedCount, buf.expectedTotal];
  }

  totalProgress(): [number, number] {
    let received = 0;
    let total = 0;
    for (const buf of this.buffers.values()) {
      received += buf.receivedCount;
      total += buf.expectedTotal;
    }
    return [received, total];
  }

  private ensureCapacity(neededBytes: number): void {
    while (
      (this.totalBufferedBytes + neededBytes > this.maxBufferBytes ||
        this.buffers.size >= this.maxConcurrentMessages) &&
      this.buffers.size > 0
    ) {
      this.evictOldest();
    }
  }

  private evictOldest(): void {
    let oldestId: bigint | undefined;
    let oldestTime = Infinity;
    for (const [id, buf] of this.buffers) {
      if (buf.lastActivity < oldestTime) {
        oldestTime = buf.lastActivity;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) {
      const buf = this.buffers.get(oldestId);
      if (buf !== undefined) {
        this.totalBufferedBytes = Math.max(0, this.totalBufferedBytes - buf.bufferedBytes);
        this.buffers.delete(oldestId);
      }
    }
  }
}

function validateFragment(f: Fragment): void {
  if (f.totalFragments > MAX_FRAGMENTS_PER_MESSAGE) {
    throw new NoxClientError(
      `Fragment totalFragments=${f.totalFragments} exceeds max ${MAX_FRAGMENTS_PER_MESSAGE}`,
      NoxClientErrorCode.DecryptionFailed,
    );
  }
  if (f.sequence >= f.totalFragments) {
    throw new NoxClientError(
      `Fragment sequence=${f.sequence} >= totalFragments=${f.totalFragments}`,
      NoxClientErrorCode.DecryptionFailed,
    );
  }
  if (f.fec !== null) {
    const { dataShardCount } = f.fec;
    if (dataShardCount === 0 || dataShardCount > f.totalFragments) {
      throw new NoxClientError(
        `Fragment FEC dataShardCount=${dataShardCount} must be in 1..=${f.totalFragments}`,
        NoxClientErrorCode.DecryptionFailed,
      );
    }
  }
}

// Reed-Solomon FEC decode (GF(2^8), polynomial 0x11d)

export function padToUniform(chunks: Uint8Array[]): [Uint8Array[], number] {
  if (chunks.length === 0) {
    throw new NoxClientError(
      "padToUniform: empty data chunks",
      NoxClientErrorCode.DecryptionFailed,
    );
  }
  const shardSize = chunks[0]!.length;
  const padded = chunks.map((chunk) => {
    if (chunk.length === shardSize) return chunk;
    const p = new Uint8Array(shardSize);
    p.set(chunk);
    return p;
  });
  return [padded, shardSize];
}

/** Reconstruct original data from a (possibly incomplete) shard array. */
export function decodeShards(
  shards: (Uint8Array | null)[],
  dataShardCount: number,
  originalDataLen: number,
): Uint8Array {
  if (dataShardCount === 0) {
    throw new NoxClientError(
      "decodeShards: dataShardCount must be > 0",
      NoxClientErrorCode.DecryptionFailed,
    );
  }
  const totalShards = shards.length;
  if (totalShards < dataShardCount) {
    throw new NoxClientError(
      `decodeShards: total shards ${totalShards} < dataShardCount ${dataShardCount}`,
      NoxClientErrorCode.DecryptionFailed,
    );
  }

  const available = shards.filter((s) => s !== null).length;
  if (available < dataShardCount) {
    throw new NoxClientError(
      `decodeShards: insufficient shards for reconstruction: have ${available}, need ${dataShardCount}`,
      NoxClientErrorCode.DecryptionFailed,
    );
  }

  const allDataPresent = shards.slice(0, dataShardCount).every((s) => s !== null);
  if (allDataPresent) {
    const parts = shards.slice(0, dataShardCount) as Uint8Array[];
    const totalLen = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(Math.min(totalLen, originalDataLen));
    let offset = 0;
    for (const p of parts) {
      const rem = originalDataLen - offset;
      if (rem <= 0) break;
      const take = Math.min(p.length, rem);
      out.set(p.subarray(0, take), offset);
      offset += take;
    }
    return out;
  }

  const parityCount = totalShards - dataShardCount;
  if (parityCount === 0) {
    throw new NoxClientError(
      "decodeShards: missing data shards and no parity shards available",
      NoxClientErrorCode.DecryptionFailed,
    );
  }

  let shardSize = 0;
  for (const s of shards) {
    if (s !== null) {
      shardSize = s.length;
      break;
    }
  }
  if (shardSize === 0) {
    throw new NoxClientError(
      "decodeShards: all shards are null",
      NoxClientErrorCode.DecryptionFailed,
    );
  }

  const reconstructed = rsReconstruct(shards, dataShardCount, parityCount, shardSize);

  const out = new Uint8Array(originalDataLen);
  let offset = 0;
  for (let i = 0; i < dataShardCount; i++) {
    const shard = reconstructed[i]!;
    const rem = originalDataLen - offset;
    if (rem <= 0) break;
    const take = Math.min(shard.length, rem);
    out.set(shard.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

const GF_PRIME = 0x11d; // x^8+x^4+x^3+x^2+1
const GF_SIZE = 256;

const gfLog = new Uint8Array(GF_SIZE);
const gfExp = new Uint8Array(GF_SIZE * 2);

(function buildTables(): void {
  let x = 1;
  for (let i = 0; i < GF_SIZE - 1; i++) {
    gfExp[i] = x;
    gfExp[i + GF_SIZE - 1] = x;
    gfLog[x] = i;
    x <<= 1;
    if (x >= GF_SIZE) x ^= GF_PRIME;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return gfExp[(gfLog[a]! + gfLog[b]!) % (GF_SIZE - 1)]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("GF division by zero");
  if (a === 0) return 0;
  return gfExp[((gfLog[a]! - gfLog[b]! + GF_SIZE - 1) % (GF_SIZE - 1))]!;
}

function gfInv(a: number): number {
  return gfDiv(1, a);
}

function gfExp_pow(base: number, exp: number): number {
  if (exp === 0) return 1;
  if (base === 0) return 0;
  let result = 1;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e & 1) result = gfMul(result, b);
    b = gfMul(b, b);
    e >>= 1;
  }
  return result;
}

function rsReconstruct(
  shards: (Uint8Array | null)[],
  dataCount: number,
  parityCount: number,
  shardSize: number,
): Uint8Array[] {
  const total = dataCount + parityCount;

  const encodeMatrix = buildEncodeMatrix(dataCount, parityCount);

  const presentIndices: number[] = [];
  for (let i = 0; i < total; i++) {
    if (shards[i] !== null) presentIndices.push(i);
    if (presentIndices.length === dataCount) break;
  }

  if (presentIndices.length < dataCount) {
    throw new NoxClientError(
      "rsReconstruct: insufficient received shards",
      NoxClientErrorCode.DecryptionFailed,
    );
  }

  const subMatrix: number[][] = presentIndices.map((rowIdx) =>
    encodeMatrix[rowIdx]!.slice(0, dataCount),
  );
  const invMatrix = gfMatrixInvert(subMatrix, dataCount);

  const result: Uint8Array[] = new Array<Uint8Array>(dataCount);
  for (let di = 0; di < dataCount; di++) {
    const out = new Uint8Array(shardSize);
    for (let pi = 0; pi < dataCount; pi++) {
      const coeff = invMatrix[di]![pi]!;
      if (coeff === 0) continue;
      const src = shards[presentIndices[pi]!]!;
      if (coeff === 1) {
        for (let k = 0; k < shardSize; k++) out[k]! ^= src[k]!;
      } else {
        const logCoeff = gfLog[coeff]!;
        for (let k = 0; k < shardSize; k++) {
          if (src[k] !== 0) out[k]! ^= gfExp[(logCoeff + gfLog[src[k]!]!) % (GF_SIZE - 1)]!;
        }
      }
    }
    result[di] = out;
  }

  return result;
}

function buildEncodeMatrix(dataCount: number, parityCount: number): number[][] {
  const total = dataCount + parityCount;

  // Vandermonde matrix: V[r][c] = r^c in GF(2^8)
  const vand: number[][] = new Array<number[]>(total);
  for (let r = 0; r < total; r++) {
    vand[r] = new Array<number>(dataCount);
    for (let c = 0; c < dataCount; c++) {
      vand[r]![c] = gfExp_pow(r, c);
    }
  }

  // Normalize so top DxD rows become identity
  const top: number[][] = vand.slice(0, dataCount).map((row) => row.slice());
  const topInv = gfMatrixInvert(top, dataCount);

  const matrix: number[][] = new Array<number[]>(total);
  for (let r = 0; r < total; r++) {
    matrix[r] = new Array<number>(dataCount).fill(0);
    for (let c = 0; c < dataCount; c++) {
      let acc = 0;
      for (let k = 0; k < dataCount; k++) {
        acc ^= gfMul(vand[r]![k]!, topInv[k]![c]!);
      }
      matrix[r]![c] = acc;
    }
  }

  return matrix;
}

function gfMatrixInvert(matrix: number[][], n: number): number[][] {
  const aug: number[][] = matrix.map((row, i) => {
    const r = row.slice();
    for (let j = 0; j < n; j++) r.push(j === i ? 1 : 0);
    return r;
  });

  for (let col = 0; col < n; col++) {
    let pivotRow = -1;
    for (let row = col; row < n; row++) {
      if (aug[row]![col] !== 0) {
        pivotRow = row;
        break;
      }
    }
    if (pivotRow < 0) {
      throw new NoxClientError(
        "Matrix inversion failed: singular matrix (insufficient independent shards)",
        NoxClientErrorCode.DecryptionFailed,
      );
    }

    if (pivotRow !== col) {
      [aug[col], aug[pivotRow]] = [aug[pivotRow]!, aug[col]!];
    }

    const pivotVal = aug[col]![col]!;
    if (pivotVal !== 1) {
      const invPivot = gfInv(pivotVal);
      const row = aug[col]!;
      for (let k = 0; k < 2 * n; k++) row[k] = gfMul(row[k]!, invPivot);
    }

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row]![col]!;
      if (factor === 0) continue;
      const pivRow = aug[col]!;
      const curRow = aug[row]!;
      for (let k = 0; k < 2 * n; k++) {
        curRow[k] = (curRow[k] ?? 0) ^ gfMul(factor, pivRow[k]!);
      }
    }
  }

  return aug.map((row) => row.slice(n));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
