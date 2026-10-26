# nox-sdk

SDK for routing Ethereum transactions, RPC calls, and arbitrary HTTP through the [NOX mixnet](https://github.com/hisoka-io/nox).

Packages in this repo:
- [`@hisoka-io/nox-wasm`](./packages/nox-wasm) - the Rust/WASM core (Sphinx, SURBs, proof-of-work)
- [`@hisoka-io/nox-client`](./packages/nox-client) - TypeScript client that handles topology, routing, fragmentation, FEC, cover traffic
- [`@hisoka-io/anon-rpc-worker`](./packages/anon-rpc-worker) - the Nox worker for the [anon-rpc](https://github.com/ethereum/anon-rpc) standard: one hash-pinned bundle a wallet's harness loads, with end-to-end TLS to the RPC provider by default. Release 0.4.1 is published by the stable specifier [`0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A`](https://sepolia.etherscan.io/address/0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A) on Ethereum Sepolia, which follows each worker release ([deployments and trust model](./packages/anon-rpc-worker/specifier/README.md#deployments)); it runs in the browser at [demo.nox.hisoka.io/anon-rpc](https://demo.nox.hisoka.io/anon-rpc)
- [`nox-tls`](./packages/nox-tls) - the rustls TLS client compiled to WebAssembly and bundled in the worker (a Rust crate in this repo)

## Quickstart

```bash
npm install @hisoka-io/nox-client @hisoka-io/nox-wasm
```

```ts
import { NoxClient, executePaid } from "@hisoka-io/nox-client";

const client = await NoxClient.connect({
  ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
});

// Paid execution: an exit submits the call and is paid on chain by your payment source.
const result = await executePaid(client, {
  chainId, entryPoint, action, payment, maxTotalFee, intentSalt, preflight,
});

// A transaction you signed and pay gas for yourself.
await client.broadcastSignedTransaction(signedTxBytes);

const balance = await client.rpcCall("eth_getBalance", ["0x...", "latest"]);
const block = await client.blockNumber();

const resp = await client.httpRequest("GET", "https://api.example.com/price", [], new Uint8Array(0));

client.disconnect();
```

`0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6` is the NoxRegistry proxy of the current Arbitrum Sepolia testnet deployment (2026-09-25). The April
2026 registry `0x8626aF80db409BeD3C19871FAdf9b0Ce7Aa641Bc` is retired: it is not ABI-compatible with this client
and is rejected during full profile verification. The full contract set, with code hashes and pinned node
images, is in [`run-nox/configs/arbitrum-sepolia.deployment.json`](https://github.com/hisoka-io/run-nox/blob/main/configs/arbitrum-sepolia.deployment.json).

You can pass config to `connect()`:

```ts
const client = await NoxClient.connect({
  seeds: ["https://api.hisoka.io/seed"],
  ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  registryAddress: "0xF7BFf88A1412054a001Dc4b8aCBddAd6F9b26cB6",
  powDifficulty: 3,
  timeoutMs: 30_000,
  topologyRefreshMs: 60_000,
  livenessMaxAgeMs: 180_000,
  surbsPerRequest: 10,
  fecRatio: 0.3,
  retryOnTimeout: true,
  dangerouslySkipFingerprintCheck: false,
});
```

`executePaid` is the transaction path served by nox 0.4.0-rc.2 and later exits: one call for the quote, its
checks, the payment proof, the simulation, the submission and the settlement evidence. The
[client README](./packages/nox-client/README.md#paid-execution) describes its options and results.

Every option is described in the [client README](./packages/nox-client/README.md#configuration-reference),
and changes between versions are in the [changelog](./packages/nox-client/CHANGELOG.md).

See the full API and architecture docs at [docs.hisoka.io](https://docs.hisoka.io/docs/nox/sdk).

## License

[Apache-2.0](LICENSE)
