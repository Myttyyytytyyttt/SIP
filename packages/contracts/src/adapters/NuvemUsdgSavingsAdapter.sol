// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IInvestmentAdapter} from "../interfaces/IInvestmentAdapter.sol";

/**
 * @dev The three functions this adapter needs from an ERC-4626 vault, declared
 *      here rather than imported. A wider interface would be an invitation to
 *      call more of it later; these three are what a deposit is made of, and
 *      `asset()` is what the constructor checks so the pairing cannot be wrong.
 */
interface IERC4626Minimal {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    // previewDeposit and NOT convertToShares: EIP-4626 forbids the former from
    // promising more than a deposit delivers. convertToAssets was here and is
    // gone — it is the function that would tempt a later editor to "convert the
    // units" inside this contract and thereby weaken the vault's own floor.
    function previewDeposit(uint256 assets) external view returns (uint256 shares);
}
import {
    BalanceDelta,
    IPoolManager,
    IUnlockCallback,
    PoolKey,
    SwapParams
} from "../interfaces/IRobinhoodVenue.sol";

/**
 * @title NuvemUsdgSavingsAdapter
 * @notice Buys USDG with a vault's WETH, in one hop, and sends it to the vault.
 *
 * WHY THIS IS A SEPARATE CONTRACT AND NOT A BRANCH IN NuvemStockAdapter.
 *
 * That adapter's route is WETH -> USDG -> stock, and its second hop is not
 * decoration: it is the code that produces the number handed to
 * `POOL_MANAGER.take`. Asking it for USDG makes the second hop's pool key
 * degenerate — `usdgIsCurrency0 = uint160(USDG) < uint160(stock)` is false when
 * the stock IS USDG, so the key becomes currency0 == currency1 == USDG, which
 * Uniswap v4 requires to be strictly ordered. It hashes to a pool that cannot
 * exist and the swap reverts. No constructor argument reaches that line, so
 * "just deploy it with USDG in the stock list" was never available.
 *
 * Deploying it separately also keeps the guardian's kill switch sharp.
 * `deactivateAdapter` is per-id and instant; `reactivateAdapter` is governance.
 * One instance serving both routes would mean the one-block response to a USDG
 * incident also stops every stock purchase, and undoing that costs a governance
 * cycle. The risk this contract exists to carry arrives with no timelock, so a
 * kill switch that takes a governance cycle is not a response to it.
 *
 * =============================================================================
 * WHAT THE HOLDER OF THIS TOKEN IS EXPOSED TO. SAID HERE BECAUSE NOWHERE ELSE
 * IN THE SYSTEM SAYS IT.
 * =============================================================================
 * USDG can be FROZEN and WIPED by an EOA with no timelock (`freeze` +
 * `wipeFrozenAddress`), and BURNED from any holder by a supply controller
 * configured with `allowAnyMintAndBurnAddress = true` — no allowance, no prior
 * freeze. That was confirmed with an eth_call against a real holder, not
 * inferred from documentation.
 *
 * NuvemStockAdapter is built so that no such balance ever exists: it does both
 * of its hops inside one `unlock`, so the intermediate USDG cancels as a delta
 * and its own balance is never non-zero. THIS ADAPTER DELIBERATELY BREAKS THAT
 * PROPERTY FOR THE VAULT, because a vault saving in dollars has to hold the
 * dollars. It does NOT break it for itself: the USDG is `take`n straight to the
 * vault inside the callback, and every call asserts it ends holding exactly what
 * it started with. The exposure belongs to the vault whose admin chose it, and
 * keeping it there is the whole containment.
 *
 * A vault holds ONE adapter id (`PersonalVault.adapterId`, one scalar, resolved
 * once and reused for every leg), so a vault saves in dollars or in stocks,
 * never both. "Is this user exposed to USDG?" is therefore one storage word
 * rather than a parsed basket. That is the price of this design and it is also
 * the point of it.
 *
 * NO OWNER, NO SETTERS, NO PAUSE — the same discipline as the stock adapter, and
 * the reason the registry's codehash pin covers behaviour rather than merely
 * bytecode. Changing anything means deploying a new adapter and registering it
 * under a new id.
 */
