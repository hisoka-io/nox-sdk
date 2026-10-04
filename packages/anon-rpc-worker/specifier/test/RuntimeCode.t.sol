// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {CHEATS} from "./utils/Cheats.sol";
import {RuntimeCode} from "./utils/RuntimeCode.sol";

/// @dev The opcode scanner backs the "no state-changing instruction" claim, so it is tested on hand-written code.
contract RuntimeCodeTest {
    /// Stand-in for solc's CBOR metadata: a one-entry map header, one byte, then the two-byte trailer length.
    bytes internal constant TRAILER = hex"a1000002";

    function test_FindsAnSstoreInstruction() public pure {
        // PUSH1 1, PUSH1 0, SSTORE, STOP, INVALID
        bytes memory code = bytes.concat(hex"600160005500fe", TRAILER);
        uint8[] memory found = RuntimeCode.stateChangingOpcodes(code);
        require(found.length == 1 && found[0] == 0x55, "SSTORE found");
        require(RuntimeCode.containsOpcode(code, 0x55), "containsOpcode agrees");
    }

    function test_FindsEveryStateChangingOpcode() public pure {
        bytes memory code = bytes.concat(hex"555da0a1a2a3a4f0f1f2f4f5ff", TRAILER);
        require(RuntimeCode.stateChangingOpcodes(code).length == 13, "all 13 opcodes found");
    }

    function test_SkipsPushImmediates() public pure {
        // PUSH1 0x55, PUSH2 0xf1ff, PUSH32 0x55..55, STOP: the operands are data, not instructions.
        bytes memory code =
            bytes.concat(hex"6055", hex"61f1ff", hex"7f", bytes32(type(uint256).max / 255 * 0x55), hex"00");
        code = bytes.concat(code, TRAILER);
        require(RuntimeCode.stateChangingOpcodes(code).length == 0, "immediates are data");
        require(!RuntimeCode.containsOpcode(code, 0x55), "no SSTORE instruction");
    }

    function test_IgnoresTheMetadataTrailer() public pure {
        // STOP, then a trailer whose bytes include SSTORE and SELFDESTRUCT values.
        bytes memory code = hex"00a25555ff0004";
        require(RuntimeCode.stateChangingOpcodes(code).length == 0, "metadata is data");
    }

    function test_RevertsWhenThereIsNoMetadataTrailer() public {
        CHEATS.expectRevert(abi.encodeWithSelector(RuntimeCode.NoMetadataTrailer.selector, uint256(3)));
        this.scan(hex"005500");
    }

    function scan(bytes calldata code) external pure returns (uint8[] memory) {
        return RuntimeCode.stateChangingOpcodes(code);
    }
}
