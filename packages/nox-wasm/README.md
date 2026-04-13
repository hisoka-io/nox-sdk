# @hisoka-io/nox-wasm

WASM bindings for NOX mixnet Sphinx cryptography. Used internally by `@hisoka-io/nox-client`.

## Install

```bash
npm install @hisoka-io/nox-wasm
```

You typically do not need to install this package directly. It is a dependency of `@hisoka-io/nox-client` which handles initialization automatically.

## What it does

This package provides the cryptographic primitives for Sphinx packet construction and SURB (Single Use Reply Block) processing, compiled from Rust to WebAssembly.

Operations included:

| Function | Purpose |
|----------|---------|
| `build_sphinx_packet` | Construct a layered Sphinx packet for 3 hop routing |
| `create_surb` | Generate a Single Use Reply Block for anonymous responses |
| `decrypt_surb_response` | Decrypt a SURB encrypted response body |
| `verify_pow` | Verify proof of work on incoming packets |
| `compute_pow` | Compute proof of work for outgoing packets |

All X25519 key exchange, Lioness wide block cipher, HMAC SHA256, and ChaCha20 operations happen inside WASM for performance and correctness (the Rust implementation is shared with the NOX relay nodes).

## Direct usage

If you need to use the WASM module directly (advanced):

```ts
import init, { build_sphinx_packet, create_surb } from "@hisoka-io/nox-wasm";

// In Node.js, the module initializes automatically on import.
// In browsers, you may need to call init() with the WASM URL.
```

## Build from source

Requires Rust toolchain with `wasm32-unknown-unknown` target and `wasm-pack`:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build --target nodejs --out-dir pkg-node
```

## License

Apache-2.0