contract NuvemUsdgSavingsAdapter is IInvestmentAdapter, IUnlockCallback, ReentrancyGuard {
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
    error YieldVaultAssetMismatch(address expected, address actual);

    /**
     * @dev ITS OWN EVENT, deliberately not `StockPurchased` with targetAsset ==
     *      USDG. The monitoring question this route creates — how much USDG has
     *      been bought into vaults, ever — must not be answerable only by
     *      filtering a stock event on an address, because a filter that is
     *      subtly wrong reads as zero exposure rather than as an error.
     */
    event DollarsPurchased(address indexed vault, uint256 amountIn, uint256 amountOut);

    /**
     * @dev A SECOND EVENT, not a flag on the first. "How much is sitting in the
     *      yield vault" and "how much is sitting in raw USDG" are different
     *      exposures with different risks — one adds Morpho market and curator
     *      risk on top of the issuer's — and an indexer must not have to know a
     *      boolean to tell them apart.
     */
    event DollarsDeposited(address indexed vault, uint256 amountIn, uint256 assets, uint256 shares);

    // ── pinned configuration ─────────────────────────────────────────────────

    address public immutable WETH;
    address public immutable USDG;
    IPoolManager public immutable POOL_MANAGER;
    uint24 public immutable WETH_USDG_FEE;
    int24 public immutable WETH_USDG_TICK_SPACING;

    /**
     * @dev The ERC-4626 vault over USDG, or address(0) for a deployment that
     *      offers plain dollars only.
     *
     * TWO IMMUTABLES, NOT A MAPPING, and the distinction is the whole safety
     * argument. A map is what lets a contract grow a third destination later
     * without anyone reviewing it; two immutables are a list that cannot change
     * after construction. Adding a destination means a new deployment and a new
     * registry id, which is the same doctrine the stock adapter states about
     * itself.
     */
    address public immutable YIELD_VAULT;

    /// @dev The same v4 price bounds the stock adapter uses.
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128740;

    /// @dev Set only for the duration of `unlock`, so a callback arriving at any
    ///      other time is refused even if it comes from the manager.
    bool private _unlocking;

    constructor(address weth, address usdg, address poolManager, uint24 fee, int24 tickSpacing, address yieldVault) {
        if (weth == address(0) || usdg == address(0) || poolManager == address(0)) revert InvalidConfiguration();
        // ONE COMPARISON, TWO GUARANTEES: WETH sorts below USDG, and they are not
        // the same token. The pool key below hardcodes that order, and an
        // inverted one does not fail loudly — it silently addresses a pool that
        // does not exist.
        if (uint160(weth) >= uint160(usdg)) revert InvalidConfiguration();
        if (tickSpacing <= 0) revert InvalidConfiguration();

        // THE PAIRING IS CHECKED, NOT TRUSTED. Depositing USDG into a vault whose
        // asset is something else is not a revert you would get for free: some
        // 4626s would take the transfer and mint shares against the wrong
        // accounting. Asking the vault what it holds costs one call at
        // construction and makes the mistake undeployable.
        if (yieldVault != address(0)) {
            address underlying = IERC4626Minimal(yieldVault).asset();
            if (underlying != usdg) revert YieldVaultAssetMismatch(usdg, underlying);
            // A vault that is also one of the currencies would make the residue
            // checks below alias each other.
            if (yieldVault == usdg || yieldVault == weth) revert InvalidConfiguration();
        }

        WETH = weth;
        USDG = usdg;
        POOL_MANAGER = IPoolManager(poolManager);
        WETH_USDG_FEE = fee;
        WETH_USDG_TICK_SPACING = tickSpacing;
        YIELD_VAULT = yieldVault;
    }

    /**
     * @inheritdoc IInvestmentAdapter
     *
     * @dev The destination is a HARD EQUALITY AGAINST AN IMMUTABLE, not a
     *      mapping. A `_configs`-style map is exactly what would let this
     *      contract grow a second destination later without a fresh review, and
     *      refusing to have one is how the blast radius stays where it was
     *      designed to be. There is one asset this adapter can ever buy.
     */
    function executeInvestment(
        address tokenIn,
        address targetAsset,
        uint256 amountIn,
        uint256 minAmountOut,
        uint48 deadline
    ) external override nonReentrant returns (uint256 amountOut) {
        if (tokenIn != WETH) revert InvalidTokenIn(tokenIn);
        // TWO DESTINATIONS, BOTH IMMUTABLE. The `YIELD_VAULT != address(0)` half
        // matters: without it, a deployment that offers plain dollars only would
        // accept address(0) as a destination and then call it.
        bool toYield = YIELD_VAULT != address(0) && targetAsset == YIELD_VAULT;
        if (!toYield && targetAsset != USDG) revert UnsupportedTargetAsset(targetAsset);
        if (amountIn == 0) revert InvalidAmountIn();
        if (block.timestamp > deadline) revert QuoteExpired(deadline);

        address vault = msg.sender;

        // MEASURED AGAINST WHAT WAS HERE ON ENTRY, NOT AGAINST ZERO — and that
        // difference is the whole of a griefing attack.
        //
        // NuvemStockAdapter asserts `balanceOf(this) == 0` after every purchase
        // and has no owner, no setter and no sweep. So anyone can send it one wei
        // of WETH and every stock purchase for every vault pointed at it reverts
        // forever, recoverable only by governance registering a replacement and
        // every vault admin repointing. Copying that assertion here would buy the
        // same attack for the price of a transfer.
        //
        // A leak is still caught, exactly: what this call brings in, it must send
        // out. A donation sits there and is ignored, which is the correct answer
        // for a contract that never spends from its own balance.
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));
        uint256 usdgBefore = IERC20(USDG).balanceOf(address(this));

        IERC20(WETH).safeTransferFrom(vault, address(this), amountIn);

        // WHERE THE DOLLARS LAND IS DECIDED HERE, not inside the callback. For
        // plain dollars they go straight to the vault and never touch this
        // contract at all. For the yield route they have to pass through, because
        // a deposit is made from the depositor's own balance — so they sit here
        // for exactly the two statements below, inside one transaction, where no
        // outside party can act on them.
        address usdgTo = toYield ? address(this) : vault;
        _unlocking = true;
        uint256 usdgOut = abi.decode(POOL_MANAGER.unlock(abi.encode(amountIn, usdgTo)), (uint256));
        _unlocking = false;

        if (toYield) {
            // The shares are minted TO THE VAULT, so this contract's own share
            // balance must be unchanged by the whole call.
            uint256 sharesBefore = IERC20(YIELD_VAULT).balanceOf(address(this));
            IERC20(USDG).forceApprove(YIELD_VAULT, usdgOut);
            amountOut = IERC4626Minimal(YIELD_VAULT).deposit(usdgOut, vault);
            // Zeroed rather than left to be consumed exactly. A 4626 that takes
            // less than it was offered would otherwise leave a standing allowance
            // on a contract nobody watches.
            IERC20(USDG).forceApprove(YIELD_VAULT, 0);
            _assertNothingStuck(YIELD_VAULT, sharesBefore);
        } else {
            amountOut = usdgOut;
        }

        // THE USDG NEVER LANDS HERE. It is taken straight to the vault inside
        // the callback, so this is what notices if that ever stops being true —
        // and given what can be done to a USDG balance, this contract holding one
        // even between two statements is worth refusing.
        _assertNothingStuck(USDG, usdgBefore);
        _assertNothingStuck(WETH, wethBefore);

        // THE ONLY PRICE CHECK, AND IT IS THE CALLER'S — the same stance as the
        // stock adapter. `minAmountOut` is already the higher of the vault
        // admin's hash-bound floor and the keeper's per-call quote.
        // THE FLOOR IS IN THE UNITS OF WHAT THE VAULT RECEIVES, which differ
        // between the two routes: raw USDG has 6 decimals, and 4626 shares
        // typically 18. The vault measures the same balance it is bounding, so
        // the two agree — but a quote computed for one route and used for the
        // other is wrong by about 1e12, which is why they are separate events
        // and why the keeper must quote per destination.
        if (amountOut < minAmountOut) revert InsufficientAmountOut(minAmountOut, amountOut);

        if (toYield) emit DollarsDeposited(vault, amountIn, usdgOut, amountOut);
        else emit DollarsPurchased(vault, amountIn, amountOut);
    }

    /**
     * @dev Runs inside `PoolManager.unlock`. One swap, then pay what is owed and
     *      take what is due — the manager refuses to close the unlock if any
     *      currency is left unsettled, which is what makes this safe to write as
     *      a straight line.
     */
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager(msg.sender);
        if (!_unlocking) revert UnexpectedCallback();
        (uint256 amountIn, address recipient) = abi.decode(data, (uint256, address));

        // WETH -> USDG. WETH sorts below USDG, checked in the constructor, so
        // this is unconditionally zeroForOne — the branch that made a USDG
        // destination impossible in the stock adapter does not exist here.
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
        // THE RECIPIENT IS THE CALLER'S DECISION, made before the unlock. For
        // plain dollars it is the vault itself, so the USDG never touches this
        // contract; for the yield route it is this contract, because a 4626
        // deposit is made from the depositor's own balance.
        POOL_MANAGER.take(USDG, recipient, usdgOut);

        return abi.encode(usdgOut);
    }

    // ── views, for the keeper's pre-flight ───────────────────────────────────

    /**
     * @notice Whether this adapter can reach `asset`.
     *
     * @dev BOTH DESTINATIONS, because `executeInvestment` accepts both. This
     *      answered `asset == USDG` alone while the yield route was already
     *      live, so a keeper using it as a pre-flight would have filtered the
     *      steakUSDG leg out and either skipped it or refused the whole basket
     *      — a view disagreeing with the function it describes.
     */
    function isSupported(address asset) external view returns (bool) {
        return asset == USDG || (YIELD_VAULT != address(0) && asset == YIELD_VAULT);
    }

    /**
     * @notice What the yield vault says it would mint for `assets` USDG, or 0
     *         when this deployment has no yield route.
     *
     * @dev ADVISORY, AND NEVER A GATE IN THE MONEY PATH. An earlier version of
     *      this file asked `maxDeposit` and REVERTED when it came back short.
     *      That would have bricked the yield route permanently on a contract
     *      with no setters, because MORPHO VAULT V2 RETURNS ZERO FROM EVERY
     *      max* BY DESIGN — steakUSDG answers maxDeposit 0 while a real deposit
     *      of 2,500 USDG mints 2,486.83 shares. reports/YIELD_2026-08-24.md
     *      records exactly that trap; the mistake was not reading it first.
     *
     *      `previewDeposit` is the honest question, and EIP-4626 forbids it from
     *      promising more than `deposit` delivers, so a floor built on it is
     *      conservative by construction. A keeper that gets a revert anyway
     *      should treat it as retry-later, not as a broken vault.
     */
    function previewYield(uint256 assets) external view returns (uint256 shares) {
        if (YIELD_VAULT == address(0)) return 0;
        return IERC4626Minimal(YIELD_VAULT).previewDeposit(assets);
    }

    /// @dev Refuses if this call left anything behind. `expected` is the balance
    ///      on entry, so a pre-existing donation is not mistaken for a leak.
    function _assertNothingStuck(address token, uint256 expected) private view {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != expected) revert ResidualBalance(token, balance - expected);
    }
}
