// Leaky worker: a test-only anon-rpc worker that does exactly what the Nox
// worker must never do. While it gets ready it opens ambient WebSockets and
// ambient fetches straight from the browser (the TEST-PLAN F16 shape: a
// transport that falls back to globalThis.WebSocket). It is the negative
// control for the egress check: the check has to flag every one of them.
//
// Config: { websockets: string[], fetches: string[], settleMs: number }.
// Every call is answered with a JSON report of what each leak did.

import type { AnonFetchResponse, AnonRpcWorkerApi } from "@anon-rpc/browser-harness";

declare const anonRpcWorker: AnonRpcWorkerApi;

interface LeakConfig {
  readonly websockets: readonly string[];
  readonly fetches: readonly string[];
  readonly settleMs: number;
}

interface LeakOutcome {
  readonly url: string;
  readonly outcome: string;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

function parseConfig(raw: unknown): LeakConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const websockets = stringList(record["websockets"]);
  const fetches = stringList(record["fetches"]);
  const settleMs = record["settleMs"];
  if (websockets === undefined || fetches === undefined) return undefined;
  if (typeof settleMs !== "number" || !Number.isSafeInteger(settleMs) || settleMs <= 0) return undefined;
  return { websockets, fetches, settleMs };
}

function openSocket(url: string, settleMs: number): Promise<LeakOutcome> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      resolve({ url, outcome: `constructor threw: ${String(error)}` });
      return;
    }
    const timer = setTimeout(() => resolve({ url, outcome: "no event within settleMs" }), settleMs);
    const settle = (outcome: string): void => {
      clearTimeout(timer);
      resolve({ url, outcome });
    };
    socket.addEventListener("open", () => {
      settle("open");
      socket.close();
    });
    socket.addEventListener("error", () => settle("error"));
  });
}

async function ambientFetch(url: string, settleMs: number): Promise<LeakOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settleMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return { url, outcome: `status ${response.status}` };
  } catch (error) {
    return { url, outcome: `rejected: ${error instanceof Error ? error.name : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function report(value: unknown): AnonFetchResponse {
  return {
    status: 200,
    headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

void (async () => {
  const config = parseConfig(anonRpcWorker.config);
  if (config === undefined) {
    anonRpcWorker.signalFailed({ code: "bad-config", message: "leaky worker needs {websockets, fetches, settleMs}" });
    return;
  }
  const leaks = await Promise.all([
    ...config.websockets.map((url) => openSocket(url, config.settleMs)),
    ...config.fetches.map((url) => ambientFetch(url, config.settleMs)),
  ]);
  anonRpcWorker.signalReady();
  for (;;) {
    let call;
    try {
      call = await anonRpcWorker.acceptCall();
    } catch (error) {
      anonRpcWorker.log.error("acceptCall failed:", String(error));
      return;
    }
    call.respond(report({ leaks }));
  }
})();
