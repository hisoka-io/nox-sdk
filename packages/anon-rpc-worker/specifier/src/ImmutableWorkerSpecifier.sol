// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IWorkerSpecifier} from "./IWorkerSpecifier.sol";

/// @title ImmutableWorkerSpecifier
/// @notice An anon-rpc worker specifier (SPEC.md §4) whose worker hash and resolver list are fixed when it is
/// deployed. It has no owner and no function that writes state, so every host pinned to this address runs exactly
/// the bundle whose keccak256 is `workerHash()`, for as long as the chain exists. A new worker version ships as a
/// new specifier at a new address.
/// @dev The read interface and the `WorkerUpdated` event match the reference `WorkerSpecifier` of
/// ethereum/anon-rpc, so harnesses, explorers and log-based tooling treat both contracts alike. The constructor
/// rejects only inputs that no harness could ever use, because a mistake here cannot be corrected later.
contract ImmutableWorkerSpecifier is IWorkerSpecifier {
    /// @dev keccak256 of the canonical worker bundle bytes, embedded in the runtime code.
    bytes32 private immutable WORKER_HASH;

    /// @dev Written once by the constructor; no function writes it afterwards.
    string[] private _workerResolvers;

    /// @notice Emitted exactly once, by the constructor. Same signature (and topic) as the reference
    /// `WorkerSpecifier` event, so a specifier's history reads the same way for both contracts.
    event WorkerUpdated(bytes32 workerHash, string[] workerResolvers);

    /// @notice The worker hash is zero. No bundle hashes to zero, so the specifier could never boot a worker.
    error ZeroWorkerHash();

    /// @notice The resolver list is empty. Harnesses fetch the bundle from these entries, so a specifier
    /// without any could never be booted by them.
    error NoWorkerResolvers();

    /// @notice The resolver entry at `index` is an empty string.
    error EmptyWorkerResolver(uint256 index);

    /// @param workerHash_ keccak256 of the exact worker bundle bytes (not SHA3-256).
    /// @param workerResolvers_ Locations serving those bytes: `https:` URLs and/or `kps:` resolver strings
    /// (SPEC.md §4.1). Harnesses try them in this order.
    constructor(bytes32 workerHash_, string[] memory workerResolvers_) {
        if (workerHash_ == bytes32(0)) revert ZeroWorkerHash();
        uint256 count = workerResolvers_.length;
        if (count == 0) revert NoWorkerResolvers();
        for (uint256 i = 0; i < count; ++i) {
            if (bytes(workerResolvers_[i]).length == 0) revert EmptyWorkerResolver(i);
        }
        WORKER_HASH = workerHash_;
        _workerResolvers = workerResolvers_;
        emit WorkerUpdated(workerHash_, workerResolvers_);
    }

    /// @notice keccak256 hash of the canonical worker bundle bytes (SPEC.md §4).
    function workerHash() external view override returns (bytes32) {
        return WORKER_HASH;
    }

    /// @notice Suggested locations from which the bundle MAY be retrieved (advisory, SPEC.md §4.1).
    function workerResolvers() external view override returns (string[] memory) {
        return _workerResolvers;
    }
}
