// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IFeeController} from "../interfaces/IFeeController.sol";

/// @notice Immediate protocol fee configuration controlled by governance.
/// @dev A 100% fee is intentionally supported. Any configuration change
///      advances feeEpoch so an investment quote can bind to one configuration.
contract FeeController is Ownable2Step, IFeeController {
    uint16 public constant BPS_DENOMINATOR = 10_000;

    error FeeBpsTooHigh(uint256 feeBps);
    error InvalidFeeCollector(address feeCollector);
    error FeeBpsUnchanged(uint16 feeBps);
    error FeeCollectorUnchanged(address feeCollector);
    error RenounceDisabled();

    event FeeBpsUpdated(uint16 previousFeeBps, uint16 newFeeBps, uint64 indexed feeEpoch);
    event FeeCollectorUpdated(
        address indexed previousFeeCollector, address indexed newFeeCollector, uint64 indexed feeEpoch
    );

    uint16 public override feeBps;
    address public override feeCollector;
    uint64 public override feeEpoch;

    constructor(address initialOwner, address initialFeeCollector, uint16 initialFeeBps) Ownable(initialOwner) {
        if (initialFeeCollector == address(0)) revert InvalidFeeCollector(address(0));
        if (initialFeeBps > BPS_DENOMINATOR) revert FeeBpsTooHigh(initialFeeBps);

        feeBps = initialFeeBps;
        feeCollector = initialFeeCollector;
        feeEpoch = 1;

        emit FeeBpsUpdated(0, initialFeeBps, 1);
        emit FeeCollectorUpdated(address(0), initialFeeCollector, 1);
    }

    /// @dev Disabled. Renouncing would freeze whatever fee is current at that
    ///      moment forever — including 100%, which sends every invested amount
    ///      to the collector.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > BPS_DENOMINATOR) revert FeeBpsTooHigh(newFeeBps);

        uint16 previousFeeBps = feeBps;
        if (newFeeBps == previousFeeBps) revert FeeBpsUnchanged(newFeeBps);

        uint64 newEpoch = feeEpoch + 1;
        feeBps = newFeeBps;
        feeEpoch = newEpoch;

        emit FeeBpsUpdated(previousFeeBps, newFeeBps, newEpoch);
    }

    function setFeeCollector(address newFeeCollector) external onlyOwner {
        if (newFeeCollector == address(0)) revert InvalidFeeCollector(address(0));

        address previousFeeCollector = feeCollector;
        if (newFeeCollector == previousFeeCollector) {
            revert FeeCollectorUnchanged(newFeeCollector);
        }

        uint64 newEpoch = feeEpoch + 1;
        feeCollector = newFeeCollector;
        feeEpoch = newEpoch;

        emit FeeCollectorUpdated(previousFeeCollector, newFeeCollector, newEpoch);
    }

    function previewFee(uint256 grossAmount) external view override returns (uint256 feeAmount, uint256 netAmount) {
        feeAmount = Math.mulDiv(grossAmount, feeBps, BPS_DENOMINATOR);
        netAmount = grossAmount - feeAmount;
    }
}
