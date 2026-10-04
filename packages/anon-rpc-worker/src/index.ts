// Placeholder anon-rpc worker that keeps the build pipeline testable.
//
// It answers fetch calls with the ambient fetch, like the upstream passthrough
// template (ethereum/anon-rpc impl/passthrough-worker), so the reproducible
// build, the keccak-256 pin and harness boots can be exercised end to end.
// Before it signals ready it initialises the embedded nox-wasm module and reads
// the pinned registry snapshot, the two inputs the Nox worker builds on. The
// Nox worker (KPS transport, Sphinx routing through the mixnet) replaces this
// file; scripts/build.mjs does not depend on anything in it.

import initNoxWasm from "@hisoka-io/nox-wasm";
import snapshot from "../snapshot/nox-snapshot.json";
import type {
  AnonFetchResponse,
  AnonRequestInit,
  AnonRpcWorkerApi,
  ByteBody,
  HeaderList,
} from "./spec-types.js";

declare const anonRpcWorker: AnonRpcWorkerApi;

/** `signalFailed` code: WebAssembly is unavailable in this sandbox. */
const FAILURE_WASM_BLOCKED = "wasm-blocked";

void run();

async function run(): Promise<void> {
  try {
    await initNoxWasm();
  } catch (error) {
    anonRpcWorker.signalFailed({
      code: FAILURE_WASM_BLOCKED,
      message:
        `nox-wasm could not be compiled or instantiated (${describe(error)}); ` +
        "the host's Content-Security-Policy must allow WebAssembly ('wasm-unsafe-eval')",
    });
    return;
  }
  anonRpcWorker.log.info("nox placeholder worker ready", {
    snapshotBlock: snapshot.blockNumber,
    registryMembers: snapshot.members.length,
  });
  anonRpcWorker.signalReady();

  for (;;) {
    let call;
    try {
      call = await anonRpcWorker.acceptCall();
    } catch (error) {
      anonRpcWorker.log.error("acceptCall failed:", describe(error));
      return;
    }
    if (call.kind !== "fetch") continue; // unknown call kinds are ignored (SPEC §8)
    call.respond(passthrough(call.url, call.requestInit));
  }
}

async function passthrough(url: string, init?: AnonRequestInit): Promise<AnonFetchResponse> {
  const response = await fetch(url, await toFetchInit(init));
  const headers: HeaderList = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  return {
    status: response.status,
    headers,
    body: new Uint8Array(await response.arrayBuffer()),
    url: response.url,
  };
}

async function toFetchInit(init?: AnonRequestInit): Promise<RequestInit | undefined> {
  if (init === undefined) return undefined;
  const out: RequestInit = {};
  if (init.method !== undefined) out.method = init.method;
  if (init.headers !== undefined) out.headers = init.headers;
  // Stream bodies are buffered: Chromium rejects stream uploads without
  // `duplex: "half"` and supports them only over HTTP/2.
  if (init.body !== undefined) out.body = await readAll(init.body);
  if (init.redirect !== undefined) out.redirect = init.redirect;
  if (init.signal !== undefined) out.signal = init.signal;
  return out;
}

function isStream(body: ByteBody): body is ReadableStream<Uint8Array> {
  // Duck-typed: a host may hand over bodies created in another realm.
  return typeof (body as Partial<ReadableStream<Uint8Array>>).getReader === "function";
}

async function readAll(body: ByteBody): Promise<Uint8Array<ArrayBuffer>> {
  if (!isStream(body)) return body.slice();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
