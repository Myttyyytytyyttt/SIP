// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * The INDEX adapter.
 *
 * TWO ASSERTIONS THIS FILE EXISTS FOR. First: a donation does NOT brick it —
 * the stock adapter's residue-against-zero makes one wei of WETH a permanent
 * denial of service (testASingleDonatedWeiBricksEveryPurchase proves it there),
 * and this adapter measures against entry balances precisely to close that.
 * Second: the INDEX never touches the adapter — it is taken straight to the
 * vault — because an adapter balance would enroll it in the INDEX protocol's
 * holder registry, which nobody chose.
 *
 * THE MOCK CHECKS EVERY KEY FIELD, because Uniswap does. The savings adapter's
 * suite learned this adversarially: a mock that accepts any PoolKey leaves the
 * whole route untested — six route-breaking mutations passed a permissive mock.
 * This one requires the exact pair, order, fee, tickSpacing, hook, direction
 * and price limit for BOTH hops.
 */

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {NuvemIndexAdapter} from "../../src/adapters/NuvemIndexAdapter.sol";
import {BalanceDelta, PoolKey, SwapParams} from "../../src/interfaces/IRobinhoodVenue.sol";

contract Token is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, uint8 d) ERC20(name_, name_) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockPoolManager {
    Token public weth;
    Token public usdg;
    Token public index;
    /// @dev USDG (1e6) produced per 1e18 of WETH.
    uint256 public wethRate;
    /// @dev INDEX (1e18) produced per 1e6 of USDG.
    uint256 public indexRate;
    uint24 public expectWethUsdgFee;
    int24 public expectWethUsdgTick;
    uint24 public expectUsdgIndexFee;
    int24 public expectUsdgIndexTick;

    /// @dev Consumes less WETH than offered, stranding the remainder on the
    ///      adapter — a partial fill, the case the residue check exists for.
    uint256 public underspend;
    /// @dev Sends USDG to the adapter mid-swap: a leak the delta accounting
    ///      never hears about and only the residue check can see.
    uint256 public leakToAdapter;
    address public adapterUnderTest;

    mapping(address => int256) public delta;
    address[] internal touched;
    address internal synced;
    /// @dev The manager's balance at `sync`; without it `settle` would credit
    ///      the whole balance and a second purchase double-counts the first.
    uint256 internal syncedAt;

    function configure(Token w, Token u, Token i, uint256 wr, uint256 ir) external {
        weth = w;
        usdg = u;
        index = i;
        wethRate = wr;
        indexRate = ir;
    }

    function expectPools(uint24 wuFee, int24 wuTick, uint24 uiFee, int24 uiTick) external {
        expectWethUsdgFee = wuFee;
        expectWethUsdgTick = wuTick;
        expectUsdgIndexFee = uiFee;
        expectUsdgIndexTick = uiTick;
    }

    function setUnderspend(uint256 amount) external {
        underspend = amount;
    }

    function setLeak(address adapter_, uint256 amount) external {
        adapterUnderTest = adapter_;
        leakToAdapter = amount;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        result = NuvemIndexAdapter(msg.sender).unlockCallback(data);
        for (uint256 i = 0; i < touched.length; ++i) {
            require(delta[touched[i]] == 0, "PoolManager: CurrencyNotSettled");
            delta[touched[i]] = 0;
        }
        delete touched;
    }

    function _record(address currency, int256 amount) private {
        if (delta[currency] == 0) touched.push(currency);
        delta[currency] += amount;
    }

    function _pack(int256 amount0, int256 amount1) private pure returns (BalanceDelta) {
        return BalanceDelta.wrap((amount0 << 128) | int256(uint256(uint128(uint256(amount1) & type(uint128).max))));
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external returns (BalanceDelta) {
        require(uint160(key.currency0) < uint160(key.currency1), "v4: currencies out of order");
        require(key.hooks == address(0), "v4: unexpected hook");
        require(params.sqrtPriceLimitX96 != 0, "v4: no price limit");
        uint256 offered = uint256(-params.amountSpecified);

        bool isWethHop = key.currency0 == address(weth) || key.currency1 == address(weth);
        if (isWethHop) {
            require(key.currency0 == address(weth) && key.currency1 == address(usdg), "v4: wrong pair for hop 1");
            require(key.fee == expectWethUsdgFee && key.tickSpacing == expectWethUsdgTick, "v4: wrong pool for hop 1");
            require(params.zeroForOne, "v4: wrong direction for WETH -> USDG");
            // The side check hop 2 already has: a zeroForOne swap must bound the
            // price from BELOW. Without this, MAX on hop 1 passed every test.
            require(params.sqrtPriceLimitX96 < 1e30, "v4: price limit on wrong side");
            uint256 spent = offered - underspend;
            uint256 out = (offered * wethRate) / 1e18;
            _record(address(weth), -int256(spent));
            _record(address(usdg), int256(out));
            usdg.mint(address(this), out);
            if (leakToAdapter > 0) usdg.mint(adapterUnderTest, leakToAdapter);
            return _pack(-int256(spent), int256(out));
        }

        bool usdgIsCurrency0 = uint160(address(usdg)) < uint160(address(index));
        require(
            key.currency0 == (usdgIsCurrency0 ? address(usdg) : address(index))
                && key.currency1 == (usdgIsCurrency0 ? address(index) : address(usdg)),
            "v4: wrong pair for hop 2"
        );
        require(key.fee == expectUsdgIndexFee && key.tickSpacing == expectUsdgIndexTick, "v4: wrong pool for hop 2");
        // The input currency is USDG, so the direction must sell whichever side
        // USDG sits on — and the price limit must match the direction.
        require(params.zeroForOne == usdgIsCurrency0, "v4: wrong direction for USDG -> INDEX");
        if (usdgIsCurrency0) {
            require(params.sqrtPriceLimitX96 < 1e30, "v4: price limit on wrong side");
        } else {
            require(params.sqrtPriceLimitX96 > 1e30, "v4: price limit on wrong side");
        }

        uint256 out2 = (offered * indexRate) / 1e6;
        _record(address(usdg), -int256(offered));
        _record(address(index), int256(out2));
        index.mint(address(this), out2);
        return usdgIsCurrency0 ? _pack(-int256(offered), int256(out2)) : _pack(int256(out2), -int256(offered));
    }

    function sync(address currency) external {
        synced = currency;
        syncedAt = Token(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        paid = Token(synced).balanceOf(address(this)) - syncedAt;
        _record(synced, int256(paid));
    }

    function take(address currency, address to, uint256 amount) external {
        _record(currency, -int256(amount));
        Token(currency).transfer(to, amount);
    }
}

contract NuvemIndexAdapterTest is Test {
    Token internal weth;
    Token internal usdg;
    Token internal index;
    MockPoolManager internal manager;
    NuvemIndexAdapter internal adapter;

    address internal vault = address(0xAA17);

    uint24 internal constant WETH_USDG_FEE = 200;
    int24 internal constant WETH_USDG_TICK = 4;
    uint24 internal constant USDG_INDEX_FEE = 9500;
    int24 internal constant USDG_INDEX_TICK = 190;

    /// @dev 1 WETH -> 2,500 USDG; 1 USDG -> ~39 INDEX (both in target decimals).
    uint256 internal constant WETH_RATE = 2_500e6;
    uint256 internal constant INDEX_RATE = 39e18;

    event IndexPurchased(address indexed vault, uint256 amountIn, uint256 amountOut);

    function setUp() public {
        // WETH must sort below USDG for the constructor, the same requirement
        // mainnet satisfies. Deploy until the order holds; foundry nonces make
        // this deterministic and it converges immediately in practice.
        weth = new Token("WETH", 18);
        usdg = new Token("USDG", 6);
        while (uint160(address(weth)) >= uint160(address(usdg))) {
            usdg = new Token("USDG", 6);
        }
        index = new Token("INDEX", 18);

        manager = new MockPoolManager();
        manager.configure(weth, usdg, index, WETH_RATE, INDEX_RATE);
        manager.expectPools(WETH_USDG_FEE, WETH_USDG_TICK, USDG_INDEX_FEE, USDG_INDEX_TICK);

        adapter = new NuvemIndexAdapter(
            address(weth),
            address(usdg),
            address(index),
            address(manager),
            WETH_USDG_FEE,
            WETH_USDG_TICK,
            USDG_INDEX_FEE,
            USDG_INDEX_TICK
        );

        weth.mint(vault, 100e18);
        vm.prank(vault);
        weth.approve(address(adapter), type(uint256).max);
    }

    function _buy(uint256 amountIn, uint256 minOut) internal returns (uint256) {
        vm.prank(vault);
        return adapter.executeInvestment(address(weth), address(index), amountIn, minOut, uint48(block.timestamp + 60));
    }

    // ── the happy path ───────────────────────────────────────────────────────

    function testBuysIndexStraightToTheVault() public {
        uint256 expected = (((1e18 * WETH_RATE) / 1e18) * INDEX_RATE) / 1e6;
        vm.expectEmit(true, false, false, true, address(adapter));
        emit IndexPurchased(vault, 1e18, expected);
        uint256 out = _buy(1e18, expected);

        assertEq(out, expected, "reported amount");
        assertEq(index.balanceOf(vault), expected, "INDEX lands in the vault");
        // The adapter ends the call owning nothing it did not start with —
        // and in particular ZERO INDEX, ever, or it would enroll itself in the
        // INDEX protocol's holder registry.
        assertEq(index.balanceOf(address(adapter)), 0, "adapter holds no INDEX");
        assertEq(usdg.balanceOf(address(adapter)), 0, "adapter holds no USDG");
        assertEq(weth.balanceOf(address(adapter)), 0, "adapter holds no WETH");
    }

    function testSecondPurchaseSeesNoGhostOfTheFirst() public {
        _buy(1e18, 0);
        uint256 before = index.balanceOf(vault);
        _buy(2e18, 0);
        uint256 expected2 = (((2e18 * WETH_RATE) / 1e18) * INDEX_RATE) / 1e6;
        assertEq(index.balanceOf(vault) - before, expected2, "second purchase priced on its own");
    }

    // ── the assertion this adapter exists for ────────────────────────────────

    /**
     * The stock adapter fails this exact scenario forever — one donated wei and
     * every later purchase reverts ResidualBalance, recoverable only by a
     * governance cycle. Entry-relative residue is the fix, and this is its test.
     */
    function testADonationDoesNotBrickAnything() public {
        weth.mint(address(adapter), 1); // the attack: one wei, from anyone
        usdg.mint(address(adapter), 7);
        index.mint(address(adapter), 3);

        uint256 out = _buy(1e18, 0);
        assertGt(out, 0, "purchase survives the donations");
        // The donations sit ignored, exactly where they were.
        assertEq(weth.balanceOf(address(adapter)), 1, "WETH donation untouched");
        assertEq(usdg.balanceOf(address(adapter)), 7, "USDG donation untouched");
        assertEq(index.balanceOf(address(adapter)), 3, "INDEX donation untouched");
    }

    function testALeakIsStillCaughtExactly() public {
        // Mid-swap the manager credits the adapter USDG outside the deltas —
        // the shape of a route bug. Entry-relative residue must still refuse.
        manager.setLeak(address(adapter), 5);
        vm.expectRevert(abi.encodeWithSelector(NuvemIndexAdapter.ResidualBalance.selector, address(usdg), 5));
        _buy(1e18, 0);
    }

    function testStrandedInputIsCaught() public {
        // The pool consumes less WETH than the adapter pulled from the vault;
        // the remainder would silently accumulate here. Refused.
        manager.setUnderspend(1e15);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemIndexAdapter.ResidualBalance.selector, address(weth), uint256(1e15))
        );
        _buy(1e18, 0);
    }

    // ── refusals ─────────────────────────────────────────────────────────────

    function testRefusesEveryTargetButIndex() public {
        vm.startPrank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemIndexAdapter.UnsupportedTargetAsset.selector, address(usdg)));
        adapter.executeInvestment(address(weth), address(usdg), 1e18, 0, uint48(block.timestamp + 60));
        vm.expectRevert(abi.encodeWithSelector(NuvemIndexAdapter.UnsupportedTargetAsset.selector, address(weth)));
        adapter.executeInvestment(address(weth), address(weth), 1e18, 0, uint48(block.timestamp + 60));
        vm.stopPrank();
    }

    function testRefusesWrongTokenIn() public {
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemIndexAdapter.InvalidTokenIn.selector, address(usdg)));
        adapter.executeInvestment(address(usdg), address(index), 1e6, 0, uint48(block.timestamp + 60));
    }

    function testRefusesZeroAmountAndExpiredDeadline() public {
        vm.startPrank(vault);
        vm.expectRevert(NuvemIndexAdapter.InvalidAmountIn.selector);
        adapter.executeInvestment(address(weth), address(index), 0, 0, uint48(block.timestamp + 60));
        uint48 stale = uint48(block.timestamp);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(NuvemIndexAdapter.QuoteExpired.selector, stale));
        adapter.executeInvestment(address(weth), address(index), 1e18, 0, stale);
        vm.stopPrank();
    }

    function testEnforcesTheCallersFloor() public {
        uint256 expected = (((1e18 * WETH_RATE) / 1e18) * INDEX_RATE) / 1e6;
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemIndexAdapter.InsufficientAmountOut.selector, expected + 1, expected)
        );
        adapter.executeInvestment(address(weth), address(index), 1e18, expected + 1, uint48(block.timestamp + 60));
    }

    // ── the callback door ────────────────────────────────────────────────────

    function testCallbackRefusesStrangers() public {
        vm.expectRevert(abi.encodeWithSelector(NuvemIndexAdapter.NotPoolManager.selector, address(this)));
        adapter.unlockCallback(abi.encode(uint256(1e18), vault));
    }

    function testCallbackRefusesTheManagerOutsideAnUnlock() public {
        // The manager itself, but with no executeInvestment in flight: refused,
        // or anyone who can make the manager call out could mint themselves a
        // route through this contract.
        vm.prank(address(manager));
        vm.expectRevert(NuvemIndexAdapter.UnexpectedCallback.selector);
        adapter.unlockCallback(abi.encode(uint256(1e18), vault));

        // AND THE DOOR CLOSES AGAIN AFTER A PURCHASE. Deleting the
        // `_unlocking = false` after the unlock survived the suite before this
        // half existed: the flag would stay raised forever and the manager
        // could re-enter the callback between purchases.
        _buy(1e18, 0);
        vm.prank(address(manager));
        vm.expectRevert(NuvemIndexAdapter.UnexpectedCallback.selector);
        adapter.unlockCallback(abi.encode(uint256(1e18), vault));
    }

    // ── construction ─────────────────────────────────────────────────────────

    function testConstructorRefusesBadConfigurations() public {
        // Zero addresses.
        vm.expectRevert(NuvemIndexAdapter.InvalidConfiguration.selector);
        new NuvemIndexAdapter(address(0), address(usdg), address(index), address(manager), 200, 4, 9500, 190);
        // WETH must sort strictly below USDG — an inverted pair addresses a
        // pool that cannot exist, silently.
        vm.expectRevert(NuvemIndexAdapter.InvalidConfiguration.selector);
        new NuvemIndexAdapter(address(usdg), address(weth), address(index), address(manager), 200, 4, 9500, 190);
        // INDEX must be distinct from both currencies — the degenerate key that
        // made USDG unlistable in the stock adapter.
        vm.expectRevert(NuvemIndexAdapter.InvalidConfiguration.selector);
        new NuvemIndexAdapter(address(weth), address(usdg), address(usdg), address(manager), 200, 4, 9500, 190);
        vm.expectRevert(NuvemIndexAdapter.InvalidConfiguration.selector);
        new NuvemIndexAdapter(address(weth), address(usdg), address(weth), address(manager), 200, 4, 9500, 190);
        // Tick spacings must be positive.
        vm.expectRevert(NuvemIndexAdapter.InvalidConfiguration.selector);
        new NuvemIndexAdapter(address(weth), address(usdg), address(index), address(manager), 200, 0, 9500, 190);
        vm.expectRevert(NuvemIndexAdapter.InvalidConfiguration.selector);
        new NuvemIndexAdapter(address(weth), address(usdg), address(index), address(manager), 200, 4, 9500, -190);
    }

    /**
     * Mainnet has INDEX (0x5691…) BELOW USDG (0x5fc5…), so hop 2 runs the
     * oneForZero branch there. The suite must exercise whichever branch setUp's
     * nondeterministic addresses did not, or the mainnet branch could ship
     * untested. This pins BOTH orders explicitly via deterministic addresses.
     */
    function testBothHopTwoSortOrdersSwapCorrectly() public {
        Token lowIndex = Token(address(0x1000));
        Token highIndex = Token(address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF));
        vm.etch(address(lowIndex), address(index).code);
        vm.etch(address(highIndex), address(index).code);

        Token[2] memory cases = [lowIndex, highIndex];
        for (uint256 i = 0; i < 2; ++i) {
            Token candidate = cases[i];
            manager.configure(weth, usdg, candidate, WETH_RATE, INDEX_RATE);
            NuvemIndexAdapter branchAdapter = new NuvemIndexAdapter(
                address(weth),
                address(usdg),
                address(candidate),
                address(manager),
                WETH_USDG_FEE,
                WETH_USDG_TICK,
                USDG_INDEX_FEE,
                USDG_INDEX_TICK
            );
            vm.prank(vault);
            weth.approve(address(branchAdapter), type(uint256).max);
            vm.prank(vault);
            uint256 out = branchAdapter.executeInvestment(
                address(weth), address(candidate), 1e18, 0, uint48(block.timestamp + 60)
            );
            uint256 expected = (((1e18 * WETH_RATE) / 1e18) * INDEX_RATE) / 1e6;
            assertEq(out, expected, "output priced identically on either sort order");
            assertEq(candidate.balanceOf(vault), expected, "INDEX in the vault on either sort order");
            assertEq(candidate.balanceOf(address(branchAdapter)), 0, "no INDEX on the adapter either way");
        }
        manager.configure(weth, usdg, index, WETH_RATE, INDEX_RATE);
    }

    // ── views ────────────────────────────────────────────────────────────────

    function testViewsDescribeExactlyWhatExecuteAccepts() public view {
        assertTrue(adapter.isSupported(address(index)));
        assertFalse(adapter.isSupported(address(usdg)));
        assertFalse(adapter.isSupported(address(weth)));
        (uint24 fee, int24 tick) = adapter.getIndexConfig();
        assertEq(fee, USDG_INDEX_FEE);
        assertEq(tick, USDG_INDEX_TICK);
    }
}
