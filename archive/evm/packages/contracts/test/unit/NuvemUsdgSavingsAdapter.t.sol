// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * The dollar-savings adapter.
 *
 * THE ASSERTION THIS FILE EXISTS FOR is that the adapter's own USDG balance is
 * zero after every call, including the ones that fail. The whole reason this is
 * a separate contract from the stock adapter is that a vault saving in dollars
 * has to HOLD dollars, and USDG can be frozen and wiped by an EOA with no
 * timelock. The vault carries that because its admin chose it; the adapter must
 * not carry it for a single statement, because nobody chose that.
 *
 * The mock manager tracks per-currency deltas and refuses to close `unlock`
 * unless they net to zero, which is what the real PoolManager does. Without it
 * a route that quietly left a debt would pass.
 */

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {NuvemUsdgSavingsAdapter} from "../../src/adapters/NuvemUsdgSavingsAdapter.sol";
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
    /// @dev Credits the adapter MORE USDG than it takes to the vault, which is
    ///      the only way a residual balance could appear on the adapter at all.
    uint256 public overCredit;
    uint256 public underspend;
    /// @dev Sends USDG to the adapter mid-swap: a leak the residue check must see.
    uint256 public leakToAdapter;
    address public adapterUnderTest;
    uint24 public expectFee;
    int24 public expectTickSpacing;

    mapping(address => int256) public delta;
    address[] internal touched;
    address internal synced;
    /// @dev The manager's balance at `sync`. Without this, `settle` credits the
    ///      manager's WHOLE balance and a second purchase double-counts the
    ///      first one's WETH — the mock reporting a settled route as unsettled.
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

    function setRate(uint256 r) external {
        rate = r;
    }

    function setOverCredit(uint256 amount) external {
        overCredit = amount;
    }

    /// @dev Consumes less WETH than offered, stranding the remainder on the
    ///      adapter — a partial fill, and the case the residue check exists for.
    function setUnderspend(uint256 amount) external {
        underspend = amount;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        result = NuvemUsdgSavingsAdapter(msg.sender).unlockCallback(data);
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

    /**
     * CHECKS THE KEY, BECAUSE UNISWAP DOES.
     *
     * This took the PoolKey as an UNNAMED parameter and never read
     * params.zeroForOne either, so nothing about the route was under test: an
     * adversarial review mutated the adapter six ways — currency0/currency1
     * inverted, zeroForOne false, fee 0, tickSpacing 1, a non-zero hooks
     * address, sqrtPriceLimitX96 0 — and all six left the suite 27/27 green.
     * The first of those would revert every purchase on the real chain, because
     * v4 requires a strictly ordered key and an inverted one addresses a pool
     * that cannot exist. A mock that accepts any key tests nothing but
     * arithmetic.
     */
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external returns (BalanceDelta) {
        require(uint160(key.currency0) < uint160(key.currency1), "v4: currencies out of order");
        require(key.currency0 == address(weth) && key.currency1 == address(usdg), "v4: wrong pair");
        require(key.fee == expectFee && key.tickSpacing == expectTickSpacing, "v4: wrong pool");
        require(key.hooks == address(0), "v4: unexpected hook");
        require(params.zeroForOne, "v4: wrong direction for WETH -> USDG");
        require(params.sqrtPriceLimitX96 != 0, "v4: no price limit");
        uint256 offered = uint256(-params.amountSpecified);
        uint256 amountIn = offered - underspend;
        uint256 out = (amountIn * rate) / 1e18 + overCredit;
        _record(address(weth), -int256(amountIn));
        _record(address(usdg), int256(out));
        usdg.mint(address(this), out);
        // Straight to the adapter, OUTSIDE the delta accounting — the shape of a
        // leak the manager never hears about and only the residue check can.
        if (leakToAdapter > 0) usdg.mint(adapterUnderTest, leakToAdapter);
        // currency0 = WETH (owed by us), currency1 = USDG (owed to us).
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
 * A 4626 with the shape that matters: SHARES IN 18 DECIMALS OVER AN ASSET IN 6.
 *
 * steakUSDG is exactly this — decimals() 18, asset() USDG at 6 — and the gap is
 * a factor of 1e12 that has already produced one wrong answer in this project
 * (a convertToAssets(1e6) that returned zero and read as "no yield"). A mock
 * with matching decimals would test a world that does not exist.
 */
contract MockYieldVault is ERC20 {
    address public immutable assetToken;
    /// @dev Assets per 1e18 shares, in the asset's own decimals.
    uint256 public price;
    /// @dev Every USDG vault on Robinhood Chain answers maxDeposit 0 today.
    ///      A mock that always accepts tests a state none of them are in.
    uint256 public cap = type(uint256).max;

    constructor(address asset_, uint256 price_) ERC20("Steakhouse USDG", "steakUSDG") {
        assetToken = asset_;
        price = price_;
    }

    function setCap(uint256 c) external {
        cap = c;
    }

    /// @dev Mints to the CALLER instead of the receiver — shares stranded on the adapter.
    bool public mintToSender;

    function setMintToSender(bool on) external {
        mintToSender = on;
    }

    function maxDeposit(address) external view returns (uint256) {
        return cap;
    }

    function asset() external view returns (address) {
        return assetToken;
    }

    function setPrice(uint256 p) external {
        price = p;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return (shares * price) / 1e18;
    }

    /// @dev The same arithmetic `deposit` uses, which is what EIP-4626 demands
    ///      of it: never a promise larger than the deposit delivers.
    function previewDeposit(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / price;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(assets <= cap, "vault: AllCapsReached");
        Token(assetToken).transferFrom(msg.sender, address(this), assets);
        shares = (assets * 1e18) / price;
        _mint(mintToSender ? msg.sender : receiver, shares);
    }
}

/// A destination that tries to come back in through the front door.
contract ReentrantYieldVault is ERC20 {
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
        // Straight back in, mid-call.
        NuvemUsdgSavingsAdapter(victim).executeInvestment(weth, address(this), 1e18, 0, uint48(block.timestamp + 60));
    }
}

contract NuvemUsdgSavingsAdapterTest is Test {
    Token internal weth;
    Token internal usdg;
    MockPoolManager internal manager;
    MockYieldVault internal yieldVault;
    NuvemUsdgSavingsAdapter internal adapter;

    address internal vault = address(0xAA17);

    uint24 internal constant FEE = 200;
    int24 internal constant TICK_SPACING = 4;
    /// 2,500 USDG per ETH, in USDG's own six decimals.
    uint256 internal constant RATE = 2_500e6;
    /// steakUSDG's real share price, read on chain: 1e18 shares = 1.005290 USDG.
    uint256 internal constant SHARE_PRICE = 1_005_290;

    function setUp() external {
        // The sort order the constructor demands is a property of the
        // ADDRESSES, so they are mined rather than assumed.
        uint256 salt;
        while (true) {
            Token a = new Token{salt: bytes32(salt)}("WETH", 18);
            Token b = new Token{salt: bytes32(salt + 1)}("USDG", 6);
            if (uint160(address(a)) < uint160(address(b))) {
                weth = a;
                usdg = b;
                break;
            }
            salt += 2;
        }

        manager = new MockPoolManager();
        manager.configure(weth, usdg, RATE, FEE, TICK_SPACING);
        yieldVault = new MockYieldVault(address(usdg), SHARE_PRICE);
        adapter =
            new NuvemUsdgSavingsAdapter(address(weth), address(usdg), address(manager), FEE, TICK_SPACING, address(yieldVault));

        weth.mint(vault, 100e18);
        vm.prank(vault);
        weth.approve(address(adapter), type(uint256).max);
    }

    function _buy(uint256 amountIn, uint256 minOut) internal returns (uint256) {
        vm.prank(vault);
        return adapter.executeInvestment(address(weth), address(usdg), amountIn, minOut, uint48(block.timestamp + 60));
    }

    // ── the happy path, and what it must leave behind ────────────────────────

    function test_buysUsdgAndSendsItStraightToTheVault() external {
        uint256 out = _buy(1e18, 0);
        assertEq(out, RATE, "one ether buys the quoted dollars");
        assertEq(usdg.balanceOf(vault), RATE, "the vault holds them");
        assertEq(weth.balanceOf(vault), 99e18, "and paid for them");
    }

    /// THE ONE THIS FILE IS FOR. Nothing may be left on the adapter.
    function test_theAdapterHoldsNothingAfterwards() external {
        _buy(1e18, 0);
        assertEq(usdg.balanceOf(address(adapter)), 0, "no USDG may sit here, ever");
        assertEq(weth.balanceOf(address(adapter)), 0, "nor any WETH");
    }

    /// The residue check is not decoration: a partial fill must be refused.
    function test_refusesToFinishWithThisCallsWethStrandedOnIt() external {
        // The pool consumes less than was offered, so the remainder sits here.
        // Letting that through would return a vault less than it paid for and
        // leave the difference on a contract with no way to move it.
        manager.setUnderspend(1e15);
        vm.prank(vault);
        vm.expectRevert();
        adapter.executeInvestment(address(weth), address(usdg), 1e18, 0, uint48(block.timestamp + 60));
    }

    /**
     * THE GRIEFING ATTACK THIS ADAPTER DOES NOT INHERIT.
     *
     * NuvemStockAdapter asserts its balance is exactly ZERO after every purchase
     * and has no owner, no setter and no sweep — so one wei sent to it stops
     * every stock purchase for every vault pointed at it, permanently, and only
     * governance registering a replacement recovers it. The cost of that attack
     * is a transfer.
     *
     * Here the check is against the balance ON ENTRY, so a donation is ignored
     * and a leak is still caught exactly. Both donated tokens are tried, because
     * the stock adapter asserts on both.
     */
    function test_aDonationDoesNotBrickIt() external {
        usdg.mint(address(adapter), 1);
        weth.mint(address(adapter), 1);

        uint256 out = _buy(1e18, 0);

        assertEq(out, RATE, "the purchase went through anyway");
        assertEq(usdg.balanceOf(vault), RATE, "and the vault got all of it");
        assertEq(usdg.balanceOf(address(adapter)), 1, "the donation is still sitting there, untouched");
        assertEq(weth.balanceOf(address(adapter)), 1, "so is the other one");
    }

    /// A donation must not mask a real leak either.
    function test_stillCatchesALeakOnTopOfADonation() external {
        usdg.mint(address(adapter), 5);
        weth.mint(address(adapter), 5);
        manager.setUnderspend(1e15);
        vm.prank(vault);
        vm.expectRevert();
        adapter.executeInvestment(address(weth), address(usdg), 1e18, 0, uint48(block.timestamp + 60));
    }

    function test_leavesNoAllowanceOrDustAcrossTwoPurchases() external {
        _buy(1e18, 0);
        _buy(2e18, 0);
        assertEq(usdg.balanceOf(vault), 3 * RATE, "both landed");
        assertEq(usdg.balanceOf(address(adapter)), 0, "and nothing accumulated");
    }

    // ── the yield route ──────────────────────────────────────────────────────

    function _deposit(uint256 amountIn, uint256 minShares) internal returns (uint256) {
        vm.prank(vault);
        return adapter.executeInvestment(
            address(weth), address(yieldVault), amountIn, minShares, uint48(block.timestamp + 60)
        );
    }

    /**
     * THE 1e12 THAT ALREADY FOOLED SOMEONE. USDG has 6 decimals, the shares 18.
     * One ether buys 2,500 USDG, which at a share price of 1.005290 is about
     * 2,486.8 shares — and a share count is roughly 1e12 TIMES the raw asset
     * number, so an implementation that mixed the two would be wrong by a factor
     * nobody would mistake for slippage.
     */
    function test_depositsIntoTheYieldVaultAndTheSharesLandOnTheVault() external {
        uint256 shares = _deposit(1e18, 0);

        uint256 expected = (RATE * 1e18) / SHARE_PRICE;
        assertEq(shares, expected, "shares are assets scaled by the share price, not by 1");
        assertEq(yieldVault.balanceOf(vault), shares, "and they belong to the vault");
        assertEq(yieldVault.convertToAssets(shares), RATE - 1, "worth what went in, less rounding");
        // A share count near 2.48e21 against an asset number near 2.5e9.
        assertGt(shares, 2_400e18, "sanity: the share count is in 18-decimal territory");
    }

    function test_theAdapterKeepsNeitherDollarsNorShares() external {
        _deposit(1e18, 0);
        assertEq(usdg.balanceOf(address(adapter)), 0, "the dollars passed through");
        assertEq(yieldVault.balanceOf(address(adapter)), 0, "and the shares were never ours");
        assertEq(weth.balanceOf(address(adapter)), 0, "nor the ether");
    }

    /// A standing allowance on an unwatched contract is a liability, not a saving.
    function test_leavesNoAllowanceOnTheYieldVault() external {
        _deposit(1e18, 0);
        assertEq(usdg.allowance(address(adapter), address(yieldVault)), 0, "the approval was zeroed");
    }

    /// The floor is in SHARES here, because shares are what the vault receives.
    function test_theFloorOnTheYieldRouteIsInShares() external {
        uint256 expected = (RATE * 1e18) / SHARE_PRICE;
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemUsdgSavingsAdapter.InsufficientAmountOut.selector, expected + 1, expected)
        );
        adapter.executeInvestment(
            address(weth), address(yieldVault), 1e18, expected + 1, uint48(block.timestamp + 60)
        );
    }

    /// A rising share price buys FEWER shares for the same money. That is the yield.
    function test_aHigherSharePriceBuysFewerShares() external {
        uint256 before_ = _deposit(1e18, 0);
        yieldVault.setPrice(SHARE_PRICE * 2);
        uint256 after_ = _deposit(1e18, 0);
        assertLt(after_, before_, "the same dollars buy fewer, more valuable shares");
    }

    /**
     * THE USDG HALF OF THE RESIDUE CHECK, WHICH WAS NEVER EXERCISED.
     *
     * An adversarial review deleted `_assertNothingStuck(USDG, usdgBefore)` and
     * the suite stayed 27/27 green: the only residue test stranded WETH, and the
     * mock knob written for the USDG case could not work, because an
     * over-credited amount rides in the BalanceDelta and is handed to the vault
     * like any other. A leak has to arrive OUTSIDE the delta to be a leak.
     */
    function test_catchesUsdgLeftOnTheAdapterOutsideTheDelta() external {
        manager.setLeak(address(adapter), 1_000_000);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemUsdgSavingsAdapter.ResidualBalance.selector, address(usdg), uint256(1_000_000))
        );
        adapter.executeInvestment(address(weth), address(usdg), 1e18, 0, uint48(block.timestamp + 60));
    }

    /// The same leak on the yield route, where the dollars legitimately pass through.
    function test_catchesUsdgLeftBehindOnTheYieldRoute() external {
        manager.setLeak(address(adapter), 1_000_000);
        vm.prank(vault);
        vm.expectRevert();
        adapter.executeInvestment(address(yieldVault), address(yieldVault), 1e18, 0, uint48(block.timestamp + 60));
    }

    // ── what the vault says it would mint ────────────────────────────────────

    /**
     * NOT A GATE. An earlier version of the adapter asked `maxDeposit` and
     * reverted when it came back short, on the strength of a measurement that
     * was wrong twice over: Morpho Vault V2 returns 0 from every max* BY DESIGN
     * — reports/YIELD_2026-08-24.md says so verbatim — and the "simulated
     * deposit reverts" that seemed to confirm it was a call from an address
     * holding no USDG, so it failed on the transfer and never reached a cap.
     * Shipping that guard on a contract with no setters would have bricked the
     * yield route permanently. previewDeposit is advisory and stays out of the
     * money path.
     */
    function test_previewsWhatTheYieldVaultWouldMint() external view {
        uint256 expected = (RATE * 1e18) / SHARE_PRICE;
        assertEq(adapter.previewYield(RATE), expected, "the vault's own answer, passed through");
    }

    function test_aPlainDeploymentPreviewsNothing() external {
        NuvemUsdgSavingsAdapter plain =
            new NuvemUsdgSavingsAdapter(address(weth), address(usdg), address(manager), FEE, TICK_SPACING, address(0));
        assertEq(plain.previewYield(RATE), 0, "there is no yield route to preview");
    }

    /**
     * A VAULT THAT REFUSES IS A REFUSAL, NOT A BRICK. If the destination reverts
     * — a real cap, a pause, anything — it must propagate rather than be
     * swallowed, so the keeper can retry later. What must NOT happen is this
     * contract deciding on its own that the vault is closed.
     */
    function test_aRefusalFromTheYieldVaultPropagates() external {
        yieldVault.setCap(0);
        vm.prank(vault);
        vm.expectRevert(bytes("vault: AllCapsReached"));
        adapter.executeInvestment(address(weth), address(yieldVault), 1e18, 0, uint48(block.timestamp + 60));
    }

    // ── two more the review found surviving ──────────────────────────────────

    /// Shares minted to the ADAPTER instead of the vault must be caught.
    function test_catchesSharesMintedToTheAdapter() external {
        yieldVault.setMintToSender(true);
        vm.prank(vault);
        vm.expectRevert();
        adapter.executeInvestment(address(weth), address(yieldVault), 1e18, 0, uint48(block.timestamp + 60));
    }

    /// A destination that calls back in must not get a second bite.
    function test_refusesAReentrantYieldVault() external {
        ReentrantYieldVault evil = new ReentrantYieldVault(address(usdg), SHARE_PRICE);
        NuvemUsdgSavingsAdapter victim =
            new NuvemUsdgSavingsAdapter(address(weth), address(usdg), address(manager), FEE, TICK_SPACING, address(evil));
        evil.arm(address(victim), address(weth));
        weth.mint(vault, 10e18);
        vm.startPrank(vault);
        weth.approve(address(victim), type(uint256).max);
        // THE EXACT ERROR, because a bare expectRevert passes with or without
        // the guard: the re-entrant call fails on its own anyway, for unrelated
        // reasons, so only naming ReentrancyGuardReentrantCall proves the guard
        // is what stopped it.
        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        victim.executeInvestment(address(weth), address(evil), 1e18, 0, uint48(block.timestamp + 60));
        vm.stopPrank();
    }

    // ── the two destinations, and nothing else ───────────────────────────────

    function test_refusesADestinationThatIsNeither() external {
        Token other = new Token("SPY", 18);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemUsdgSavingsAdapter.UnsupportedTargetAsset.selector, address(other))
        );
        adapter.executeInvestment(address(weth), address(other), 1e18, 0, uint48(block.timestamp + 60));
    }

    /**
     * A DEPLOYMENT WITHOUT A YIELD VAULT MUST NOT ACCEPT address(0) AS A
     * DESTINATION. Without the `YIELD_VAULT != address(0)` half of the check,
     * `targetAsset == YIELD_VAULT` is true for the zero address and the adapter
     * would go on to call it.
     */
    function test_aPlainDeploymentRefusesTheZeroDestination() external {
        NuvemUsdgSavingsAdapter plain =
            new NuvemUsdgSavingsAdapter(address(weth), address(usdg), address(manager), FEE, TICK_SPACING, address(0));
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemUsdgSavingsAdapter.UnsupportedTargetAsset.selector, address(0)));
        plain.executeInvestment(address(weth), address(0), 1e18, 0, uint48(block.timestamp + 60));
    }

    /// The pairing is checked at construction, so the mistake is undeployable.
    function test_refusesAYieldVaultOverTheWrongAsset() external {
        Token wrong = new Token("DAI", 18);
        MockYieldVault mismatched = new MockYieldVault(address(wrong), SHARE_PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                NuvemUsdgSavingsAdapter.YieldVaultAssetMismatch.selector, address(usdg), address(wrong)
            )
        );
        new NuvemUsdgSavingsAdapter(
            address(weth), address(usdg), address(manager), FEE, TICK_SPACING, address(mismatched)
        );
    }

    // ── what it refuses ──────────────────────────────────────────────────────

    function test_refusesAnyTokenInThatIsNotWeth() external {
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemUsdgSavingsAdapter.InvalidTokenIn.selector, address(usdg)));
        adapter.executeInvestment(address(usdg), address(usdg), 1e18, 0, uint48(block.timestamp + 60));
    }

    /**
     * THE HARD EQUALITY, NOT A MAP. This adapter can buy exactly one asset, and
     * the test that proves it is the one that hands it something plausible —
     * a real token, correctly ordered — and watches it refuse anyway.
     */
    function test_refusesZeroIn() external {
        vm.prank(vault);
        vm.expectRevert(NuvemUsdgSavingsAdapter.InvalidAmountIn.selector);
        adapter.executeInvestment(address(weth), address(usdg), 0, 0, uint48(block.timestamp + 60));
    }

    function test_refusesAnExpiredQuote() external {
        vm.warp(1_000);
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemUsdgSavingsAdapter.QuoteExpired.selector, uint48(999)));
        adapter.executeInvestment(address(weth), address(usdg), 1e18, 0, uint48(999));
    }

    /// The caller's floor is the only price check, so it has to bind.
    function test_refusesAPriceBelowTheCallersFloor() external {
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemUsdgSavingsAdapter.InsufficientAmountOut.selector, RATE + 1, RATE)
        );
        adapter.executeInvestment(address(weth), address(usdg), 1e18, RATE + 1, uint48(block.timestamp + 60));
    }

    function test_acceptsExactlyTheFloor() external {
        assertEq(_buy(1e18, RATE), RATE, "the floor is a minimum, not a strict inequality");
    }

    // ── the callback, which is the other door in ─────────────────────────────

    function test_refusesACallbackFromAnyoneButTheManager() external {
        vm.expectRevert(abi.encodeWithSelector(NuvemUsdgSavingsAdapter.NotPoolManager.selector, address(this)));
        adapter.unlockCallback(abi.encode(uint256(1e18), vault));
    }

    /// Even the manager may not call in outside an unlock this adapter started.
    function test_refusesACallbackOutsideAnUnlock() external {
        vm.prank(address(manager));
        vm.expectRevert(NuvemUsdgSavingsAdapter.UnexpectedCallback.selector);
        adapter.unlockCallback(abi.encode(uint256(1e18), vault));
    }

    // ── the constructor, where a silent misconfiguration would live ──────────

    /**
     * AN INVERTED PAIR DOES NOT FAIL LOUDLY AT RUNTIME — it addresses a pool
     * that does not exist. Refusing at construction is the only cheap place.
     */
    function test_refusesTokensInTheWrongSortOrder() external {
        vm.expectRevert(NuvemUsdgSavingsAdapter.InvalidConfiguration.selector);
        new NuvemUsdgSavingsAdapter(address(usdg), address(weth), address(manager), FEE, TICK_SPACING, address(0));
    }

    function test_refusesTheSameTokenTwice() external {
        vm.expectRevert(NuvemUsdgSavingsAdapter.InvalidConfiguration.selector);
        new NuvemUsdgSavingsAdapter(address(weth), address(weth), address(manager), FEE, TICK_SPACING, address(0));
    }

    function test_refusesAZeroAddress() external {
        vm.expectRevert(NuvemUsdgSavingsAdapter.InvalidConfiguration.selector);
        new NuvemUsdgSavingsAdapter(address(0), address(usdg), address(manager), FEE, TICK_SPACING, address(0));
    }

    function test_refusesANonPositiveTickSpacing() external {
        vm.expectRevert(NuvemUsdgSavingsAdapter.InvalidConfiguration.selector);
        new NuvemUsdgSavingsAdapter(address(weth), address(usdg), address(manager), FEE, 0, address(0));
    }

    function test_isSupportedAnswersForBothDestinations() external view {
        assertTrue(adapter.isSupported(address(usdg)), "plain dollars");
        // THE ONE THE OLD TEST NEVER ASKED. It asserted usdg/weth/zero and
        // locked in a wrong answer by omission: executeInvestment already
        // accepted the yield vault while this view denied it.
        assertTrue(adapter.isSupported(address(yieldVault)), "and the yield route");
        assertFalse(adapter.isSupported(address(weth)));
        assertFalse(adapter.isSupported(address(0)));
    }
}
