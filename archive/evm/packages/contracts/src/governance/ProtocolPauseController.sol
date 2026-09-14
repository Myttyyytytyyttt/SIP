// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {GuardianOwnable} from "./GuardianOwnable.sol";
import {IProtocolPauseController} from "../interfaces/IProtocolPauseController.sol";

/// @notice Shared protocol pause signal.
/// @dev Governance and the guardian may pause; only governance may unpause.
contract ProtocolPauseController is GuardianOwnable, Pausable, IProtocolPauseController {
    event PauseEpochAdvanced(uint64 indexed pauseEpoch, bool paused, address indexed caller);

    uint64 public override pauseEpoch;

    constructor(address initialOwner, address initialGuardian) GuardianOwnable(initialOwner, initialGuardian) {}

    function paused() public view override(Pausable, IProtocolPauseController) returns (bool) {
        return super.paused();
    }

    function pause() external onlyOwnerOrGuardian whenNotPaused {
        uint64 newEpoch = pauseEpoch + 1;
        pauseEpoch = newEpoch;
        _pause();
        emit PauseEpochAdvanced(newEpoch, true, msg.sender);
    }

    function unpause() external onlyOwner whenPaused {
        uint64 newEpoch = pauseEpoch + 1;
        pauseEpoch = newEpoch;
        _unpause();
        emit PauseEpochAdvanced(newEpoch, false, msg.sender);
    }
}
