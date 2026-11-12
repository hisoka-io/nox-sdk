# Changelog

All notable changes to `@hisoka-io/nox-wasm`.

## Unreleased

### Changed

- nox-crypto pinned to nox `b687ecf` (main, after v0.4.0-rc.13), up from `676bb80`. Sphinx packets and reply
  blocks built by `build_sphinx_packet`, `create_surb` and `create_surb_v2` fill the final hop's unused routing
  bytes with random bytes, so the final hop cannot read the path length. Nodes read the same bytes as before; the
  wire format is unchanged.

## 0.3.0 (2026-10-25)

### Fixed

- `topology_fingerprint` now hashes each 20-byte address with keccak256 (was SHA-256), so it returns the value of
  NoxRegistry `topologyFingerprint()`, the node and nox-client `computeTopologyFingerprint`. Checked against the
  registry's fingerprint of its 10 members at Arbitrum Sepolia block 316,207,920. An address that is not 20 bytes
  of hex is now an error.
- `decrypt_surb_response` returns an error for a reply body shorter than 33 bytes, from nox-crypto's
  `BodyTooShort` bound.

### Changed

- nox-crypto pinned to nox `676bb80` (the v0.4.0-rc.11 tag), up from `c8aef77`. Sphinx packets, reply
  blocks and the wire format are unchanged.

## 0.2.0

Format 2 reply blocks (`create_surb_v2`), claimed by delivery ID with a checked reply tag.
