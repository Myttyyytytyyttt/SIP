// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IInvestmentAdapter} from "../interfaces/IInvestmentAdapter.sol";

interface IMintableERC20 {
    function mint(address recipient, uint256 amount) external;
}

/// @notice Deterministic test adapter that pulls tokenIn and mints target output
///         directly to the calling vault.
contract MockInvestmentAdapter is IInvestmentAdapter {
    using SafeERC20 for IERC20;

    uint256 public constant RATE_SCALE = 1e18;

    error InvalidTokenIn(address tokenIn);
    error InvalidTargetAsset(address targetAsset);
    error InvalidAmountIn(uint256 amountIn);
    error InvalidRate(uint256 rateWad);
    error QuoteExpired(uint48 deadline, uint256 timestamp);
    error InsufficientAmountOut(uint256 amountOut, uint256 minAmountOut);

    event RateUpdated(uint256 previousRateWad, uint256 newRateWad);
    event MockInvestmentExecuted(
        address indexed vault, address indexed tokenIn, address indexed targetAsset, uint256 amountIn, uint256 amountOut
    );

    address public immutable EXPECTED_TOKEN_IN;
    address public immutable EXPECTED_TARGET_ASSET;
    uint256 public rateWad;

    constructor(address tokenIn_, address targetAsset_, uint256 initialRateWad) {
        if (tokenIn_ == address(0)) revert InvalidTokenIn(address(0));
        if (targetAsset_ == address(0)) revert InvalidTargetAsset(address(0));
        if (initialRateWad == 0) revert InvalidRate(0);

        EXPECTED_TOKEN_IN = tokenIn_;
        EXPECTED_TARGET_ASSET = targetAsset_;
        rateWad = initialRateWad;
    }

    function setRateWad(uint256 newRateWad) external {
        if (newRateWad == 0) revert InvalidRate(0);
        uint256 previousRateWad = rateWad;
        rateWad = newRateWad;
        emit RateUpdated(previousRateWad, newRateWad);
    }

    function executeInvestment(
        address tokenIn,
        address targetAsset,
        uint256 amountIn,
        uint256 minAmountOut,
        uint48 deadline
    ) external override returns (uint256 amountOut) {
        if (tokenIn != EXPECTED_TOKEN_IN) revert InvalidTokenIn(tokenIn);
        if (targetAsset != EXPECTED_TARGET_ASSET) revert InvalidTargetAsset(targetAsset);
        if (amountIn == 0) revert InvalidAmountIn(0);
        if (block.timestamp > deadline) revert QuoteExpired(deadline, block.timestamp);

        amountOut = Math.mulDiv(amountIn, rateWad, RATE_SCALE);
        if (amountOut < minAmountOut) {
            revert InsufficientAmountOut(amountOut, minAmountOut);
        }

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IMintableERC20(targetAsset).mint(msg.sender, amountOut);

        emit MockInvestmentExecuted(msg.sender, tokenIn, targetAsset, amountIn, amountOut);
    }
}
