// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @dev Instruction-level view of deployed runtime code: walks opcodes, skips PUSH immediates and stops before the
/// CBOR metadata trailer solc appends (its length is the last two bytes of the code).
library RuntimeCode {
    error NoMetadataTrailer(uint256 codeLength);

    uint8 internal constant PUSH1 = 0x60;
    uint8 internal constant PUSH32 = 0x7f;

    /// @dev Opcodes that write state or reach other accounts: SSTORE, TSTORE, LOG0-LOG4, CREATE, CALL, CALLCODE,
    /// DELEGATECALL, CREATE2, SELFDESTRUCT. Runtime code without any of them cannot change any state on chain.
    function isStateChanging(uint8 op) internal pure returns (bool) {
        return op == 0x55 || op == 0x5d || (op >= 0xa0 && op <= 0xa4) || op == 0xf0 || op == 0xf1 || op == 0xf2
            || op == 0xf4 || op == 0xf5 || op == 0xff;
    }

    /// @dev Offset where executable code ends and the CBOR metadata trailer begins.
    function executableEnd(bytes memory code) internal pure returns (uint256) {
        uint256 n = code.length;
        if (n < 2) revert NoMetadataTrailer(n);
        uint256 metadataLength = (uint256(uint8(code[n - 2])) << 8) | uint256(uint8(code[n - 1]));
        if (metadataLength + 2 > n) revert NoMetadataTrailer(n);
        uint256 end = n - 2 - metadataLength;
        // A CBOR map header (0xa1..0xa5) opens solc's metadata.
        uint8 head = uint8(code[end]);
        if (head < 0xa1 || head > 0xa5) revert NoMetadataTrailer(n);
        return end;
    }

    /// @dev Every state-changing opcode that occurs as an instruction, in code order (duplicates kept).
    function stateChangingOpcodes(bytes memory code) internal pure returns (uint8[] memory found) {
        uint256 end = executableEnd(code);
        uint8[] memory buffer = new uint8[](end);
        uint256 count = 0;
        for (uint256 i = 0; i < end; ++i) {
            uint8 op = uint8(code[i]);
            if (op >= PUSH1 && op <= PUSH32) {
                i += op - PUSH1 + 1;
            } else if (isStateChanging(op)) {
                buffer[count++] = op;
            }
        }
        found = new uint8[](count);
        for (uint256 j = 0; j < count; ++j) {
            found[j] = buffer[j];
        }
    }

    /// @dev True if `op` occurs as an instruction (not inside PUSH data or metadata).
    function containsOpcode(bytes memory code, uint8 op) internal pure returns (bool) {
        uint256 end = executableEnd(code);
        for (uint256 i = 0; i < end; ++i) {
            uint8 current = uint8(code[i]);
            if (current == op) return true;
            if (current >= PUSH1 && current <= PUSH32) i += current - PUSH1 + 1;
        }
        return false;
    }
}
