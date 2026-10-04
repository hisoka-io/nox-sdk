// Host page script, bundled by esbuild once per harness version (the version is
// selected with an import alias). It exposes window.e2e for Playwright: boot an
// AnonRpcWorker from a specifier, call worker.fetch, drain worker logs, and dial
// KPS directly with the same @kpstreams/webrtc-client the harness uses.

import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { dial } from "@kpstreams/webrtc-client";
import { describe } from "../shared/kps-echo.js";
import { runEchoPlan } from "../shared/kps-probe.js";
import type {
  BootRequest,
  BootResult,
  DirectEchoRequest,
  DirectEchoResult,
  E2EPageApi,
  ErrorInfo,
  FetchRequest,
  FetchResult,
  LogLine,
} from "./api.js";

declare const __HARNESS_VERSION__: string;

interface RpcProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const workers = new Map<string, AnonRpcWorker>();

function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error || (typeof error === "object" && error !== null && "message" in error)) {
    const record = error as { name?: unknown; message?: unknown; code?: unknown };
    const base = {
      name: typeof record.name === "string" ? record.name : "Error",
      message: typeof record.message === "string" ? record.message : String(error),
    };
    return typeof record.code === "string" ? { ...base, code: record.code } : base;
  }
  return { name: "Error", message: String(error) };
}

/** preExisting.rpcProvider: plain JSON-RPC over the page's own fetch. */
function rpcProvider(url: string): RpcProvider {
  let id = 0;
  return {
    async request({ method, params }) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      });
      const reply = (await response.json()) as { result?: unknown; error?: { message?: string } };
      if (reply.error !== undefined) throw new Error(`${method}: ${reply.error.message ?? "RPC error"}`);
      return reply.result;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function workerFor(id: string): AnonRpcWorker {
  const worker = workers.get(id);
  if (worker === undefined) throw new Error(`no worker booted under id ${id}`);
  return worker;
}

function renderArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Uint8Array) return `<${arg.byteLength} bytes>`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

const api: E2EPageApi = {
  harnessVersion: __HARNESS_VERSION__,

  async boot(request: BootRequest): Promise<BootResult> {
    const started = performance.now();
    const before = new Set(document.querySelectorAll("iframe"));
    const hasConfig = Object.prototype.hasOwnProperty.call(request, "config");
    workers.get(request.id)?.close();
    const worker = new AnonRpcWorker({
      address: request.address,
      preExisting: { rpcProvider: rpcProvider(request.specifierRpcUrl) },
      ...(hasConfig ? { config: request.config } : {}),
    });
    workers.set(request.id, worker);
    // The harness creates its iframe once the bundle is verified, so look for
    // it after `ready` settles.
    const sandboxOfNewFrame = (): string | null => {
      const frame = [...document.querySelectorAll("iframe")].find((candidate) => !before.has(candidate));
      return frame?.getAttribute("sandbox") ?? null;
    };
    try {
      await withTimeout(worker.ready, request.readyTimeoutMs, "worker.ready");
      return { ok: true, readyMs: Math.round(performance.now() - started), sandbox: sandboxOfNewFrame() };
    } catch (error) {
      return {
        ok: false,
        readyMs: Math.round(performance.now() - started),
        error: errorInfo(error),
        sandbox: sandboxOfNewFrame(),
      };
    }
  },

  async fetch(request: FetchRequest): Promise<FetchResult> {
    const worker = workerFor(request.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`call exceeded ${request.timeoutMs} ms`)), request.timeoutMs);
    const abortAfter = request.abortAfterMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), request.abortAfterMs);
    const started = performance.now();
    try {
      const init: RequestInit = { method: request.method ?? "GET", signal: controller.signal };
      if (request.headers !== undefined) init.headers = request.headers.map(([k, v]) => [k, v]);
      if (request.body !== undefined) init.body = request.body;
      const response = await worker.fetch(request.url, init);
      const bodyText = await response.text();
      const headers: [string, string][] = [];
      response.headers.forEach((value, name) => headers.push([name, value]));
      return { ok: true, ms: Math.round(performance.now() - started), status: response.status, headers, bodyText };
    } catch (error) {
      return { ok: false, ms: Math.round(performance.now() - started), error: errorInfo(error) };
    } finally {
      clearTimeout(timeout);
      if (abortAfter !== undefined) clearTimeout(abortAfter);
    }
  },

  async logs(id: string, max: number, waitMs: number): Promise<LogLine[]> {
    const worker = workerFor(id);
    const out: LogLine[] = [];
    while (out.length < max) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), waitMs);
      try {
        const entry = await worker.acceptLog({ signal: controller.signal });
        out.push({ level: entry.level, text: entry.args.map(renderArg).join(" ") });
      } catch {
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    return out;
  },

  close(id: string): void {
    workers.get(id)?.close();
    workers.delete(id);
  },

  async directKpsEcho(request: DirectEchoRequest): Promise<DirectEchoResult> {
    const started = performance.now();
    let conn: Awaited<ReturnType<typeof dial>>;
    try {
      conn = await dial(request.addr, { signal: AbortSignal.timeout(request.dialTimeoutMs) });
    } catch (error) {
      return {
        ok: false,
        dialMs: Math.round(performance.now() - started),
        samples: [],
        sequential: [],
        parallel: [],
        error: describe(error),
      };
    }
    const dialMs = Math.round(performance.now() - started);
    try {
      const result = await runEchoPlan(conn, request);
      return { ...result, dialMs, remote: conn.remoteAddress };
    } finally {
      await conn.close().catch(() => undefined);
    }
  },
};

window.e2e = api;
