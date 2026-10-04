/**
 * An in-memory anon-rpc harness (SPEC §7-§13) for driving the worker core:
 * buffered `acceptCall`, `respond` exactly once, `signalReady`/`signalFailed`
 * bookkeeping, a map-backed storage and captured logs.
 */
import type {
  AnonFetchResponse,
  AnonRequestInit,
  AnonRpcWorkerApi,
  IncomingCall,
  KpsApi,
  LogArg,
  StorageApi,
} from "../../src/spec-types.js";

export interface LoggedEntry {
  level: "debug" | "info" | "warn" | "error";
  args: LogArg[];
}

interface Waiter {
  resolve(call: IncomingCall): void;
  reject(error: unknown): void;
}

export class FakeHarness {
  readonly logs: LoggedEntry[] = [];
  readonly failures: { code?: string; message?: string }[] = [];
  readyCount = 0;
  readonly store = new Map<string, Uint8Array>();
  readonly api: AnonRpcWorkerApi;
  /** Calls answered, by call index: how many times `respond` ran. */
  readonly respondCounts: number[] = [];
  private readonly queue: IncomingCall[] = [];
  private readonly waiters: Waiter[] = [];
  private acceptError: unknown;
  private readyResolve!: () => void;
  readonly ready: Promise<void>;
  private failedResolve!: () => void;
  readonly failed: Promise<void>;

  constructor(config: unknown, kps: KpsApi | undefined) {
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.failed = new Promise((resolve) => {
      this.failedResolve = resolve;
    });
    const log = (level: LoggedEntry["level"]) => (...args: LogArg[]) => {
      this.logs.push({ level, args: structuredClone(args) });
    };
    const storage: StorageApi = {
      get: async (key) => this.store.get(key)?.slice(),
      set: async (key, value) => {
        this.store.set(key, value.slice());
      },
      delete: async (key) => {
        this.store.delete(key);
      },
      has: async (key) => this.store.has(key),
      list: () => {
        const keys = [...this.store.keys()];
        return (async function* () {
          yield* keys;
        })();
      },
      clear: async () => {
        this.store.clear();
      },
    };
    const api = {
      signalReady: () => {
        if (this.failures.length > 0) return;
        this.readyCount += 1;
        this.readyResolve();
      },
      signalFailed: (reason?: { code?: string; message?: string }) => {
        this.failures.push(reason ?? {});
        this.failedResolve();
      },
      acceptCall: () => this.acceptCall(),
      config: structuredClone(config),
      kps: kps as KpsApi,
      storage,
      log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    };
    if (kps === undefined) delete (api as { kps?: unknown }).kps;
    this.api = api;
  }

  /** Queue a fetch call; resolves or rejects with what the worker responds. */
  fetch(url: string, requestInit?: AnonRequestInit): Promise<AnonFetchResponse> {
    const index = this.respondCounts.length;
    this.respondCounts.push(0);
    return new Promise<AnonFetchResponse>((resolve, reject) => {
      const call: IncomingCall = {
        kind: "fetch",
        url,
        ...(requestInit === undefined ? {} : { requestInit }),
        respond: (response) => {
          this.respondCounts[index] = (this.respondCounts[index] ?? 0) + 1;
          if (this.respondCounts[index]! > 1) throw new Error("respond() called twice");
          Promise.resolve(response).then(resolve, reject);
        },
      };
      this.deliver(call);
    });
  }

  /** Queue a call of a kind the worker does not know. */
  pushUnknownKind(kind: string): void {
    this.deliver({ kind, respond: () => undefined } as unknown as IncomingCall);
  }

  /** Make the next and every pending `acceptCall` reject. */
  breakAccept(error: unknown): void {
    this.acceptError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  /** Log entries whose event (second argument) is `event`. */
  events(event: string): LoggedEntry[] {
    return this.logs.filter((entry) => entry.args[1] === event);
  }

  private deliver(call: IncomingCall): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve(call);
    else this.queue.push(call);
  }

  private acceptCall(): Promise<IncomingCall> {
    if (this.acceptError !== undefined) return Promise.reject(this.acceptError);
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

/** A `kps` capability whose dial never resolves (the core tests use a fake client instead). */
export function idleKps(): KpsApi {
  return {
    dial: () => new Promise(() => undefined),
    openStream: () => new Promise(() => undefined),
  };
}
