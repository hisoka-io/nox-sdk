/**
 * The Nox anon-rpc worker (ARCHITECTURE §4.3-§4.10), written against injected
 * dependencies so it runs in Node tests with fakes: no top-level WASM, network
 * or SDK side effects. `worker.ts` wires the real harness API, the embedded
 * WASM and snapshot, and `NoxClient.connect`.
 *
 * Boot: snapshot and bootstrap check → config → platform → WASM → accept
 * loop (calls may arrive before ready) → `NoxClient.connect({ mode: "kps" })`
 * with retries → `signalReady()`. Ready means: config valid, WASM
 * initialised, pinned snapshot and discovery bootstrap verified, at least one
 * KPS anchor dialled and one served topology accepted. Only permanent faults
 * call `signalFailed`; transient ones retry forever with back-off while
 * `ready` stays pending. After ready the SDK checks NoxRegistry through the
 * mixnet in the background (S1); each verified check refreshes the
 * learned-anchor cache.
 */
import {
  eligiblePinnedMembers,
  pinnedKpsAddresses,
  verifyBootstrap,
  verifyPinnedSnapshot,
  type KpsBootstrap,
  type KpsConnLike,
  type KpsDiscoveryOptions,
  type NoxClientConfig,
  type NoxLogSink,
  type NoxWasmBindings,
  type PinnedSnapshot,
  type VerifiedDiscovery,
} from "@hisoka-io/nox-client";
import type { AnonFetchResponse, AnonRpcWorkerApi, FetchCall } from "./spec-types.js";
import { ConfigError, parseConfig, type NoxWorkerConfig } from "./config.js";
import {
  BOOT_RETRY_CODES,
  CALL_CODES,
  FAILED_CODES,
  NoxWorkerError,
  abortedByHost,
  callError,
  type BootRetryCode,
  type FailedCode,
} from "./errors.js";
import { mapClientError, prepareRequest, sendPrepared, type CallBudget, type NoxHttpPort } from "./fetch-map.js";
import { createLogger, describeError, errorCode, type LogLevel, type WorkerLogger } from "./log.js";
import {
  LearnedCacheWriter,
  RemovalCacheWriter,
  REMOVAL_CACHE_WRITE_INTERVAL_MS,
  learnedCacheRegistry,
  readLearnedCache,
  readRemovalCache,
  type LearnedForBoot,
} from "./storage.js";

/** The slice of `NoxClient` the worker uses. */
export interface NoxClientPort extends NoxHttpPort {
  readonly nodes: readonly { readonly id: string }[];
  sendEcho(data: Uint8Array): Promise<Uint8Array>;
  disconnect(): void;
}

/** Everything the worker needs from its environment. */
export interface WorkerDeps {
  /** The pinned snapshot embedded in the bundle, as parsed JSON (verified at boot). */
  readonly snapshot: unknown;
  /** The discovery bootstrap embedded in the bundle (`nox-anon-rpc-bootstrap/1`), verified at boot. */
  readonly bootstrap: unknown;
  /** Initialise the embedded WASM and return its bindings; throws when WebAssembly is blocked. */
  loadWasm(): Promise<NoxWasmBindings>;
  /** `NoxClient.connect`. */
  connect(config: NoxClientConfig): Promise<NoxClientPort>;
  /** Milliseconds since the epoch. Default `Date.now`. */
  now?(): number;
  /** Uniform in [0, 1). Default: `crypto.getRandomValues`. */
  random?(): number;
  /** Wait `ms`. Default `setTimeout`. */
  sleep?(ms: number): Promise<void>;
}

/** First boot retry delay; doubles per attempt up to `bootRetryMaxMs`, times U[0.5, 1]. */
export const BOOT_RETRY_BASE_MS = 1_000;
/** WebAssembly traps tolerated within `WASM_TRAP_WINDOW_MS` before the worker fails. */
export const WASM_TRAP_LIMIT = 3;
export const WASM_TRAP_WINDOW_MS = 60_000;
/** Bytes of the optional warm-up echo. */
export const WARMUP_ECHO_BYTES = 16;

