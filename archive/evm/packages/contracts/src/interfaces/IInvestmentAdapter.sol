// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Restricted investment adapter called by a PersonalVault.
/// @dev The adapter must send all output to msg.sender. There is intentionally
///      no caller-controlled recipient or arbitrary calldata.
interface IInvestmentAdapter {
    function executeInvestment(
        address tokenIn,
        address targetAsset,
        uint256 amountIn,
        uint256 minAmountOut,
        uint48 deadline
    ) external returns (uint256 amountOut);
}
