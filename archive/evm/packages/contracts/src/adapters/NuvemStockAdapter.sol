// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IInvestmentAdapter} from "../interfaces/IInvestmentAdapter.sol";
import {
    BalanceDelta,
    IAccessControlsRegistry,
    IAggregatorV3,
    IPoolManager,
    IStock,
    IUnlockCallback,
    PoolKey,
    SwapParams
} from "../interfaces/IRobinhoodVenue.sol";

/**
 * @title NuvemStockAdapter
 * @notice Buys canonical Robinhood stock tokens with a vault's WETH.
 *
 * THE ROUTE: TWO HOPS, ONE VENUE, ONE UNLOCK.
 *
 *     WETH ──> USDG ──> stock,  both swaps inside a single PoolManager.unlock
 *
 * There is not one live stock/WETH pool on this chain. Counting `Initialize`
 * events and filtering for live liquidity: NVDA/WETH has one pool with zero
 * swaps ever; SPY/WETH has none at all. USDG is where the liquidity is — SPY/USDG
 * carries roughly 660x the depth of SPY/ETH. So USDG is unavoidable.
 *
 * WHAT IS AVOIDABLE IS EVER HOLDING IT, AND THAT IS THE POINT OF DOING BOTH HOPS
 * INSIDE ONE UNLOCK. Uniswap v4 settles in deltas: the USDG the first swap owes
 * this contract and the USDG the second swap takes from it cancel inside the same
 * accounting session. The adapter's USDG BALANCE is never non-zero at any point,
 * so there is nothing to freeze and nothing to seize.
 *
 * That matters more than it sounds. USDG can be frozen and wiped by an EOA with
 * no timelock (`freeze` + `wipeFrozenAddress`), and burned from any holder by a
 * supply controller configured with `allowAnyMintAndBurnAddress = true` — no
 * allowance, no prior freeze, confirmed with an eth_call against a real holder. A
 * route that parks user funds on that, even briefly, is carrying a risk it does
 * not have to carry.
 *
 * WHY NOT RIALTO, WHICH QUOTES BETTER. Measured at a mainbet block, USDG→NVDA:
 * Rialto -7 bps against the oracle, this v4 pool +29 bps, both flat from $10 to
 * $1,000. So Rialto is about 35 bps better, which on a $93 purchase is 33 cents.
 * What that would buy is a dependency on a pair contract whose source is NOT
 * verified — its fill guarantees, its admin surface and its caller gating could
 * only be established indirectly — plus a real USDG balance between the hops.
 * Thirty-three cents is not the price of that.
 *
 * `_assertNoResidue` stays anyway. It should now be impossible to trip, which is
 * exactly why it is cheap to keep: it is the assertion that notices if this
 * reasoning ever stops being true.
 *
 * NO OWNER, NO SETTERS, NO PAUSE. Every parameter is an immutable or is written
 * once in the constructor, so `AdapterRegistry`'s runtime-codehash pin covers the
 * adapter's BEHAVIOUR and not merely its bytecode: nothing can be repointed after
 * review. The emergency stop lives outside, where it belongs — the guardian can
 * `deactivateAdapter` instantly and every vault stops using it in the same block,
 * and governance alone can register a replacement.
 *
 * CHANGING ANYTHING — a band, a pool, a stock, the trading window — means
 * deploying a new adapter and registering it under a new id. The registry is
 * append-only by design and this matches it.
 */
