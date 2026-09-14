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
 * @title NuvemIndexAdapter
 * @notice Buys INDEX (theindex.finance) with a vault's WETH, WETH -> USDG ->
 *         INDEX in one unlock, and takes it straight to the vault.
 *
 * WHY THIS IS A SEPARATE CONTRACT AND NOT AN ENTRY IN NuvemStockAdapter'S LIST.
 *
 * That adapter's identity gate is three-deep and every layer refuses INDEX:
 * the asset list is written once in the constructor (no owner, no setters),
 * `_requireCanonicalStock` pins the codehash of Robinhood's stock BeaconProxy
 * (INDEX's does not match), and the `IStock` probe asks for
 * `ACCESS_CONTROLLED_REGISTRY()` (INDEX does not answer it). Those gates are
 * the point of that adapter — they bind it to tokens whose pause flags,
 * deny-list and corporate-action windows it knows how to respect — and INDEX
 * has none of that machinery. So INDEX gets its own adapter whose identity
 * gate is one immutable address, reviewed once, changeable only by deploying
 * again.
 *
 * Separation also keeps the guardian's kill switch sharp, the same argument the
 * savings adapter states: `deactivateAdapter` is per-id and instant, and an
 * INDEX incident (the far likelier kind — see below) must not stop stock or
 * dollar purchases for a governance cycle.
 *
 * =============================================================================
 * WHAT THE HOLDER OF THIS TOKEN IS EXPOSED TO. SAID HERE BECAUSE NOWHERE ELSE
 * IN THE SYSTEM SAYS IT.
 * =============================================================================
 * INDEX is a reflection token whose protocol pushes tokenized stocks to every
 * registered holder above its threshold (10,000 INDEX at review time), hourly,
 * with no claim. That yield is DISCRETIONARY: the token's and the distributor's
 * owner is one non-renounced EOA which can exclude any holder, raise the
 * threshold, pause or repoint the distributor at will — it has already replaced
 * the distributor four times. The token itself is fixed-supply, unpausable,
 * has no blacklist and NO FEE ON TRANSFER (verified by simulation; its only
 * transfer hook maintains the holder registry). None of the vault's money
 * depends on the distribution continuing: this adapter buys a plain ERC-20 at
 * a pool price, and the airdrops, while they last, arrive at the vault on top.
 *
 * THE ADAPTER MUST NEVER HOLD INDEX, and structurally cannot: both hops run in
 * one `unlock` and `take` delivers the INDEX from the manager DIRECTLY to the
 * vault, so this contract's INDEX balance never goes non-zero — which also
 * means it never enters the INDEX protocol's holder registry and never earns
 * (or taints) a distribution of its own.
 *
 * THE POOL IS PINNED, AND THAT IS A SAFETY DECISION, NOT A CONVENIENCE. At
 * review time 107 of the 108 hookless INDEX/USDG pools were empty shells or
 * fee traps (85–99.99%); exactly one carries real liquidity, and the 3% ETH
 * tax lives only in the hooked ETH/INDEX pool this adapter never touches.
 * The fee and tickSpacing below select the one real pool, immutably; if its
 * liquidity migrates, the answer is a new adapter, not a setter.
 *
 * NO OWNER, NO SETTERS, NO PAUSE — the same discipline as the other two
 * adapters, so the registry's codehash pin covers behaviour, not just bytecode.
 */
contract NuvemIndexAdapter is IInvestmentAdapter, IUnlockCallback, ReentrancyGuard {
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

    /**
     * @dev ITS OWN EVENT, deliberately not `StockPurchased`. "How much INDEX
     *      has been bought into vaults" is the exposure question this listing
     *      creates — a young, unaudited protocol whose yield one EOA controls —
     *      and it must not be answerable only by filtering a stock event on an
     *      address.
     */
    event IndexPurchased(address indexed vault, uint256 amountIn, uint256 amountOut);

    // ── pinned configuration ─────────────────────────────────────────────────

    address public immutable WETH;
    address public immutable USDG;
    /// @dev The one asset this adapter can ever buy. Identity is this immutable.
    address public immutable INDEX;
    IPoolManager public immutable POOL_MANAGER;
    uint24 public immutable WETH_USDG_FEE;
    int24 public immutable WETH_USDG_TICK_SPACING;
    uint24 public immutable USDG_INDEX_FEE;
    int24 public immutable USDG_INDEX_TICK_SPACING;

    /// @dev The same v4 price bounds the other adapters use.
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341;

    /// @dev Set only for the duration of `unlock`, so a callback arriving at any
    ///      other time is refused even if it comes from the manager.
    bool private _unlocking;

    constructor(
        address weth,
        address usdg,
        address index,
        address poolManager,
        uint24 wethUsdgFee,
        int24 wethUsdgTickSpacing,
        uint24 usdgIndexFee,
        int24 usdgIndexTickSpacing
    ) {
        if (weth == address(0) || usdg == address(0) || index == address(0) || poolManager == address(0)) {
            revert InvalidConfiguration();
        }
        // ONE COMPARISON, TWO GUARANTEES: WETH sorts below USDG, and they are
        // not the same token. The first hop's key hardcodes that order, and an
        // inverted one does not fail loudly — it silently addresses a pool that
        // does not exist.
        if (uint160(weth) >= uint160(usdg)) revert InvalidConfiguration();
        // INDEX distinct from both currencies, or the residue checks below
        // alias each other and the second hop's key degenerates — the exact
        // failure that made USDG unlistable in the stock adapter.
        if (index == weth || index == usdg) revert InvalidConfiguration();
        if (wethUsdgTickSpacing <= 0 || usdgIndexTickSpacing <= 0) revert InvalidConfiguration();

        WETH = weth;
        USDG = usdg;
        INDEX = index;
        POOL_MANAGER = IPoolManager(poolManager);
        WETH_USDG_FEE = wethUsdgFee;
        WETH_USDG_TICK_SPACING = wethUsdgTickSpacing;
        USDG_INDEX_FEE = usdgIndexFee;
        USDG_INDEX_TICK_SPACING = usdgIndexTickSpacing;
    }

    /**
     * @inheritdoc IInvestmentAdapter
     *
     * @dev The destination is a HARD EQUALITY AGAINST AN IMMUTABLE, not a
     *      mapping — one asset, forever, the same stance as the savings
     *      adapter and for the same reason: a map is what lets a contract grow
     *      a destination later without anyone reviewing it.
     */
    function executeInvestment(
        address tokenIn,
        address targetAsset,
        uint256 amountIn,
        uint256 minAmountOut,
        uint48 deadline
    ) external override nonReentrant returns (uint256 amountOut) {
        if (tokenIn != WETH) revert InvalidTokenIn(tokenIn);
        if (targetAsset != INDEX) revert UnsupportedTargetAsset(targetAsset);
        if (amountIn == 0) revert InvalidAmountIn();
        if (block.timestamp > deadline) revert QuoteExpired(deadline);

        address vault = msg.sender;

        // MEASURED AGAINST WHAT WAS HERE ON ENTRY, NOT AGAINST ZERO. The stock
        // adapter asserts against zero, and one donated wei bricks every
        // purchase for every vault pointed at it, forever
        // (testASingleDonatedWeiBricksEveryPurchase proves it). A leak is still
        // caught exactly — what this call brings in, it must send out — while a
        // donation sits ignored, the correct answer for a contract that never
        // spends from its own balance.
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));
        uint256 usdgBefore = IERC20(USDG).balanceOf(address(this));
        uint256 indexBefore = IERC20(INDEX).balanceOf(address(this));

        IERC20(WETH).safeTransferFrom(vault, address(this), amountIn);

        _unlocking = true;
        amountOut = abi.decode(POOL_MANAGER.unlock(abi.encode(amountIn, vault)), (uint256));
        _unlocking = false;

        // THE INDEX NEVER LANDS HERE — it is taken straight to the vault inside
        // the callback. Landing here, even transiently, would also enroll this
        // contract in the INDEX protocol's holder registry, which no one chose.
        _assertNothingStuck(INDEX, indexBefore);
        _assertNothingStuck(USDG, usdgBefore);
        _assertNothingStuck(WETH, wethBefore);

        // THE ONLY PRICE CHECK, AND IT IS THE CALLER'S — the same stance as the
        // other adapters. `minAmountOut` is already the higher of the vault
        // admin's hash-bound floor and the keeper's per-call quote.
        if (amountOut < minAmountOut) revert InsufficientAmountOut(minAmountOut, amountOut);

        emit IndexPurchased(vault, amountIn, amountOut);
    }

    /**
     * @dev Runs inside `PoolManager.unlock`. Two swaps, pay the WETH, take the
     *      INDEX. The manager asserts every currency nets to zero when this
     *      returns, which is what proves the intermediate USDG cancelled.
     */
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager(msg.sender);
        if (!_unlocking) revert UnexpectedCallback();
        (uint256 amountIn, address vault) = abi.decode(data, (uint256, address));

        // Hop 1: WETH -> USDG. WETH sorts below USDG, checked in the constructor.
        BalanceDelta d1 = POOL_MANAGER.swap(
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
        uint256 wethOwed = uint256(uint128(-int128(BalanceDelta.unwrap(d1) >> 128)));
        uint256 usdgIn = uint256(uint128(int128(BalanceDelta.unwrap(d1))));

        // Hop 2: USDG -> INDEX, on whichever side USDG sorts. On mainnet INDEX
        // (0x5691…) sorts below USDG (0x5fc5…), so this is the oneForZero
        // branch — but the comparison stays runtime, the same proven shape as
        // the stock adapter's, rather than a constructor-baked boolean a future
        // edit could desynchronise from the key.
        bool usdgIsCurrency0 = uint160(USDG) < uint160(INDEX);
        BalanceDelta d2 = POOL_MANAGER.swap(
            PoolKey({
                currency0: usdgIsCurrency0 ? USDG : INDEX,
                currency1: usdgIsCurrency0 ? INDEX : USDG,
                fee: USDG_INDEX_FEE,
                tickSpacing: USDG_INDEX_TICK_SPACING,
                hooks: address(0)
            }),
            SwapParams({
                zeroForOne: usdgIsCurrency0,
                amountSpecified: -int256(usdgIn),
                sqrtPriceLimitX96: usdgIsCurrency0 ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT
            }),
            ""
        );
        int256 raw2 = BalanceDelta.unwrap(d2);
        uint256 indexOut = usdgIsCurrency0 ? uint256(uint128(int128(raw2))) : uint256(uint128(int128(raw2 >> 128)));

        // Pay the WETH, take the INDEX straight to the vault. The USDG legs
        // cancelled; the manager refuses this callback if they did not.
        POOL_MANAGER.sync(WETH);
        IERC20(WETH).safeTransfer(address(POOL_MANAGER), wethOwed);
        POOL_MANAGER.settle();
        POOL_MANAGER.take(INDEX, vault, indexOut);

        return abi.encode(indexOut);
    }

    // ── views, for the keeper's pre-flight ───────────────────────────────────

    function isSupported(address asset) external view returns (bool) {
        return asset == INDEX;
    }

    /// @dev The keeper reads pool parameters per target from the adapter that
    ///      will use them, so its quote and the adapter's swap can never name
    ///      different pools. Same shape as the stock adapter's getStockConfig.
    function getIndexConfig() external view returns (uint24 fee, int24 tickSpacing) {
        return (USDG_INDEX_FEE, USDG_INDEX_TICK_SPACING);
    }

    /// @dev Refuses if this call left anything behind. `expected` is the balance
    ///      on entry, so a pre-existing donation is not mistaken for a leak.
    function _assertNothingStuck(address token, uint256 expected) private view {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != expected) revert ResidualBalance(token, balance - expected);
    }
}
