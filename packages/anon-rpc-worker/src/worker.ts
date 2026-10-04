// Entry point of the Nox anon-rpc worker bundle: one classic-script IIFE that
// the anon-rpc harness runs with `anonRpcWorker` installed (SPEC §7).
//
// The bundle build resolves "@hisoka-io/nox-wasm" to an init that compiles the
// embedded nox-wasm bytes (no .wasm fetch) and "nox-embed:snapshot" to the
// pinned registry snapshot. Everything else lives in core.ts.
import { NoxClient, type NoxWasmBindings } from "@hisoka-io/nox-client";
import initNoxWasm, * as noxWasm from "@hisoka-io/nox-wasm";
import snapshot from "nox-embed:snapshot";
import { runNoxWorker } from "./core.js";
import type { AnonRpcWorkerApi } from "./spec-types.js";

declare const anonRpcWorker: AnonRpcWorkerApi;

void runNoxWorker(anonRpcWorker, {
  snapshot,
  loadWasm: async () => {
    await initNoxWasm();
    return noxWasm as unknown as NoxWasmBindings;
  },
  connect: (config) => NoxClient.connect(config),
});
