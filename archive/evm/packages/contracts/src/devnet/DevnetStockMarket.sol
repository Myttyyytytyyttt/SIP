// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {DevnetSyntheticStock} from "./DevnetSyntheticStock.sol";

/// @notice Deterministic fixed-price stock venue for explicitly labelled drills.
/// @dev It performs real ERC-20/native transfers but is not an oracle or production exchange.
contract DevnetStockMarket is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOKEN_SCALE = 1e18;

    error DeadlineExpired(uint48 deadline, uint256 timestamp);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InsufficientOutput(uint256 minimum, uint256 actual);
    error InvalidAmount();
    error InvalidPrice(uint256 priceWeiPerToken);
    error PriceUnchanged(uint256 priceWeiPerToken);

    event LiquidityFunded(address indexed sender, uint256 amount);
    event PriceUpdated(uint256 previousPriceWeiPerToken, uint256 newPriceWeiPerToken);
    event StockBought(address indexed trader, uint256 nativeAmountIn, uint256 stockAmountOut, uint256 priceWeiPerToken);
    event StockSold(address indexed trader, uint256 stockAmountIn, uint256 nativeAmountOut, uint256 priceWeiPerToken);

    DevnetSyntheticStock public immutable stock;
    uint256 public priceWeiPerToken;

    constructor(address initialOwner, DevnetSyntheticStock stock_, uint256 initialPriceWeiPerToken)
        Ownable(initialOwner)
    {
        if (address(stock_) == address(0)) revert InvalidAmount();
        if (initialPriceWeiPerToken == 0) revert InvalidPrice(0);
        stock = stock_;
        priceWeiPerToken = initialPriceWeiPerToken;
    }

    receive() external payable {
        emit LiquidityFunded(msg.sender, msg.value);
    }

    function fundLiquidity() external payable {
        if (msg.value == 0) revert InvalidAmount();
        emit LiquidityFunded(msg.sender, msg.value);
    }

    function setPriceWeiPerToken(uint256 nextPriceWeiPerToken) external onlyOwner {
        if (nextPriceWeiPerToken == 0) revert InvalidPrice(0);
        uint256 previous = priceWeiPerToken;
        if (nextPriceWeiPerToken == previous) revert PriceUnchanged(previous);
        priceWeiPerToken = nextPriceWeiPerToken;
        emit PriceUpdated(previous, nextPriceWeiPerToken);
    }

    function quoteBuy(uint256 nativeAmountIn) public view returns (uint256 stockAmountOut) {
        return Math.mulDiv(nativeAmountIn, TOKEN_SCALE, priceWeiPerToken);
    }

    function quoteSell(uint256 stockAmountIn) public view returns (uint256 nativeAmountOut) {
        return Math.mulDiv(stockAmountIn, priceWeiPerToken, TOKEN_SCALE);
    }

    function buy(uint256 minStockAmountOut, uint48 deadline)
        external
        payable
        nonReentrant
        returns (uint256 stockAmountOut)
    {
        _validateDeadline(deadline);
        if (msg.value == 0) revert InvalidAmount();

        stockAmountOut = quoteBuy(msg.value);
        if (stockAmountOut == 0) revert InvalidAmount();
        if (stockAmountOut < minStockAmountOut) {
            revert InsufficientOutput(minStockAmountOut, stockAmountOut);
        }

        stock.mint(msg.sender, stockAmountOut);
        emit StockBought(msg.sender, msg.value, stockAmountOut, priceWeiPerToken);
    }

    function sell(uint256 stockAmountIn, uint256 minNativeAmountOut, uint48 deadline)
        external
        nonReentrant
        returns (uint256 nativeAmountOut)
    {
        _validateDeadline(deadline);
        if (stockAmountIn == 0) revert InvalidAmount();

        nativeAmountOut = quoteSell(stockAmountIn);
        if (nativeAmountOut == 0) revert InvalidAmount();
        if (nativeAmountOut < minNativeAmountOut) {
            revert InsufficientOutput(minNativeAmountOut, nativeAmountOut);
        }

        uint256 available = address(this).balance;
        if (nativeAmountOut > available) {
            revert InsufficientLiquidity(nativeAmountOut, available);
        }

        IERC20(address(stock)).safeTransferFrom(msg.sender, address(this), stockAmountIn);
        stock.burn(address(this), stockAmountIn);
        Address.sendValue(payable(msg.sender), nativeAmountOut);
        emit StockSold(msg.sender, stockAmountIn, nativeAmountOut, priceWeiPerToken);
    }

    function _validateDeadline(uint48 deadline) private view {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
    }
}
