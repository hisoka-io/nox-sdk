// Entry point of the Nox anon-rpc worker bundle: one classic-script IIFE that
// the anon-rpc harness runs with `anonRpcWorker` installed (SPEC §7).
//
// The bundle build resolves "@hisoka-io/nox-wasm" to an init that compiles the
// embedded nox-wasm bytes (no .wasm fetch), "nox-embed:tls" to the same for
// the embedded nox-tls module, "nox-embed:tls-root" to a test bed's extra CA
// (null in release builds), "nox-embed:snapshot" to the pinned registry
// snapshot and "nox-embed:bootstrap" to the discovery bootstrap (default
// anchors, RPC providers, policy). Everything else lives in core.ts.
import { NoxClient, type NoxWasmBindings } from "@hisoka-io/nox-client";
import initNoxWasm, * as noxWasm from "@hisoka-io/nox-wasm";
import bootstrap from "nox-embed:bootstrap";
import snapshot from "nox-embed:snapshot";
import initNoxTls, * as noxTls from "nox-embed:tls";
import extraRoot from "nox-embed:tls-root";
import { installUnhandledRejectionLog, runNoxWorker } from "./core.js";
import { tlsBindings } from "./tls/module.js";
import type { AnonRpcWorkerApi } from "./spec-types.js";

declare const anonRpcWorker: AnonRpcWorkerApi;

installUnhandledRejectionLog(anonRpcWorker, globalThis);

void runNoxWorker(anonRpcWorker, {
  snapshot,
  bootstrap,
  loadWasm: async () => {
    await initNoxWasm();
    return noxWasm as unknown as NoxWasmBindings;
  },
  loadTls: async () => {
    await initNoxTls();
    return tlsBindings(noxTls, extraRoot);
  },
  connect: (config) => NoxClient.connect(config),
});
