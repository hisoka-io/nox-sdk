// Build fixture: an entry that never uses the embedded nox-wasm module.
declare const anonRpcWorker: { signalReady(): void };
anonRpcWorker.signalReady();
