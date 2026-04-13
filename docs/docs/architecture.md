---
sidebar_position: 9
title: Architecture
---

# Architecture

How the NOX SDK works under the hood. Read this if you want to understand the protocol, tune performance, or debug issues.

## Sphinx packets

Every message is wrapped in a **Sphinx packet**  - a fixed-size (32 KB) encrypted blob with one encryption layer per node.

- **Layered encryption**  - each node decrypts its layer, revealing only the next hop
- **Fixed size**  - all packets are exactly 32,768 bytes, so you can't distinguish a small RPC call from a large transaction
- **Unlinkable**  - the packet looks completely different at each hop; an observer watching two nodes can't tell they're handling the same message

The SDK builds packets using the WASM crypto module (`@hisoka-io/nox-wasm`), which implements Sphinx packet construction and proof-of-work in Rust compiled to WebAssembly.

## Three-layer routing

Every request passes through exactly three nodes:

```
Client  →  Entry (layer 0)  →  Mix (layer 1)  →  Exit (layer 2)  →  Destination
```

| Node | Knows your IP? | Knows the request? | Role |
|------|:-:|:-:|------|
| Entry | Yes | No | Accepts packets, holds responses |
| Mix | No | No | Relays and shuffles |
| Exit | No | Yes | Executes the request |

The SDK selects a random node from each layer for every request. Nodes are assigned layers based on their `role` value  - relay nodes (role 1) serve layers 0–1, exit-capable nodes (roles 2–3) serve all layers.

## SURBs (Single-Use Reply Blocks)

The exit node doesn't know who you are  - so how does it send the response back?

You include **SURBs** with your request. A SURB is a pre-built, encrypted return path:

1. Before sending, the SDK generates SURBs containing encrypted routing instructions for the reverse path (Exit → Mix → Entry)
2. The exit node attaches the response to a SURB and sends it back through the network
3. Each return-path node strips its encryption layer
4. The entry node holds the encrypted response until the SDK picks it up
5. The SDK decrypts the final layer using keys it stored when creating the SURB

Each SURB is single-use and carries ~30 KB of response data (`USABLE_RESPONSE_PER_SURB = 30,699 bytes`). A typical request includes 10 SURBs, supporting responses up to ~300 KB.

### SURB pool

The SDK maintains a `SurbPool` that tracks active SURBs and their decryption keys. When a response arrives, the pool matches it by SURB ID for O(1) decryption. After a request completes (or times out), its SURBs are cleaned up.

## Fragmentation and FEC

Responses larger than one SURB (~30 KB) are split into fragments by the exit node. The SDK reassembles them on the client side.

### How fragmentation works

1. The exit node splits the response into chunks that fit in a single SURB
2. Each chunk becomes a `Fragment` with a `messageId`, `sequence` number, and `totalFragments` count
3. The SDK's `Reassembler` collects fragments and reconstructs the original message when all pieces arrive

### Forward Error Correction

Packets can be lost in transit. FEC (Reed-Solomon erasure coding) adds redundancy fragments so the client can reconstruct the response even if some are missing.

With `fecRatio: 0.3`, the exit node generates 30% extra parity fragments. If the response splits into 10 data fragments, 3 parity fragments are added  - the client only needs any 10 of the 13 to reconstruct the full response.

| `fecRatio` | Overhead | Tolerates |
|-----------|----------|-----------|
| `0.0` | None | No loss  - all fragments must arrive |
| `0.2` | +20% | ~17% fragment loss |
| `0.3` | +30% | ~23% fragment loss (default) |
| `0.5` | +50% | ~33% fragment loss |

### Reassembler limits

The `Reassembler` has built-in limits to prevent memory exhaustion:

- **Max buffer:** 300 MB across all in-flight messages
- **Max concurrent messages:** 50
- **Stale timeout:** 120 seconds  - incomplete messages are pruned

## Adaptive SURB budgeting

The SDK doesn't always know how large a response will be. Sending too few SURBs means the response gets truncated. Sending too many wastes bandwidth.

The `AdaptiveSurbBudget` tracks an exponential moving average (EMA) of response sizes per operation type (e.g., `eth_blockNumber` vs. `eth_getLogs`). After the first request to an endpoint, subsequent requests automatically allocate the right number of SURBs.

For the first request to a new endpoint, the SDK uses:
1. `expectedResponseBytes` if you passed it in options
2. `surbsPerRequest` from config (default: 10)

### SURB replenishment

If the exit node runs out of SURBs mid-response, it sends a `NeedMoreSurbs` message back to the client. The SDK's `ReplenishmentManager` generates fresh SURBs and sends them in a `ReplenishSurbs` packet, allowing the exit node to continue sending fragments.

This happens transparently  - you don't need to handle it.

## Topology verification

The SDK verifies the node list it receives from seed nodes:

### Self-consistency check

The topology includes a `fingerprint`  - the XOR of `keccak256(address)` for every node. The SDK recomputes this and rejects the topology if they don't match.

### On-chain verification (optional)

When `ethRpcUrl` and `registryAddress` are configured, the SDK reads the fingerprint from the NoxRegistry smart contract and compares it to the seed node's fingerprint. This catches:

- Compromised seed nodes serving a fake topology
- Stale seed nodes serving an outdated node list
- Man-in-the-middle attacks modifying the topology in transit

```ts
const client = await NoxClient.connect({
  ethRpcUrl: "https://arb-sepolia.g.alchemy.com/v2/YOUR_KEY",
  registryAddress: "0x8626aF80db409BeD3C19871FAdf9b0Ce7Aa641Bc",
});
```

## Cover traffic

The `CoverTrafficController` sends dummy Sphinx packets at Poisson-distributed intervals. These packets are indistinguishable from real packets to any observer  - they're the same size, go through the same three-hop route, and carry random padding.

The exit node recognizes dummy packets (they carry a `Dummy` payload) and discards them. The key property is that an observer watching your connection to the entry node can't distinguish real requests from noise.

See [Cover Traffic](./cover-traffic) for configuration details.

## Transport

The SDK communicates with entry nodes over HTTPS:

- **Sending:** Sphinx packets are POSTed to the entry node
- **Receiving:** Responses are delivered via WebSocket (preferred) or HTTP polling (fallback)

The SDK auto-detects WebSocket support. When available, it subscribes to SURB IDs for push-based delivery. When not available, it polls the entry node at regular intervals.
