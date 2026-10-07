//! rustls client configuration: ring crypto, compiled-in Mozilla roots, ALPN http/1.1 only and
//! no session resumption, so no ticket or PSK ever links two sessions.

use std::sync::Arc;

use rustls::client::Resumption;
use rustls::crypto::{ring, CryptoProvider};
use rustls::pki_types::CertificateDer;
use rustls::{CipherSuite, ClientConfig, NamedGroup, RootCertStore};

use crate::error::TlsError;

/// The only application protocol offered; the exit refuses tunnels that offer anything else.
pub const ALPN_HTTP11: &[u8] = b"http/1.1";

/// AEAD suites only, ECDHE key exchange over X25519 or P-256.
fn provider() -> CryptoProvider {
    let mut provider = ring::default_provider();
    provider.cipher_suites.retain(|suite| {
        matches!(
            suite.suite(),
            CipherSuite::TLS13_AES_128_GCM_SHA256
                | CipherSuite::TLS13_AES_256_GCM_SHA384
                | CipherSuite::TLS13_CHACHA20_POLY1305_SHA256
                | CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
                | CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
                | CipherSuite::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
                | CipherSuite::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
                | CipherSuite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
                | CipherSuite::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256
        )
    });
    provider
        .kx_groups
        .retain(|group| matches!(group.name(), NamedGroup::X25519 | NamedGroup::secp256r1));
    provider
}

/// Builds the client config shared by every session. `extra_roots_der` is for test beds only:
/// a release worker passes none and trusts the compiled-in roots alone.
pub fn build_client_config(
    use_webpki_roots: bool,
    extra_roots_der: &[Vec<u8>],
) -> Result<Arc<ClientConfig>, TlsError> {
    let mut roots = RootCertStore::empty();
    if use_webpki_roots {
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    }
    for der in extra_roots_der {
        roots
            .add(CertificateDer::from(der.clone()))
            .map_err(|error| TlsError::InvalidTrustAnchor {
                len: der.len(),
                reason: error.to_string(),
            })?;
    }
    if roots.is_empty() {
        return Err(TlsError::Config(
            "no trust anchors: enable the compiled-in roots or pass a root certificate".to_string(),
        ));
    }
    let mut config = ClientConfig::builder_with_provider(Arc::new(provider()))
        .with_safe_default_protocol_versions()
        .map_err(|error| TlsError::Config(format!("protocol versions: {error}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![ALPN_HTTP11.to_vec()];
    config.resumption = Resumption::disabled();
    config.enable_early_data = false;
    Ok(Arc::new(config))
}

/// Number of compiled-in trust anchors.
#[must_use]
pub fn webpki_root_count() -> usize {
    webpki_roots::TLS_SERVER_ROOTS.len()
}
