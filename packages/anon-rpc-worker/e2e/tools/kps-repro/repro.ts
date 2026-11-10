// KPS-only repro: dial one KPS address (WebRTC, ICE, DTLS, SCTP, KPS HELLO),
// then one KPS-HTTP/1 `GET /health` on a stream. No Nox code runs, so a failure
// here is in the browser's WebRTC or in KPS, not in the Nox worker.
//
// Open as repro.html?addr=<ip>:<port>:<certhash>. The result is shown on the
// page and kept in window.kpsRepro for scripts/kps-repro.mjs.

import { dial } from "@kpstreams/webrtc-client";

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

interface ReproResult {
  userAgent: string;
  address: string;
  steps: Step[];
  pcStates: string[];
  done: boolean;
  ok: boolean;
}

const DIAL_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 10_000;
const MAX_HEAD_BYTES = 16 * 1024;

const result: ReproResult = {
  userAgent: navigator.userAgent,
  address: new URLSearchParams(location.search).get("addr") ?? "",
  steps: [],
  pcStates: [],
  done: false,
  ok: false,
};
(window as unknown as { kpsRepro: ReproResult }).kpsRepro = result;

const out = document.getElementById("out");
function render(): void {
  if (out !== null) out.textContent = JSON.stringify(result, null, 2);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === "string" ? ` (${code})` : ""}: ${error.message}`;
  }
  return String(error);
}

async function step<T>(name: string, fn: () => Promise<T> | T, describe: (value: T) => string = () => ""): Promise<T> {
  const start = performance.now();
  try {
    const value = await fn();
    result.steps.push({ name, ok: true, ms: Math.round(performance.now() - start), detail: describe(value) });
    render();
    return value;
  } catch (error) {
    result.steps.push({ name, ok: false, ms: Math.round(performance.now() - start), detail: errorText(error) });
    render();
    throw error;
  }
}

// Record what the browser does with the munged local offer and the synthesized
// ICE-lite answer, and every ICE and connection state it passes through.
function instrumentPeerConnection(): void {
  const proto = RTCPeerConnection.prototype;
  const setLocal = proto.setLocalDescription;
  const setRemote = proto.setRemoteDescription;
  const t0 = performance.now();
  const note = (text: string): void => {
    result.pcStates.push(`+${Math.round(performance.now() - t0)}ms ${text}`);
    render();
  };
  proto.setLocalDescription = async function (this: RTCPeerConnection, ...args: Parameters<typeof setLocal>) {
    try {
      await setLocal.apply(this, args);
      note("setLocalDescription(munged offer) ok");
    } catch (error) {
      note(`setLocalDescription(munged offer) rejected: ${errorText(error)}`);
      throw error;
    }
    this.addEventListener("iceconnectionstatechange", () => note(`ice ${this.iceConnectionState}`));
    this.addEventListener("connectionstatechange", () => note(`connection ${this.connectionState}`));
    this.addEventListener("icegatheringstatechange", () => note(`gathering ${this.iceGatheringState}`));
  } as typeof setLocal;
  proto.setRemoteDescription = async function (this: RTCPeerConnection, ...args: Parameters<typeof setRemote>) {
    try {
      await setRemote.apply(this, args);
      note("setRemoteDescription(ICE-lite answer) ok");
    } catch (error) {
      note(`setRemoteDescription(ICE-lite answer) rejected: ${errorText(error)}`);
      throw error;
    }
  } as typeof setRemote;
}

async function readHead(readable: ReadableStream<Uint8Array>): Promise<string> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      const text = new TextDecoder().decode(concat(chunks, size));
      const end = text.indexOf("\r\n\r\n");
      if (end >= 0) return text.slice(0, end);
      if (size > MAX_HEAD_BYTES) throw new Error(`response head over ${MAX_HEAD_BYTES} bytes`);
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`stream ended after ${size} bytes without a complete response head`);
}

function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

async function run(): Promise<void> {
  await step("platform", () => {
    const missing: string[] = [];
    if (typeof RTCPeerConnection !== "function") missing.push("RTCPeerConnection");
    if (typeof WebAssembly !== "object") missing.push("WebAssembly (off under Lockdown Mode)");
    if (typeof crypto?.subtle?.importKey !== "function") missing.push("crypto.subtle (needs a secure context)");
    if (missing.length > 0) throw new Error(`missing: ${missing.join(", ")}`);
    return "RTCPeerConnection, WebAssembly and crypto.subtle present";
  }, (detail) => detail);
  if (result.address.length === 0) throw new Error("no ?addr=<ip>:<port>:<certhash> given");
  instrumentPeerConnection();
  const conn = await step(
    "dial (ICE, DTLS, SCTP, KPS HELLO)",
    () => dial(result.address, { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) }),
    (c) => `remote ${c.remoteAddress.ip}:${c.remoteAddress.port}`,
  );
  try {
    const stream = await step("openStream", () => conn.openStream({ signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }));
    await step("GET /health", async () => {
      const writer = stream.writable.getWriter();
      const certhash = result.address.slice(result.address.lastIndexOf(":") + 1);
      await writer.write(new TextEncoder().encode(`GET /health HTTP/1.1\r\nHost: ${certhash}\r\n\r\n`));
      writer.releaseLock();
      await stream.closeWrite();
      const head = await Promise.race([
        readHead(stream.readable),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`no response head within ${HEALTH_TIMEOUT_MS} ms`)), HEALTH_TIMEOUT_MS),
        ),
      ]);
      const status = head.split("\r\n")[0] ?? "";
      if (!/^HTTP\/1\.1 2\d\d /u.test(status)) throw new Error(`unexpected status line: ${status}`);
      return status;
    }, (status) => status);
    await stream.close();
  } finally {
    await conn.close();
  }
}

run()
  .then(() => {
    result.ok = true;
  })
  .catch(() => {
    result.ok = false;
  })
  .finally(() => {
    result.done = true;
    render();
  });
