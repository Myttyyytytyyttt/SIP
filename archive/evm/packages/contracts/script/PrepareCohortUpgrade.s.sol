// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {VaultFactory} from "../src/factory/VaultFactory.sol";

interface IUpgradeableBeaconAdmin {
    function upgradeTo(address newImplementation) external;
}

/// @notice Read-only builder for a timelocked stable-cohort promotion.
/// @dev The helper neither broadcasts, schedules, nor executes an upgrade. It
///      requires the exact implementation to already run in a distinct canary
///      cohort and binds the supplied evidence hash into the operation salt.
///
///      STORAGE LAYOUT IS OUT OF SCOPE FOR THIS HELPER AND IS A HUMAN REVIEW
///      GATE. It validates cohort separation, beacon ownership, the canary
///      implementation address and the evidence hash — it does NOT and cannot
///      validate that the target cohort's vaults share the implementation's
///      storage layout. Promoting an implementation across a layout change
///      produces a valid, executable timelock payload that silently makes every
///      vault in the cohort misread its own admin, epochs and pause flags.
///
///      Concretely: the implementation that removed the investment path dropped
///      four slots from `VaultStorage`, so it must only ever be promoted onto a
///      cohort created after that change. Never onto a cohort holding
///      pre-change vaults. `UpgradeContinuityTest` demonstrates the failure.
contract PrepareCohortUpgrade {
    uint256 public constant GOVERNANCE_DELAY = 7 days;
    bytes32 public constant UPGRADE_OPERATION_VERSION = keccak256("NUVEM_PROMOTE_CANARY_IMPLEMENTATION_V1");

    error ZeroAddress();
    error InvalidCohort(uint32 cohortId);
    error CanaryMustUseSeparateCohort(uint32 cohortId);
    error InvalidCanaryEvidence();
    error NotAContract(address account);
    error BeaconNotOwnedByTimelock(address beacon, address expectedTimelock, address actualOwner);
    error CanaryImplementationMismatch(address expectedImplementation, address actualImplementation);
    error ImplementationAlreadyActive(address implementation);

    function prepare(
        address timelock,
        VaultFactory factory,
        uint32 stableCohortId,
        uint32 canaryCohortId,
        address newImplementation,
        bytes32 canaryEvidenceHash
    )
        external
        view
        returns (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt, uint256 delay)
    {
        if (timelock == address(0) || address(factory) == address(0) || newImplementation == address(0)) {
            revert ZeroAddress();
        }
        if (timelock.code.length == 0 || address(factory).code.length == 0 || newImplementation.code.length == 0) {
            address invalid = timelock.code.length == 0
                ? timelock
                : address(factory).code.length == 0 ? address(factory) : newImplementation;
            revert NotAContract(invalid);
        }
        if (stableCohortId == canaryCohortId) {
            revert CanaryMustUseSeparateCohort(stableCohortId);
        }
        if (canaryEvidenceHash == bytes32(0)) {
            revert InvalidCanaryEvidence();
        }

        (address stableBeacon,,,) = factory.cohorts(stableCohortId);
        (address canaryBeacon,,,) = factory.cohorts(canaryCohortId);
        if (stableBeacon == address(0)) revert InvalidCohort(stableCohortId);
        if (canaryBeacon == address(0)) revert InvalidCohort(canaryCohortId);

        address stableOwner = UpgradeableBeacon(stableBeacon).owner();
        if (stableOwner != timelock) {
            revert BeaconNotOwnedByTimelock(stableBeacon, timelock, stableOwner);
        }
        address canaryOwner = UpgradeableBeacon(canaryBeacon).owner();
        if (canaryOwner != timelock) {
            revert BeaconNotOwnedByTimelock(canaryBeacon, timelock, canaryOwner);
        }

        address canaryImplementation = UpgradeableBeacon(canaryBeacon).implementation();
        if (canaryImplementation != newImplementation) {
            revert CanaryImplementationMismatch(newImplementation, canaryImplementation);
        }
        if (UpgradeableBeacon(stableBeacon).implementation() == newImplementation) {
            revert ImplementationAlreadyActive(newImplementation);
        }

        target = stableBeacon;
        value = 0;
        data = abi.encodeCall(IUpgradeableBeaconAdmin.upgradeTo, (newImplementation));
        predecessor = bytes32(0);
        salt = keccak256(
            abi.encode(
                UPGRADE_OPERATION_VERSION,
                block.chainid,
                address(factory),
                stableCohortId,
                canaryCohortId,
                stableBeacon,
                canaryBeacon,
                newImplementation,
                canaryEvidenceHash
            )
        );
        delay = GOVERNANCE_DELAY;
    }
}
