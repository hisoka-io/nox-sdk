// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// @title E2eLogEmitter
/// @notice Test-bed contract on the upstream anvil chain: gives the Nox worker
/// end-to-end tests an `eth_call` target and `eth_getLogs` results of a chosen
/// size. Never deployed outside a local test chain.
contract E2eLogEmitter {
    event Ping(address indexed from, uint256 indexed value);
    event Blob(uint256 indexed index, bytes data);

    /// @notice Emit one small log.
    function ping(uint256 value) external {
        emit Ping(msg.sender, value);
    }

    /// @notice Emit `count` Blob logs of `size` bytes each. Byte `i` of a blob
    /// is byte `i % 32` of keccak256(i / 32), so a corrupted reply shows up as
    /// different bytes rather than as a shorter string of zeros.
    function emitBlobs(uint256 count, uint256 size) external {
        // `new bytes(size)` reserves whole words, so every mstore below stays inside it.
        bytes memory data = new bytes(size);
        uint256 words = (size + 31) / 32;
        for (uint256 w = 0; w < words; w++) {
            bytes32 chunk = keccak256(abi.encode(w));
            assembly {
                mstore(add(add(data, 32), mul(w, 32)), chunk)
            }
        }
        for (uint256 i = 0; i < count; i++) {
            emit Blob(i, data);
        }
    }

    /// @notice A view for eth_call: echoes its input with the caller and block.
    function probe(uint256 value) external view returns (uint256 doubled, address caller, uint256 blockNumber) {
        return (value * 2, msg.sender, block.number);
    }
}
