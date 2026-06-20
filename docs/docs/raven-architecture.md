---
sidebar_position: 3
title: Raven Architecture
---

# Raven Architecture

Raven's production deployment for Railgun runs six InsPIRe instances on Ethereum mainnet. This page covers the internal architecture: how queries flow from client to server, how the PIR engine handles updates without blocking live queries, and how the two-engine main+sidecar pattern enables private reads of mutable state.

## Two workspaces, one clean separation

The Raven codebase is split into two physically separate Cargo workspaces:

**Framework** (`raven/crates/`): storage traits, the PIR scheme abstraction, instance lifecycle, the InsPIRe implementation, the WASM client, crypto primitives, and the binary fuse filter. No Hisoka-specific, Railgun-specific, or note/memo naming anywhere in these crates. This workspace compiles to WASM cleanly because native dependencies never feature-unify into it.

**Adapter** (`raven/adapters/railgun/`): the Ethereum indexer, Railgun event decoding, PIR table encoders, the HTTP server, CLI, WASM client bundle, and TypeScript SDK. This is the only live serving path. The separation means the framework can be reused for any PIR application without pulling in blockchain-specific code.

## Query flow

A client interaction follows these steps:

```
Client                              Raven Server
  │                                      │
  ├─ GET /v1/instance/:id/params ───────►│
  │◄─ InspireParams + CRS ───────────────┤
  │                                      │
  ├─ Build ClientSession (WASM) ─────────┤  (local, ~3.8s first time)
  │                                      │
  ├─ POST /session (packing keys) ──────►│  (saves ~48 KB/query bandwidth)
  │                                      │
  ├─ query_seeded (local, WASM) ─────────┤  (produces encrypted PIR query)
  │                                      │
  ├─ POST /query ───────────────────────►│
  │                                      ├─ respond_seeded_inspiring_cached
  │                                      │    (uses InspiRING + packing cache)
  │◄─ encrypted PIR response ────────────┤
  │                                      │
  ├─ extract_response (local, WASM) ─────┤  (decrypts; learns the record)
```

The server never sees the plaintext query index. It processes a Ring-LWE ciphertext and returns an encrypted response. The client decrypts locally.

**Session residue.** A full `ClientSession` at ring dimension 2048 is over 160 MB (the automorphism tables) and takes roughly 3.8 seconds to build. Rather than rebuilding it on every page load, the client stores a `SessionResidue`: roughly 1.25 MB containing the CRS, RLWE secret key, and packing keys: in IndexedDB. Subsequent queries rehydrate from the residue without recomputing the tables. The CRS itself was shrunk from 34.9 MB to 1.13 MB on the wire through seeded generation.

## Addressing: commitment as keyword

In the Railgun deployment, the "index" Raven fetches is keyed by a blinded commitment. The PIR table encodes PPOI status and Merkle paths in fixed-width rows. The encoder maps a blinded commitment to a dense row index (its position in the commitment tree leaf ordering). The client does the same mapping locally, builds a query for that index, and the server responds without learning which commitment was queried.

Six encoder types cover the three PIR primitives:

| Encoder label | Record shape | What it serves |
|---|---|---|
| `per-leaf-bc` | Blinded commitment (indexed) | Commitment lookup |
| `per-leaf-path` | 512 B | Commitment-tree Merkle path |
| `per-node` | 32 B | Commitment-tree node |
| `per-list-status` | Status byte | PPOI status per list |
| `per-list-path` | 512 B | PPOI Merkle auth path |
| `per-list-node` | 32 B | PPOI Merkle node |

Encoder labels are a cross-crate string contract: CLI, TOML config, engine, and SDK must all use the same strings. Renaming them breaks deployed configurations.

## Blue-green rebuild

The on-chain commitment tree grows with every Ethereum block. When new events arrive, the PIR table must be updated: but rebuilding a PIR table from scratch is expensive, and live queries cannot wait.

Raven uses a blue-green rebuild: the server maintains two InsPIRe engine instances. One instance is "hot" and serves live queries. The second instance absorbs new chain events in the background, rebuilding the affected shards. When the background rebuild is complete, the server atomically swaps the two instances using `ArcSwap::rcu`. Live queries never block on indexing.

The key insight is that re-encoding is **shard-local**: updating one leaf requires re-encoding only the shards whose rows contain that leaf's data. The "shard-dirty" optimization reduces the re-encode cost from O(leaf_index × depth) to O(shards × depth): roughly a 2000x reduction for typical event volumes.

