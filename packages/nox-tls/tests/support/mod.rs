//! Test helpers: an in-memory rustls server standing in for the RPC host behind a Nox exit,
//! and a ClientHello reader for the properties the exit's tunnel gate checks.

use std::io::{Read, Write};
use std::sync::Arc;

use nox_tls::{build_client_config, TlsSession};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ServerConfig, ServerConnection};

pub const CA: &[u8] = include_bytes!("../fixtures/ca.cert.der");
pub const EC_CERT: &[u8] = include_bytes!("../fixtures/server-ec.cert.der");
pub const EC_KEY: &[u8] = include_bytes!("../fixtures/server-ec.key.der");
pub const RSA_CERT: &[u8] = include_bytes!("../fixtures/server-rsa.cert.der");
pub const RSA_KEY: &[u8] = include_bytes!("../fixtures/server-rsa.key.der");
pub const EXPIRED_CERT: &[u8] = include_bytes!("../fixtures/server-expired.cert.der");
pub const EXPIRED_KEY: &[u8] = include_bytes!("../fixtures/server-expired.key.der");
pub const UNTRUSTED_CERT: &[u8] = include_bytes!("../fixtures/server-untrusted.cert.der");
pub const UNTRUSTED_KEY: &[u8] = include_bytes!("../fixtures/server-untrusted.key.der");

pub const REPLY: &[u8] = br#"{"jsonrpc":"2.0","id":1,"result":"0x1234"}"#;

#[derive(Clone, Copy)]
pub enum Versions {
    Both,
    Tls12Only,
}

/// How the toy server frames its reply.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Framing {
    ContentLength,
    /// No length: the body ends when the connection does.
    UntilClose {
        close_notify: bool,
    },
}

pub fn server_config(cert: &[u8], key: &[u8], versions: Versions) -> Arc<ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ServerConfig::builder_with_provider(provider);
    let builder = match versions {
        Versions::Both => builder.with_safe_default_protocol_versions(),
        Versions::Tls12Only => builder.with_protocol_versions(&[&rustls::version::TLS12]),
    }
    .unwrap();
    let mut config = builder
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.to_vec())),
        )
        .unwrap();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

pub fn client(server_name: &str) -> TlsSession {
    TlsSession::new(
        build_client_config(false, &[CA.to_vec()]).unwrap(),
        server_name,
    )
    .unwrap()
}

/// The exit's TCP socket to the RPC host plus a toy HTTP server; one `exchange` is one tunnel
/// round trip carrying ciphertext both ways.
pub struct Upstream {
    pub server: ServerConnection,
    pub exchanges: usize,
    pub framing: Framing,
    pub tamper_next_reply: bool,
    request_buf: Vec<u8>,
}

impl Upstream {
    pub fn new(config: Arc<ServerConfig>) -> Self {
        Self {
            server: ServerConnection::new(config).unwrap(),
            exchanges: 0,
            framing: Framing::ContentLength,
            tamper_next_reply: false,
            request_buf: Vec::new(),
        }
    }

    pub fn exchange(&mut self, client_bytes: &[u8]) -> Result<Vec<u8>, rustls::Error> {
        self.exchanges += 1;
        let mut input = client_bytes;
        while !input.is_empty() {
            self.server.read_tls(&mut input).unwrap();
            self.server.process_new_packets()?;
        }
        let mut plain = Vec::new();
        let _ = self.server.reader().read_to_end(&mut plain);
        self.request_buf.extend_from_slice(&plain);
        if let Some(len) = complete_request_len(&self.request_buf) {
            self.request_buf.drain(..len);
            match self.framing {
                Framing::ContentLength => {
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        REPLY.len()
                    );
                    self.server.writer().write_all(head.as_bytes()).unwrap();
                    self.server.writer().write_all(REPLY).unwrap();
                }
                Framing::UntilClose { close_notify } => {
                    let head = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n";
                    self.server.writer().write_all(head.as_bytes()).unwrap();
                    self.server.writer().write_all(REPLY).unwrap();
                    if close_notify {
                        self.server.send_close_notify();
                    }
                }
            }
        }
        let mut out = Vec::new();
        while self.server.wants_write() {
            self.server.write_tls(&mut out).unwrap();
        }
        if self.tamper_next_reply && !out.is_empty() {
            let last = out.len() - 1;
            out[last] ^= 0x01;
            self.tamper_next_reply = false;
        }
        Ok(out)
    }
}

fn complete_request_len(buf: &[u8]) -> Option<usize> {
    let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
    let body_len = head
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .map_or(0, |value| value.trim().parse::<usize>().unwrap());
    (buf.len() >= head_end + body_len).then_some(head_end + body_len)
}

/// What the exit's ClientHello gate looks at.
#[derive(Debug, Default)]
pub struct ClientHello {
    pub server_name: Option<String>,
    pub alpn: Vec<String>,
    pub extensions: Vec<u16>,
}

pub const EXT_PRE_SHARED_KEY: u16 = 41;
pub const EXT_EARLY_DATA: u16 = 42;

/// Parses one TLS record holding one ClientHello.
pub fn read_client_hello(record: &[u8]) -> ClientHello {
    assert_eq!(record[0], 22, "handshake record");
    let len = u16::from_be_bytes([record[3], record[4]]) as usize;
    assert_eq!(record.len(), 5 + len, "exactly one record");
    let body = &record[5..];
    assert_eq!(body[0], 1, "ClientHello");
    let mut at = 4 + 2 + 32;
    at += 1 + body[at] as usize;
    at += 2 + u16::from_be_bytes([body[at], body[at + 1]]) as usize;
    at += 1 + body[at] as usize;
    let end = at + 2 + u16::from_be_bytes([body[at], body[at + 1]]) as usize;
    at += 2;
    let mut hello = ClientHello::default();
    while at < end {
        let kind = u16::from_be_bytes([body[at], body[at + 1]]);
        let size = u16::from_be_bytes([body[at + 2], body[at + 3]]) as usize;
        let data = &body[at + 4..at + 4 + size];
        hello.extensions.push(kind);
        match kind {
            0 => {
                let name_len = u16::from_be_bytes([data[3], data[4]]) as usize;
                hello.server_name =
                    Some(String::from_utf8(data[5..5 + name_len].to_vec()).unwrap());
            }
            16 => {
                let mut i = 2;
                while i < data.len() {
                    let n = data[i] as usize;
                    hello
                        .alpn
                        .push(String::from_utf8(data[i + 1..i + 1 + n].to_vec()).unwrap());
                    i += 1 + n;
                }
            }
            _ => {}
        }
        at += 4 + size;
    }
    hello
}
