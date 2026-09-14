// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice Proxy-safe reentrancy guard with isolated ERC-7201-style storage.
/// @dev This deliberately avoids EIP-1153 so vaults do not depend on transient
///      storage support on the target chain.
abstract contract NuvemReentrancyGuardUpgradeable is Initializable {
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    // keccak256(abi.encode(uint256(keccak256("nuvem.storage.ReentrancyGuard")) - 1))
    // & ~bytes32(uint256(0xff))
    bytes32 private constant REENTRANCY_GUARD_STORAGE_LOCATION =
        0x68c41e6041995afef7d9cdabde9d2f24d3ee6b522a86457a2ef12366fc00c000;

    /// @custom:storage-location erc7201:nuvem.storage.ReentrancyGuard
    struct ReentrancyGuardStorage {
        uint256 status;
    }

    error ReentrantCall();

    function _nuvemReentrancyGuardInit() internal onlyInitializing {
        _getReentrancyGuardStorage().status = NOT_ENTERED;
    }

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() private {
        ReentrancyGuardStorage storage $ = _getReentrancyGuardStorage();
        if ($.status == ENTERED) revert ReentrantCall();
        $.status = ENTERED;
    }

    function _nonReentrantAfter() private {
        ReentrancyGuardStorage storage $ = _getReentrancyGuardStorage();
        $.status = NOT_ENTERED;
    }

    function _getReentrancyGuardStorage() private pure returns (ReentrancyGuardStorage storage $) {
        bytes32 slot = REENTRANCY_GUARD_STORAGE_LOCATION;
        assembly {
            $.slot := slot
        }
    }
}
