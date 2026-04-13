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

const client = await NoxClient.connect();

// submit a tx through the mixnet
const txResult = await client.submitTransaction("0xContractAddress", new Uint8Array([...]));

// or broadcast something you already signed
await client.broadcastSignedTransaction(signedTxBytes);

// rpc works too
const block = await client.blockNumber();
const receipt = await client.getTransactionReceipt("0x...");
const raw = await client.rpcCall("eth_getBalance", ["0x...", "latest"]);

// route arbitrary http through the exit node
const body = await client.httpRequest(
  "GET", "https://api.example.com/price", [], new Uint8Array(0),
);

client.disconnect();
```

You can pass config to `connect()`:

```ts
const client = await NoxClient.connect({
  seeds: ["https://your-entry-node.example.com"],
  ethRpcUrl: "https://mainnet.infura.io/v3/YOUR_KEY",
  registryAddress: "0x...",
  powDifficulty: 0,
  timeoutMs: 30_000,
  topologyRefreshMs: 60_000,
  surbsPerRequest: 10,
  fecRatio: 0.3,
  dangerouslySkipFingerprintCheck: false,
});
```

See the full API and architecture docs at [docs/](./docs/README.md).

## License

[Apache-2.0](LICENSE)
