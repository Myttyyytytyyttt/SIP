// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * The perp-token adapter (Arcus pTokens).
 *
 * THE ASSERTION THIS FILE EXISTS FOR: while the pToken's deposits are gated or
 * asynchronous — which is what Arcus does TODAY — every purchase reverts and no
 * money moves. The adapter is synchronous-or-nothing by design, because the
 * vault measures its own balance delta in the same transaction, and a "deposit
 * now, receive when the operator's bot passes" would end the call with zero
 * received and the user's signed floor enforced against nothing.
 *
 * Everything else is the discipline the other adapters' suites established:
 * entry-relative residue (a donation does not brick), exact leak detection, a
 * strict mock that checks every PoolKey field including the price-limit side,
 * and a callback door that closes again after each purchase.
 */

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {NuvemPerpTokenAdapter} from "../../src/adapters/NuvemPerpTokenAdapter.sol";
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
    /// @dev USDG (1e6) produced per 1e18 of WETH.
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
        result = NuvemPerpTokenAdapter(msg.sender).unlockCallback(data);
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

    /// @dev CHECKS THE KEY, BECAUSE UNISWAP DOES — including the price-limit
    ///      side, the field an adversarial pass on the savings suite showed a
    ///      permissive mock leaves completely untested.
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

/**
 * A pToken with the shape Arcus shows on chain: 18-decimal shares over 6-decimal
 * USDG, previewDeposit and deposit both GATEABLE — because that is today's
 * reality (previewDeposit reverts, deposits settle asynchronously via the
 * operator), and the adapter's whole posture is failing closed against it.
 */
