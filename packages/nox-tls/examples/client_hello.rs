//! Prints, as hex, the ClientHello record the worker sends for `<host>` (default
//! `rpc.example`). The exit's tunnel gate checks a copy of this output in as its fixture, so a
//! rustls upgrade that changes the ClientHello in a way the gate refuses fails a unit test.
//!
//! Usage: cargo run -p nox-tls --example client_hello [host]

use std::process::ExitCode;

fn main() -> ExitCode {
    let host = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "rpc.example".to_string());
    let hello = nox_tls::build_client_config(true, &[])
        .and_then(|config| nox_tls::TlsSession::new(config, &host))
        .and_then(|mut session| session.take_outgoing());
    match hello {
        Ok(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            println!("{hex}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("client_hello: {error} ({})", error.code());
            ExitCode::FAILURE
        }
    }
}
