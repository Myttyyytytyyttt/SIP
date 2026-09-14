// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IFeeCollector} from "../interfaces/IFeeCollector.sol";

/// @notice Holds protocol fees until they are pulled to the fixed treasury.
/// @dev Neither governance nor the caller can select an arbitrary withdrawal
///      recipient. Governance can rotate the treasury.
contract FeeCollector is Ownable2Step, ReentrancyGuard, IFeeCollector {
    using SafeERC20 for IERC20;

    error InvalidTreasury(address treasury);
    error InvalidToken(address token);
    error InvalidWithdrawalAmount(uint256 amount);
    error NotTreasuryOrOwner(address caller);
    error TreasuryUnchanged(address treasury);
    error RenounceDisabled();

    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event ERC20Withdrawn(address indexed token, address indexed treasury, uint256 amount);
    event NativeWithdrawn(address indexed treasury, uint256 amount);
    event NativeReceived(address indexed sender, uint256 amount);

    address public override treasury;

    constructor(address initialOwner, address initialTreasury) Ownable(initialOwner) {
        if (initialTreasury == address(0)) revert InvalidTreasury(address(0));
        treasury = initialTreasury;
        emit TreasuryUpdated(address(0), initialTreasury);
    }

    modifier onlyTreasuryOrOwner() {
        _checkTreasuryOrOwner();
        _;
    }

    function _checkTreasuryOrOwner() private view {
        if (msg.sender != treasury && msg.sender != owner()) {
            revert NotTreasuryOrOwner(msg.sender);
        }
    }

    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    /// @dev Disabled. Renouncing would permanently pin the treasury, and with
    ///      it the only address that can ever pull accrued fees.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidTreasury(address(0));

        address previousTreasury = treasury;
        if (newTreasury == previousTreasury) revert TreasuryUnchanged(newTreasury);

        treasury = newTreasury;
        emit TreasuryUpdated(previousTreasury, newTreasury);
    }

    function withdrawERC20(address token, uint256 amount) external override onlyTreasuryOrOwner nonReentrant {
        _withdrawErc20(token, amount);
    }

    function withdrawAllERC20(address token)
        external
        override
        onlyTreasuryOrOwner
        nonReentrant
        returns (uint256 amount)
    {
        if (token == address(0)) revert InvalidToken(address(0));
        amount = IERC20(token).balanceOf(address(this));
        _withdrawErc20(token, amount);
    }

    function withdrawNative(uint256 amount) external onlyTreasuryOrOwner nonReentrant {
        if (amount == 0 || amount > address(this).balance) {
            revert InvalidWithdrawalAmount(amount);
        }

        address destination = treasury;
        Address.sendValue(payable(destination), amount);
        emit NativeWithdrawn(destination, amount);
    }

    function withdrawAllNative() external onlyTreasuryOrOwner nonReentrant returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) revert InvalidWithdrawalAmount(0);

        address destination = treasury;
        Address.sendValue(payable(destination), amount);
        emit NativeWithdrawn(destination, amount);
    }

    function _withdrawErc20(address token, uint256 amount) private {
        if (token == address(0)) revert InvalidToken(address(0));
        if (amount == 0) revert InvalidWithdrawalAmount(0);

        address destination = treasury;
        IERC20(token).safeTransfer(destination, amount);
        emit ERC20Withdrawn(token, destination, amount);
    }
}
