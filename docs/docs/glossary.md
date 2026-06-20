---
sidebar_position: 12
title: Glossary
---

# Glossary

Key terms used across the Hisoka protocol documentation. Alphabetical order.

---

**Anonymity set.** The set of possible senders or query originators that a network observer or database server cannot distinguish. In Nox, the anonymity set for sender identity is roughly the set of active users in the network during the mixing window. In Raven, the anonymity set for a PIR query is one shard (~2,048 entries) because the shard ID is plaintext in the query.

---

**ArcSwap.** A lock-free atomic reference-counting swap primitive (Rust crate). Raven uses `ArcSwap::rcu` to atomically replace the live PIR engine with a freshly rebuilt one during blue-green swaps, without blocking in-flight queries.

---

**BabyJubJub.** A twisted Edwards elliptic curve embedded in the BN254 scalar field. Parameters: A=168700, D=168696, generator Base8. Used in Howl for in-circuit ECDH key agreement, DLEQ proofs, the compliance key, and the key hierarchy. Scalar range: ~2^251 (the BabyJubJub subgroup order), which is smaller than BN254's scalar field (~2^254). In-circuit scalar multiplications use a 63-limb `ScalarField` requiring sub-order values.

---

**Barretenberg (bb.js).** The Rust/C++ backend for the UltraHonk proof system, developed by Aztec. Howl uses `bb.js` specifically (the JavaScript/WASM version) for both proving and verifier generation. The `bb` CLI binary and `bb.js` produce different verifier contract bytecodes for the same circuit: the project standardizes on `bb.js` end-to-end. Pinned to nightly `4.0.0-nightly.20260218`.

---

**Binary Fuse Filter (BFF).** A compact probabilistic membership structure from ChalametPIR (eprint 2024/092), used for keyword-to-index mapping in PIR schemes. Raven's codebase includes a ported BFF crate (`raven/crates/binary-fuse-filter/`) but it currently has no live consumers. InsPIRe handles keyword addressing differently (via local index computation by the client).

---

**Blue-green rebuild.** Raven's update strategy for append-only data. The server maintains two PIR engine instances: one "hot" (serving live queries) and one "warm" (rebuilding in the background as new chain events arrive). When the warm rebuild completes, the two instances swap atomically via ArcSwap. Live queries never block on indexing.

---

**BN254.** The elliptic curve and scalar field used by UltraHonk. Howl's ZK circuits operate over BN254's scalar field (Fr). BabyJubJub is embedded in BN254. BN254 is not post-quantum secure.

---

**ChalametPIR.** A keyword PIR scheme (eprint 2024/092) that uses Binary Fuse Filters for keyword-to-index mapping. Raven's first scheme was based on ChalametPIR; the current production scheme is InsPIRe.

---

**Commitment.** In Howl, the on-chain representation of a note. Defined as `Poseidon2(packed_ciphertext[0..7])`: the hash of the 7 BN254 field elements that pack the AES-encrypted note. The Merkle tree stores commitments. The commitment binds to the ciphertext, not the plaintext, so the tree contains no decryptable information without the ECDH shared key.

---

**Compliance key.** A single immutable BabyJubJub public key set at `DarkPool` deployment. Every note is ECDH-encrypted to this key, enabling the compliance key holder to decrypt any note in the pool. The contract enforces that every proof uses this specific key. "Private by default, auditable by exception." A threshold quorum scheme (the "15-entity" marketing claim) is a roadmap item, not a deployed feature.

---

**Cover traffic.** Dummy Sphinx packets sent through the mixnet at Poisson-distributed intervals. Cover packets are wire-indistinguishable from real packets: same size, same three-hop route, same encryption. Exit nodes recognize and discard them. Cover traffic is free (no fee) to maximize the anonymity set.

---

**Dark pool.** A trading venue where order details are hidden from the public before and during execution. Howl is Hisoka's private dark pool: a ZK-UTXO shielded pool where asset, value, and counterparty are hidden inside encrypted notes proven valid in zero knowledge.

---

