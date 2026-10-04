// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IWorkerSpecifier} from "../src/IWorkerSpecifier.sol";
import {WorkerSpecifier} from "../src/WorkerSpecifier.sol";
import {ImmutableWorkerSpecifier} from "../src/ImmutableWorkerSpecifier.sol";
import {CHEATS} from "./utils/Cheats.sol";
import {Samples} from "./utils/Samples.sol";

/// @dev What a harness can observe of a specifier, checked identically for both contracts. The reference harness
/// (npm package anon-rpc browser-harness 0.3.2, file src/host/specifier.ts) issues `eth_call` with the bare
/// selectors and decodes the return data by hand, so the exact selector values and the canonical ABI encoding of
/// the return data are part of the interface, not implementation details.
abstract contract SpecifierConformance {
    bytes4 internal constant WORKER_HASH_SELECTOR = 0x3898587d;
    bytes4 internal constant WORKER_RESOLVERS_SELECTOR = 0x1c67ff29;

    function _deploy(bytes32 hash, string[] memory resolvers) internal virtual returns (IWorkerSpecifier);

    function test_SelectorsMatchTheHarness() public pure {
        require(IWorkerSpecifier.workerHash.selector == WORKER_HASH_SELECTOR, "workerHash() selector");
        require(IWorkerSpecifier.workerResolvers.selector == WORKER_RESOLVERS_SELECTOR, "workerResolvers() selector");
        require(bytes4(keccak256("workerHash()")) == WORKER_HASH_SELECTOR, "harness derives workerHash() this way");
        require(
            bytes4(keccak256("workerResolvers()")) == WORKER_RESOLVERS_SELECTOR,
            "harness derives workerResolvers() this way"
        );
    }

    function test_ReturnsTheSampleHashAndResolvers() public {
        IWorkerSpecifier spec = _deploy(Samples.BUNDLE_HASH, Samples.resolvers());
        require(spec.workerHash() == Samples.BUNDLE_HASH, "hash");
        string[] memory got = spec.workerResolvers();
        require(got.length == 5, "resolver count");
        require(Samples.equal(got[0], Samples.JSDELIVR), "jsdelivr entry");
        require(Samples.equal(got[1], Samples.UNPKG), "unpkg entry");
        require(Samples.equal(got[2], Samples.GITHUB_KECCAK), "github keccak entry");
        require(Samples.equal(got[3], Samples.KPS_IPV4), "kps ipv4 entry");
        require(Samples.equal(got[4], Samples.KPS_IPV6), "kps ipv6 entry");
    }

    /// The harness reads raw return data (32-byte word for the hash; offset, length, element offsets and padded
    /// strings for the list). Anything but the canonical encoding would decode differently or not at all.
    function test_RawReturnDataIsCanonicalAbiEncoding() public {
        string[] memory resolvers = Samples.resolvers();
        IWorkerSpecifier spec = _deploy(Samples.BUNDLE_HASH, resolvers);

        (bool okHash, bytes memory hashRet) = address(spec).staticcall(abi.encodeWithSelector(WORKER_HASH_SELECTOR));
        require(okHash, "workerHash() staticcall");
        require(keccak256(hashRet) == keccak256(abi.encode(Samples.BUNDLE_HASH)), "workerHash() return data");

        (bool okList, bytes memory listRet) =
            address(spec).staticcall(abi.encodeWithSelector(WORKER_RESOLVERS_SELECTOR));
        require(okList, "workerResolvers() staticcall");
        require(keccak256(listRet) == keccak256(abi.encode(resolvers)), "workerResolvers() return data");
        // Head word: offset 0x20 to the array, as the harness's decodeStringArray expects.
        require(uint256(bytes32(_slice32(listRet, 0))) == 0x20, "array offset word");
        require(uint256(bytes32(_slice32(listRet, 32))) == resolvers.length, "array length word");
    }

    function test_LongResolverListsRoundTrip() public {
        string[] memory resolvers = new string[](16);
        for (uint256 i = 0; i < resolvers.length; ++i) {
            resolvers[i] = string.concat(Samples.KPS_IPV4, "?entry=", _decimal(i), _filler(i * 17));
        }
        IWorkerSpecifier spec = _deploy(Samples.BUNDLE_HASH, resolvers);
        require(Samples.equal(spec.workerResolvers(), resolvers), "16 long entries round-trip in order");
    }

    function testFuzz_AnyHashAndResolversRoundTrip(bytes32 hash, string[] memory resolvers) public {
        CHEATS.assume(hash != bytes32(0) && resolvers.length > 0 && resolvers.length <= 24);
        for (uint256 i = 0; i < resolvers.length; ++i) {
            if (bytes(resolvers[i]).length == 0) resolvers[i] = "kps:";
        }
        IWorkerSpecifier spec = _deploy(hash, resolvers);
        require(spec.workerHash() == hash, "hash round-trips");
        require(Samples.equal(spec.workerResolvers(), resolvers), "resolvers round-trip byte for byte");
    }

    function _slice32(bytes memory data, uint256 offset) private pure returns (bytes32 out) {
        require(data.length >= offset + 32, "short return data");
        assembly ("memory-safe") {
            out := mload(add(add(data, 0x20), offset))
        }
    }

    function _decimal(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits = 0;
        for (uint256 v = value; v != 0; v /= 10) {
            ++digits;
        }
        bytes memory out = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) {
            out[--digits] = bytes1(uint8(48 + v % 10));
        }
        return string(out);
    }

    function _filler(uint256 length) private pure returns (string memory) {
        bytes memory out = new bytes(length);
        for (uint256 i = 0; i < length; ++i) {
            out[i] = "x";
        }
        return string(out);
    }
}

contract ReferenceWorkerSpecifierConformanceTest is SpecifierConformance {
    function _deploy(bytes32 hash, string[] memory resolvers) internal override returns (IWorkerSpecifier) {
        return IWorkerSpecifier(address(new WorkerSpecifier(hash, resolvers)));
    }
}

contract ImmutableWorkerSpecifierConformanceTest is SpecifierConformance {
    function _deploy(bytes32 hash, string[] memory resolvers) internal override returns (IWorkerSpecifier) {
        return new ImmutableWorkerSpecifier(hash, resolvers);
    }
}
