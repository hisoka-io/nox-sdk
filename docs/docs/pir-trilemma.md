---
sidebar_position: 4
title: The PIR Trilemma
---

# The PIR Trilemma

Building a practical PIR scheme for blockchain data requires navigating a three-way tradeoff. You cannot have all three desirable properties simultaneously. Understanding which two Raven chose, and why, explains the scheme's design.

## The three properties

**Stateless client.** The client does not need to download any auxiliary data (a "hint") before issuing queries. Useful for lightweight and browser wallets where pre-loading hundreds of megabytes is impractical.

**Sublinear server computation.** The server processes each query in time less than O(n), where n is the number of rows in the database. Full linear server computation means the server reads the entire database for every query, which limits throughput.

**Dynamic updates.** The database can be updated without expensive full rebuilds. For a commitment tree that grows with every Ethereum block, this is essential for keeping data fresh.

## The trilemma

| Scheme | Stateless client | Sublinear server | Dynamic updates |
|---|:---:|:---:|:---:|
| SimplePIR / DoublePIR | No (requires hint) | Yes | Expensive |
| iSimplePIR | No (requires hint) | Yes | Yes (native) |
| **InsPIRe (Raven)** | **Yes** | **No** | **Yes** |
| SealPIR | Yes | Yes | No |

You can pick any two. The third is not achievable within any known single-server computational PIR scheme.

## Where InsPIRe sits

InsPIRe is stateless-client and live-updatable, but requires linear server computation. For every query, the server processes the entire database shard. This is the deliberate tradeoff Raven makes.

**Why give up sublinear server computation?** Two reasons.

First, browser wallet UX requires a stateless client. Downloading a 100+ MB hint on every page load (as SimplePIR and iSimplePIR require) is a non-starter. The session residue optimization in Raven's InsPIRe fork reduces the client state to 1.25 MB, but that is only possible because InsPIRe never required a full hint download.

Second, linear server computation is manageable at Ethereum's data scales when the database is sharded. Raven shards the commitment tree so each shard covers 2,048 entries. A single shard query at d=2048 runs in roughly 3–4 ms server-side, and the full Railgun deployment (65,536 entries across 32 shards) handles queries at practical throughput. The anonymity set is one shard (~2,048 entries), not the full database: an honest limitation documented in `raven/SECURITY.md` (item G7).

## Why this tradeoff is right for blockchain data

Blockchain data has characteristics that make the stateless-client choice particularly important:

**Users are mobile and ephemeral.** A user opening a wallet on their phone or in a browser tab cannot be expected to have maintained gigabytes of local state. Hint-based schemes penalize cold-start and cross-device use.

**The database grows monotonically.** The Ethereum commitment tree only appends. Raven exploits this with the blue-green rebuild: only the new tail shards need re-encoding. For mutable state (account balances), the main+sidecar pattern handles updates incrementally. Neither of these optimizations requires sublinear server computation.

**Linear computation over a shard is fast.** At d=2048 with InsPIRe's ring packing, the server does one polynomial multiplication per entry. On modern hardware this runs in milliseconds. The bottleneck in practice is network latency, not server computation.

**iSimplePIR's incremental updates don't help here.** iSimplePIR's differentiator is native incremental updates with a stateful client. But a stateful client is exactly what Raven is trying to avoid. iSimplePIR is kept in the codebase as a benchmarked alternative and the intended second scheme to force a generic PIR trait, but it is not wired into serving and is banned from the sidecar role (a stateful client would have to re-sync its hint on every fold).

## SealPIR and the sublinear alternative

SealPIR achieves stateless client and sublinear server computation using homomorphic encryption over ciphertexts (BFV scheme). The tradeoff is that the database encoding is static: updates require a full re-encode, which is prohibitively expensive for a live chain.

For a read-only archive this would be viable. For a live commitment tree that updates on every Ethereum block, it is not.

## Practical implications

**Anonymity set.** Each query reveals the shard you queried (the shard ID is plaintext on the wire). The anonymity set is one shard, not the full database. For the Railgun deployment this is ~2,048 entries; for the full Ethereum account state it would be ~2,048 accounts per shard out of roughly 2.4 billion total entries (~72 shards of 2^25 entries at full scale, with each shard covering 2,048 ring coefficients).

**Server-stateful session.** InsPIRe in Raven's production deployment uses sticky sessions: the client uploads packing keys once per session, and the server caches them. This saves roughly 48 KB per query. The tradeoff is that the server can link queries within a session: a documented linkability tradeoff, not a cryptographic break. Pairing Raven with Nox (routing PIR queries through the mixnet) limits what a server can infer even from session linking.

**The open noise gate.** There is a pending cryptographer review of a possibly-missing factor in InsPIRe's noise-variance derivation. This does not affect the trilemma analysis: it is a question about correctness and the privacy assertion at specific parameter margins, not about the scheme's structural properties. See [Security](/security).

## Summary

Raven picks stateless client and live updates, accepts linear server computation, and mitigates the anonymity-set limitation through sharding. This is the correct tradeoff for browser wallets querying a live blockchain commitment tree. Other tradeoffs exist and are valid for different deployment contexts; they are not the right fit for Raven's target use cases.
