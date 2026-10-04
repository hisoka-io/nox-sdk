// KPS probe worker: a test-only anon-rpc worker that exercises the harness's
// KPS capability (anonRpcWorker.kps, WebRTC on the host page, streams bridged
// into this worker) and reports what happened. It is bundled to a classic IIFE
// and loaded through a real WorkerSpecifier, like any other worker.
//
//   kps-echo://<ip:port:certhash>?sizes=32,32768&seq=5&par=4&mode=dial&timeout=20000
//       dial once (mode=dial) or use kps.openStream per stream (mode=open),
//       echo each size, then seq sequential and par parallel streams of the first
//       size; responds 200 with a JSON report (ok=false when any stream failed).
//   kps-http://<ip:port:certhash>/<path>
//       one KPS-HTTP/1 exchange with the call's method, headers and body;
//       responds with the server's status, headers and body.

import type { AnonFetchResponse, AnonRequestInit, AnonRpcWorkerApi, KpsStream } from "@anon-rpc/browser-harness";
import { describe, readToEnd } from "../shared/kps-echo.js";
import { certhashOf, exchange } from "../shared/kps-http.js";
import { runEchoPlan, type ClosableStream, type StreamOpener } from "../shared/kps-probe.js";

declare const anonRpcWorker: AnonRpcWorkerApi;

const ECHO_PREFIX = "kps-echo://";
const HTTP_PREFIX = "kps-http://";
const DEFAULT_TIMEOUT_MS = 20_000;
/** Largest echo or KPS-HTTP body this probe accepts. */
const MAX_BYTES = 16 * 1024 * 1024;

const encoder = new TextEncoder();

function json(status: number, value: unknown): AnonFetchResponse {
  return {
    status,
    headers: [["content-type", "application/json"]],
    body: encoder.encode(JSON.stringify(value)),
  };
}

function intParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_BYTES) throw new Error(`bad ${name}=${raw}`);
  return value;
}

function asClosable(stream: KpsStream): ClosableStream {
  return { readable: stream.readable, writable: stream.writable, close: () => stream.close() };
}

async function kpsEcho(rest: string): Promise<AnonFetchResponse> {
  const query = rest.indexOf("?");
  const addr = query < 0 ? rest : rest.slice(0, query);
  const params = new URLSearchParams(query < 0 ? "" : rest.slice(query + 1));
  const sizes = (params.get("sizes") ?? "32").split(",").map((part) => {
    const size = Number(part);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw new Error(`bad size ${part}`);
    return size;
  });
  const plan = {
    sizes,
    sequentialStreams: intParam(params, "seq", 0),
    parallelStreams: intParam(params, "par", 0),
    streamTimeoutMs: intParam(params, "timeout", DEFAULT_TIMEOUT_MS),
  };
  const mode = params.get("mode") ?? "dial";
  anonRpcWorker.log.debug("kps echo", addr, mode);
  const started = performance.now();
  if (mode === "open") {
    // kps.openStream sugar: every stream rides its own hidden connection.
    const opener: StreamOpener = {
      openStream: async (options) => asClosable(await anonRpcWorker.kps.openStream(addr, options)),
    };
    const result = await runEchoPlan(opener, plan);
    return json(200, { ...result, mode, totalMs: Math.round(performance.now() - started) });
  }
  let conn;
  try {
    conn = await anonRpcWorker.kps.dial(addr, { signal: AbortSignal.timeout(plan.streamTimeoutMs) });
  } catch (error) {
    return json(200, { ok: false, mode, error: `dial: ${describe(error)}`, dialMs: Math.round(performance.now() - started) });
  }
  const dialMs = Math.round(performance.now() - started);
  const opener: StreamOpener = {
    openStream: async (options) => asClosable(await conn.openStream(options)),
  };
  try {
    const result = await runEchoPlan(opener, plan);
    return json(200, { ...result, mode, dialMs, remote: conn.remoteAddress });
  } finally {
    await conn.close().catch(() => undefined);
  }
}

async function bodyBytes(init: AnonRequestInit | undefined): Promise<Uint8Array> {
  const body = init?.body;
  if (body === undefined) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  return readToEnd(body, MAX_BYTES);
}

async function kpsHttp(rest: string, init: AnonRequestInit | undefined): Promise<AnonFetchResponse> {
  const slash = rest.indexOf("/");
  if (slash <= 0) throw new Error(`kps-http URL needs <addr>/<path>: ${rest}`);
  const addr = rest.slice(0, slash);
  const path = rest.slice(slash);
  const started = performance.now();
  const stream = await anonRpcWorker.kps.openStream(addr, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  try {
    const response = await exchange(
      stream,
      {
        method: (init?.method ?? "GET").toUpperCase(),
        path,
        headers: init?.headers ?? [],
        body: await bodyBytes(init),
      },
      certhashOf(addr),
      MAX_BYTES,
    );
    return {
      status: response.status,
      headers: [...response.headers, ["x-kps-ms", String(Math.round(performance.now() - started))]],
      body: response.body,
    };
  } finally {
    await stream.close().catch(() => undefined);
  }
}

async function handle(url: string, init: AnonRequestInit | undefined): Promise<AnonFetchResponse> {
  try {
    if (url.startsWith(ECHO_PREFIX)) return await kpsEcho(url.slice(ECHO_PREFIX.length));
    if (url.startsWith(HTTP_PREFIX)) return await kpsHttp(url.slice(HTTP_PREFIX.length), init);
    return json(400, { ok: false, error: `the probe worker serves ${ECHO_PREFIX} and ${HTTP_PREFIX} URLs only` });
  } catch (error) {
    return json(502, { ok: false, error: describe(error) });
  }
}

void (async () => {
  anonRpcWorker.log.info("kps-probe-worker starting");
  anonRpcWorker.signalReady();
  for (;;) {
    let call;
    try {
      call = await anonRpcWorker.acceptCall();
    } catch (error) {
      anonRpcWorker.log.error("acceptCall failed:", describe(error));
      return;
    }
    if (call.kind !== "fetch") continue;
    call.respond(handle(call.url, call.requestInit));
  }
})();
