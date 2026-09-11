# nox-sdk

SDK for routing Ethereum transactions, RPC calls, and arbitrary HTTP through the [NOX mixnet](https://github.com/hisoka-io/nox).

Two packages:
- [`@hisoka-io/nox-wasm`](./packages/nox-wasm) - the Rust/WASM core (Sphinx, SURBs, proof-of-work)
- [`@hisoka-io/nox-client`](./packages/nox-client) - TypeScript client that handles topology, routing, fragmentation, FEC, cover traffic

## Quickstart

```bash
npm install @hisoka-io/nox-client @hisoka-io/nox-wasm
```

```ts
import { NoxClient } from "@hisoka-io/nox-client";

const client = await NoxClient.connect({
  ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  registryAddress: "0xCURRENT_NOX_REGISTRY",
});

await client.submitTransaction("0xContractAddress", calldata);
await client.broadcastSignedTransaction(signedTxBytes);

const balance = await client.rpcCall("eth_getBalance", ["0x...", "latest"]);
const block = await client.blockNumber();

const resp = await client.httpRequest("GET", "https://api.example.com/price", [], new Uint8Array(0));

client.disconnect();
```

Replace the registry placeholder with the address in the current signed deployment record. The retired April
testnet Registry is not ABI-compatible with this client and is rejected during full profile verification.

You can pass config to `connect()`:

```ts
const client = await NoxClient.connect({
  seeds: ["https://api.hisoka.io/seed"],
  ethRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
  registryAddress: "0xCURRENT_NOX_REGISTRY",
  powDifficulty: 3,
  timeoutMs: 30_000,
  topologyRefreshMs: 60_000,
  livenessMaxAgeMs: 180_000,
  surbsPerRequest: 10,
  fecRatio: 0.3,
  dangerouslySkipFingerprintCheck: false,
});
```

See the full API and architecture docs at [docs.hisoka.io](https://docs.hisoka.io).

## License

[Apache-2.0](LICENSE)
