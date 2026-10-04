// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {WorkerSpecifier} from "../src/WorkerSpecifier.sol";
import {Samples} from "./utils/Samples.sol";

/// @dev Guards the "copied faithfully" claim with the strongest available evidence: the reference contract compiled
/// here has the same runtime code, metadata hash included, as the three WorkerSpecifier deployments on Ethereum
/// mainnet (eth_getCode, read 2026-10-03). Any edit to src/WorkerSpecifier.sol or to the compiler settings in
/// foundry.toml changes this hash.
contract ReferenceBytecodeTest {
    /// keccak256 of the runtime code at all three mainnet specifiers below.
    bytes32 internal constant MAINNET_REFERENCE_CODEHASH =
        0xc4c54384a9c1f1201ef3711a7ed7ba20e078a432e85ecc4f8b14927587cc7b5f;

    // passthrough:   0x4fd77be300f31c5fe6ab266d35d27750a3478d27 (listed in adopters.json5, kind "reference")
    // tor-js:        0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e (listed in adopters.json5, kind "network")
    // Nym PoC:       0xfCc24f66E2F8bdF17537f2b117c80707219e91AD (voltrevo/poc-nym-anon-rpc README)

    function test_RuntimeCodeMatchesTheMainnetReferenceDeployments() public {
        WorkerSpecifier spec = new WorkerSpecifier(Samples.BUNDLE_HASH, Samples.resolvers());
        require(address(spec).codehash == MAINNET_REFERENCE_CODEHASH, "runtime code differs from mainnet reference");
    }

    /// The reference contract has no immutables, so its runtime code does not depend on constructor arguments.
    function testFuzz_RuntimeCodeIsIndependentOfConstructorArguments(bytes32 hash, string memory entry) public {
        WorkerSpecifier spec = new WorkerSpecifier(hash, Samples.one(entry));
        require(address(spec).codehash == MAINNET_REFERENCE_CODEHASH, "runtime code depends on arguments");
    }
}
