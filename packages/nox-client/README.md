# @hisoka-io/nox-client

TypeScript client SDK for the NOX mixnet. Route Ethereum transactions, JSON RPC calls, and HTTP requests through a 3-hop Sphinx mix network for network-layer privacy.

## Install

```bash
npm install @hisoka-io/nox-client
```

The WASM dependency (`@hisoka-io/nox-wasm`) is installed automatically.

## Quick start

```ts
import { NoxClient } from "@hisoka-io/nox-client";

const client = await NoxClient.init();

const balance = await client.rpcCall("eth_getBalance", ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"]);
console.log(balance);

client.disconnect();
```

`init()` connects to the Hisoka testnet with production defaults (seed discovery, PoW, timeouts). No configuration needed.

## Usage

### Connect with overrides

```ts
// Override specific settings while keeping the rest as defaults
const client = await NoxClient.init({ timeoutMs: 60_000, surbsPerRequest: 20 });
```

### Full custom configuration

For local development or connecting to a custom mesh:

```ts
const client = await NoxClient.connect({
  seeds: ["http://localhost:14001"],
  powDifficulty: 0,
  timeoutMs: 30_000,
  dangerouslySkipFingerprintCheck: true,
});
```

### Submit a transaction

```ts
const response = await client.submitTransaction(
  "0xContractAddress",
  calldata, // Uint8Array
);
```

The transaction is wrapped in a Sphinx packet, routed through 3 relay nodes, and executed by the exit node. The response comes back through Single-Use Reply Blocks (SURBs) so the exit node never learns who sent the request.

### Broadcast a signed transaction

```ts
const txHash = await client.broadcastSignedTransaction(signedTxBytes);
```

### JSON RPC calls

```ts
const blockNumber = await client.rpcCall("eth_blockNumber", []);
const balance = await client.rpcCall("eth_getBalance", [address, "latest"]);
const logs = await client.rpcCall("eth_getLogs", [{ address, fromBlock: "0x0", toBlock: "latest" }]);
```

All RPC calls are routed through the mixnet. The exit node forwards them to its configured Ethereum RPC endpoint.

### HTTP requests

```ts
const body = await client.httpRequest(
  "GET",
  "https://api.example.com/data",
  { "Accept": "application/json" },
  new Uint8Array(0),
);
```

### Cover traffic

Send dummy packets at a configurable rate to hide when you're actually using the network:

```ts
import { createCoverController } from "@hisoka-io/nox-client";

const cover = createCoverController(client);
cover.start({ lambdaP: 1.0 }); // ~1 packet/sec (Poisson)
cover.stop();
```

### Disconnect

```ts
client.disconnect();
```

## Configuration reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `seeds` | `string[]` | `["https://api.hisoka.io/seed"]` | Seed node URLs for topology discovery |
| `powDifficulty` | `number` | `3` | Proof-of-work difficulty (anti-spam) |
| `timeoutMs` | `number` | `30000` | Per-request timeout in milliseconds |
| `surbsPerRequest` | `number` | `10` | SURBs sent with each request (~30KB each) |
| `topologyRefreshMs` | `number` | `60000` | Background topology refresh interval |
| `fecRatio` | `number` | `0.3` | Reed-Solomon FEC redundancy ratio (0.0--1.0) |
| `ethRpcUrl` | `string` | `""` | Ethereum RPC for on-chain topology verification |
| `registryAddress` | `string` | `""` | NoxRegistry contract address |
| `dangerouslySkipFingerprintCheck` | `boolean` | `true` | Skip topology fingerprint verification |

All fields are optional. `NoxClient.init()` uses these defaults. `NoxClient.connect()` also falls back to these defaults for any unset field.

To inspect or spread the defaults programmatically:

```ts
import { DEFAULTS } from "@hisoka-io/nox-client";

const client = await NoxClient.connect({
  ...DEFAULTS,
  timeoutMs: 60_000,
  ethRpcUrl: "https://eth.llamarpc.com",
  registryAddress: "0x...",
  dangerouslySkipFingerprintCheck: false,
});
```

## How it works

1. Client fetches the network topology from a seed node (list of relay nodes with their Sphinx public keys)
2. Selects a 3-hop route: entry node, mix node, exit node
3. For each request, builds a Sphinx packet with layered encryption -- each relay can only decrypt its own layer and learn the next hop
4. Packet is sent to the entry node via HTTPS
5. Each relay peels one encryption layer and forwards to the next hop via libp2p
6. Exit node decrypts the final layer, executes the request (RPC, transaction, or HTTP fetch), and sends the response back through SURBs
7. SURBs are pre-built anonymous return paths -- the exit node packs the response without knowing the destination
8. Client polls the entry node for responses and decrypts them using SURB recovery keys

Large responses are automatically fragmented and reassembled with Reed-Solomon forward error correction.

## Requirements

Node.js 18+. Works in browsers with WASM support.

## License

Apache-2.0
