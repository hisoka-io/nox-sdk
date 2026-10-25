# Changelog

All notable changes to `@hisoka-io/nox-wasm`.

## 0.3.0 (2026-10-25)

### Fixed

- `topology_fingerprint` now hashes each 20-byte address with keccak256 (was SHA-256), so it returns the value of
  NoxRegistry `topologyFingerprint()`, the node and nox-client `computeTopologyFingerprint`. Checked against the
  registry's fingerprint of its 10 members at Arbitrum Sepolia block 316,207,920. An address that is not 20 bytes
  of hex is now an error.
- `decrypt_surb_response` returns an error for a reply body shorter than 33 bytes, from nox-crypto's
  `BodyTooShort` bound.

### Changed

- nox-crypto pinned to nox `dff8ebe` (v0.4.0-rc.10 plus documentation), up from `c8aef77`. Sphinx packets, reply
  blocks and the wire format are unchanged.

## 0.2.0

Format 2 reply blocks (`create_surb_v2`), claimed by delivery ID with a checked reply tag.
