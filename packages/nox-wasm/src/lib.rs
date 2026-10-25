//! WASM bindings for NOX Sphinx cryptography, used by `@hisoka/nox-client`.

use wasm_bindgen::prelude::*;

use nox_crypto::{
    build_multi_hop_packet,
    sphinx::pow::{count_leading_zeros, default_solver, meets_difficulty},
    PathHop, Surb, SurbRecovery, PACKET_SIZE,
};

#[wasm_bindgen]
pub struct JsPathHop {
    pub_key_hex: String,
    address: String,
}

#[wasm_bindgen]
impl JsPathHop {
    #[wasm_bindgen(constructor)]
    pub fn new(pub_key_hex: String, address: String) -> JsPathHop {
        JsPathHop {
            pub_key_hex,
            address,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn pub_key_hex(&self) -> String {
        self.pub_key_hex.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn address(&self) -> String {
        self.address.clone()
    }
}

/// Opaque SURB recovery — serialize to JSON, pass back to `decrypt_surb_response`.
#[wasm_bindgen]
pub struct JsSurbRecovery {
    inner: SurbRecovery,
    id_hex: String,
}

#[wasm_bindgen]
impl JsSurbRecovery {
    #[wasm_bindgen(getter)]
    pub fn id_hex(&self) -> String {
        self.id_hex.clone()
    }

    /// Reply format: 1, or 2 when replies carry a reply tag.
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> u8 {
        self.inner.version
    }

    pub fn to_json(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn from_json(json: &str) -> Result<JsSurbRecovery, JsValue> {
        let inner: SurbRecovery = serde_json::from_str(json)
            .map_err(|e| JsValue::from_str(&format!("SurbRecovery deserialize: {e}")))?;
        let id_hex = hex::encode(inner.id);
        Ok(JsSurbRecovery { inner, id_hex })
    }
}

/// Build a 32,768-byte Sphinx packet from a path and payload.
#[wasm_bindgen]
pub fn build_sphinx_packet(
    hops: Vec<JsPathHop>,
    payload: &[u8],
    pow_difficulty: u32,
) -> Result<Vec<u8>, JsValue> {
    let path = parse_hops(&hops)?;
    let packet = build_multi_hop_packet(&path, payload, pow_difficulty)
        .map_err(|e| JsValue::from_str(&format!("Sphinx build failed: {e}")))?;
    debug_assert_eq!(
        packet.len(),
        PACKET_SIZE,
        "build_multi_hop_packet must return exactly PACKET_SIZE bytes"
    );
    Ok(packet)
}

/// Create a SURB for the given reverse path. Returns serialized bytes + recovery object.
#[wasm_bindgen]
pub fn create_surb(
    path: Vec<JsPathHop>,
    id_hex: &str,
    pow_difficulty: u32,
) -> Result<JsSurbCreateResult, JsValue> {
    let rust_path = parse_hops(&path)?;
    let id = parse_id_hex(id_hex)?;

    let (surb, recovery) = Surb::new(&rust_path, id, pow_difficulty)
        .map_err(|e| JsValue::from_str(&format!("SURB creation failed: {e}")))?;

    let surb_bytes = bincode::serialize(&surb)
        .map_err(|e| JsValue::from_str(&format!("SURB serialization failed: {e}")))?;

    let recovery_id_hex = hex::encode(recovery.id);
    Ok(JsSurbCreateResult {
        surb_bytes,
        recovery: JsSurbRecovery {
            inner: recovery,
            id_hex: recovery_id_hex,
        },
    })
}

/// Create a format 2 SURB for the given reverse path.
///
/// The recovery's `id_hex` is the delivery ID that the final hop derives from
/// its shared secret. Claim the reply with it; it is never sent anywhere.
/// Replies are checked with a reply tag on decryption.
#[wasm_bindgen]
pub fn create_surb_v2(
    path: Vec<JsPathHop>,
    pow_difficulty: u32,
) -> Result<JsSurbCreateResult, JsValue> {
    let rust_path = parse_hops(&path)?;

    let (surb, recovery) = Surb::new_v2(&rust_path, pow_difficulty)
        .map_err(|e| JsValue::from_str(&format!("SURB creation failed: {e}")))?;

    let surb_bytes = bincode::serialize(&surb)
        .map_err(|e| JsValue::from_str(&format!("SURB serialization failed: {e}")))?;

    let recovery_id_hex = hex::encode(recovery.id);
    Ok(JsSurbCreateResult {
        surb_bytes,
        recovery: JsSurbRecovery {
            inner: recovery,
            id_hex: recovery_id_hex,
        },
    })
}

#[wasm_bindgen]
pub struct JsSurbCreateResult {
    surb_bytes: Vec<u8>,
    recovery: JsSurbRecovery,
}

#[wasm_bindgen]
impl JsSurbCreateResult {
    #[wasm_bindgen(getter)]
    pub fn surb_bytes(&self) -> Vec<u8> {
        self.surb_bytes.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn recovery(self) -> JsSurbRecovery {
        self.recovery
    }
}

/// Decrypt a SURB response body using the stored recovery. For a format 2
/// recovery the reply tag is checked before anything is returned.
#[wasm_bindgen]
pub fn decrypt_surb_response(
    recovery: &JsSurbRecovery,
    encrypted_body: &[u8],
) -> Result<Vec<u8>, JsValue> {
    recovery
        .inner
        .decrypt(encrypted_body)
        .map_err(|e| JsValue::from_str(&format!("SURB decryption failed: {e}")))
}

/// Find a nonce satisfying the PoW difficulty. Returns LE u64 bytes.
#[wasm_bindgen]
pub fn solve_pow(
    header_bytes: &[u8],
    difficulty: u32,
    start_nonce: u32,
) -> Result<Vec<u8>, JsValue> {
    let solver = default_solver();
    let nonce = solver
        .solve(header_bytes, difficulty, u64::from(start_nonce))
        .map_err(|e| JsValue::from_str(&format!("PoW solve failed: {e}")))?;
    Ok(nonce.to_le_bytes().to_vec())
}

#[wasm_bindgen]
pub fn verify_pow(header_bytes: &[u8], nonce_le_bytes: &[u8], difficulty: u32) -> bool {
    if nonce_le_bytes.len() != 8 {
        return false;
    }
    let nonce = u64::from_le_bytes([
        nonce_le_bytes[0],
        nonce_le_bytes[1],
        nonce_le_bytes[2],
        nonce_le_bytes[3],
        nonce_le_bytes[4],
        nonce_le_bytes[5],
        nonce_le_bytes[6],
        nonce_le_bytes[7],
    ]);
    let solver = default_solver();
    solver.verify(header_bytes, nonce, difficulty)
}

#[wasm_bindgen]
pub fn count_leading_zero_bits(hash: &[u8]) -> u32 {
    count_leading_zeros(hash)
}

#[wasm_bindgen]
pub fn check_difficulty(hash: &[u8], difficulty: u32) -> bool {
    meets_difficulty(hash, difficulty)
}

/// Topology fingerprint: XOR of `keccak256(address)` over the 20-byte node
/// addresses, as the NoxRegistry contract (`topologyFingerprint()`), the node
/// (`nox_core::utils::compute_topology_fingerprint`) and nox-client
/// (`computeTopologyFingerprint`) compute it. Addresses are 40 hex characters,
/// with or without a `0x` prefix; the result is 64 hex characters, no prefix.
#[wasm_bindgen]
pub fn topology_fingerprint(addresses_hex: Vec<String>) -> Result<String, JsValue> {
    compute_topology_fingerprint(&addresses_hex)
        .map(hex::encode)
        .map_err(|e| JsValue::from_str(&e))
}

fn compute_topology_fingerprint(addresses_hex: &[String]) -> Result<[u8; 32], String> {
    use tiny_keccak::{Hasher, Keccak};
    let mut xor = [0u8; 32];
    for addr_hex in addresses_hex {
        let addr_bytes = hex::decode(addr_hex.trim_start_matches("0x"))
            .map_err(|e| format!("Invalid address hex '{addr_hex}': {e}"))?;
        if addr_bytes.len() != 20 {
            return Err(format!(
                "Invalid address '{addr_hex}': {} bytes, expected 20",
                addr_bytes.len()
            ));
        }
        let mut hasher = Keccak::v256();
        hasher.update(&addr_bytes);
        let mut hash = [0u8; 32];
        hasher.finalize(&mut hash);
        for (x, h) in xor.iter_mut().zip(hash.iter()) {
            *x ^= h;
        }
    }
    Ok(xor)
}

fn parse_hops(hops: &[JsPathHop]) -> Result<Vec<PathHop>, JsValue> {
    hops.iter()
        .enumerate()
        .map(|(i, hop)| {
            let key_bytes = hex::decode(&hop.pub_key_hex)
                .map_err(|e| JsValue::from_str(&format!("Hop {i}: invalid pub_key_hex: {e}")))?;
            if key_bytes.len() != 32 {
                return Err(JsValue::from_str(&format!(
                    "Hop {i}: pub_key_hex must be 32 bytes (64 hex chars), got {}",
                    key_bytes.len()
                )));
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&key_bytes);
            Ok(PathHop {
                public_key: key.into(),
                address: hop.address.clone(),
            })
        })
        .collect()
}

fn parse_id_hex(id_hex: &str) -> Result<[u8; 16], JsValue> {
    let bytes =
        hex::decode(id_hex).map_err(|e| JsValue::from_str(&format!("Invalid SURB id_hex: {e}")))?;
    if bytes.len() != 16 {
        return Err(JsValue::from_str(&format!(
            "SURB id_hex must be 16 bytes (32 hex chars), got {}",
            bytes.len()
        )));
    }
    let mut id = [0u8; 16];
    id.copy_from_slice(&bytes);
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn test_pow_trivial() {
        let header = [0u8; 32];
        let nonce = solve_pow(&header, 0, 0).unwrap();
        assert_eq!(nonce.len(), 8);
        assert!(verify_pow(&header, &nonce, 0));
    }

    #[wasm_bindgen_test]
    fn test_pow_low_difficulty() {
        let header = b"test_header_data_for_pow";
        let nonce_bytes = solve_pow(header, 4, 0).unwrap();
        assert!(verify_pow(header, &nonce_bytes, 4));
    }

    #[wasm_bindgen_test]
    fn test_sphinx_packet_size() {
        let hop1 = JsPathHop::new("aa".repeat(32), "1.1.1.1:9000".to_string());
        let hop2 = JsPathHop::new("bb".repeat(32), "2.2.2.2:9000".to_string());
        let payload = b"hello mixnet";
        let packet = build_sphinx_packet(vec![hop1, hop2], payload, 0).unwrap();
        assert_eq!(packet.len(), 32_768);
    }

    #[wasm_bindgen_test]
    fn test_short_reply_body_is_an_error() {
        // A reply shorter than the Lioness minimum is refused with an error
        // (nox-crypto BodyTooShort) instead of trapping the module.
        let hops = vec![
            JsPathHop::new(hex::encode([9u8; 32]), "/ip4/1.1.1.1/tcp/9000".to_string()),
            JsPathHop::new(hex::encode([7u8; 32]), "/ip4/2.2.2.2/tcp/9000".to_string()),
        ];
        let recovery = create_surb_v2(hops, 0).unwrap().recovery();
        for len in [0usize, 1, 16, 31, 32] {
            let err = decrypt_surb_response(&recovery, &vec![0x42u8; len]).unwrap_err();
            let msg = err.as_string().unwrap_or_default();
            assert!(msg.contains("too short"), "{len} bytes: {msg}");
        }
    }

    #[test]
    fn v1_recovery_json_without_version_loads_as_v1() {
        let hop = JsPathHop::new("aa".repeat(32), "/ip4/1.1.1.1/tcp/9000".to_string());
        let created = create_surb(vec![hop], &"11".repeat(16), 0).unwrap();
        let json = created.recovery().to_json().unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&json).unwrap();
        value.as_object_mut().unwrap().remove("version");
        let loaded = JsSurbRecovery::from_json(&value.to_string()).unwrap();
        assert_eq!(loaded.version(), 1);
        assert_eq!(loaded.id_hex(), "11".repeat(16));
    }

    #[test]
    fn v2_surb_uses_marker_and_delivery_id() {
        let hops = vec![
            JsPathHop::new(hex::encode([9u8; 32]), "/ip4/1.1.1.1/tcp/9000".to_string()),
            JsPathHop::new(hex::encode([7u8; 32]), "/ip4/2.2.2.2/tcp/9000".to_string()),
        ];
        let created = create_surb_v2(hops, 0).unwrap();
        let surb: Surb = bincode::deserialize(&created.surb_bytes()).unwrap();
        assert!(surb.is_v2());
        let recovery = created.recovery();
        assert_eq!(recovery.version(), 2);
        assert_ne!(recovery.id_hex(), hex::encode(surb.id));
        let json = recovery.to_json().unwrap();
        assert_eq!(JsSurbRecovery::from_json(&json).unwrap().version(), 2);
    }

    #[test]
    fn v2_reply_roundtrip_and_tamper_rejected() {
        let hop = JsPathHop::new(hex::encode([5u8; 32]), "/ip4/1.1.1.1/tcp/9000".to_string());
        let created = create_surb_v2(vec![hop], 0).unwrap();
        let surb: Surb = bincode::deserialize(&created.surb_bytes()).unwrap();
        let recovery = created.recovery();
        let packet = surb.encapsulate_v2(b"\x01reply").unwrap();
        let body = &packet.as_bytes()[nox_crypto::sphinx::HEADER_SIZE..];
        // Undo the single hop's layer as the hop would have applied it.
        let mut inner = recovery.inner.clone();
        inner.layer_keys = vec![];
        let no_layers = JsSurbRecovery {
            inner,
            id_hex: recovery.id_hex(),
        };
        assert_eq!(
            decrypt_surb_response(&no_layers, body).unwrap(),
            b"\x01reply"
        );
        let mut tampered = body.to_vec();
        tampered[3] ^= 1;
        // Error paths build a JsValue, which only exists on wasm targets.
        assert!(no_layers.inner.decrypt(&tampered).is_err());
        // A format 1 reply cannot pass a format 2 recovery.
        let untagged = surb.encapsulate(b"\x01reply").unwrap();
        let untagged_body = &untagged.as_bytes()[nox_crypto::sphinx::HEADER_SIZE..];
        assert!(no_layers.inner.decrypt(untagged_body).is_err());
    }

    /// Live NoxRegistry members at Arbitrum Sepolia block 316,207,920 and the
    /// registry's `topologyFingerprint()` at that block (the worker snapshot,
    /// packages/anon-rpc-worker/snapshot/nox-snapshot.json). nox-client checks
    /// the same vector in tests/topology_fingerprint.test.ts.
    const LIVE_MEMBERS: [&str; 10] = [
        "0x03a42846c18b99c453a49d7fce69f336f865c48b",
        "0x074a13b271b73eb5c0c44e2037d035e7eef4a462",
        "0x1efa385556a6e8643df0033048ba1dd67ec43f93",
        "0x3e98ee4572741fd932e031ac60e79f7c012758be",
        "0x6774ca4baf6fff84f02898a3dee4299ed1f5ab4e",
        "0x74486dc1ac551e5cd3f4eef80727cc9d50d3abe9",
        "0x862d6b1105bde9d64dc5182fe3cd9d09f6f37463",
        "0x8c9fb3e9fe537067c8430480f80a4a5b9a12be1a",
        "0xbeb31ac0c57b3765cb855fa02081eadb9edb2426",
        "0xf8681a0acb60effcd9c169226e6f9c1ae9dd7894",
    ];
    const LIVE_FINGERPRINT: &str =
        "14ca3b69d6defe50fe55b6d332e6c9734db74f460ce5a8ac280c651724147c75";

    fn strings(addrs: &[&str]) -> Vec<String> {
        addrs.iter().map(|a| (*a).to_string()).collect()
    }

    #[test]
    fn test_topology_fingerprint_matches_registry_golden_vector() {
        let fp = compute_topology_fingerprint(&strings(&LIVE_MEMBERS)).unwrap();
        assert_eq!(hex::encode(fp), LIVE_FINGERPRINT);
        // Prefix and case do not change the bytes hashed.
        let bare: Vec<String> = LIVE_MEMBERS
            .iter()
            .map(|a| a.trim_start_matches("0x").to_uppercase())
            .collect();
        assert_eq!(
            hex::encode(compute_topology_fingerprint(&bare).unwrap()),
            LIVE_FINGERPRINT
        );
    }

    #[test]
    fn test_topology_fingerprint_two_addresses() {
        // keccak256(0x1234…5678) ^ keccak256(0xabcd…abcd), checked with `cast keccak`.
        let addrs = [
            "0x1234567890abcdef1234567890abcdef12345678",
            "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        ];
        let fp = compute_topology_fingerprint(&strings(&addrs)).unwrap();
        assert_eq!(
            hex::encode(fp),
            "4ef26622b39ecd0690c95f5f4c4041c6b3abd01f375c52ae08f3036b798cd11b"
        );
        let reversed = compute_topology_fingerprint(&strings(&[addrs[1], addrs[0]])).unwrap();
        assert_eq!(fp, reversed);
        let twice = compute_topology_fingerprint(&strings(&[addrs[0], addrs[0]])).unwrap();
        assert_eq!(twice, [0u8; 32]);
    }

    #[test]
    fn test_topology_fingerprint_rejects_bad_addresses() {
        assert!(compute_topology_fingerprint(&strings(&["not_hex"])).is_err());
        assert!(compute_topology_fingerprint(&strings(&["0x1234"])).is_err());
        assert!(compute_topology_fingerprint(&strings(&[
            "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
        ]))
        .is_err());
    }
}
