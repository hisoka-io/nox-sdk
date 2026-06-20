---
sidebar_position: 6
title: Security
---

# Security

This page describes the adversary model, what each Hisoka layer protects against, and explicit non-goals. Read this before deploying any Hisoka component in a security-sensitive context.

## Adversary model

Hisoka designs against a computationally bounded adversary that is simultaneously:

**Global passive (GPA).** The adversary observes every packet (size, timing, and content) between all node pairs, and observes every Ethereum transaction, event, and state update. The adversary cannot modify, drop, delay, or inject on honest links.

**Limited active.** The adversary controls a fraction f of mix nodes. On controlled nodes, it may delay, drop, replay, inject, or reorder packets. It may register Sybil nodes subject to on-chain staking cost.

**Active protocol participant.** The adversary may be a pool user, relayer, solver, or compliance key holder.

**Hardness assumptions:** DDH on Curve25519 and BabyJubJub; UltraHonk/Noir proof system soundness; collision resistance of Poseidon2, SHA-256, and BLAKE3; security of X25519/ECDH; AEAD security of ChaCha20-Poly1305; AES-128-CBC security.

## What Nox protects against

**IP unlinkability.** The entry node sees your IP but not your request. The exit node sees your request but not your IP. No single node sees both. An observer watching your connection to the entry node cannot link it to the exit node's outbound request.

**Timing correlation (partial).** Poisson mixing delays decorrelate input and output timing. The mixing delay is the primary privacy mechanism. An adversary watching two specific nodes cannot determine with high confidence that they are handling the same packet: provided the network has sufficient traffic and mixing delay is large enough.

**Traffic analysis.** All packets are exactly 32,768 bytes. Cover traffic (loop and drop packets) is indistinguishable from real traffic. An observer counting packets cannot determine which are real requests.

**Sybil infiltration.** Joining the network requires on-chain staking, economic cost on `NoxRegistry`. The handshake binds each peer connection to a staked on-chain identity; unregistered nodes cannot complete the handshake.

**Replay attacks.** Each packet's replay tag (`BLAKE3(pk_eph ‖ mac ‖ nonce)`) is checked in a rotational dual-Bloom filter before any cryptographic processing. Replayed packets are rejected before EC operations.

**Packet tagging.** Lioness (wide-block cipher) over the Sphinx body means a single-bit flip diffuses over the entire 32 KB body. An adversary cannot flip a recognizable bit in the body at one hop and identify the same bit at a downstream hop.

**Gas payment deanonymization.** The `gas_payment` circuit proves fund ownership in zero knowledge. The execution hash binds the proof to one specific action. The relayer learns the action but not the payer. The on-chain contract verifies the proof and execution hash; it has no `msg.sender` check.

**Front-running and parameter substitution.** The execution hash `keccak256(target ‖ calldata ‖ fee) mod p_BN254` is a public circuit output. The contract recomputes it from the actual submitted parameters and reverts on mismatch. The proof can only authorize the specific action it was generated for.

### Nox non-goals

**Global passive adversary attacks.** Nox does not protect against an adversary that observes all network traffic simultaneously. With global observation and sufficient traffic analysis, a patient adversary can correlate inputs and outputs across all hops. The M/M/∞ mixing argument reduces leakage per hop but does not eliminate it.

**Long-term intersection attacks.** An adversary that can observe a user's traffic over time and intersect the sets of nodes involved in each request can narrow down the anonymity set. This is inherent to finite-population mixnets.

**Endpoint compromise.** If the device running the SDK or the exit node's execution environment is compromised, Nox provides no protection.

**Client-to-entry traffic analysis.** Cover traffic between client and entry node is supported but off by default. Without it, a local network observer can count packets from your device.

**Post-quantum adversaries.** X25519 and BabyJubJub are not post-quantum secure.

**Full-layer compromise.** The three-hop path requires at least one honest node per layer. If all nodes in a layer are adversarial, the privacy of that hop is broken. Probability of full-path compromise: f³ where f is the fraction of adversary-controlled nodes.

**Transport-layer DoS.** PoW and rate limits raise the cost of spam but do not guarantee availability under a sustained resource-exhausted attack.

**Hiding that you use Nox.** Nox packets are visible on the wire. Your ISP, VPN provider, or local network can observe that you are connecting to Nox entry nodes.

**Formal anonymity bound.** A formal closed-form sender-anonymity bound has not been proven. The `yellow-paper/TODO.md` lists this as an open problem. The false `1/N + negl(λ)` claim from the original spec was removed; the current empirical measurement is roughly 5.76 bits of entropy per hop at 1 ms delay with N=256 nodes.

