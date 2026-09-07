// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IInvestmentAdapter} from "../interfaces/IInvestmentAdapter.sol";
import {
    BalanceDelta,
    IPoolManager,
    IUnlockCallback,
    PoolKey,
    SwapParams
} from "../interfaces/IRobinhoodVenue.sol";

/**
 * @dev The three functions this adapter needs from an ERC-4626 vault — the same
 *      minimal surface the savings adapter declares, for the same reason: a
 *      wider interface is an invitation to call more of it later.
 */
interface IERC4626Minimal {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function previewDeposit(uint256 assets) external view returns (uint256 shares);
}

/**
 * @title NuvemPerpTokenAdapter
 * @notice Buys shares of ONE leveraged perp-vault token (an Arcus pToken) with
 *         a vault's WETH: WETH -> USDG in one v4 unlock, then a synchronous
 *         ERC-4626 deposit, shares minted straight to the vault.
 *
 * WHY THIS IS A SEPARATE CONTRACT AND NOT A SECOND DEPLOYMENT OF THE SAVINGS
 * ADAPTER. Mechanically it IS the savings adapter's yield route — same hop,
 * same deposit shape — and a NuvemUsdgSavingsAdapter deployed with a pToken as
 * YIELD_VAULT would compile and run. It would also be a lie in the one place
 * lies are load-bearing: that contract's header tells the holder they are
 * exposed to DOLLARS, its events say DollarsDeposited, and its guardian
 * kill-switch story assumes the dollar risk family. A pToken is a 3x perp
 * position that its own issuer labels "can lose its entire value" — a
 * different risk family, which needs its own adapter id so the guardian can
 * kill it in one block without stopping anyone's dollar savings, and its own
 * event so "how much user money sits on Arcus" is one filter, not a heuristic.
 *
 * =============================================================================
 * WHAT THE HOLDER OF THIS TOKEN IS EXPOSED TO. SAID HERE BECAUSE NOWHERE ELSE
 * IN THE SYSTEM SAYS IT.
 * =============================================================================
 * The pToken is a pro-rata claim on an Arcus perp-vault: USDG collateral plus
 * an open leveraged position, rebalanced by AN OPERATOR BOT on Arcus's own
 * exchange, with funding, slippage and fees accruing against NAV. Measured at
 * review time (2026-08-30): the token is a BEACON PROXY whose beacon is owned
 * by an EOA (one key can replace the token's entire code); the implementation
 * is unverified; deposits were processed ASYNCHRONOUSLY by the operator in
 * batches, with previewDeposit reverting and maxDeposit answering 0.
 *
 * THIS ADAPTER REFUSES THAT WORLD BY CONSTRUCTION. It calls the SYNCHRONOUS
 * deposit() and measures the shares it minted in the same transaction; while
 * Arcus keeps deposits gated, every purchase reverts and no money moves. The
 * deploy script additionally refuses to deploy while previewDeposit reverts,
 * so the adapter cannot even be installed against today's behaviour. It
 * becomes operable on the day Arcus opens synchronous deposits — and the
 * governance ask that accompanies this contract (verified source, beacon
 * behind their existing timelocked multisig) is a listing precondition, not a
 * nice-to-have.
 *
 * A 3x TOKEN CAN GO TO ~ZERO. Every other Nuvem option cannot. The web listing
 * that names this adapter id must carry that sentence where the user picks.
 *
 * NO OWNER, NO SETTERS, NO PAUSE — the discipline all three existing adapters
 * share. Changing anything means a new deployment under a new id.
 */