contract NuvemStockAdapter is IInvestmentAdapter, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── errors ───────────────────────────────────────────────────────────────

    error InvalidTokenIn(address tokenIn);
    error UnsupportedTargetAsset(address targetAsset);
    error NotCanonicalStock(address targetAsset);
    error StockImplementationRotated(address expected, address actual);
    error StockPaused(address targetAsset);
    error StockOraclePaused(address targetAsset);
    error AccountBlocked(address account);
    error PendingCorporateAction(address targetAsset, uint256 effectiveAt);
    error MarketClosed(uint256 timestamp);
    error StaleFeed(address feed, uint256 updatedAt);
    error InvalidOraclePrice(address feed, int256 answer);
    error QuoteExpired(uint48 deadline);
    error InvalidAmountIn();
    error InsufficientAmountOut(uint256 required, uint256 received);
    error ResidualBalance(address token, uint256 amount);
    error NotPoolManager(address caller);
    error UnexpectedCallback();
    error InvalidConfiguration();

    /// @dev No `usdgOut`: the intermediate USDG never becomes a balance, so
    ///      there was never a number here that corresponded to anything the
    ///      adapter held. What matters is what went in and what came out.
    event StockPurchased(address indexed vault, address indexed targetAsset, uint256 amountIn, uint256 amountOut);

    // ── pinned configuration ─────────────────────────────────────────────────

    address public immutable WETH;
    address public immutable USDG;
    IPoolManager public immutable POOL_MANAGER;
    address public immutable STOCK_REGISTRY;
    address public immutable PINNED_STOCK_IMPLEMENTATION;
    bytes32 public immutable STOCK_PROXY_CODEHASH;

    /// @dev The WETH/USDG pool. currency0 is WETH because its address sorts lower.
    uint24 public immutable WETH_USDG_FEE;
    int24 public immutable WETH_USDG_TICK_SPACING;

    uint256 internal constant BPS = 10_000;

    /// @dev The widest legal limits. The economic bound is `minAmountOut`, not a
    ///      tick: a price limit returns a PARTIAL fill, and a partial fill is a
    ///      stranded balance rather than a clean refusal.
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341;

    /// @dev Refuse for a day either side of a scheduled multiplier change.
    uint256 internal constant CORPORATE_ACTION_GUARD = 1 days;

    struct StockConfig {
        /// @dev The USDG/stock pool. Hookless on purpose: a hook with
        ///      `beforeSwapReturnsDelta` could rewrite the trade's economics
        ///      arbitrarily, and the pinned pair is how this adapter knows which
        ///      pool it is trading in. Measured on mainnet, the hookless
        ///      NVDA/USDG pools include ones charging 85%, 90%, 95% and 99.9% —
        ///      so "hookless" is not "safe", the PINNED FEE is what makes it safe.
        uint24 fee;
        int24 tickSpacing;
        /// @dev Distinguishes "configured with fee 0" from "never configured".
        ///      Without it a stock absent from the map is indistinguishable from
        ///      one pinned to a zero-fee pool.
        bool configured;
    }

    mapping(address stock => StockConfig) internal _configs;

    struct StockInput {
        address stock;
        uint24 fee;
        int24 tickSpacing;
    }

    /// @dev Guards the unlock callback. Set immediately before `unlock` and
    ///      cleared immediately after, so a callback arriving at any other moment
    ///      finds it zero and is refused. Plain storage rather than transient
    ///      because this repo pins solc 0.8.26 and `transient` landed in 0.8.28;
    ///      `nonReentrant` already prevents the nesting that would make the
    ///      difference matter.
    bool private _unlocking;

    constructor(
        address weth,
        address usdg,
        address poolManager,
        address stockRegistry,
        address pinnedStockImplementation,
        bytes32 stockProxyCodehash,
        uint24 wethUsdgFee,
        int24 wethUsdgTickSpacing,
        StockInput[] memory stocks
    ) {
        if (
            weth == address(0) || usdg == address(0) || poolManager == address(0) || stockRegistry == address(0)
                || pinnedStockImplementation == address(0) || stockProxyCodehash == bytes32(0) || stocks.length == 0
        ) revert InvalidConfiguration();
        // WETH must sort below USDG or the pool key below is inverted, and an
        // inverted key silently addresses a pool that does not exist.
        if (uint160(weth) >= uint160(usdg)) revert InvalidConfiguration();
        if (wethUsdgTickSpacing <= 0) revert InvalidConfiguration();

        WETH = weth;
        USDG = usdg;
        POOL_MANAGER = IPoolManager(poolManager);
        STOCK_REGISTRY = stockRegistry;
        PINNED_STOCK_IMPLEMENTATION = pinnedStockImplementation;
        STOCK_PROXY_CODEHASH = stockProxyCodehash;
        WETH_USDG_FEE = wethUsdgFee;
        WETH_USDG_TICK_SPACING = wethUsdgTickSpacing;

        for (uint256 i = 0; i < stocks.length; ++i) {
            StockInput memory input = stocks[i];
            if (input.stock == address(0)) revert InvalidConfiguration();
            if (_configs[input.stock].configured) revert InvalidConfiguration();
            if (input.tickSpacing <= 0) revert InvalidConfiguration();

            _configs[input.stock] =
                StockConfig({fee: input.fee, tickSpacing: input.tickSpacing, configured: true});
        }
    }

    // ── the investment ───────────────────────────────────────────────────────

    /**
     * @inheritdoc IInvestmentAdapter
     *
     * @dev The vault checks its own balance deltas afterwards and discards this
     *      return value, which is correct and which this adapter is written to
     *      deserve rather than to depend on.
     */
    function executeInvestment(
        address tokenIn,
        address targetAsset,
        uint256 amountIn,
        uint256 minAmountOut,
        uint48 deadline
    ) external override nonReentrant returns (uint256 amountOut) {
        if (tokenIn != WETH) revert InvalidTokenIn(tokenIn);
        if (amountIn == 0) revert InvalidAmountIn();
        if (block.timestamp > deadline) revert QuoteExpired(deadline);

        StockConfig memory config = _configs[targetAsset];
        if (!config.configured) revert UnsupportedTargetAsset(targetAsset);

        address vault = msg.sender;
        // The counterparty for the stock leg is now the PoolManager itself,
        // since the route no longer goes through a third-party pair contract.
        _requireCanonicalStock(targetAsset, vault, address(POOL_MANAGER));

        IERC20(WETH).safeTransferFrom(vault, address(this), amountIn);

        // Both hops, one unlock. The USDG the first swap credits and the second
        // swap debits cancel inside the manager's accounting, so this contract
        // never holds a USDG balance at any point in the call.
        _unlocking = true;
        amountOut = abi.decode(
            POOL_MANAGER.unlock(abi.encode(targetAsset, config.fee, config.tickSpacing, amountIn, vault)),
            (uint256)
        );
        _unlocking = false;

        // Belt and braces. With both hops in one unlock these should be
        // impossible to trip, which is why they are worth keeping: they are what
        // notices if that ever stops being true.
        _assertNoResidue(USDG);
        _assertNoResidue(WETH);

        // THE ONLY PRICE CHECK, AND IT IS THE CALLER'S. See the contract header
        // for why the oracle that used to sit here is gone: `minAmountOut` is
        // already the higher of the vault admin's hash-bound `minOutRateWad` and
        // the keeper's per-call quote, so an oracle floor here was a third guard
        // on a number two parties had already agreed.
        if (amountOut < minAmountOut) revert InsufficientAmountOut(minAmountOut, amountOut);
        emit StockPurchased(vault, targetAsset, amountIn, amountOut);
    }

    /**
     * @dev Runs inside `PoolManager.unlock`. The manager asserts every currency
     *      nets to zero when this returns, so a settlement bug reverts here
     *      rather than leaving a debt — and that same assertion is what proves
     *      the intermediate USDG really did cancel.
     */
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager(msg.sender);
        if (!_unlocking) revert UnexpectedCallback();
        (address stock, uint24 fee, int24 tickSpacing, uint256 amountIn, address vault) =
            abi.decode(data, (address, uint24, int24, uint256, address));

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

        // Hop 2: USDG -> stock, on whichever side USDG sorts.
        bool usdgIsCurrency0 = uint160(USDG) < uint160(stock);
        BalanceDelta d2 = POOL_MANAGER.swap(
            PoolKey({
                currency0: usdgIsCurrency0 ? USDG : stock,
                currency1: usdgIsCurrency0 ? stock : USDG,
                fee: fee,
                tickSpacing: tickSpacing,
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
        uint256 stockOut = usdgIsCurrency0 ? uint256(uint128(int128(raw2))) : uint256(uint128(int128(raw2 >> 128)));

        // Pay the WETH, take the stock. The USDG legs cancelled; the manager
        // refuses this callback if they did not.
        POOL_MANAGER.sync(WETH);
        IERC20(WETH).safeTransfer(address(POOL_MANAGER), wethOwed);
        POOL_MANAGER.settle();
        POOL_MANAGER.take(stock, vault, stockOut);

        return abi.encode(stockOut);
    }

    // ── the checks ───────────────────────────────────────────────────────────

    /**
     * @dev Six checks, and the first is the only one that establishes IDENTITY.
     *
     *      The other five are structural, and a permissionlessly-initialised
     *      clone of the real beacon passes all of them: same codehash, same
     *      registry, same implementation. They are still worth running, because
     *      they catch a token that has since been paused, blocked or upgraded out
     *      from under a configuration that was correct when it was written.
     */
    function _requireCanonicalStock(address stock, address vault, address pair) private view {
        // 1. Identity: the pinned list. Nothing else distinguishes THE token.
        //    `_configs` was already checked by the caller.

        // 2. The proxy shell is a real Stock BeaconProxy.
        if (stock.codehash != STOCK_PROXY_CODEHASH) revert NotCanonicalStock(stock);

        // 3. Its current implementation was built against the real registry.
        if (IStock(stock).ACCESS_CONTROLLED_REGISTRY() != STOCK_REGISTRY) revert NotCanonicalStock(stock);

        // 4. The beacon still runs the implementation this adapter was reviewed
        //    against. A rotation to one that gates transfers, charges a fee on
        //    transfer, or changes multiplier semantics FAILS CLOSED here, and
        //    resuming needs a new adapter that governance has looked at.
        address impl = IAccessControlsRegistry(STOCK_REGISTRY).implementation();
        if (impl != PINNED_STOCK_IMPLEMENTATION) revert StockImplementationRotated(PINNED_STOCK_IMPLEMENTATION, impl);

        // 5. Not halted. `paused()` ORs the token's own flag with the registry's
        //    global one, so this covers "every stock at once" too.
        if (IStock(stock).paused()) revert StockPaused(stock);
        if (IStock(stock).oraclePaused()) revert StockOraclePaused(stock);

        // 6. The deny-list applies to sender, from and to on every transfer.
        //    Checking all three here turns an opaque revert deep inside the pair
        //    into a named error the keeper can act on.
        IAccessControlsRegistry registry = IAccessControlsRegistry(STOCK_REGISTRY);
        if (registry.isBlocked(address(this))) revert AccountBlocked(address(this));
        if (registry.isBlocked(vault)) revert AccountBlocked(vault);
        if (registry.isBlocked(pair)) revert AccountBlocked(pair);

        // A scheduled multiplier change is the one moment the feed's price and
        // the token's multiplier can disagree. Stand off a day either side.
        uint256 effectiveAt = IStock(stock).effectiveAt();
        if (
            effectiveAt != 0 && block.timestamp + CORPORATE_ACTION_GUARD >= effectiveAt
                && block.timestamp <= effectiveAt + CORPORATE_ACTION_GUARD
        ) revert PendingCorporateAction(stock, effectiveAt);
    }

    // NO TRADING-WINDOW GATE, AND NO ORACLE. Both were here and both are gone;
    // the reasoning is in the contract header. In short: the pool is open 24/7 and
    // the gates were ours, not the venue's — measured on a Saturday, the hookless
    // NVDA/USDG pool quoted $224.83 against a 22-hour-old feed at $225.31, a 0.21%
    // difference. What replaced them is `minAmountOut`, which was always the
    // binding constraint anyway.

    function _assertNoResidue(address token) private view {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != 0) revert ResidualBalance(token, balance);
    }

    // ── views, for the keeper's pre-flight ───────────────────────────────────

    function isSupported(address stock) external view returns (bool) {
        return _configs[stock].configured;
    }

    function getStockConfig(address stock)
        external
        view
        returns (uint24 fee, int24 tickSpacing, bool configured)
    {
        StockConfig memory config = _configs[stock];
        return (config.fee, config.tickSpacing, config.configured);
    }

    // NO previewFloor. It existed to tell the keeper what the ORACLE floor would
    // be before it spent gas discovering it, and there is no oracle floor now. The
    // keeper quotes the pool itself — which is the price it will actually get —
    // and the only floor is the one it and the vault admin already agreed.
}
