//! Typed errors with stable codes; the worker maps the codes to anon-rpc call codes.

use rustls::CertificateError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum TlsError {
    #[error("invalid TLS server name '{name}': {reason}")]
    InvalidServerName { name: String, reason: String },

    #[error("TLS client configuration failed: {0}")]
    Config(String),

    #[error("trust anchor rejected (DER, {len} bytes): {reason}")]
    InvalidTrustAnchor { len: usize, reason: String },

    #[error(
        "the certificate of '{server}' is not valid at this device's clock time ({detail}); check the device clock"
    )]
    Clock { server: String, detail: String },

    #[error("TLS session with '{server}' failed: {source}")]
    Tls {
        server: String,
        #[source]
        source: rustls::Error,
    },

    #[error("TLS record buffering with '{server}' failed: {source}")]
    Io {
        server: String,
        #[source]
        source: std::io::Error,
    },

    #[error("TLS session with '{server}' is closed; {bytes} plaintext bytes were not sent")]
    WriteAfterClose { server: String, bytes: usize },

    #[error("HTTP request rejected before sending: {0}")]
    HttpRequest(String),

    #[error("HTTP response malformed: {0}")]
    HttpResponse(String),

    #[error("HTTP response {part} exceeds the {limit}-byte limit")]
    HttpTooLarge { part: &'static str, limit: usize },

    #[error("HTTP response truncated: the connection ended {0}")]
    HttpTruncated(&'static str),
}

impl TlsError {
    /// Stable machine-readable code. Never reworded: the worker branches on it.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidServerName { .. } => "TLS_INVALID_SERVER_NAME",
            Self::Config(_) => "TLS_CONFIG",
            Self::InvalidTrustAnchor { .. } => "TLS_INVALID_TRUST_ANCHOR",
            Self::Clock { .. } => "TLS_CERTIFICATE_REJECTED",
            Self::Tls { source, .. } => tls_code(source),
            Self::Io { .. } => "TLS_IO",
            Self::WriteAfterClose { .. } => "TLS_CLOSED",
            Self::HttpRequest(_) => "HTTP_REQUEST_INVALID",
            Self::HttpResponse(_) => "HTTP_RESPONSE_MALFORMED",
            Self::HttpTooLarge { .. } => "HTTP_RESPONSE_TOO_LARGE",
            Self::HttpTruncated(_) => "HTTP_RESPONSE_TRUNCATED",
        }
    }

    /// Wraps a rustls failure, naming the device clock when a certificate is outside its
    /// validity period at the local time.
    pub(crate) fn from_rustls(server: &str, source: rustls::Error) -> Self {
        if let rustls::Error::InvalidCertificate(cert) = &source {
            let clock = matches!(
                cert,
                CertificateError::Expired
                    | CertificateError::ExpiredContext { .. }
                    | CertificateError::NotValidYet
                    | CertificateError::NotValidYetContext { .. }
            );
            if clock {
                return Self::Clock {
                    server: server.to_string(),
                    detail: source.to_string(),
                };
            }
        }
        Self::Tls {
            server: server.to_string(),
            source,
        }
    }
}

fn tls_code(error: &rustls::Error) -> &'static str {
    match error {
        rustls::Error::InvalidCertificate(_) | rustls::Error::NoCertificatesPresented => {
            "TLS_CERTIFICATE_REJECTED"
        }
        rustls::Error::AlertReceived(_) => "TLS_ALERT_RECEIVED",
        rustls::Error::PeerIncompatible(_) => "TLS_PEER_INCOMPATIBLE",
        rustls::Error::PeerMisbehaved(_) => "TLS_PEER_MISBEHAVED",
        rustls::Error::DecryptError => "TLS_DECRYPT_FAILED",
        _ => "TLS_PROTOCOL",
    }
}
