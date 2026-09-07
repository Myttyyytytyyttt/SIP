// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IProtocolPauseController {
    function paused() external view returns (bool);

    function pauseEpoch() external view returns (uint64);
}