contract MockPerpToken is ERC20 {
    address public immutable assetToken;
    /// @dev Assets per 1e18 shares, in USDG's 6 decimals (the NAV).
    uint256 public price;
    /// @dev Today's Arcus: sync entry points revert with a custom error.
    bool public depositsClosed;
    /// @dev Mints to the CALLER instead of the receiver — shares stranded on
    ///      the adapter, the leak its residue check must catch.
    bool public mintToSender;
    /// @dev Consumes less USDG than approved — the standing-allowance case.
    bool public partialConsume;

    error DepositsClosed();

    constructor(address asset_, uint256 price_) ERC20("Arcus HOOD (3x Long)", "pHOOD3x") {
        assetToken = asset_;
        price = price_;
    }

    function setDepositsClosed(bool on) external {
        depositsClosed = on;
    }

    function setMintToSender(bool on) external {
        mintToSender = on;
    }

    function setPartialConsume(bool on) external {
        partialConsume = on;
    }

    /// @dev For donation tests only — anyone can gift shares to any address.
    function donate(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function asset() external view returns (address) {
        return assetToken;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        if (depositsClosed) revert DepositsClosed();
        return (assets * 1e18) / price;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (depositsClosed) revert DepositsClosed();
        uint256 taken = partialConsume ? assets / 2 : assets;
        Token(assetToken).transferFrom(msg.sender, address(this), taken);
        shares = (taken * 1e18) / price;
        _mint(mintToSender ? msg.sender : receiver, shares);
    }
}

/// A destination that pulls the adapter's WHOLE balance instead of what it was
/// offered — the shape only an exact allowance can stop.
contract GreedyPerpToken is ERC20 {
    address public immutable assetToken;
    uint256 public price;

    constructor(address asset_, uint256 price_) ERC20("Greedy", "GREED") {
        assetToken = asset_;
        price = price_;
    }

    function asset() external view returns (address) {
        return assetToken;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / price;
    }

    function deposit(uint256, address receiver) external returns (uint256 shares) {
        uint256 grab = Token(assetToken).balanceOf(msg.sender);
        Token(assetToken).transferFrom(msg.sender, address(this), grab);
        shares = (grab * 1e18) / price;
        _mint(receiver, shares);
    }
}

/// A destination that tries to come back in through the front door.
contract ReentrantPerpToken is ERC20 {
    address public immutable assetToken;
    uint256 public price;
    address internal victim;
    address internal weth;

    constructor(address asset_, uint256 price_) ERC20("Evil", "EVIL") {
        assetToken = asset_;
        price = price_;
    }

    function arm(address victim_, address weth_) external {
        victim = victim_;
        weth = weth_;
    }

    function asset() external view returns (address) {
        return assetToken;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / price;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        Token(assetToken).transferFrom(msg.sender, address(this), assets);
        shares = (assets * 1e18) / price;
        _mint(receiver, shares);
        NuvemPerpTokenAdapter(victim).executeInvestment(weth, address(this), 1e18, 0, uint48(block.timestamp + 60));
    }
}

contract NuvemPerpTokenAdapterTest is Test {
    Token internal weth;
    Token internal usdg;
    MockPoolManager internal manager;
    MockPerpToken internal ptoken;
    NuvemPerpTokenAdapter internal adapter;

    address internal vault = address(0xAA17);

    uint24 internal constant FEE = 200;
    int24 internal constant TICK = 4;
    /// @dev 1 WETH -> 2,500 USDG.
    uint256 internal constant RATE = 2_500e6;
    /// @dev NAV: 147.787625 USDG per 1e18 shares (pHOOD3x's real reading).
    uint256 internal constant NAV = 147_787_625;

    event PerpSharesPurchased(address indexed vault, uint256 amountIn, uint256 assets, uint256 shares);

    function setUp() public {
        weth = new Token("WETH", 18);
        usdg = new Token("USDG", 6);
        while (uint160(address(weth)) >= uint160(address(usdg))) {
            usdg = new Token("USDG", 6);
        }

        manager = new MockPoolManager();
        manager.configure(weth, usdg, RATE, FEE, TICK);
        ptoken = new MockPerpToken(address(usdg), NAV);

        adapter = new NuvemPerpTokenAdapter(
            address(weth), address(usdg), address(ptoken), address(manager), FEE, TICK
        );

        weth.mint(vault, 100e18);
        vm.prank(vault);
        weth.approve(address(adapter), type(uint256).max);
    }

    function _buy(uint256 amountIn, uint256 minOut) internal returns (uint256) {
        vm.prank(vault);
        return adapter.executeInvestment(address(weth), address(ptoken), amountIn, minOut, uint48(block.timestamp + 60));
    }

    function _expectedShares(uint256 amountIn) internal pure returns (uint256) {
        return (((amountIn * RATE) / 1e18) * 1e18) / NAV;
    }

    // ── the assertion this adapter exists for ────────────────────────────────

    /**
     * Today's Arcus: deposits gated, settled asynchronously by their operator.
     * The purchase must revert INSIDE deposit() — fail closed, no money moved,
     * nothing stranded — not succeed with zero received.
     */
    function testTodaysArcusIsRefusedOutright() public {
        ptoken.setDepositsClosed(true);
        uint256 vaultWethBefore = weth.balanceOf(vault);
        vm.prank(vault);
        vm.expectRevert(MockPerpToken.DepositsClosed.selector);
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
        assertEq(weth.balanceOf(vault), vaultWethBefore, "the vault keeps every wei");
        assertEq(usdg.balanceOf(address(adapter)), 0, "no USDG stranded on the adapter");
        assertEq(ptoken.balanceOf(vault), 0, "no phantom shares");
    }

    // ── the happy path, for the day Arcus opens deposits ─────────────────────

    function testBuysSharesStraightToTheVault() public {
        uint256 expected = _expectedShares(1e18);
        vm.expectEmit(true, false, false, true, address(adapter));
        emit PerpSharesPurchased(vault, 1e18, 2_500e6, expected);
        uint256 out = _buy(1e18, expected);

        assertEq(out, expected, "reported shares");
        assertEq(ptoken.balanceOf(vault), expected, "shares land in the vault");
        assertEq(ptoken.balanceOf(address(adapter)), 0, "no shares on the adapter");
        assertEq(usdg.balanceOf(address(adapter)), 0, "no USDG on the adapter");
        assertEq(weth.balanceOf(address(adapter)), 0, "no WETH on the adapter");
        assertEq(usdg.allowance(address(adapter), address(ptoken)), 0, "allowance zeroed");
    }

    function testPartialConsumeLeavesNoStandingAllowanceAndIsCaught() public {
        // The pToken takes half the offered USDG. The unspent half sits on the
        // adapter — a residual the entry-relative check must refuse — and
        // whatever happens, no allowance may survive the call.
        ptoken.setPartialConsume(true);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemPerpTokenAdapter.ResidualBalance.selector, address(usdg), uint256(1_250e6))
        );
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
    }

    // ── residue: donations survive, leaks do not ─────────────────────────────

    function testADonationDoesNotBrickAnything() public {
        weth.mint(address(adapter), 1);
        usdg.mint(address(adapter), 7);
        ptoken.donate(address(adapter), 3);

        uint256 out = _buy(1e18, 0);
        assertGt(out, 0, "purchase survives the donations");
        assertEq(weth.balanceOf(address(adapter)), 1, "WETH donation untouched");
        assertEq(usdg.balanceOf(address(adapter)), 7, "USDG donation untouched");
        assertEq(ptoken.balanceOf(address(adapter)), 3, "share donation untouched");
    }

    function testALeakIsStillCaughtExactly() public {
        manager.setLeak(address(adapter), 5);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpTokenAdapter.ResidualBalance.selector, address(usdg), 5));
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
    }

    function testSharesStrandedOnTheAdapterAreCaught() public {
        // The pToken mints to the caller instead of the receiver: an Arcus
        // position resting on the adapter, which nobody chose. Refused.
        ptoken.setMintToSender(true);
        uint256 expected = _expectedShares(1e18);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemPerpTokenAdapter.ResidualBalance.selector, address(ptoken), expected)
        );
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
    }

    function testStrandedInputIsCaught() public {
        manager.setUnderspend(1e15);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemPerpTokenAdapter.ResidualBalance.selector, address(weth), uint256(1e15))
        );
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp + 60));
    }

    // ── refusals ─────────────────────────────────────────────────────────────

    function testRefusesEveryTargetButThePerpToken() public {
        vm.startPrank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpTokenAdapter.UnsupportedTargetAsset.selector, address(usdg)));
        adapter.executeInvestment(address(weth), address(usdg), 1e18, 0, uint48(block.timestamp + 60));
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpTokenAdapter.UnsupportedTargetAsset.selector, address(weth)));
        adapter.executeInvestment(address(weth), address(weth), 1e18, 0, uint48(block.timestamp + 60));
        vm.stopPrank();
    }

    function testRefusesWrongTokenInZeroAmountAndExpiredDeadline() public {
        vm.startPrank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpTokenAdapter.InvalidTokenIn.selector, address(usdg)));
        adapter.executeInvestment(address(usdg), address(ptoken), 1e6, 0, uint48(block.timestamp + 60));
        vm.expectRevert(NuvemPerpTokenAdapter.InvalidAmountIn.selector);
        adapter.executeInvestment(address(weth), address(ptoken), 0, 0, uint48(block.timestamp + 60));
        uint48 stale = uint48(block.timestamp);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpTokenAdapter.QuoteExpired.selector, stale));
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, stale);
        vm.stopPrank();
    }

    function testEnforcesTheCallersFloorInShares() public {
        uint256 expected = _expectedShares(1e18);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemPerpTokenAdapter.InsufficientAmountOut.selector, expected + 1, expected)
        );
        adapter.executeInvestment(address(weth), address(ptoken), 1e18, expected + 1, uint48(block.timestamp + 60));
    }

    // ── the callback door ────────────────────────────────────────────────────

    function testCallbackRefusesStrangersAndClosesAfterAPurchase() public {
        vm.expectRevert(abi.encodeWithSelector(NuvemPerpTokenAdapter.NotPoolManager.selector, address(this)));
        adapter.unlockCallback(abi.encode(uint256(1e18)));

        vm.prank(address(manager));
        vm.expectRevert(NuvemPerpTokenAdapter.UnexpectedCallback.selector);
        adapter.unlockCallback(abi.encode(uint256(1e18)));

        // And the door closes again after a successful purchase — the flag
        // lowering a suite once left untested until a mutation pass caught it.
        _buy(1e18, 0);
        vm.prank(address(manager));
        vm.expectRevert(NuvemPerpTokenAdapter.UnexpectedCallback.selector);
        adapter.unlockCallback(abi.encode(uint256(1e18)));
    }

    function testReentrancyThroughTheDestinationIsRefused() public {
        ReentrantPerpToken evil = new ReentrantPerpToken(address(usdg), NAV);
        NuvemPerpTokenAdapter victim =
            new NuvemPerpTokenAdapter(address(weth), address(usdg), address(evil), address(manager), FEE, TICK);
        evil.arm(address(victim), address(weth));
        vm.prank(vault);
        weth.approve(address(victim), type(uint256).max);
        vm.prank(vault);
        // TYPED, NOT BARE. A bare expectRevert passes with or without the
        // guard, because the re-entrant call fails on its own (no WETH, no
        // approval) — a mutation pass proved deleting nonReentrant left the
        // suite green under the bare form. Only the guard's own error will do.
        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        victim.executeInvestment(address(weth), address(evil), 1e18, 0, uint48(block.timestamp + 60));
    }

    /**
     * A pToken that pulls the adapter's ENTIRE USDG balance instead of the
     * `assets` it was offered. Under the exact approval this is blocked by the
     * allowance itself with a typed error; under a mutated max approval it
     * would over-pull donated USDG and die as a Panic in the residue check.
     * This test is what pins the approval to exactly usdgOut.
     */
    function testAGreedyDestinationIsStoppedByTheExactAllowance() public {
        GreedyPerpToken greedy = new GreedyPerpToken(address(usdg), NAV);
        NuvemPerpTokenAdapter victim =
            new NuvemPerpTokenAdapter(address(weth), address(usdg), address(greedy), address(manager), FEE, TICK);
        vm.prank(vault);
        weth.approve(address(victim), type(uint256).max);
        usdg.mint(address(victim), 7); // the donation the greed would sweep
        vm.prank(vault);
        // TYPED: under a mutated max approval this scenario dies as Panic(0x11)
        // in the residue check instead — a bare expectRevert would bless both.
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC20InsufficientAllowance(address,uint256,uint256)", address(greedy), 2_500e6, 2_500e6 + 7
            )
        );
        victim.executeInvestment(address(weth), address(greedy), 1e18, 0, uint48(block.timestamp + 60));
        // The donation survives, unswept.
        assertEq(usdg.balanceOf(address(victim)), 7, "the donation was not sweepable");
    }

    function testAcceptsAQuoteExpiringExactlyNow() public {
        // The boundary is `>`, not `>=`: a deadline of exactly now is valid.
        vm.prank(vault);
        uint256 out =
            adapter.executeInvestment(address(weth), address(ptoken), 1e18, 0, uint48(block.timestamp));
        assertGt(out, 0, "a deadline of exactly now is accepted");
    }

    // ── construction ─────────────────────────────────────────────────────────

    function testConstructorRefusesBadConfigurations() public {
        vm.expectRevert(NuvemPerpTokenAdapter.InvalidConfiguration.selector);
        new NuvemPerpTokenAdapter(address(0), address(usdg), address(ptoken), address(manager), FEE, TICK);
        vm.expectRevert(NuvemPerpTokenAdapter.InvalidConfiguration.selector);
        new NuvemPerpTokenAdapter(address(usdg), address(weth), address(ptoken), address(manager), FEE, TICK);
        vm.expectRevert(NuvemPerpTokenAdapter.InvalidConfiguration.selector);
        new NuvemPerpTokenAdapter(address(weth), address(usdg), address(usdg), address(manager), FEE, TICK);
        // BOTH halves of the aliasing check — a mutation pass showed the WETH
        // half could be dropped with the suite still green.
        vm.expectRevert(NuvemPerpTokenAdapter.InvalidConfiguration.selector);
        new NuvemPerpTokenAdapter(address(weth), address(usdg), address(weth), address(manager), FEE, TICK);
        vm.expectRevert(NuvemPerpTokenAdapter.InvalidConfiguration.selector);
        new NuvemPerpTokenAdapter(address(weth), address(usdg), address(ptoken), address(manager), FEE, 0);
        // The pairing is checked, not trusted: a destination over the wrong
        // asset is undeployable.
        Token notUsdg = new Token("DAI", 18);
        MockPerpToken wrongAsset = new MockPerpToken(address(notUsdg), NAV);
        vm.expectRevert(
            abi.encodeWithSelector(
                NuvemPerpTokenAdapter.PerpVaultAssetMismatch.selector, address(usdg), address(notUsdg)
            )
        );
        new NuvemPerpTokenAdapter(address(weth), address(usdg), address(wrongAsset), address(manager), FEE, TICK);
    }

    // ── views ────────────────────────────────────────────────────────────────

    function testViewsDescribeExactlyWhatExecuteAccepts() public {
        assertTrue(adapter.isSupported(address(ptoken)));
        assertFalse(adapter.isSupported(address(usdg)));
        assertEq(adapter.previewShares(1e6), (uint256(1e6) * 1e18) / NAV);
        // And on today's Arcus the preview REVERTS — callers must read that as
        // "closed, defer", and the deploy script reads it as "do not deploy".
        ptoken.setDepositsClosed(true);
        vm.expectRevert(MockPerpToken.DepositsClosed.selector);
        adapter.previewShares(1e6);
    }
}
