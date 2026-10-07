//! Sans-IO TLS client session. The caller moves ciphertext between this session and the Nox
//! tunnel; the exit holds no key and sees TLS records only.

use std::io::{ErrorKind, Read, Write};
use std::sync::Arc;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection};

use crate::error::TlsError;

/// Plaintext read from rustls per call.
const READ_CHUNK: usize = 16 * 1024;

pub struct TlsSession {
    server: String,
    conn: ClientConnection,
    plaintext: Vec<u8>,
    close_notify: bool,
    transport_closed: bool,
}

impl TlsSession {
    /// Starts a client handshake; the ClientHello is available from [`Self::take_outgoing`].
    pub fn new(config: Arc<ClientConfig>, server_name: &str) -> Result<Self, TlsError> {
        let name = ServerName::try_from(server_name.to_string()).map_err(|error| {
            TlsError::InvalidServerName {
                name: server_name.to_string(),
                reason: error.to_string(),
            }
        })?;
        if matches!(name, ServerName::IpAddress(_)) {
            return Err(TlsError::InvalidServerName {
                name: server_name.to_string(),
                reason: "tunnels reach hosts by DNS name".to_string(),
            });
        }
        let conn = ClientConnection::new(config, name)
            .map_err(|source| TlsError::from_rustls(server_name, source))?;
        Ok(Self {
            server: server_name.to_string(),
            conn,
            plaintext: Vec::new(),
            close_notify: false,
            transport_closed: false,
        })
    }

    #[must_use]
    pub fn is_handshaking(&self) -> bool {
        self.conn.is_handshaking()
    }

    /// True when records wait to go to the server (a handshake flight, an alert, data).
    #[must_use]
    pub fn wants_write(&self) -> bool {
        self.conn.wants_write()
    }

    /// True once the server sent close_notify: everything before it is authentic and complete.
    #[must_use]
    pub fn close_notify_received(&self) -> bool {
        self.close_notify
    }

    /// True once the server sent close_notify or the transport ended.
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.close_notify || self.transport_closed
    }

    /// Drains every TLS record waiting to go to the server.
    pub fn take_outgoing(&mut self) -> Result<Vec<u8>, TlsError> {
        let mut out = Vec::new();
        while self.conn.wants_write() {
            let written = self
                .conn
                .write_tls(&mut out)
                .map_err(|source| TlsError::Io {
                    server: self.server.clone(),
                    source,
                })?;
            if written == 0 {
                break;
            }
        }
        Ok(out)
    }

    /// Feeds TLS records from the server; decrypted bytes accumulate for
    /// [`Self::take_plaintext`]. After a TLS error the alert stays queued for `take_outgoing`.
    pub fn push_incoming(&mut self, mut data: &[u8]) -> Result<(), TlsError> {
        while !data.is_empty() {
            let read = self
                .conn
                .read_tls(&mut data)
                .map_err(|source| TlsError::Io {
                    server: self.server.clone(),
                    source,
                })?;
            self.process()?;
            if read == 0 {
                break;
            }
        }
        Ok(())
    }

    /// The tunnel reported the upstream connection closed.
    pub fn push_transport_eof(&mut self) -> Result<(), TlsError> {
        let mut empty: &[u8] = &[];
        self.conn
            .read_tls(&mut empty)
            .map_err(|source| TlsError::Io {
                server: self.server.clone(),
                source,
            })?;
        self.transport_closed = true;
        self.process()
    }

    /// Queues application data for the next [`Self::take_outgoing`]. Written before the
    /// handshake ends, it leaves right after the client Finished, in the same tunnel exchange.
    pub fn write_plaintext(&mut self, data: &[u8]) -> Result<(), TlsError> {
        if self.is_closed() {
            return Err(TlsError::WriteAfterClose {
                server: self.server.clone(),
                bytes: data.len(),
            });
        }
        self.conn
            .writer()
            .write_all(data)
            .map_err(|source| TlsError::Io {
                server: self.server.clone(),
                source,
            })
    }

    /// Returns and clears the decrypted bytes received so far.
    pub fn take_plaintext(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.plaintext)
    }

    /// Queues close_notify.
    pub fn close(&mut self) {
        self.conn.send_close_notify();
    }

    /// Negotiated protocol version, for logs (`TLSv1_3`, `TLSv1_2` or `none`).
    #[must_use]
    pub fn protocol(&self) -> String {
        self.conn
            .protocol_version()
            .map_or_else(|| "none".to_string(), |version| format!("{version:?}"))
    }

    fn process(&mut self) -> Result<(), TlsError> {
        self.conn
            .process_new_packets()
            .map_err(|source| TlsError::from_rustls(&self.server, source))?;
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match self.conn.reader().read(&mut buf) {
                Ok(0) => {
                    self.close_notify = true;
                    return Ok(());
                }
                Ok(n) => self.plaintext.extend_from_slice(&buf[..n]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(()),
                // The transport ended without close_notify; HTTP framing decides whether the
                // response is complete, and a close-delimited body is then a truncation.
                Err(error) if error.kind() == ErrorKind::UnexpectedEof => {
                    self.transport_closed = true;
                    return Ok(());
                }
                Err(source) => {
                    return Err(TlsError::Io {
                        server: self.server.clone(),
                        source,
                    })
                }
            }
        }
    }
}
