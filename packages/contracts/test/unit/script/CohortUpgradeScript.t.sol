// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {IUpgradeableBeaconAdmin, PrepareCohortUpgrade} from "../../../script/PrepareCohortUpgrade.s.sol";
import {VaultFactory} from "../../../src/factory/VaultFactory.sol";

contract StableVaultImplementation {}

contract CanaryVaultImplementation {}

contract UnvalidatedVaultImplementation {}

contract CohortUpgradeScriptTest is Test {
    TimelockController internal timelock;
    VaultFactory internal factory;
    PrepareCohortUpgrade internal helper;

    StableVaultImplementation internal stableImplementation;
    CanaryVaultImplementation internal canaryImplementation;
    uint32 internal stableCohortId;
    uint32 internal canaryCohortId;
    address internal stableBeacon;
    address internal canaryBeacon;

    function setUp() external {
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(7 days, proposers, executors, address(0));

        factory = new VaultFactory(address(this));
        stableImplementation = new StableVaultImplementation();
        canaryImplementation = new CanaryVaultImplementation();
        (stableCohortId, stableBeacon) = factory.registerCohort(address(stableImplementation), address(timelock));
        (canaryCohortId, canaryBeacon) = factory.registerCohort(address(canaryImplementation), address(timelock));
        helper = new PrepareCohortUpgrade();
    }

    function testBuildsExactTimelockPayloadWithoutExecutingUpgrade() external view {
        bytes32 evidenceHash = keccak256("reviewed-canary-evidence");
        (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt, uint256 delay) = helper.prepare(
            address(timelock), factory, stableCohortId, canaryCohortId, address(canaryImplementation), evidenceHash
        );

        assertEq(target, stableBeacon);
        assertEq(value, 0);
        assertEq(data, abi.encodeCall(IUpgradeableBeaconAdmin.upgradeTo, (address(canaryImplementation))));
        assertEq(predecessor, bytes32(0));
        assertEq(delay, 7 days);
        assertEq(
            salt,
            keccak256(
                abi.encode(
                    helper.UPGRADE_OPERATION_VERSION(),
                    block.chainid,
                    address(factory),
                    stableCohortId,
                    canaryCohortId,
                    stableBeacon,
                    canaryBeacon,
                    address(canaryImplementation),
                    evidenceHash
                )
            )
        );

        bytes32 operationId = timelock.hashOperation(target, value, data, predecessor, salt);
        assertFalse(timelock.isOperation(operationId));
        assertEq(UpgradeableBeacon(stableBeacon).implementation(), address(stableImplementation));
    }

    function testRejectsImplementationNotRunningInCanaryCohort() external {
        UnvalidatedVaultImplementation unvalidated = new UnvalidatedVaultImplementation();

        vm.expectRevert(
            abi.encodeWithSelector(
                PrepareCohortUpgrade.CanaryImplementationMismatch.selector,
                address(unvalidated),
                address(canaryImplementation)
            )
        );
        helper.prepare(
            address(timelock),
            factory,
            stableCohortId,
            canaryCohortId,
            address(unvalidated),
            keccak256("unrelated-evidence")
        );
    }

    function testRejectsStableCohortUsedAsItsOwnCanary() external {
        vm.expectRevert(
            abi.encodeWithSelector(PrepareCohortUpgrade.CanaryMustUseSeparateCohort.selector, stableCohortId)
        );
        helper.prepare(
            address(timelock),
            factory,
            stableCohortId,
            stableCohortId,
            address(canaryImplementation),
            keccak256("evidence")
        );
    }
}
