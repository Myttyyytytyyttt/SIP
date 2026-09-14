// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Two-step governance ownership with a separately rotatable guardian.
/// @dev Derived contracts decide which narrowly scoped actions the guardian may take.
abstract contract GuardianOwnable is Ownable2Step {
    error InvalidGuardian(address guardian);
    error GuardianUnchanged(address guardian);
    error NotOwnerOrGuardian(address caller);
    error RenounceDisabled();

    event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);

    address public guardian;

    constructor(address initialOwner, address initialGuardian) Ownable(initialOwner) {
        if (initialGuardian == address(0)) revert InvalidGuardian(address(0));
        guardian = initialGuardian;
        emit GuardianUpdated(address(0), initialGuardian);
    }

    modifier onlyOwnerOrGuardian() {
        _checkOwnerOrGuardian();
        _;
    }

    function _checkOwnerOrGuardian() internal view {
        if (msg.sender != owner() && msg.sender != guardian) {
            revert NotOwnerOrGuardian(msg.sender);
        }
    }

    /// @dev Disabled. Guardian powers are restrictive-only and every reversal —
    ///      unpause, attester rotation, adapter reactivation — is owner-gated,
    ///      so renouncing would make an emergency action permanent. Ownable2Step
    ///      transfer is the only supported exit.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidGuardian(address(0));

        address previousGuardian = guardian;
        if (newGuardian == previousGuardian) revert GuardianUnchanged(newGuardian);

        guardian = newGuardian;
        emit GuardianUpdated(previousGuardian, newGuardian);
    }
}
