// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @dev The one question the desk asks the pToken: what is a share worth, in
 *      the asset, right now. It is the same number Arcus's own UI displays.
 */
interface INavSource {
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}

/**
 * @title NuvemPerpDesk
 * @notice An OTC counter with OWNER inventory: sells ONE Arcus pToken for USDG,
 *         synchronously, at the pToken's own on-chain NAV minus an immutable
 *         spread, to exactly one authorized buyer (the Nuvem adapter).
 *
 * WHY THIS EXISTS. Arcus pTokens have no contract-reachable entry today: their
 * primary deposits are signed off-chain and settled minutes later by their
 * operator, and the hookless USDG pools are empty. A human can wait 2–15
 * minutes; PersonalVault.invest() cannot — it measures what it received in the
 * same transaction, because that is where the user's signed floor is enforced.
 * This desk is the missing synchronous hop: the operator buys inventory
 * through Arcus's RFQ as a human, parks it here, and vaults buy from it
 * atomically.
 *
 * =============================================================================
 * WHOSE MONEY SITS HERE, AND WHOSE NEVER DOES.
 * =============================================================================
 * The desk holds ONLY the operator's capital: the pToken inventory they
 * deposited (a plain transfer) and the USDG proceeds of sales. A vault's USDG
 * exists here only inside the single transaction that swaps it, and the
 * pToken goes straight to the vault. If this contract were drained to zero
 * tomorrow, no user loses anything — that property is the whole design, and it
 * is why `withdrawToken` can be owner-only-and-unrestricted without touching
 * anyone's savings.
 *
 * WHAT PROTECTS THE BUYER'S USERS. The price is not the operator's to set:
 * shares out = usdgIn / convertToAssets(1e18), minus SPREAD_BPS — both the NAV
 * source and the spread are immutable. Changing the spread means deploying a
 * new desk and pointing a new adapter at it through governance. And the
 * keeper's per-call quote plus the vault admin's hash-bound floor still bind
 * every purchase, so a NAV that jumps between quote and execution reverts at
 * the vault rather than filling at a surprise price.
 *
 * WHAT THE OPERATOR IS EXPOSED TO, knowingly: the pToken itself (a 3x perp
 * token whose issuer says it can lose its entire value, behind a beacon owned
 * today by an EOA), and NAV staleness — convertToAssets moves when Arcus's
 * manager reports, so a fast BTC move is the operator's risk, which is
 * exactly why `buy` is restricted to the one adapter: an open desk would be
 * picked off by arbitrage every time the NAV lagged, and the spread priced
 * for savings flow cannot pay for that.
 */
contract NuvemPerpDesk {
    using SafeERC20 for IERC20;

    // ── errors ───────────────────────────────────────────────────────────────

    error NotOwner(address caller);
    error NotBuyer(address caller);
    error AlreadyArmed(address buyer);
    error ZeroAddress();
    error InvalidSpread(uint16 spreadBps);
    error InvalidAmountIn();
    error NavUnavailable();
    error InsufficientInventory(uint256 requested, uint256 available);

    event Armed(address indexed buyer);
    event SharesSold(address indexed recipient, uint256 usdgIn, uint256 sharesOut);
    event InventoryWithdrawn(address indexed token, address indexed to, uint256 amount);

    // ── pinned configuration ─────────────────────────────────────────────────

    address public immutable USDG;
    address public immutable PERP_TOKEN;
    /// @dev Basis points taken off NAV on every sale. IMMUTABLE: the operator
    ///      cannot widen it later, and a different spread is a different desk.
    uint16 public immutable SPREAD_BPS;
    /// @dev Inventory operations only. Deliberately not transferable: a pilot
    ///      desk with a handover mechanism is a pilot desk with one more thing
    ///      to get wrong.
    address public immutable OWNER;

    uint16 internal constant BPS = 10_000;
    /// @dev Above this the "spread" is a confiscation. Checked at construction.
    uint16 internal constant MAX_SPREAD_BPS = 500;

    /// @dev The one address allowed to buy — the registered Nuvem adapter.
    ///      Zero until `arm`, and settable exactly once.
    address public buyer;

    constructor(address usdg, address perpToken, uint16 spreadBps) {
        if (usdg == address(0) || perpToken == address(0)) revert ZeroAddress();
        if (usdg == perpToken) revert ZeroAddress();
        if (spreadBps == 0 || spreadBps > MAX_SPREAD_BPS) revert InvalidSpread(spreadBps);
        USDG = usdg;
        PERP_TOKEN = perpToken;
        SPREAD_BPS = spreadBps;
        OWNER = msg.sender;
    }

    // ── arming, once ─────────────────────────────────────────────────────────

    /**
     * @dev ONCE, and only by the owner. The buyer is the adapter governance
     *      registered; fixing it here (rather than reading the registry) keeps
     *      the desk free of registry coupling, and once-only means a
     *      compromised owner key later cannot repoint user flow at a fake
     *      buyer — the worst it can do is drain its own inventory.
     */
    function arm(address buyer_) external {
        if (msg.sender != OWNER) revert NotOwner(msg.sender);
        if (buyer_ == address(0)) revert ZeroAddress();
        if (buyer != address(0)) revert AlreadyArmed(buyer);
        buyer = buyer_;
        emit Armed(buyer_);
    }

    // ── the market ───────────────────────────────────────────────────────────

    /**
     * @notice Shares `usdgIn` would buy right now, NAV minus the spread.
     *
     * @dev NAMED previewDeposit ON PURPOSE: it is the exact question the
     *      keeper's yield route already knows how to ask (readPreviewDeposit),
     *      so quoting this desk costs the keeper no new vocabulary. Open to
     *      anyone — a quote is not an execution.
     */
    function previewDeposit(uint256 usdgIn) public view returns (uint256 sharesOut) {
        if (usdgIn == 0) return 0;
        uint256 nav = INavSource(PERP_TOKEN).convertToAssets(1e18);
        if (nav == 0) revert NavUnavailable();
        sharesOut = (usdgIn * 1e18 * (BPS - SPREAD_BPS)) / (nav * BPS);
    }

    /**
     * @notice Sells inventory: pulls `usdgIn` from the buyer, sends the shares
     *         to `recipient`. Synchronous — the whole point.
     *
     * @dev Only the armed buyer. Inventory short? Revert with the numbers, so
     *      the keeper logs a cause the operator can act on (refill) rather
     *      than a bare failure.
     */
    function buy(uint256 usdgIn, address recipient) external returns (uint256 sharesOut) {
        if (msg.sender != buyer || buyer == address(0)) revert NotBuyer(msg.sender);
        if (recipient == address(0)) revert ZeroAddress();
        if (usdgIn == 0) revert InvalidAmountIn();

        sharesOut = previewDeposit(usdgIn);
        uint256 available = IERC20(PERP_TOKEN).balanceOf(address(this));
        if (sharesOut > available) revert InsufficientInventory(sharesOut, available);

        IERC20(USDG).safeTransferFrom(msg.sender, address(this), usdgIn);
        IERC20(PERP_TOKEN).safeTransfer(recipient, sharesOut);
        emit SharesSold(recipient, usdgIn, sharesOut);
    }

    // ── inventory operations, owner only ─────────────────────────────────────

    /**
     * @dev Refilling needs no function — inventory is `balanceOf`, and a plain
     *      transfer funds it. Withdrawing takes everything or anything: it is
     *      all the operator's own money, see the header.
     */
    function withdrawToken(address token, address to, uint256 amount) external {
        if (msg.sender != OWNER) revert NotOwner(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit InventoryWithdrawn(token, to, amount);
    }
}
