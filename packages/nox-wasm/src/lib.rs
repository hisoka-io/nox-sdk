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

/// Decrypt a SURB response body using the stored recovery.
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

/// XOR topology fingerprint over node addresses (40-char hex, no 0x prefix).
#[wasm_bindgen]
pub fn topology_fingerprint(addresses_hex: Vec<String>) -> Result<String, JsValue> {
    use sha2::{Digest, Sha256};
    let mut xor = [0u8; 32];
    for addr_hex in &addresses_hex {
        let addr_bytes = hex::decode(addr_hex.trim_start_matches("0x"))
            .map_err(|e| JsValue::from_str(&format!("Invalid address hex '{addr_hex}': {e}")))?;
        let hash: [u8; 32] = Sha256::digest(&addr_bytes).into();
        for (x, h) in xor.iter_mut().zip(hash.iter()) {
            *x ^= h;
        }
    }
    Ok(hex::encode(xor))
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

    wasm_bindgen_test::wasm_bindgen_test_configure!(run_in_browser);

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
    fn test_topology_fingerprint_deterministic() {
        let addrs = vec![
            "abcdef1234567890abcdef1234567890abcdef12".to_string(),
            "1234567890abcdef1234567890abcdef12345678".to_string(),
        ];
        let fp1 = topology_fingerprint(addrs.clone()).unwrap();
        let fp2 = topology_fingerprint(addrs).unwrap();
        assert_eq!(fp1, fp2);
    }
}
