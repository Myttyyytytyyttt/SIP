// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFeeController {
    function feeBps() external view returns (uint16);

    function feeCollector() external view returns (address);

    function feeEpoch() external view returns (uint64);

    function previewFee(uint256 grossAmount) external view returns (uint256 feeAmount, uint256 netAmount);
}