/** Stable identity of a pinned snapshot, for the storage cache binding. */
export function snapshotIdentity(pinned: PinnedSnapshot): string {
  return `${pinned.chainId}:${pinned.registry}:${pinned.blockNumber}:${pinned.fingerprint}`;
}

/** Boot back-off for attempt `n` (1-based). */
export function bootBackoffMs(attempt: number, maxMs: number, random: () => number): number {
  const ceiling = Math.min(BOOT_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 30), maxMs);
  return Math.max(1, Math.round(ceiling * (0.5 + 0.5 * random())));
}

/** The slice of a worker global the unhandled-rejection guard uses. */
export interface RejectionEventTarget {
  addEventListener(type: "unhandledrejection", listener: (event: { reason?: unknown; preventDefault?(): void }) => void): void;
}

/** Log event for a promise rejection nothing handled. */
export const UNHANDLED_REJECTION_EVENT = "worker.unhandled";

/**
 * Log promise rejections nothing handled, with a code (ARCHITECTURE §4.3).
 * The harness does not forward them to the host, so without this a lost
 * promise would be invisible; call failures already reach the host through
 * `respond`. Returns false when `target` has no `addEventListener`.
 */
export function installUnhandledRejectionLog(api: AnonRpcWorkerApi, target: unknown): boolean {
  const events = target as Partial<RejectionEventTarget> | null | undefined;
  if (typeof events?.addEventListener !== "function") return false;
  const log = createLogger(api.log, "error");
  events.addEventListener("unhandledrejection", (event) => {
    event.preventDefault?.();
    log.error(UNHANDLED_REJECTION_EVENT, {
      code: errorCode(event.reason) ?? "error",
      reason: describeError(event.reason),
    });
  });
  return true;
}

/**
 * Run the worker until it fails or the harness stops delivering calls.
 * Never rejects: every failure path logs and, when permanent, signals failure.
 */
export async function runNoxWorker(api: AnonRpcWorkerApi, deps: WorkerDeps): Promise<void> {
  const worker = new NoxWorker(api, deps);
  try {
    await worker.boot();
  } catch (error) {
    worker.fail(FAILED_CODES.internalError, `Unexpected boot failure: ${describeError(error)}`);
  }
}