## What Raven protects against

**Query-index revelation.** The PIR server processes your query and returns a response without learning which index (record) you requested. The server's computation is over an RLWE ciphertext; it learns nothing about the plaintext query index.

**UTXO clustering.** Without Raven, a PPOI node that receives a list of blinded commitments to check learns which commitments you hold, and can cluster them by IP address. With Raven, the server sees only a PIR query over a shard; it does not learn which specific commitment was queried.

**Spend-time identity leaks.** Fetching a Merkle authentication path for a specific leaf reveals which note you are about to spend. Raven serves auth paths via PIR, hiding which leaf was requested.

### Raven non-goals

**Server-side anonymity against session linking.** In the production Railgun deployment, Raven uses sticky sessions: the client uploads packing keys once and the server caches them for the session. The server can link queries within a session. This is a documented tradeoff, not a cryptographic break. Pair Raven with Nox to mitigate: the PIR query itself travels through the mixnet, and the server sees different IP addresses per session.

**Anonymity beyond one shard.** The shard ID is plaintext in each query (it determines which engine handles the request). The anonymity set is one shard (~2,048 entries), not the full database. An adversary that knows which shard you queried can narrow your query to one of ~2,048 records.

**Post-quantum adversaries.** InsPIRe is based on Ring-LWE. Its hardness assumption is believed to be post-quantum resistant, but the overall system includes non-PQ components.

**Data authenticity.** Raven verifies that the server's response is a correct PIR answer to the query. It does not verify that the underlying database is authentic (e.g., that the Merkle paths correspond to a real on-chain commitment tree). This is the "detects staleness not forgery" limitation noted in the `eth-state` example.

**Open crypto gate.** There is a pending cryptographer review of a possibly-missing `(q̃/q)²` factor in InsPIRe's noise-variance derivation (`raven/SECURITY.md`, item G6). Until this is resolved, Raven should not be used to serve high-value data where a wrong noise bound would affect correctness or privacy assertions. The current Railgun PPOI deployment uses the conservative wider single-prime modulus `q ≈ 2⁶⁰` which provides larger noise margins.

## What Howl protects against

**Transaction content revelation.** Asset type, value, sender, and receiver are all hidden inside encrypted notes. The on-chain commitment tree contains only ciphertexts. A chain analysis firm observing the contract sees that a valid ZK proof was submitted and a nullifier was consumed, but learns nothing about the note's contents or the parties involved.

**Double-spend.** The nullifier set tracks spent notes. A valid proof consumes the nullifier; subsequent attempts with the same nullifier are rejected by the contract.

**Linkability of nullifier to note.** The nullifier computation (either `Poseidon2(nullifier)` for self-owned notes or `Poseidon2(shared_secret, commitment, leaf_index)` for received notes) has no algebraic relationship to the note's on-chain commitment. A chain analyst cannot link a nullifier publication to the corresponding tree leaf.

**Gas payment attribution.** The `gas_payment` circuit pays relayers from shielded funds. The relayer learns the action being paid for but not the payer's identity or note.

### Howl non-goals and open issues

**Mainnet deployment.** Howl has a CRITICAL open audit finding: field-overflow in value conservation. All value-balance checks use BN254 `Field` (modular) arithmetic; a prover can satisfy conservation while individual output values exceed the input via modular wraparound, enabling pool drain with no special access. A working exploit exists. This is the mainnet blocker. Do not use Howl with real funds until this is fixed and an audit is completed.

**Threshold compliance.** The deployed compliance mechanism is a single immutable BabyJubJub public key set at contract deployment. All notes are ECDH-encrypted to this key. The "15-entity threshold quorum" described on the marketing site is a design goal, not a deployed feature.

**Post-quantum adversaries.** BabyJubJub, BN254, and UltraHonk are not post-quantum secure.

## Open security issues across layers

| Severity | Issue | Layer | Status |
|---|---|---|---|
| Critical | Field-overflow value conservation (pool drain) | Howl | Open: mainnet blocker |
| High | SURB AEAD authentication (ISSUE-012) | Nox | Open: mainnet blocker |
| Medium | `public_claim` does not enforce timelock | Howl | Open |
| Medium | Fee-on-transfer tokens break `deposit()` accounting | Howl | Open |
| Open question | Noise-variance factor in InsPIRe `get_variance` | Raven | Cryptographer review needed |
| Open research | Formal sender-anonymity bound | Nox | Not yet proven |

For the full list of known issues, see the respective repositories: `darkpool-v2/no-commit/ISSUES.md` (Howl), `raven/SECURITY.md` (Raven), and `yellow-paper/TODO.md` (Nox).
