// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @dev Sample specifier contents in the shapes the Nox worker will publish: npm CDN and GitHub `keccak`-branch
/// `https:` URLs, plus `kps:` resolver strings for an IPv4 and a bracketed IPv6 entry node (SPEC.md §4.1). The
/// addresses are documentation ranges (RFC 5737, RFC 3849) and the certhash is a well-formed multibase base64url
/// sha2-256 multihash, so the strings have production length and syntax without pointing anywhere real.
library Samples {
    /// keccak256("nox anon-rpc worker sample bundle")
    bytes32 internal constant BUNDLE_HASH = 0x3cec500f4c13d5735640bfc325a6634cf4c9b83adee173517551e9a5fe12c505;

    bytes32 internal constant OTHER_HASH = keccak256("nox anon-rpc worker sample bundle, next version");

    string internal constant JSDELIVR =
        "https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@0.1.0/dist/nox-anon-rpc-worker.js";
    string internal constant UNPKG = "https://unpkg.com/@hisoka-io/anon-rpc-worker@0.1.0/dist/nox-anon-rpc-worker.js";
    string internal constant GITHUB_KECCAK =
        "https://raw.githubusercontent.com/hisoka-io/anon-rpc-worker/keccak/3c/ec500f4c13d5735640bfc325a6634cf4c9b83adee173517551e9a5fe12c505";
    string internal constant KPS_IPV4 =
        "kps:203.0.113.10:15005:uEiBfU3pQgjdx0UAXVjX5E73SDaz3GOV3554Ff7Yze-8_aQ/keccak/3c/ec500f4c13d5735640bfc325a6634cf4c9b83adee173517551e9a5fe12c505";
    string internal constant KPS_IPV6 =
        "kps:[2001:db8::10]:15005:uEiBfU3pQgjdx0UAXVjX5E73SDaz3GOV3554Ff7Yze-8_aQ/keccak/3c/ec500f4c13d5735640bfc325a6634cf4c9b83adee173517551e9a5fe12c505";

    function resolvers() internal pure returns (string[] memory r) {
        r = new string[](5);
        r[0] = JSDELIVR;
        r[1] = UNPKG;
        r[2] = GITHUB_KECCAK;
        r[3] = KPS_IPV4;
        r[4] = KPS_IPV6;
    }

    function one(string memory entry) internal pure returns (string[] memory r) {
        r = new string[](1);
        r[0] = entry;
    }

    function equal(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function equal(string[] memory a, string[] memory b) internal pure returns (bool) {
        return keccak256(abi.encode(a)) == keccak256(abi.encode(b));
    }
}
