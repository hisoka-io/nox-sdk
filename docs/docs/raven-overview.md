---
sidebar_position: 2
title: Raven Overview
---

# Raven: Read Privacy

Raven is Hisoka's read-privacy layer: a general-purpose Private Information Retrieval (PIR) framework for Ethereum. It lets a wallet fetch chain state (UTXOs, incoming transfers, Merkle paths, PPOI compliance data) without the server learning which record was requested.

## The problem Raven solves

When a wallet queries an RPC provider or a chain indexer, the request reveals the wallet's interests. An RPC provider that sees `eth_getStorageAt(address, slot)` learns exactly which account you are watching. A PPOI aggregator that receives a list of blinded commitments to check learns which commitments you hold, clustering your UTXOs by IP address.

This is the **read-privacy leak**: even if your transactions are shielded, the act of querying for them is not. Raven closes this leak at the protocol level.

## What PIR provides

In a standard database query, the server learns the index of the record you fetched. PIR inverts this: the server processes your query and returns a result, but learns nothing about which index you asked for. Communication cost is independent of database size. This is a load-bearing property: any scheme that sends less traffic for popular records leaks popularity.

Raven uses **single-server PIR**, which means:

- No coordination between multiple servers is required.
- The privacy guarantee is computational (based on the hardness of Ring-LWE), not information-theoretic.
- One cooperative server is enough; you do not need to trust that servers do not collude.

## What Raven protects today

Raven is live on Ethereum mainnet, serving Railgun's Private Proof of Innocence (PPOI) data via six InsPIRe instances at `raven.hisoka.io` and `demo.railgun.hisoka.io`.

PPOI is Railgun's compliance mechanism. An append-only list (production list: OFAC) tracks "innocent" blinded commitments. Wallets must check this list before spending. Normally this means querying the PPOI node directly, which leaks which commitments they hold. Raven serves three PIR primitives privately:

| Primitive | What it closes |
|---|---|
| **PPOI status per blinded commitment** | Per-IP UTXO clustering at the PPOI aggregator |
| **PPOI Merkle auth paths** | Spend-time identity leak when fetching inclusion proofs |
| **Commitment-tree auth path** | Client-side IMT state requirement (mobile enabler) |

Raven sits below Railgun's wallet SDK as a drop-in transport replacement. Applications that use Railgun get private reads without changing their contract logic or wallet engine.

## The generalization: private Ethereum state reads

Raven is not Railgun-specific. The same framework serves arbitrary key-value Ethereum state reads. The `eth-state` library (currently a tested example) demonstrates private reads of account balances: a client fetches `eth_getBalance` equivalent data without the server learning which account was queried. The server sees a PIR query over a shard of the account state; the anonymity set is one shard (~2,048 entries).

The data model follows the EIP-7864 Unified Binary Tree flat keyspace shape: one address maps to one dense leaf index, one shard covers 2,048 consecutive accounts. This matches Ethereum's flat plain-state layout and positions Raven to serve the broader Ethereum state as an app-agnostic public good.

Target use cases beyond Railgun: World ID inclusion proofs (13M+ member tree, phones cannot hold it), Zcash, Aztec, Kohaku, Penumbra.

## Relationship to Nox

Nox and Raven close different leaks and compose:

| | Nox | Raven |
|---|---|---|
| **What it hides** | Who is asking (IP, timing) | What is being asked (record index) |
| **Mechanism** | Sphinx mixnet, onion routing | PIR query over Ring-LWE |
| **Transport** | Three-hop relayed packet | Direct HTTP to PIR server |
| **Threat** | Network observer, RPC provider sees IP | Database server learns query index |

A wallet using both Nox and Raven: the PIR query itself travels through the mixnet (hiding IP), and the PIR protocol hides which record was queried (hiding intent). Neither the network nor the server learns both who asked and what was asked.

## PIR scheme: InsPIRe

Raven's production scheme is InsPIRe (eprint 2025/1352, IEEE S&P 2025). It is a lattice-based hintless PIR scheme: the client is stateless (no hint download required). The deployed parameters are:

| Parameter | Value |
|---|---|
| Ring dimension | 2048 |
| Ciphertext modulus | 2⁶⁰ − 2¹⁴ + 1 |
| Plaintext modulus | 65537 (Fermat F4) |
| Noise parameter σ | 6.4 |

At the Railgun deployment scale (65,536 × 512 B cells), the full PIR roundtrip runs at approximately 71.9 ms with a 32.9 KB response. Server-side computation is roughly 3–4 ms; end-to-end with network is roughly 12 ms without sticky session overhead.

There is an open crypto review item before Raven serves real financial value on mainnet: a possibly-missing noise-variance factor in the InsPIRe parameter derivation. This is disclosed openly in `raven/SECURITY.md` (item G6) and must be reviewed by a cryptographer before production use with high-value data. See [Security](/security) for the full threat model.

## Next steps

- [Raven Architecture](/raven-architecture): how the main engine, sidecar, and blue-green rebuild work
- [PIR Trilemma](/pir-trilemma): the tradeoff space and why Raven's choices are correct for blockchain data
- [Glossary](/glossary): definitions of InsPIRe, PIR, PPOI, LeanIMT, and other terms
