// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * The desk and its adapter, together.
 *
 * THE PROPERTY THIS FILE EXISTS FOR: user money never rests in the desk and
 * user price never depends on trusting it. A vault's USDG exists inside the
 * desk only within the single buy() transaction; the shares land in the vault
 * in that same transaction; and the floor the user signed is enforced by the
 * adapter against what actually arrived. The desk's inventory and proceeds
 * are operator capital, and only operator capital.
 *
 * The mock manager keeps the strict-key discipline the adapter family's
 * suites established (pair, order, fee, tick, hook, direction, price-limit
 * side all checked), because a permissive mock tests nothing but arithmetic.
 */

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {NuvemPerpDesk} from "../../src/periphery/NuvemPerpDesk.sol";
import {NuvemPerpDeskAdapter} from "../../src/adapters/NuvemPerpDeskAdapter.sol";
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

/// An 18-decimal pToken whose NAV the test controls — the only thing the desk
/// ever asks it for.
contract MockPToken is ERC20 {
    /// @dev USDG (6 dec) per 1e18 shares.
    uint256 public nav;

    constructor(uint256 nav_) ERC20("Arcus BTC (3x Long)", "pBTC3x") {
        nav = nav_;
    }

    function setNav(uint256 nav_) external {
        nav = nav_;
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return (shares * nav) / 1e18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockPoolManager {
    Token public weth;
    Token public usdg;
    uint256 public rate;
    uint256 public underspend;
    uint256 public leakToAdapter;
    address public adapterUnderTest;
    uint24 public expectFee;
    int24 public expectTickSpacing;

    mapping(address => int256) public delta;
    address[] internal touched;
    address internal synced;
    uint256 internal syncedAt;

    function configure(Token w, Token u, uint256 r, uint24 fee, int24 ts) external {
        weth = w;
        usdg = u;
        rate = r;
        expectFee = fee;
        expectTickSpacing = ts;
    }

    function setLeak(address adapter_, uint256 amount) external {
        adapterUnderTest = adapter_;
        leakToAdapter = amount;
    }

    function setUnderspend(uint256 amount) external {
        underspend = amount;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        result = NuvemPerpDeskAdapter(msg.sender).unlockCallback(data);
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

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external returns (BalanceDelta) {
        require(uint160(key.currency0) < uint160(key.currency1), "v4: currencies out of order");
        require(key.currency0 == address(weth) && key.currency1 == address(usdg), "v4: wrong pair");
        require(key.fee == expectFee && key.tickSpacing == expectTickSpacing, "v4: wrong pool");
        require(key.hooks == address(0), "v4: unexpected hook");
        require(params.zeroForOne, "v4: wrong direction for WETH -> USDG");
        require(params.sqrtPriceLimitX96 != 0 && params.sqrtPriceLimitX96 < 1e30, "v4: price limit on wrong side");
        uint256 offered = uint256(-params.amountSpecified);
        uint256 amountIn = offered - underspend;
        uint256 out = (offered * rate) / 1e18;
        _record(address(weth), -int256(amountIn));
        _record(address(usdg), int256(out));
        usdg.mint(address(this), out);
        if (leakToAdapter > 0) usdg.mint(adapterUnderTest, leakToAdapter);
        return BalanceDelta.wrap((int256(-int256(amountIn)) << 128) | int256(uint256(uint128(uint128(out)))));
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

/// A desk that tries to come back in through the front door mid-purchase.
contract ReentrantDesk {
    address public immutable USDG;
    address public immutable PERP_TOKEN;
    address internal victim;
    address internal weth;

    constructor(address usdg_, address ptoken_) {
        USDG = usdg_;
        PERP_TOKEN = ptoken_;
    }

    function arm(address victim_, address weth_) external {
        victim = victim_;
        weth = weth_;
    }

    function previewDeposit(uint256) external pure returns (uint256) {
        return 1;
    }

    function buy(uint256, address) external returns (uint256) {
        NuvemPerpDeskAdapter(victim).executeInvestment(weth, PERP_TOKEN, 1e18, 0, uint48(block.timestamp + 60));
        return 1;
    }
}

/// A desk that pulls the adapter's WHOLE USDG balance instead of usdgIn — the
/// shape only the exact allowance can stop.
contract GreedyDesk {
    address public immutable USDG;
    address public immutable PERP_TOKEN;

    constructor(address usdg_, address ptoken_) {
        USDG = usdg_;
        PERP_TOKEN = ptoken_;
    }

    function previewDeposit(uint256 usdgIn) external pure returns (uint256) {
        return usdgIn;
    }

    function buy(uint256, address recipient) external returns (uint256) {
        uint256 grab = Token(USDG).balanceOf(msg.sender);
        Token(USDG).transferFrom(msg.sender, address(this), grab);
        MockPToken(PERP_TOKEN).mint(recipient, 1);
        return 1;
    }
}

contract NuvemPerpDeskTest is Test {
    Token internal weth;
    Token internal usdg;
    MockPToken internal ptoken;
    MockPoolManager internal manager;
    NuvemPerpDesk internal desk;
    NuvemPerpDeskAdapter internal adapter;

    address internal vault = address(0xAA17);
    address internal operator = address(this);
    address internal stranger = address(0xBEEF);

    uint24 internal constant FEE = 200;
    int24 internal constant TICK = 4;
    uint16 internal constant SPREAD = 100;
    /// @dev 1 WETH -> 2,500 USDG; NAV 175.02 USDG per 1e18 shares (the real reading).
    uint256 internal constant RATE = 2_500e6;
    uint256 internal constant NAV = 175_020_000;

    event SharesSold(address indexed recipient, uint256 usdgIn, uint256 sharesOut);
    event PerpSharesPurchased(address indexed vault, uint256 amountIn, uint256 assets, uint256 shares);

    function setUp() public {
        weth = new Token("WETH", 18);
        usdg = new Token("USDG", 6);
        while (uint160(address(weth)) >= uint160(address(usdg))) {
            usdg = new Token("USDG", 6);
        }
        ptoken = new MockPToken(NAV);

        manager = new MockPoolManager();
        manager.configure(weth, usdg, RATE, FEE, TICK);

        desk = new NuvemPerpDesk(address(usdg), address(ptoken), SPREAD);
        adapter = new NuvemPerpDeskAdapter(address(weth), address(usdg), address(desk), address(manager), FEE, TICK);
        desk.arm(address(adapter));

        // The operator's pilot inventory.
        ptoken.mint(address(desk), 100e18);

        weth.mint(vault, 100e18);
        vm.prank(vault);
        weth.approve(address(adapter), type(uint256).max);
    }

    function _expectedShares(uint256 usdgIn) internal pure returns (uint256) {
        return (usdgIn * 1e18 * (10_000 - SPREAD)) / (NAV * 10_000);
    }

    function _buy(uint256 amountIn, uint256 minOut) internal returns (uint256) {
        vm.prank(vault);
        return adapter.executeInvestment(address(weth), address(ptoken), amountIn, minOut, uint48(block.timestamp + 60));
    }

    // ── the desk alone ───────────────────────────────────────────────────────

    function testQuoteIsNavMinusTheImmutableSpread() public view {
        // 10 USDG at NAV 175.02 with 100 bps off: 10e6 * 1e18 * 9900 / (175.02e6 * 10000)
        assertEq(desk.previewDeposit(10e6), _expectedShares(10e6));
        assertEq(desk.previewDeposit(0), 0);
    }

    function testQuoteRefusesAZeroNav() public {
        ptoken.setNav(0);
        vm.expectRevert(NuvemPerpDesk.NavUnavailable.selector);
        desk.previewDeposit(1e6);
    }

    function testOnlyTheArmedBuyerCanBuy() public {
        usdg.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usdg.approve(address(desk), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDesk.NotBuyer.selector, stranger));
        desk.buy(10e6, stranger);
        vm.stopPrank();
    }

    function testArmIsOwnerOnlyAndOnce() public {
        NuvemPerpDesk fresh = new NuvemPerpDesk(address(usdg), address(ptoken), SPREAD);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDesk.NotOwner.selector, stranger));
        fresh.arm(address(adapter));
        fresh.arm(address(adapter));
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDesk.AlreadyArmed.selector, address(adapter)));
        fresh.arm(stranger);
    }

    function testInventoryOperationsAreOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDesk.NotOwner.selector, stranger));
        desk.withdrawToken(address(ptoken), stranger, 1e18);
        // The owner can pull both inventory and proceeds: all operator money.
        desk.withdrawToken(address(ptoken), operator, 1e18);
        assertEq(ptoken.balanceOf(operator), 1e18);
    }

    function testConstructorRefusesBadConfigurations() public {
        vm.expectRevert(NuvemPerpDesk.ZeroAddress.selector);
        new NuvemPerpDesk(address(0), address(ptoken), SPREAD);
        vm.expectRevert(NuvemPerpDesk.ZeroAddress.selector);
        new NuvemPerpDesk(address(usdg), address(usdg), SPREAD);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDesk.InvalidSpread.selector, uint16(0)));
        new NuvemPerpDesk(address(usdg), address(ptoken), 0);
        // Above 500 bps a "spread" is a confiscation; undeployable.
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDesk.InvalidSpread.selector, uint16(501)));
        new NuvemPerpDesk(address(usdg), address(ptoken), 501);
    }

    // ── the whole circuit: vault -> pool -> desk -> shares ───────────────────

    function testVaultBuysSharesAtomicallyFromOperatorInventory() public {
        uint256 usdgOut = (1e18 * RATE) / 1e18;
        uint256 expected = _expectedShares(usdgOut);
        uint256 inventoryBefore = ptoken.balanceOf(address(desk));

        vm.expectEmit(true, false, false, true, address(adapter));
        emit PerpSharesPurchased(vault, 1e18, usdgOut, expected);
        uint256 out = _buy(1e18, expected);

        assertEq(out, expected, "reported shares");
        assertEq(ptoken.balanceOf(vault), expected, "shares land in the vault, same tx");
        assertEq(usdg.balanceOf(address(desk)), usdgOut, "proceeds stay in the desk for the operator");
        assertEq(ptoken.balanceOf(address(desk)), inventoryBefore - expected, "inventory decremented");
        // The adapter ends the call owning nothing it did not start with.
        assertEq(ptoken.balanceOf(address(adapter)), 0, "no shares on the adapter");
        assertEq(usdg.balanceOf(address(adapter)), 0, "no USDG on the adapter");
        assertEq(weth.balanceOf(address(adapter)), 0, "no WETH on the adapter");
        assertEq(usdg.allowance(address(adapter), address(desk)), 0, "allowance zeroed");
    }

    function testAnEmptyDeskFailsClosed() public {
        desk.withdrawToken(address(ptoken), operator, ptoken.balanceOf(address(desk)));
        uint256 vaultWethBefore = weth.balanceOf(vault);
        uint256 usdgOut = (1e18 * RATE) / 1e18;
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(
                NuvemPerpDesk.InsufficientInventory.selector, _expectedShares(usdgOut), uint256(0)
            )
        );
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
        assertEq(weth.balanceOf(vault), vaultWethBefore, "the vault keeps every wei");
    }

    function testTheCallersFloorBindsAgainstWhatArrived() public {
        uint256 usdgOut = (1e18 * RATE) / 1e18;
        uint256 expected = _expectedShares(usdgOut);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemPerpDeskAdapter.InsufficientAmountOut.selector, expected + 1, expected)
        );
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, expected + 1, uint48(block.timestamp + 60));
    }

    function testADonationDoesNotBrickAnything() public {
        weth.mint(address(adapter), 1);
        usdg.mint(address(adapter), 7);
        ptoken.mint(address(adapter), 3);
        uint256 out = _buy(1e18, 0);
        assertGt(out, 0, "purchase survives the donations");
        assertEq(weth.balanceOf(address(adapter)), 1);
        assertEq(usdg.balanceOf(address(adapter)), 7);
        assertEq(ptoken.balanceOf(address(adapter)), 3);
    }

    function testALeakIsStillCaughtExactly() public {
        manager.setLeak(address(adapter), 5);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDeskAdapter.ResidualBalance.selector, address(usdg), 5));
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
    }

    function testStrandedInputIsCaught() public {
        manager.setUnderspend(1e15);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemPerpDeskAdapter.ResidualBalance.selector, address(weth), uint256(1e15))
        );
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
    }

    function testAdapterRefusalsAndTheCallbackDoor() public {
        vm.startPrank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDeskAdapter.UnsupportedTargetAsset.selector, address(usdg)));
        adapter.executeInvestment(address(weth), address(usdg), 1e18, 0, uint48(block.timestamp + 60));
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDeskAdapter.InvalidTokenIn.selector, address(usdg)));
        adapter.executeInvestment(address(usdg), address(ptoken), 1e6, 0, uint48(block.timestamp + 60));
        vm.expectRevert(NuvemPerpDeskAdapter.InvalidAmountIn.selector);
        adapter.executeInvestment(address(weth), address(ptoken), 0, 0, uint48(block.timestamp + 60));
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(NuvemPerpDeskAdapter.NotPoolManager.selector, address(this)));
        adapter.unlockCallback(abi.encode(uint256(1e18)));
        vm.prank(address(manager));
        vm.expectRevert(NuvemPerpDeskAdapter.UnexpectedCallback.selector);
        adapter.unlockCallback(abi.encode(uint256(1e18)));
        // And the door closes again after a purchase.
        _buy(1e18, 0);
        vm.prank(address(manager));
        vm.expectRevert(NuvemPerpDeskAdapter.UnexpectedCallback.selector);
        adapter.unlockCallback(abi.encode(uint256(1e18)));
    }

    function testAdapterConstructorCrossChecksTheDesk() public {
        Token otherUsdg = new Token("USDG2", 6);
        NuvemPerpDesk mismatched = new NuvemPerpDesk(address(otherUsdg), address(ptoken), SPREAD);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemPerpDeskAdapter.DeskMismatch.selector, address(usdg), address(otherUsdg))
        );
        new NuvemPerpDeskAdapter(address(weth), address(usdg), address(mismatched), address(manager), FEE, TICK);
    }

    function testAcceptsAQuoteExpiringExactlyNow() public {
        // The boundary is `>`, not `>=`: a deadline of exactly now is valid.
        vm.prank(vault);
        uint256 out =
            adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp));
        assertGt(out, 0, "a deadline of exactly now is accepted");
    }

    function testReentrancyThroughTheDeskIsRefused() public {
        ReentrantDesk evil = new ReentrantDesk(address(usdg), address(ptoken));
        NuvemPerpDeskAdapter victim =
            new NuvemPerpDeskAdapter(address(weth), address(usdg), address(evil), address(manager), FEE, TICK);
        evil.arm(address(victim), address(weth));
        vm.prank(vault);
        weth.approve(address(victim), type(uint256).max);
        vm.prank(vault);
        // TYPED, NOT BARE — the mutation lesson from the sibling suite: a bare
        // expectRevert passes with or without the guard, because the re-entrant
        // call fails on its own for unrelated reasons.
        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        victim.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
    }

    function testAGreedyDeskIsStoppedByTheExactAllowance() public {
        GreedyDesk greedy = new GreedyDesk(address(usdg), address(ptoken));
        NuvemPerpDeskAdapter victim =
            new NuvemPerpDeskAdapter(address(weth), address(usdg), address(greedy), address(manager), FEE, TICK);
        vm.prank(vault);
        weth.approve(address(victim), type(uint256).max);
        usdg.mint(address(victim), 7); // the donation the greed would sweep
        vm.prank(vault);
        // TYPED: under a mutated max approval this dies as Panic(0x11) in the
        // residue check instead — a bare expectRevert would bless both.
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC20InsufficientAllowance(address,uint256,uint256)", address(greedy), 2_500e6, 2_500e6 + 7
            )
        );
        victim.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
        assertEq(usdg.balanceOf(address(victim)), 7, "the donation was not sweepable");
    }

    function testViewsPassTheDesksQuoteThrough() public view {
        assertTrue(adapter.isSupported(address(ptoken)));
        assertFalse(adapter.isSupported(address(usdg)));
        assertEq(adapter.previewShares(10e6), desk.previewDeposit(10e6));
    }
}