**DarkPool.sol.** Howl's core Ethereum contract. Holds the LeanIMT commitment tree, nullifier set, public-memo registry, and references to seven HonkVerifier contracts. Enforces compliance-key pinning, proof-timestamp validation (proof timestamp must be within block.timestamp + 1 hour), Merkle root history, nullifier double-spend prevention, and a pausable emergency stop. Has no `msg.sender` ownership checks: all authorization is proven in zero knowledge.

---

**DLEQ (Discrete Log Equality, Chaum-Pedersen).** A non-interactive zero-knowledge proof that two public keys share the same discrete logarithm with respect to two different generators. Howl's `transfer` circuit uses a BabyJubJub DLEQ proof to enable three-party note encryption: the memo note is encrypted so both the recipient and the compliance key holder can decrypt it, without the circuit or the sender learning the recipient's secret key.

---

**EIP-7864 (Unified Binary Tree, UBT).** A draft Ethereum proposal to replace the hexary Merkle Patricia Trie with a flat binary trie over accounts and storage. Raven's `eth-state` example adopts EIP-7864's flat single-keyspace shape (address maps to dense leaf index) to key PIR queries. It does not implement a live UBT.

---

**Execution hash.** `keccak256(target || calldata || fee) mod p_BN254`. A public output of the `gas_payment` circuit that binds the proof to one specific on-chain action. The `DarkPool` contract recomputes this from the actual submitted transaction parameters and reverts on mismatch, preventing front-running, parameter substitution, and proof reuse.

---

**FEC (Forward Error Correction).** Reed-Solomon erasure coding over GF(2^8) applied to SURB reply shards in Nox. Default configuration: d=11 data shards, p=4 parity shards (26.7% overhead). Any d of d+p shards reconstruct the full response. At 10% packet loss, FEC recovery probability is 98.8% (vs. 30.9% without FEC).

---

**Fold.** In Raven's main+sidecar architecture, a fold merges the sidecar engine's dirty rows into the main engine. Only affected shards are re-encoded. After the fold, the sidecar is reset to empty. The fold commits in crash-safe order: snapshot then manifest then sidecar reset.

---

**Four Silences (四つの沈黙).** The four independently deployable Hisoka layers, named for what each silences: Howl silences the trades, Raven silences the queries, Nox silences the traffic, Kage silences the exposure.

---

**GPA (Global Passive Adversary).** An adversary that observes all network traffic simultaneously (every packet between every pair of nodes) without modifying anything. Nox does not fully protect against a GPA. The Poisson mixing argument reduces but does not eliminate the information available to a GPA.

---

**Howl.** Hisoka's write-privacy layer. A multi-asset ZK-UTXO shielded pool on Ethereum. Also called "Dark Pool." The original protocol name "Xythum" survives in the Solidity NatSpec and legacy sites but maps to Howl. Deployed to Arbitrum Sepolia testnet; not on mainnet (gated on a CRITICAL audit finding).

---

**InsPIRe.** The lattice-based PIR scheme Raven uses in production. Published as eprint 2025/1352, presented at IEEE S&P 2025. Key properties: hintless (client-stateless), uses InspiRING ring packing (LWE to RLWE with only 2 key-switching matrices), operates over `R_q = Z_q[X]/(X^d+1)`. Raven's fork patches a critical NTT-limb bug in the upstream implementation and adds session caching. Parameters: d=2048, q=2^60 minus 2^14 plus 1, p=65537 (Fermat F4). Currently locked in both the main and sidecar roles.

---

**InspiRING.** InsPIRe's ring-packing technique. Packs d LWE ciphertexts into one RLWE ciphertext using only 2 key-switching matrices (K_g and K_h), compared to log(d) matrices in earlier tree-packing approaches. This reduces the packing-key upload size and server computation.

---

**iSimplePIR.** A client-stateful, incrementally-updatable PIR scheme (eprint 2026/030). Its differentiator over InsPIRe is native incremental updates with a stateful client (hint). In Raven it is a complete crate (`raven/crates/isimplepir/`) with AVX2/AVX-512 server kernels, but it is not wired into any live serving path. It is banned from the sidecar role (a stateful client would have to re-sync its hint on every fold). The intended use is as a second scheme to drive extraction of a generic PIR trait.

---