## Main + sidecar (for mutable state)

Blue-green handles append-only updates efficiently. Mutable state (where existing records change value, as in account balances) requires a different approach. The main + sidecar pattern handles this.

**Main engine:** holds the full corpus as of the last "fold" operation. Serves the baseline data.

**Sidecar engine:** holds only the rows that changed since the last fold. It is small and cheap to rebuild because it covers only the delta.

**Read path:** on every query, both engines are queried for the same leaf index. The client receives both responses and selects the fresher one based on the decrypted presence tag. Critically, both queries are always sent regardless of which holds the fresh data: this prevents timing-based inference about whether the record was recently updated.

**Fold operation:** periodically, the sidecar's dirty rows are merged into the main engine. Only the affected shards are re-encoded (not the full corpus). After the fold, the sidecar is reset to empty. The fold is crash-safe: it commits in the order snapshot → manifest → sidecar reset, so a crash at any point leaves a recoverable state.

The main + sidecar pattern is currently demonstrated in the `eth-state` example. The Railgun adapter uses the simpler blue-green approach because the commitment tree is append-only.

## ChalametPIR evolution

Raven's first PIR scheme was based on ChalametPIR (eprint 2024/092), which uses a Binary Fuse Filter for keyword-to-index PIR. The BFF crate (`raven/crates/binary-fuse-filter/`) remains in the codebase, ported from ChalametPIR's implementation, but has no live consumers. The current scheme, InsPIRe, addresses keyword queries differently: the commitment-to-index mapping is computed locally by the client, not by a filter.

InsPIRe was chosen because it is hintless (client-stateless), which matters for browser wallets. A scheme that requires downloading a hint to answer queries would make lightweight wallet UX impractical.

## Freshness

Raven runs an Ethereum event indexer that watches for `PpoiListLeafAdded` and `PpoiStatus` events (in that order: reversing the order silently breaks T2 path PIR). When events arrive, the affected shards are marked dirty and re-encoded. The background rebuild picks up dirty shards and rebuilds the sidecar engine. After the ArcSwap, new queries see the fresh data.

For the Railgun deployment, freshness latency is the time from Ethereum event to sidecar swap. For append-only commitment trees this is a straightforward rebuild of the new tail shards. For mutable state (eth-state), it is an incremental sidecar update on every block.

The server exposes a `/health` endpoint and an SSE `/events` stream so clients can observe rebuild progress.

## Persistence

Raven's persistence stack is crash-safe:

- **WAL:** append-only CRC32-framed log. Each entry carries a sequence number, block height, and payload. Fsync on every append. Torn-tail detection on recovery.
- **Snapshot:** base64-prefixed binary with SHA-256 checksum and optional zstd compression. The current engine version (V6) embeds the full `LogicalLeafStore` in the snapshot so WAL replay is not required from genesis.
- **Manifest:** JSON file tracking the current snapshot sequence number, WAL commit pointer, and schema version. Commit order is snapshot → manifest → archive. The manifest is the atomic commit point.

The wire format between client and server uses a two-byte big-endian schema version prefix followed by bincode-encoded body. The schema version is also sent as an HTTP header (`X-Raven-Schema-Version`) so clients can detect mismatches without parsing the body.

## On-chain topology vs. server

Raven's servers are not registered on-chain. They are standalone HTTP/HTTPS services. The Railgun adapter's HTTP server (axum) exposes:

- `GET /v1/instance/:id/params`: scheme parameters and CRS
- `POST /session`: packing-key upload (saves per-query bandwidth)
- `POST /query`: single PIR query
- `POST /batch`: batch PIR queries
- `GET /health`: server health
- `GET /events`: SSE rebuild events
- `GET /metrics`: Prometheus metrics

The Railgun PPOI shim routes (`/v1/poi/pois-per-list`, `/v1/poi/merkle-proofs`, `/v1/commit-tree/:n/merkle-proof`) are compatible with the existing Railgun wallet SDK interface: the wallet does not need to know it is talking to a PIR server.

## Next steps

- [PIR Trilemma](/pir-trilemma): the fundamental tradeoff space and where InsPIRe sits
- [Glossary](/glossary): InsPIRe, PIR, PPOI, LeanIMT, ArcSwap, and related terms
