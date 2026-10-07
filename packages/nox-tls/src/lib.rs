//! TLS inside the Nox anon-rpc worker. The worker runs the TLS client and moves ciphertext
//! through a Nox exit tunnel, so the exit relays TLS records and never sees the request or the
//! response. Sans-IO: the caller moves the bytes.

pub mod config;
pub mod error;
pub mod http1;
pub mod session;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use config::{build_client_config, webpki_root_count};
pub use error::TlsError;
pub use http1::{
    encode_request, padded_len, HttpLimits, HttpResponse, RequestOptions, ResponseParser,
    USER_AGENT,
};
pub use session::TlsSession;
