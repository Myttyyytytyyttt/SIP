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
 * @dev What this adapter needs from the desk: a quote and an execution.
 */
interface IPerpDesk {
    function USDG() external view returns (address);
    function PERP_TOKEN() external view returns (address);
    function previewDeposit(uint256 usdgIn) external view returns (uint256 sharesOut);
    function buy(uint256 usdgIn, address recipient) external returns (uint256 sharesOut);
}

/**
 * @title NuvemPerpDeskAdapter
 * @notice Buys ONE Arcus pToken with a vault's WETH: WETH -> USDG in one v4
 *         unlock, then a synchronous purchase from NuvemPerpDesk's operator
 *         inventory, shares delivered straight to the vault.
 *
 * THE TWIN OF NuvemPerpTokenAdapter, AND WHY BOTH EXIST. That adapter calls
 * the pToken's own deposit() and arms itself the day Arcus opens synchronous
 * deposits. This one buys from the Nuvem-operated desk — the bridge that works
 * TODAY, because the desk's inventory is refilled by a human through Arcus's
 * off-chain RFQ while vaults buy from it atomically. When Arcus opens
 * deposits, governance registers the other adapter, admins re-sign, and the
 * desk retires. Same event shape on both, so "how much user money went into
 * Arcus pTokens" stays one filter across the transition.
 *
 * WHAT THE HOLDER IS EXPOSED TO: everything the desk's and the perp-token
 * adapter's headers say — a 3x token that can go to ~zero, behind a beacon
 * owned today by an EOA. The desk changes WHERE the purchase happens, not what
 * is being bought. The listing copy owes the user that sentence.
 *
 * PRICE SAFETY DOES NOT COME FROM TRUSTING THE DESK. The desk's price is
 * pinned to the pToken's own convertToAssets minus an immutable spread, but
 * this adapter does not rely on that: `minAmountOut` — the higher of the vault
 * admin's hash-bound floor and the keeper's per-call quote — is enforced here
 * against the shares that actually arrived, the same as every adapter.
 *
 * NO OWNER, NO SETTERS, NO PAUSE — the family discipline.
 */
contract NuvemPerpDeskAdapter is IInvestmentAdapter, IUnlockCallback, ReentrancyGuard {
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
    error DeskMismatch(address expected, address actual);

    /// @dev Same event signature as NuvemPerpTokenAdapter, deliberately — one
    ///      indexer filter covers the desk era and the direct-deposit era.
    event PerpSharesPurchased(address indexed vault, uint256 amountIn, uint256 assets, uint256 shares);

    // ── pinned configuration ─────────────────────────────────────────────────

    address public immutable WETH;
    address public immutable USDG;
    address public immutable PERP_TOKEN;
    IPerpDesk public immutable DESK;
    IPoolManager public immutable POOL_MANAGER;
    uint24 public immutable WETH_USDG_FEE;
    int24 public immutable WETH_USDG_TICK_SPACING;

    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128740;

    bool private _unlocking;

    constructor(address weth, address usdg, address desk, address poolManager, uint24 fee, int24 tickSpacing) {
        if (weth == address(0) || usdg == address(0) || desk == address(0) || poolManager == address(0)) {
            revert InvalidConfiguration();
        }
        if (uint160(weth) >= uint160(usdg)) revert InvalidConfiguration();
        if (tickSpacing <= 0) revert InvalidConfiguration();

        // THE PAIRING IS READ FROM THE DESK, NOT TYPED TWICE. The desk already
        // pins its USDG and its pToken; asking it removes the one chance for
        // this deployment to disagree with the counter it buys from.
        address deskUsdg = IPerpDesk(desk).USDG();
        if (deskUsdg != usdg) revert DeskMismatch(usdg, deskUsdg);
        address perpToken = IPerpDesk(desk).PERP_TOKEN();
        if (perpToken == weth || perpToken == usdg) revert InvalidConfiguration();

        WETH = weth;
        USDG = usdg;
        PERP_TOKEN = perpToken;
        DESK = IPerpDesk(desk);
        POOL_MANAGER = IPoolManager(poolManager);
        WETH_USDG_FEE = fee;
        WETH_USDG_TICK_SPACING = tickSpacing;
    }

    /// @inheritdoc IInvestmentAdapter
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

        // Entry-relative, the anti-brick rule the whole family follows.
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));
        uint256 usdgBefore = IERC20(USDG).balanceOf(address(this));
        uint256 sharesBefore = IERC20(PERP_TOKEN).balanceOf(address(this));

        IERC20(WETH).safeTransferFrom(vault, address(this), amountIn);

        _unlocking = true;
        uint256 usdgOut = abi.decode(POOL_MANAGER.unlock(abi.encode(amountIn)), (uint256));
        _unlocking = false;

        // Shares go straight to the vault; the allowance is zeroed after even
        // though buy() pulls exactly — a desk that ever took less would
        // otherwise leave a standing allowance on a contract nobody watches.
        IERC20(USDG).forceApprove(address(DESK), usdgOut);
        amountOut = DESK.buy(usdgOut, vault);
        IERC20(USDG).forceApprove(address(DESK), 0);

        _assertNothingStuck(PERP_TOKEN, sharesBefore);
        _assertNothingStuck(USDG, usdgBefore);
        _assertNothingStuck(WETH, wethBefore);

        // THE ONLY PRICE CHECK, AND IT IS THE CALLER'S. Floor is in shares.
        if (amountOut < minAmountOut) revert InsufficientAmountOut(minAmountOut, amountOut);

        emit PerpSharesPurchased(vault, amountIn, usdgOut, amountOut);
    }

    /// @dev One hop, USDG taken to this contract for the desk purchase that follows.
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

    /// @dev The desk's own quote, passed through: NAV minus its immutable
    ///      spread. Advisory, never a gate in the money path.
    function previewShares(uint256 assets) external view returns (uint256 shares) {
        return DESK.previewDeposit(assets);
    }

    function _assertNothingStuck(address token, uint256 expected) private view {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance != expected) revert ResidualBalance(token, balance - expected);
    }
}
