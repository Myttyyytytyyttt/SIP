// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {DevnetSyntheticStock} from "./DevnetSyntheticStock.sol";
import {IInvestmentAdapter} from "../interfaces/IInvestmentAdapter.sol";

/// @notice Immutable-rate WETH-to-synthetic-stock adapter for the public-testnet drill.
/// @dev This is deterministic test infrastructure, not a production exchange or price oracle.
contract PublicTestnetFixedRateAdapter is IInvestmentAdapter {
    using SafeERC20 for IERC20;

    uint256 public constant RATE_SCALE = 1e18;

    error InsufficientAmountOut(uint256 amountOut, uint256 minAmountOut);
    error InvalidAmountIn(uint256 amountIn);
    error InvalidRate(uint256 rateWad);
    error InvalidTargetAsset(address targetAsset);
    error InvalidTokenIn(address tokenIn);
    error QuoteExpired(uint48 deadline, uint256 timestamp);

    event SyntheticInvestmentExecuted(
        address indexed vault,
        address indexed tokenIn,
        address indexed targetAsset,
        uint256 amountIn,
        uint256 amountOut,
        uint256 immutableRateWad
    );

    address public immutable EXPECTED_TOKEN_IN;
    DevnetSyntheticStock public immutable SYNTHETIC_TARGET;
    uint256 public immutable RATE_WAD;

    constructor(address tokenIn_, DevnetSyntheticStock syntheticTarget_, uint256 rateWad_) {
        if (tokenIn_ == address(0)) revert InvalidTokenIn(address(0));
        if (address(syntheticTarget_) == address(0)) revert InvalidTargetAsset(address(0));
        if (rateWad_ == 0) revert InvalidRate(0);

        EXPECTED_TOKEN_IN = tokenIn_;
        SYNTHETIC_TARGET = syntheticTarget_;
        RATE_WAD = rateWad_;
    }

    function executeInvestment(
        address tokenIn,
        address targetAsset,
        uint256 amountIn,
        uint256 minAmountOut,
        uint48 deadline
    ) external override returns (uint256 amountOut) {
        if (tokenIn != EXPECTED_TOKEN_IN) revert InvalidTokenIn(tokenIn);
        if (targetAsset != address(SYNTHETIC_TARGET)) revert InvalidTargetAsset(targetAsset);
        if (amountIn == 0) revert InvalidAmountIn(0);
        if (block.timestamp > deadline) revert QuoteExpired(deadline, block.timestamp);

        amountOut = Math.mulDiv(amountIn, RATE_WAD, RATE_SCALE);
        if (amountOut < minAmountOut) {
            revert InsufficientAmountOut(amountOut, minAmountOut);
        }

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        SYNTHETIC_TARGET.mint(msg.sender, amountOut);

        emit SyntheticInvestmentExecuted(msg.sender, tokenIn, targetAsset, amountIn, amountOut, RATE_WAD);
    }
}
