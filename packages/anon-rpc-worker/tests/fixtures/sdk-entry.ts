// Build fixture: a worker entry that uses the SDK sources and the embedded
// nox-wasm module, as the Nox worker will. It only has to bundle.
import { computeTopologyFingerprint } from "@hisoka-io/nox-client";
import initNoxWasm, { topology_fingerprint } from "@hisoka-io/nox-wasm";

declare const anonRpcWorker: { signalReady(): void; log: { info(...args: unknown[]): void } };

void (async () => {
  await initNoxWasm();
  anonRpcWorker.log.info(computeTopologyFingerprint([]), topology_fingerprint([]));
  anonRpcWorker.signalReady();
})();
