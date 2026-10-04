// Build fixture: a worker entry that uses the SDK sources, the embedded
// nox-wasm module and the pinned snapshot, as the Nox worker does. It only has
// to bundle.
import { computeTopologyFingerprint } from "@hisoka-io/nox-client";
import initNoxWasm, { topology_fingerprint } from "@hisoka-io/nox-wasm";
import snapshot from "nox-embed:snapshot";

declare const anonRpcWorker: { signalReady(): void; log: { info(...args: unknown[]): void } };

void (async () => {
  await initNoxWasm();
  anonRpcWorker.log.info(computeTopologyFingerprint([]), topology_fingerprint([]), snapshot);
  anonRpcWorker.signalReady();
})();
