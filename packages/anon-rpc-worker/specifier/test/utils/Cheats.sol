// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @dev The few Foundry cheatcodes these tests use, declared directly instead of vendoring forge-std (the upstream
/// WorkerSpecifier test does the same). Cheatcodes live at the well-known hevm address.
interface Cheats {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
    function record() external;
    function accesses(address target) external returns (bytes32[] memory reads, bytes32[] memory writes);
    function assume(bool condition) external pure;
}

Cheats constant CHEATS = Cheats(address(uint160(uint256(keccak256("hevm cheat code")))));
