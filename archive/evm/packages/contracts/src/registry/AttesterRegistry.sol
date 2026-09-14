// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GuardianOwnable} from "../governance/GuardianOwnable.sol";
import {IAttesterRegistry} from "../interfaces/IAttesterRegistry.sol";

/// @notice Registry for the single active MVP attester.
/// @dev Every rotation or emergency disable advances the epoch so old
///      attestations cannot become valid again if a signer is later reused.
contract AttesterRegistry is GuardianOwnable, IAttesterRegistry {
    error InvalidAttester(address attester);
    error AttesterUnchanged(address attester);
    error AttesterAlreadyDisabled();

    event AttesterRotated(address indexed previousAttester, address indexed newAttester, uint32 indexed attesterEpoch);
    event AttesterDisabled(address indexed previousAttester, address indexed caller, uint32 indexed attesterEpoch);

    address public override attester;
    uint32 public override attesterEpoch;

    constructor(address initialOwner, address initialGuardian, address initialAttester)
        GuardianOwnable(initialOwner, initialGuardian)
    {
        if (initialAttester == address(0)) revert InvalidAttester(address(0));

        attester = initialAttester;
        attesterEpoch = 1;
        emit AttesterRotated(address(0), initialAttester, 1);
    }

    function rotateAttester(address newAttester) external onlyOwner {
        if (newAttester == address(0)) revert InvalidAttester(address(0));

        address previousAttester = attester;
        if (newAttester == previousAttester) revert AttesterUnchanged(newAttester);

        uint32 newEpoch = attesterEpoch + 1;
        attester = newAttester;
        attesterEpoch = newEpoch;

        emit AttesterRotated(previousAttester, newAttester, newEpoch);
    }

    function disableAttester() external onlyOwnerOrGuardian {
        address previousAttester = attester;
        if (previousAttester == address(0)) revert AttesterAlreadyDisabled();

        uint32 newEpoch = attesterEpoch + 1;
        attester = address(0);
        attesterEpoch = newEpoch;

        emit AttesterDisabled(previousAttester, msg.sender, newEpoch);
    }

    function isCurrentAttester(address signer, uint32 epoch) external view override returns (bool) {
        return signer != address(0) && signer == attester && epoch == attesterEpoch;
    }
}