class NoxWorker {
  private log: WorkerLogger;
  private client: NoxClientPort | undefined;
  private failed = false;
  private stopped = false;
  private kpsUnsupported = false;
  private readonly readyWaiters = new Set<{ resolve(client: NoxClientPort): void; reject(error: unknown): void }>();
  private readonly trapTimes: number[] = [];
  private cacheTimer: ReturnType<typeof setInterval> | undefined;
  private learnedWriter: LearnedCacheWriter | undefined;
  private callSeq = 0;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly api: AnonRpcWorkerApi,
    private readonly deps: WorkerDeps,
  ) {
    this.log = createLogger(api.log, "info");
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? secureRandomUnit;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async boot(): Promise<void> {
    let pinned: PinnedSnapshot;
    try {
      verifyPinnedSnapshot(this.deps.snapshot as PinnedSnapshot);
      pinned = this.deps.snapshot as PinnedSnapshot;
    } catch (error) {
      this.fail(FAILED_CODES.snapshotInvalid, `The pinned snapshot in this bundle is invalid: ${describeError(error)}`);
      return;
    }

    let bootstrap: KpsBootstrap;
    try {
      bootstrap = verifyBootstrap(this.deps.bootstrap, pinned);
    } catch (error) {
      this.fail(FAILED_CODES.snapshotInvalid, `The discovery bootstrap in this bundle is invalid: ${describeError(error)}`);
      return;
    }

    let cfg: NoxWorkerConfig;
    try {
      cfg = parseConfig(this.api.config);
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : describeError(error);
      this.fail(FAILED_CODES.badConfig, message);
      return;
    }
    this.log = createLogger(this.api.log, cfg.logLevel);
    this.log.info("boot.start");
    this.log.info("boot.snapshot", {
      chainId: pinned.chainId,
      block: pinned.blockNumber,
      members: pinned.members.length,
      kpsMembers: pinnedKpsAddresses(pinned).size,
      anchors: bootstrap.anchors.length,
      discovery: cfg.discovery,
      gateways: cfg.gateways?.length ?? 0,
      bridges: cfg.bridges?.length ?? 0,
    });

    const missing = missingPlatform(this.api);
    if (missing !== null) {
      this.fail(FAILED_CODES.unsupportedPlatform, `This harness lacks ${missing}, which the Nox worker needs`);
      return;
    }

    let wasm: NoxWasmBindings;
    try {
      wasm = await this.deps.loadWasm();
    } catch (error) {
      this.fail(
        FAILED_CODES.wasmBlocked,
        `WebAssembly could not be compiled or instantiated (${describeError(error)}); ` +
          "the embedder's Content-Security-Policy must allow 'wasm-unsafe-eval'",
      );
      return;
    }
    this.log.info("boot.wasm");

    void this.acceptLoop(cfg);

    const snapshotId = snapshotIdentity(pinned);
    const nowUnix = Math.floor(this.now() / 1000);
    const stored = await readRemovalCache(this.api.storage, snapshotId, nowUnix);
    const registry = learnedCacheRegistry(pinned.chainId, pinned.registry);
    const eligible = new Set(eligiblePinnedMembers(pinned).map((member) => member.address));
    const learned = await readLearnedCache(this.api.storage, registry, pinned.blockNumber, eligible, nowUnix);
    this.log.info("boot.learned", { anchors: learned.learned.length, firstSeen: learned.firstSeen.length });
    this.learnedWriter = new LearnedCacheWriter(this.api.storage, registry);
    const client = await this.connectWithRetries(cfg, pinned, bootstrap, wasm, stored, learned);
    if (client === undefined) return;

    if (cfg.warmup) await this.warmup(client);
    if (this.failed || this.stopped) {
      client.disconnect();
      return;
    }
    this.client = client;
    this.startRemovalCache(pinned, snapshotId, stored);
    this.api.signalReady();
    this.log.info("ready");
    for (const waiter of this.readyWaiters) waiter.resolve(client);
    this.readyWaiters.clear();
  }

  /** Fail permanently: log the cause, then `signalFailed` (once). */
  fail(code: FailedCode, message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.log.error("worker.failed", { code, reason: message });
    try {
      this.api.signalFailed({ code, message });
    } catch {
      // The harness ignores repeated or late failure signals; nothing else to do.
    }
    this.shutdown(new NoxWorkerError(CALL_CODES.networkError, `The worker failed (${code})`));
  }

  private shutdown(reason: NoxWorkerError): void {
    if (this.cacheTimer !== undefined) clearInterval(this.cacheTimer);
    this.cacheTimer = undefined;
    this.client?.disconnect();
    this.client = undefined;
    for (const waiter of this.readyWaiters) waiter.reject(reason);
    this.readyWaiters.clear();
  }

  private async connectWithRetries(
    cfg: NoxWorkerConfig,
    pinned: PinnedSnapshot,
    bootstrap: KpsBootstrap,
    wasm: NoxWasmBindings,
    deprioritize: readonly string[],
    learned: LearnedForBoot,
  ): Promise<NoxClientPort | undefined> {
    const dial = this.api.kps.dial.bind(this.api.kps);
    const kpsDial = async (address: string, opts?: { signal?: AbortSignal }): Promise<KpsConnLike> => {
      try {
        return await dial(address, opts) as unknown as KpsConnLike;
      } catch (error) {
        if (errorCode(error) === "unsupported") this.kpsUnsupported = true;
        throw error;
      }
    };
    const config: NoxClientConfig = {
      mode: "kps",
      wasm,
      log: this.sdkLogSink(),
      timeoutMs: cfg.attemptTimeoutMs,
      surbFormat: cfg.surbFormat,
      kps: {
        dial: kpsDial,
        pinned,
        topologySources: cfg.topologySources,
        claimIntervalMs: cfg.claimIntervalMs,
        discovery: this.discoveryOptions(cfg, bootstrap, learned),
        ...(deprioritize.length === 0 ? {} : { deprioritize }),
      },
    };
    for (let attempt = 1; ; attempt++) {
      if (this.failed || this.stopped) return undefined;
      try {
        const client = await this.deps.connect(config);
        if (this.failed || this.stopped) {
          client.disconnect();
          return undefined;
        }
        return client;
      } catch (error) {
        if (this.failed || this.stopped) return undefined;
        const code = errorCode(error);
        if (code === "TOPOLOGY_STALE") {
          this.fail(FAILED_CODES.snapshotStale, `This bundle's pinned node set is superseded: ${describeError(error)}`);
          return undefined;
        }
        if (this.kpsUnsupported) {
          this.fail(FAILED_CODES.unsupportedPlatform, "This harness does not support KPS dialing (anonRpcWorker.kps)");
          return undefined;
        }
        if (code === "WASM_NOT_INITIALIZED") {
          this.fail(FAILED_CODES.wasmBlocked, `WebAssembly bindings are unusable: ${describeError(error)}`);
          return undefined;
        }
        if (code === "INVALID_CONFIG" || code === "MODE_VIOLATION") {
          this.fail(FAILED_CODES.internalError, `The worker built an invalid client config: ${describeError(error)}`);
          return undefined;
        }
        const delayMs = bootBackoffMs(attempt, cfg.bootRetryMaxMs, this.random);
        this.log.warn("boot.retry", { attempt, code: bootRetryCode(code), delayMs, reason: describeError(error) });
        await this.sleep(delayMs);
      }
    }
  }

  /** SDK discovery options from the config, the bundle's bootstrap and the learned-anchor cache. */
  private discoveryOptions(cfg: NoxWorkerConfig, bootstrap: KpsBootstrap, learned: LearnedForBoot): KpsDiscoveryOptions {
    return {
      bootstrap,
      chain: cfg.discovery === "chain",
      onVerified: (state) => this.onVerified(state),
      ...(cfg.gateways === undefined ? {} : { gateways: cfg.gateways }),
      ...(cfg.bridges === undefined ? {} : { bridges: cfg.bridges }),
      // With bridges the worker never dials a published address, learned ones included.
      ...(cfg.bridges === undefined && learned.learned.length > 0 ? { learned: learned.learned } : {}),
      ...(learned.firstSeen.length > 0 ? { firstSeen: learned.firstSeen } : {}),
      ...(cfg.registryRpcUrls === undefined ? {} : { registryRpcUrls: cfg.registryRpcUrls }),
      ...(cfg.chainQuorum === undefined ? {} : { chainQuorum: cfg.chainQuorum }),
    };
  }

  /** A verified chain check: refresh the learned-anchor cache (best effort). */
  private onVerified(state: VerifiedDiscovery): void {
    const writer = this.learnedWriter;
    if (writer === undefined || this.failed) return;
    writer.update(state, this.now()).then(
      (wrote) => {
        if (wrote) this.log.debug("storage.learned", { anchors: state.members.filter((m) => m.kpsAddress !== null).length });
      },
      (error: unknown) => this.log.warn("storage.failed", { code: errorCode(error) ?? "error" }),
    );
  }

  private async warmup(client: NoxClientPort): Promise<void> {
    const probe = new Uint8Array(WARMUP_ECHO_BYTES);
    crypto.getRandomValues(probe);
    const started = this.now();
    try {
      const echoed = await client.sendEcho(probe);
      const same = echoed.length === probe.length && echoed.every((byte, index) => byte === probe[index]);
      this.log.info("boot.warmup", { ok: same, ms: this.now() - started });
    } catch (error) {
      // The KPS entry already answered; a lost echo is logged and boot goes on.
      this.log.warn("boot.warmup", { ok: false, code: errorCode(error) ?? "error", ms: this.now() - started });
    }
  }

  /** SDK diagnostics to the host log; `topology.stale` after ready fails the worker. */
  private sdkLogSink(): NoxLogSink {
    return (level, event, fields) => {
      const logLevel: LogLevel = level;
      this.log[logLevel](event, fields);
      if (event === "topology.stale" && this.client !== undefined) {
        this.fail(FAILED_CODES.snapshotStale, "Served topologies agree the registry no longer lists every pinned member of a route layer");
      }
    };
  }

  private startRemovalCache(pinned: PinnedSnapshot, snapshotId: string, stored: readonly string[]): void {
    const storage = this.api.storage;
    if (storage === undefined) return;
    const writer = new RemovalCacheWriter(storage, snapshotId, pinned.blockNumber, stored);
    const eligible = eligiblePinnedMembers(pinned).map((member) => member.address);
    this.cacheTimer = setInterval(() => {
      const client = this.client;
      if (client === undefined) return;
      const present = new Set(client.nodes.map((node) => node.id));
      const removed = eligible.filter((address) => !present.has(address));
      writer.update(removed, this.now()).then(
        (wrote) => {
          if (wrote) this.log.debug("storage.removed", { removed: removed.length });
        },
        (error: unknown) => this.log.warn("storage.failed", { code: errorCode(error) ?? "error" }),
      );
    }, REMOVAL_CACHE_WRITE_INTERVAL_MS);
  }

  private async acceptLoop(cfg: NoxWorkerConfig): Promise<void> {
    const slots = new Semaphore(cfg.maxConcurrentCalls);
    for (;;) {
      await slots.acquire();
      if (this.failed) return;
      let call;
      try {
        call = await this.api.acceptCall();
      } catch (error) {
        // The call source is gone: fail loudly so the host never waits on a
        // worker that can no longer serve (ARCHITECTURE §4.4).
        slots.release();
        if (this.failed) return;
        this.stopped = true;
        this.log.error("accept.failed", { code: errorCode(error) ?? "error", reason: describeError(error) });
        this.fail(FAILED_CODES.internalError, `acceptCall rejected: ${describeError(error)}`);
        return;
      }
      if (call.kind !== "fetch") {
        // Unknown call kinds are ignored (SPEC §8).
        slots.release();
        this.log.debug("call.ignored", { kind: String((call as { kind?: unknown }).kind).slice(0, 32) });
        continue;
      }
      const result = this.handleFetch(call, cfg).finally(() => slots.release());
      result.catch(() => undefined);
      try {
        call.respond(result);
      } catch (error) {
        this.log.error("respond.failed", { reason: describeError(error) });
      }
    }
  }

  private async handleFetch(call: FetchCall, cfg: NoxWorkerConfig): Promise<AnonFetchResponse> {
    const seq = ++this.callSeq;
    const started = this.now();
    const budget = new CallControl(call.requestInit?.signal, cfg.callDeadlineMs, this.now);
    try {
      const prepared = await prepareRequest(call.url, call.requestInit, cfg, budget.signal);
      const client = await this.waitReady(budget.signal);
      const response = await sendPrepared(prepared, client, cfg, budget);
      if (this.log.enabled("debug")) {
        this.log.debug("call.done", {
          seq,
          jsonrpcMethod: prepared.profile.method ?? null,
          bytesOut: prepared.body.length,
          bytesIn: response.body instanceof Uint8Array ? response.body.length : null,
          ms: this.now() - started,
          outcome: "ok",
        });
      }
      return response;
    } catch (error) {
      const final = budget.signal.aborted ? budget.signal.reason : mapClientError(error);
      this.noteTrap(error);
      this.log.debug("call.done", { seq, ms: this.now() - started, outcome: errorCode(final) ?? "error" });
      throw final;
    } finally {
      budget.dispose();
    }
  }

  private waitReady(signal: AbortSignal): Promise<NoxClientPort> {
    if (this.client !== undefined) return Promise.resolve(this.client);
    if (this.failed || this.stopped) {
      return Promise.reject(callError(CALL_CODES.networkError, "The worker is not running"));
    }
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<NoxClientPort>((resolve, reject) => {
      const waiter = {
        resolve: (client: NoxClientPort) => {
          signal.removeEventListener("abort", onAbort);
          resolve(client);
        },
        reject: (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        this.readyWaiters.delete(waiter);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.readyWaiters.add(waiter);
    });
  }

  /** Repeated WebAssembly traps leave the instance in an unknown state: fail after `WASM_TRAP_LIMIT`. */
  private noteTrap(error: unknown): void {
    if (!isWasmTrap(error)) return;
    const now = this.now();
    this.trapTimes.push(now);
    while (this.trapTimes.length > 0 && now - this.trapTimes[0]! > WASM_TRAP_WINDOW_MS) this.trapTimes.shift();
    this.log.warn("wasm.trap", { count: this.trapTimes.length });
    if (this.trapTimes.length >= WASM_TRAP_LIMIT) {
      this.fail(FAILED_CODES.internalError, `WebAssembly trapped ${this.trapTimes.length} times within ${WASM_TRAP_WINDOW_MS} ms`);
    }
  }
}

/** Deadline plus host abort for one call. The signal's reason is the call's rejection. */
class CallControl implements CallBudget {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly deadline: number;
  private readonly onHostAbort: () => void;

  constructor(
    private readonly host: AbortSignal | undefined,
    deadlineMs: number,
    private readonly now: () => number,
  ) {
    this.deadline = now() + deadlineMs;
    this.onHostAbort = () => this.abort(abortedByHost());
    if (host?.aborted === true) this.abort(abortedByHost());
    else host?.addEventListener("abort", this.onHostAbort, { once: true });
    this.timer = setTimeout(
      () => this.abort(callError(CALL_CODES.timeout, `The call did not complete within ${deadlineMs} ms`)),
      deadlineMs,
    );
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  remainingMs(): number {
    return this.deadline - this.now();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.host?.removeEventListener("abort", this.onHostAbort);
  }

  private abort(reason: NoxWorkerError): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }
}

/** FIFO counting semaphore for the accept loop's back-pressure. */
class Semaphore {
  private readonly waiters: (() => void)[] = [];

  constructor(private available: number) {}

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.available += 1;
  }
}

/** What the platform lacks, or `null`. */
function missingPlatform(api: AnonRpcWorkerApi): string | null {
  const kps = (api as { kps?: { dial?: unknown } }).kps;
  if (typeof kps !== "object" || kps === null || typeof kps.dial !== "function") return "anonRpcWorker.kps.dial";
  if (typeof globalThis.crypto?.getRandomValues !== "function") return "crypto.getRandomValues";
  const wasm = (globalThis as { WebAssembly?: unknown }).WebAssembly;
  if (typeof wasm !== "object" || wasm === null) return "WebAssembly";
  if (typeof AbortController !== "function" || typeof ReadableStream !== "function") return "AbortController/ReadableStream";
  return null;
}

function bootRetryCode(code: string | undefined): BootRetryCode {
  switch (code) {
    case "KPS_UNAVAILABLE":
      return BOOT_RETRY_CODES.noAnchorReachable;
    case "TOPOLOGY_FETCH_FAILED":
      return BOOT_RETRY_CODES.topologyFetchFailed;
    case "TOPOLOGY_VERIFICATION_FAILED":
    case "NO_NODES_AVAILABLE":
      return BOOT_RETRY_CODES.topologyRejected;
    default:
      return BOOT_RETRY_CODES.kpsDialFailed;
  }
}

/** A `WebAssembly.RuntimeError` anywhere in the cause chain. */
function isWasmTrap(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ((current as { name?: unknown }).name === "RuntimeError") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function secureRandomUnit(): number {
  const word = new Uint32Array(1);
  crypto.getRandomValues(word);
  return word[0]! / 2 ** 32;
}
