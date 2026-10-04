// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ImmutableWorkerSpecifier} from "../src/ImmutableWorkerSpecifier.sol";
import {WorkerSpecifier} from "../src/WorkerSpecifier.sol";
import {CHEATS, Cheats} from "./utils/Cheats.sol";
import {RuntimeCode} from "./utils/RuntimeCode.sol";
import {Samples} from "./utils/Samples.sol";

contract ImmutableWorkerSpecifierTest {
    bytes32 internal constant WORKER_UPDATED_TOPIC = keccak256("WorkerUpdated(bytes32,string[])");
    address internal constant STRANGER = address(0xBEEF);

    ImmutableWorkerSpecifier internal spec;

    function setUp() public {
        spec = new ImmutableWorkerSpecifier(Samples.BUNDLE_HASH, Samples.resolvers());
    }

    function test_ConstructorSetsHashAndResolvers() public view {
        require(spec.workerHash() == Samples.BUNDLE_HASH, "hash");
        require(Samples.equal(spec.workerResolvers(), Samples.resolvers()), "resolvers, in order");
    }

    function test_WorkerUpdatedTopicMatchesTheReferenceEvent() public pure {
        require(
            WORKER_UPDATED_TOPIC == 0x5f46dde25e626d2254306dda6c26b29248554d94a398a26204202f145071f731,
            "topic seen on the mainnet reference specifiers"
        );
        require(ImmutableWorkerSpecifier.WorkerUpdated.selector == WORKER_UPDATED_TOPIC, "immutable event");
        require(WorkerSpecifier.WorkerUpdated.selector == WORKER_UPDATED_TOPIC, "reference event");
    }

    function test_EmitsWorkerUpdatedExactlyOnceAtDeployment() public {
        CHEATS.recordLogs();
        ImmutableWorkerSpecifier fresh = new ImmutableWorkerSpecifier(Samples.BUNDLE_HASH, Samples.resolvers());
        Cheats.Log[] memory logs = CHEATS.getRecordedLogs();
        require(logs.length == 1, "exactly one log");
        require(logs[0].emitter == address(fresh), "emitted by the specifier");
        require(logs[0].topics.length == 1 && logs[0].topics[0] == WORKER_UPDATED_TOPIC, "WorkerUpdated topic");
        require(
            keccak256(logs[0].data) == keccak256(abi.encode(Samples.BUNDLE_HASH, Samples.resolvers())),
            "event carries the hash and the resolvers"
        );
    }

    function test_RevertsOnZeroHash() public {
        CHEATS.expectRevert(ImmutableWorkerSpecifier.ZeroWorkerHash.selector);
        new ImmutableWorkerSpecifier(bytes32(0), Samples.resolvers());
    }

    function test_RevertsOnEmptyResolverList() public {
        CHEATS.expectRevert(ImmutableWorkerSpecifier.NoWorkerResolvers.selector);
        new ImmutableWorkerSpecifier(Samples.BUNDLE_HASH, new string[](0));
    }

    function test_RevertsOnEmptyResolverEntryWithItsIndex() public {
        string[] memory resolvers = Samples.resolvers();
        resolvers[3] = "";
        CHEATS.expectRevert(abi.encodeWithSelector(ImmutableWorkerSpecifier.EmptyWorkerResolver.selector, uint256(3)));
        new ImmutableWorkerSpecifier(Samples.BUNDLE_HASH, resolvers);
    }

    /// Every mutating entry point of the reference contract is absent here: calls fail for anyone, the deployer
    /// included, and nothing changes.
    function test_HasNoOwnerAndNoSetters() public {
        bytes[] memory calls = new bytes[](4);
        calls[0] =
            abi.encodeCall(WorkerSpecifier.setWorker, (Samples.OTHER_HASH, Samples.one("https://evil.test/w.js")));
        calls[1] = abi.encodeCall(WorkerSpecifier.transferOwnership, (STRANGER));
        calls[2] = abi.encodeCall(WorkerSpecifier.renounceOwnership, ());
        calls[3] = abi.encodeWithSignature("owner()");
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool okDeployer,) = address(spec).call(calls[i]);
            CHEATS.prank(STRANGER);
            (bool okStranger,) = address(spec).call(calls[i]);
            require(!okDeployer && !okStranger, "no such function");
        }
        require(spec.workerHash() == Samples.BUNDLE_HASH, "hash unchanged");
        require(Samples.equal(spec.workerResolvers(), Samples.resolvers()), "resolvers unchanged");
    }

    function test_RejectsEther() public {
        (bool ok,) = address(spec).call{value: 1 wei}("");
        require(!ok, "no receive or fallback");
        require(address(spec).balance == 0, "holds no ether");
    }

    /// The strongest form of the immutability claim: the deployed runtime code contains no instruction that can
    /// write storage, emit a log, call out, create or self-destruct. The reference contract is the positive
    /// control: its setters compile to SSTORE and LOG1/LOG3.
    function test_RuntimeCodeHasNoStateChangingOpcodes() public {
        uint8[] memory found = RuntimeCode.stateChangingOpcodes(address(spec).code);
        require(found.length == 0, "immutable runtime code must not change state");

        WorkerSpecifier upstream = new WorkerSpecifier(Samples.BUNDLE_HASH, Samples.resolvers());
        bytes memory upstreamCode = address(upstream).code;
        require(RuntimeCode.containsOpcode(upstreamCode, 0x55), "control: reference code has SSTORE");
        require(RuntimeCode.containsOpcode(upstreamCode, 0xa1), "control: reference code has LOG1");
    }

    /// Any calldata, from any sender, leaves storage untouched and the views unchanged.
    function testFuzz_ArbitraryCallsNeverWriteState(bytes calldata data, address sender) public {
        CHEATS.record();
        CHEATS.prank(sender);
        // Success or failure are both acceptable here; only a storage write would be a defect.
        (bool success,) = address(spec).call(data);
        success;
        (, bytes32[] memory writes) = CHEATS.accesses(address(spec));
        require(writes.length == 0, "no storage writes");
        require(spec.workerHash() == Samples.BUNDLE_HASH, "hash unchanged");
        require(Samples.equal(spec.workerResolvers(), Samples.resolvers()), "resolvers unchanged");
    }
}
