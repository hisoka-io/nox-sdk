// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The specifier interface from the anon-rpc specification, SPEC.md §4
// (version 0.3.2), https://github.com/ethereum/anon-rpc at commit
// f2c8a758caaa555974a3c79769e8cb4a40ac1ae1: the same declarations and
// comments, re-indented by forge fmt. Copyright (c) 2026 Ethereum Foundation,
// MIT License; see NOTICE in this directory.
//
// Harnesses read exactly these two views with eth_call (selectors 0x3898587d
// and 0x1c67ff29) and admit only bundle bytes whose keccak256 equals
// workerHash().
interface IWorkerSpecifier {
    // keccak256 hash of the canonical worker bundle bytes.
    function workerHash() external view returns (bytes32);
    // Suggested locations from which the bundle MAY be retrieved.
    function workerResolvers() external view returns (string[] memory);
}