contract NuvemPerpTokenAdapter is IInvestmentAdapter, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── errors ───────────────────────────────────────────────────────────────

    error InvalidTokenIn(address tokenIn);
    error UnsupportedTargetAsset(address targetAsset);
    error QuoteExpired(uint48 deadline);
    error InvalidAmountIn();
    error InsufficientAmountOut(uint256 required, uint256 received);
    error ResidualBalance(address token, uint256 amount);
    error NotPoolManager(address caller);
    error UnexpectedCallback();
    error InvalidConfiguration();
    error PerpVaultAssetMismatch(address expected, address actual);

    /**
     * @dev ITS OWN EVENT. "How much user money has been routed onto Arcus" is
     *      the exposure question this listing creates, and it must be one
     *      indexed filter — not DollarsDeposited with a different address, and
     *      not StockPurchased with a leveraged token in the field.
     */
    event PerpSharesPurchased(address indexed vault, uint256 amountIn, uint256 assets, uint256 shares);

    // ── pinned configuration ─────────────────────────────────────────────────

    address public immutable WETH;
    address public immutable USDG;
    /// @dev The one pToken this adapter can ever buy. Identity is this immutable.
    address public immutable PERP_TOKEN;
    IPoolManager public immutable POOL_MANAGER;
    uint24 public immutable WETH_USDG_FEE;
    int24 public immutable WETH_USDG_TICK_SPACING;

    /// @dev The same v4 price bound the other adapters use for zeroForOne.
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128740;

    /// @dev Set only for the duration of `unlock`, so a callback arriving at
    ///      any other time is refused even if it comes from the manager.
    bool private _unlocking;

    constructor(address weth, address usdg, address perpToken, address poolManager, uint24 fee, int24 tickSpacing) {
        if (weth == address(0) || usdg == address(0) || perpToken == address(0) || poolManager == address(0)) {
            revert InvalidConfiguration();
        }
        // ONE COMPARISON, TWO GUARANTEES: WETH sorts below USDG and they are
        // distinct — the hop's key hardcodes that order.
        if (uint160(weth) >= uint160(usdg)) revert InvalidConfiguration();
        // A destination that is also a currency would alias the residue checks.
        if (perpToken == usdg || perpToken == weth) revert InvalidConfiguration();
        if (tickSpacing <= 0) revert InvalidConfiguration();

        // THE PAIRING IS CHECKED, NOT TRUSTED — the savings adapter's rule.
        // Depositing USDG into a vault whose asset is something else is not a
        // revert you get for free.
        address underlying = IERC4626Minimal(perpToken).asset();
        if (underlying != usdg) revert PerpVaultAssetMismatch(usdg, underlying);

        WETH = weth;
        USDG = usdg;
        PERP_TOKEN = perpToken;
        POOL_MANAGER = IPoolManager(poolManager);
        WETH_USDG_FEE = fee;
        WETH_USDG_TICK_SPACING = tickSpacing;
    }

    /**
     * @inheritdoc IInvestmentAdapter
     *
     * @dev SYNCHRONOUS OR NOTHING. deposit() must mint the shares in this same
     *      transaction, because the vault measures its own balance delta and
     *      enforces the floor the user signed. While the pToken's deposits are
     *      gated or asynchronous this call reverts inside deposit() and no
     *      money moves — the fail-closed posture is the whole design.
     */
    function executeInvestment(
        address tokenIn,
        address targetAsset,
        uint256 amountIn,
        uint256 minAmountOut,
        uint48 deadline
    ) external override nonReentrant returns (uint256 amountOut) {
        if (tokenIn != WETH) revert InvalidTokenIn(tokenIn);
        if (targetAsset != PERP_TOKEN) revert UnsupportedTargetAsset(targetAsset);
        if (amountIn == 0) revert InvalidAmountIn();
        if (block.timestamp > deadline) revert QuoteExpired(deadline);

        address vault = msg.sender;

        // MEASURED AGAINST WHAT WAS HERE ON ENTRY, NOT AGAINST ZERO — the
        // anti-brick rule proven necessary by the stock adapter's one-wei
        // denial of service. A donation sits ignored; a leak is caught exactly.
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));
        uint256 usdgBefore = IERC20(USDG).balanceOf(address(this));
        uint256 sharesBefore = IERC20(PERP_TOKEN).balanceOf(address(this));

        IERC20(WETH).safeTransferFrom(vault, address(this), amountIn);

        // The USDG lands HERE, deliberately: a 4626 deposit is made from the
        // depositor's own balance. It exists for exactly the statements between
        // unlock and deposit, inside one transaction.
        _unlocking = true;
        uint256 usdgOut = abi.decode(POOL_MANAGER.unlock(abi.encode(amountIn)), (uint256));
        _unlocking = false;

        // Shares minted TO THE VAULT. This contract's own share balance must
        // be unchanged by the whole call — a pToken balance resting here would
        // also be an Arcus position nobody chose to give this contract.
        IERC20(USDG).forceApprove(PERP_TOKEN, usdgOut);
        amountOut = IERC4626Minimal(PERP_TOKEN).deposit(usdgOut, vault);
        // Zeroed rather than left to be consumed exactly: a vault that takes
        // less than offered would otherwise leave a standing allowance on a
        // contract nobody watches.
        IERC20(USDG).forceApprove(PERP_TOKEN, 0);

        _assertNothingStuck(PERP_TOKEN, sharesBefore);
        _assertNothingStuck(USDG, usdgBefore);
        _assertNothingStuck(WETH, wethBefore);

        // THE ONLY PRICE CHECK, AND IT IS THE CALLER'S — the shared stance.
        // THE FLOOR IS IN SHARES of the pToken (18 decimals), the same balance
        // the vault bounds; the keeper must quote this destination in shares.
        if (amountOut < minAmountOut) revert InsufficientAmountOut(minAmountOut, amountOut);

        emit PerpSharesPurchased(vault, amountIn, usdgOut, amountOut);
    }

    /**
     * @dev Runs inside `PoolManager.unlock`. One swap, settle the WETH, take
     *      the USDG to this contract for the deposit that follows.
     */
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager(msg.sender);
        if (!_unlocking) revert UnexpectedCallback();
        uint256 amountIn = abi.decode(data, (uint256));

        BalanceDelta d = POOL_MANAGER.swap(
            PoolKey({
                currency0: WETH,
                currency1: USDG,
                fee: WETH_USDG_FEE,
                tickSpacing: WETH_USDG_TICK_SPACING,
                hooks: address(0)
            }),
            SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: MIN_SQRT_PRICE_LIMIT}),
            ""
        );
        uint256 wethOwed = uint256(uint128(-int128(BalanceDelta.unwrap(d) >> 128)));
        uint256 usdgOut = uint256(uint128(int128(BalanceDelta.unwrap(d))));

        POOL_MANAGER.sync(WETH);
        IERC20(WETH).safeTransfer(address(POOL_MANAGER), wethOwed);
        POOL_MANAGER.settle();
        POOL_MANAGER.take(USDG, address(this), usdgOut);

        return abi.encode(usdgOut);
    }

    // ── views, for the keeper's pre-flight ───────────────────────────────────

    function isSupported(address asset) external view returns (bool) {
        return asset == PERP_TOKEN;
    }

    /**
     * @notice What the pToken says it would mint for `assets` USDG.
     *
     * @dev ADVISORY, NEVER A GATE IN THE MONEY PATH — and on today's Arcus it
     *      REVERTS, which callers must treat as "deposits are closed, defer"
     *      rather than as a broken adapter. The deploy script uses exactly
     *      this probe as its arming gate.
     */
    function previewShares(uint256 assets) external view returns (uint256 shares) {
        return IERC4626Minimal(PERP_TOKEN).previewDeposit(assets);
    }

    /// @dev Refuses if this call left anything behind. `expected` is the
    ///      balance on entry, so a donation is not mistaken for a leak.
    function _assertNothingStuck(address token, uint256 expected) private view {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != expected) revert ResidualBalance(token, balance - expected);
    }
}
