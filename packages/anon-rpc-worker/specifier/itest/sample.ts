// A sample worker bundle and the resolver list a Nox release would publish for it: KPS entry nodes (IPv4 and
// bracketed IPv6) plus npm CDN and GitHub `keccak`-branch URLs. Addresses come from documentation ranges
// (RFC 5737, RFC 3849); the certhash is a well-formed sha2-256 multihash. Nothing here points at a real host.

import { keccak256 } from "ethers";

export const SAMPLE_BUNDLE = new TextEncoder().encode(
  '"use strict";\n// Nox anon-rpc worker: specifier integration-test sample bundle\n',
);
export const SAMPLE_HASH = keccak256(SAMPLE_BUNDLE).toLowerCase() as `0x${string}`;

const hh = SAMPLE_HASH.slice(2, 4);
const rest = SAMPLE_HASH.slice(4);

export const SAMPLE_CERTHASH = "uEiBfU3pQgjdx0UAXVjX5E73SDaz3GOV3554Ff7Yze-8_aQ";
export const SAMPLE_KPS_IPV4 = `kps:203.0.113.10:15005:${SAMPLE_CERTHASH}/keccak/${hh}/${rest}`;
export const SAMPLE_KPS_IPV6 = `kps:[2001:db8::10]:15005:${SAMPLE_CERTHASH}/keccak/${hh}/${rest}`;
export const SAMPLE_JSDELIVR =
  "https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@0.1.0/dist/nox-anon-rpc-worker.js";
export const SAMPLE_UNPKG = "https://unpkg.com/@hisoka-io/anon-rpc-worker@0.1.0/dist/nox-anon-rpc-worker.js";
export const SAMPLE_GITHUB = `https://raw.githubusercontent.com/hisoka-io/anon-rpc-worker/keccak/${hh}/${rest}`;

/** KPS entries first: in a browser they are the CA-free path; in Node they fail over to the https entries. */
export const SAMPLE_RESOLVERS: readonly string[] = [
  SAMPLE_KPS_IPV4,
  SAMPLE_KPS_IPV6,
  SAMPLE_JSDELIVR,
  SAMPLE_UNPKG,
  SAMPLE_GITHUB,
];

/** The tor-js specifier on Ethereum mainnet, read 2026-10-03: real-world strings for the resolver checks. */
export const TORJS_MAINNET = {
  address: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
  workerHash: "0xe8919c53b89d2328b1de33aedf573cef194b1ac7d582342004a6b3362e7aad3e",
  resolvers: [
    "https://cdn.jsdelivr.net/npm/tor-js@0.4.2/dist/anon-rpc-worker.js",
    "https://unpkg.com/tor-js@0.4.2/dist/anon-rpc-worker.js",
    "https://raw.githubusercontent.com/ethereum/tor-js/keccak/e8/919c53b89d2328b1de33aedf573cef194b1ac7d582342004a6b3362e7aad3e",
    "kps:170.64.236.147:12298:uEiBHwUMNRTetrbqScahm81Di57Xv2OphNrx-CurJGOq3ww/keccak/e8/919c53b89d2328b1de33aedf573cef194b1ac7d582342004a6b3362e7aad3e",
    "kps:[2400:6180:10:200::cca4:4000]:12298:uEiBHwUMNRTetrbqScahm81Di57Xv2OphNrx-CurJGOq3ww/keccak/e8/919c53b89d2328b1de33aedf573cef194b1ac7d582342004a6b3362e7aad3e",
  ],
} as const;
