# nox-tls

The TLS client of the Nox anon-rpc worker: rustls 0.23 with the ring crypto provider, compiled to WebAssembly and
embedded in the worker bundle. It is sans-IO: the worker moves TLS records through a Nox exit tunnel
(`ServiceRequest::TunnelV1`), so the exit relays ciphertext and the request and response stay between the worker
and the RPC provider.

- TLS 1.3 and 1.2, AEAD suites only, X25519 and P-256 key exchange, ALPN `http/1.1` only (the exit's tunnel gate
  requires exactly that), resumption off: every ClientHello carries a fresh key share and no PSK or ticket.
- Certificates: the Mozilla root store compiled in (webpki-roots, version and release date in `Cargo.toml`
  `[package.metadata.webpki-roots]`, recorded in the worker provenance), checked against the host name and the
  device clock (`Date.now()` in WebAssembly); a certificate outside its validity period names the device clock.
- HTTP/1.1 (`http1.rs`): an encoder that sets `Host`, `Content-Length`, `Connection` and a fixed `User-Agent`
  itself, drops caller framing and hop-by-hop headers, refuses CR, LF and NUL, and pads JSON requests to size
  buckets; an incremental response parser for Content-Length, chunked and close-delimited bodies (the last complete
  only with TLS close_notify), with 1xx responses skipped.
- Errors carry stable codes (`TLS_CERTIFICATE_REJECTED`, `HTTP_RESPONSE_TRUNCATED`, ...) that the worker maps to
  anon-rpc call codes.

Build: `packages/anon-rpc-worker/scripts/build-wasm.sh` builds this crate with the worker's pinned toolchain,
including clang and llvm-ar for ring's C sources (`scripts/toolchain.env`).

Tests (native, against an in-memory rustls server): `cargo test -p nox-tls`.

The exit's ClientHello gate checks a fixture of the ClientHello this crate sends:
`cargo run -p nox-tls --example client_hello [host]` prints it as hex (default host `rpc.example`). Refresh the
fixture in nox (`crates/nox-node/src/services/handlers/tunnel/worker_client_hello.hex`) whenever rustls or this
configuration changes.