**Kage.** Hisoka's settlement layer. A private solver network where users emit intent ZK proofs and solvers recursively verify them inside their own circuits before settling swaps on-chain. Roadmap only; design stage. The `/kage` website redirect to `/nox` is deprecated: Kage now means the solver network, not the mixnet.

---

**LeanIMT (Lean Incremental Merkle Tree).** A depth-32 binary Merkle tree optimization. If a node's right sibling is zero, the parent equals the left child (no hash computation required). This avoids pre-allocating empty leaves, making appends cheaper. Used in Howl's commitment tree. Three implementations must agree byte-for-byte: the Noir circuit, the Solidity `MerkleTreeLib.sol`, and the TypeScript `LeanIMT.ts`.

---

**Lioness.** A 4-round Luby-Rackoff wide-block cipher (SPRP) instantiated with ChaCha20 (stream) and SHA-256 (hash). Used to encrypt the Sphinx body in Nox. A wide-block cipher means a single-bit flip in the body diffuses over the entire 32 KB body, preventing the tagging attack that a stream cipher would enable. Nox uses a non-canonical subkey order (k2, k1, k4, k3) with stream rounds operating on the larger half of the body split.

---

**Loopix.** The mixnet design template Nox follows. Published at USENIX Security 2017. Key features: stratified topology, continuous-time Poisson mixing, four cover-traffic classes (loop, drop, payload cover, mix-loop), SURBs for anonymous replies. Nox implements all four cover-traffic classes; the original Hisoka spec incorrectly said three.

---

**Merkle path.** A list of sibling hashes along the path from a leaf to the root of a Merkle tree, used to prove that a leaf is included in the tree. In Howl, a spend proof requires a valid Merkle path against a known historical root. In Raven, commitment-tree Merkle paths are served privately via PIR.

---

**Mixnet.** A network of nodes that receive, hold, and re-transmit messages in shuffled order, making it difficult to trace a message from sender to recipient. Nox is a Sphinx-packet mixnet with Poisson mixing delays.

---

**Noir.** A ZK circuit language developed by Aztec. Howl's seven circuits are written in Noir and compiled to UltraHonk proofs via Barretenberg.

---

**Note.** Howl's unified UTXO. A 6-field struct: `(asset_id, value, secret, nullifier, timelock, hashlock)`, serialized to 192 bytes. `timelock` enables time-locked spending; `hashlock` enables hash-locked spending (HTLCs, atomic swaps). A "memo note" (a received transfer) is a Note with `nullifier = 0` using the received-note nullifier path.

---

**Nox.** Hisoka's network-privacy layer. A three-hop stratified Sphinx mixnet following Loopix. Routes wallet queries and transactions through a network of independent relay and exit nodes, hiding IP, timing, and metadata. Also serves as the Dark Pool's anonymous paymaster via the `gas_payment` circuit. Live on Arbitrum Sepolia testnet.

---

**NoxRegistry.** The on-chain Solidity contract that stores Nox node registrations: Sphinx public key, staking, role, and service URLs. Computes an XOR topology fingerprint for cheap stale-topology detection. Clients optionally verify the topology fingerprint against the on-chain value to detect compromised seed nodes.

---

**Nullifier.** A value published when a note is spent, preventing double-spends. Two computation paths: self-owned notes use `Poseidon2(nullifier_field)` where `nullifier_field` is the note's nullifier field value; received notes (with `nullifier == 0`) use `Poseidon2(shared_secret, commitment, leaf_index)`. Neither path algebraically links the nullifier to the note's on-chain commitment.

---

**PIR (Private Information Retrieval).** A cryptographic protocol that allows a client to fetch a record from a server's database without the server learning which record was requested. Communication cost must be independent of database size (otherwise, sending less data for popular records would leak popularity). Raven uses single-server computational PIR based on Ring-LWE.

---

**Poisson mixing.** Each hop in the Nox mixnet delays a packet by a random duration drawn from an exponential distribution. The exponential distribution is memoryless: future delays are independent of past delays. Under the M/M/infinity queueing model, this makes the output timing distribution approximately Poisson regardless of input timing patterns.

---

**Poseidon2.** A ZK-friendly hash function (t=4, rate 3, capacity 1) over the BN254 scalar field. Used in Howl for Merkle hashing, note commitment, key derivation, and intent hashing. Roughly 3x fewer constraints than original Poseidon, and far fewer than SHA-256 in-circuit.

---

**PPOI (Private Proof of Innocence).** Railgun's compliance mechanism. An append-only list (production: OFAC) of blinded commitments with associated POI status (Valid, ShieldBlocked, ProofSubmitted, Missing). Wallets must verify PPOI status before spending to prove the note is not tainted. Without Raven, this query reveals which commitments a wallet holds. Raven serves PPOI status and Merkle paths privately via PIR.

---

**PSS (Private State Storage).** A proposed Hisoka service (design stage) that stores user-encrypted wallet state blobs. On wallet startup, the wallet loads its cached encrypted blob from PSS and syncs from the stored state instead of regenerating from the root secret. PSS is distinct from Raven: Raven reads chain state privately; PSS stores the wallet's own derived state encrypted.

---

**Railgun.** A privacy protocol on Ethereum using ZK-UTXO shielded pools. Raven's first production integration: six InsPIRe instances serve Railgun's PPOI data privately via PIR on Ethereum mainnet. Raven sits below Railgun's wallet SDK as a drop-in transport replacement.

---

**Raven.** Hisoka's read-privacy layer. A general-purpose PIR framework that lets a wallet fetch chain state (UTXOs, Merkle paths, PPOI data, account balances) without the server learning which record was requested. Live on Ethereum mainnet via the Railgun integration. The `eth-state` example generalizes Raven to arbitrary private Ethereum account-state reads.

---

**Reed-Solomon.** An erasure coding scheme over a finite field. Nox uses Reed-Solomon over GF(2^8) for FEC on SURB reply shards. Default: d=11 data shards, p=4 parity shards. Any d of d+p shards reconstruct the original data.

---

**RelayerMulticall.** An on-chain Solidity contract that batch-executes operations: `(target, calldata, value, requireSuccess)[]`. Each operation is authorized by its own ZK proof; there are no `msg.sender` checks. Used by exit nodes to submit `gas_payment`-authorized transactions and other pool operations.

---

**Ring-LWE (RLWE).** Ring Learning With Errors. A lattice-based hardness assumption used in InsPIRe. A query ciphertext is an RLWE encryption of an inverse monomial; the server applies InspiRING ring packing and evaluates homomorphically; the client decrypts. Believed to be post-quantum resistant.

---

**SessionResidue.** A compact representation of an InsPIRe client session (~1.25 MB) that can be persisted and rehydrated without rebuilding the full session (~160 MB, ~3.8 seconds). Contains the CRS, RLWE secret key, and packing keys. Stored in IndexedDB. Enables practical browser wallet UX.

---

**Sphinx.** A fixed-size onion-routing packet format (Danezis-Goldberg 2009, IEEE S&P). Nox uses Sphinx packets of exactly 32,768 bytes, per-hop X25519 key blinding, HMAC-SHA256 MACs, and Lioness body encryption. The fixed size prevents message-size traffic analysis.

---

**SURB (Single-Use Reply Block).** A pre-built encrypted return path that the exit node attaches to a reply packet. The exit node does not know the requester's IP; the SURB routes the reply back through the network to the entry node where the client picks it up. Each SURB is single-use: reuse would allow an adversary to correlate multiple replies to the same request. Each SURB carries roughly 30 KB of response data.

---

**UltraHonk.** The proving system Howl uses, implemented in Barretenberg. A KZG-based argument system with a Keccak-256 transcript for EVM-verifiable proofs. Soundness is a security assumption of the Hisoka protocol.

---

**ZK proof (Zero-Knowledge Proof).** A cryptographic method for proving the truth of a statement without revealing anything beyond the truth of the statement itself. In Howl, ZK proofs prove that a note exists in the commitment tree, that the prover knows the secret to spend it, and that value is conserved: without revealing the note, the secret, or the tree position.

---

**ZK-UTXO.** A privacy model where balances are held as encrypted notes (UTXOs) committed to an on-chain Merkle tree. Ownership and validity are proven in zero knowledge. The on-chain state reveals only that valid commitments exist and valid nullifiers have been spent. Used by Howl, Zcash, Tornado Nova, Railgun, and Aztec.
