// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The adapter, against mocked venues.
//
// WHAT IS BEING PROVED. The adapter is the one contract in this system that
// touches a third-party venue, and it is the one that a vault deliberately does
// not trust. Two obligations follow, and both are tested here:
//
//   * Every refusal must happen BEFORE the vault's WETH is pulled. A gate that
//     rejects after the transfer leaves the caller holding a failed call and the
//     adapter holding funds — so each gate test asserts the vault's balance is
//     untouched, not merely that the call reverted.
//   * Nothing may be left behind. USDG that stops here is a balance a third
//     party can freeze (`freeze` + `wipeFrozenAddress` sit behind one EOA with no
//     timelock), so the residue assertion is a safety property, not hygiene.
//
// The mocks below stand in for Uniswap v4, Chainlink and the Robinhood
// stock/registry pair. Their shapes come from verified source on
// robinhoodchain.blockscout.com; what they cannot prove is that the real venues
// behave this way, which is what the fork tests are for.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {NuvemStockAdapter} from "../../src/adapters/NuvemStockAdapter.sol";
import {BalanceDelta, IPoolManager, PoolKey, SwapParams} from "../../src/interfaces/IRobinhoodVenue.sol";

// ── mocks ────────────────────────────────────────────────────────────────────

contract MintableToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockAggregator {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 a) {
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 t) external {
        answer = a;
        updatedAt = t;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @dev Uniswap v4's flash-accounting shape, reduced to what the adapter uses.
///      It serves BOTH pools, dispatching on the key, because the whole point of
///      the route is that the two hops happen inside one unlock and the USDG
///      legs cancel without this contract ever holding a balance.
contract MockPoolManager {
    MintableToken public weth;
    MintableToken public usdg;
    MintableToken public stock;
    /// @dev USDG (1e6) produced per 1e18 of WETH.
    uint256 public wethRate;
    /// @dev Stock (1e18) produced per 1e6 of USDG.
    uint256 public stockRate;
    bool public underspend;
    uint256 public leaveUsdgBehind;

    function configure(MintableToken w, MintableToken u, MintableToken s_, uint256 wr, uint256 sr) external {
        weth = w;
        usdg = u;
        stock = s_;
        wethRate = wr;
        stockRate = sr;
    }

    function setRate(uint256 r) external {
        wethRate = r;
    }

    function setStockRate(uint256 r) external {
        stockRate = r;
    }

    /// @dev Consumes less WETH while still pricing the full amount, so the
    ///      oracle floor is CLEARED and only the residue assertion can notice
    ///      the stranded input. Without this the floor masks it.
    function setUnderspend(bool on) external {
        underspend = on;
    }

    /// @dev Credits less USDG on hop 2 than hop 1 produced, which is the only
    ///      way a USDG balance could appear here at all.
    function setLeaveUsdgBehind(uint256 amount) external {
        leaveUsdgBehind = amount;
    }

    /// @dev Tracks per-currency deltas and asserts they net to zero, which is
    ///      what the real PoolManager does at the end of `unlock`. Without this
    ///      the mock would accept a route that leaves a debt — and the whole
    ///      reason both hops live in one unlock is that this assertion is what
    ///      proves the intermediate USDG cancelled.
    mapping(address => int256) public delta;
    address[] internal touched;

    function unlock(bytes calldata data) external returns (bytes memory result) {
        result = NuvemStockAdapter(msg.sender).unlockCallback(data);
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
        uint256 amountIn = uint256(-params.amountSpecified);
        bool isWethHop = key.currency0 == address(weth) || key.currency1 == address(weth);

        if (isWethHop) {
            uint256 spent = underspend ? amountIn - 1e15 : amountIn;
            uint256 out = ((underspend ? amountIn : spent) * wethRate) / 1e18;
            _record(address(weth), -int256(spent));
            _record(address(usdg), int256(out));
            // currency0 = WETH (owed by us), currency1 = USDG (owed to us).
            return BalanceDelta.wrap((int256(-int256(spent)) << 128) | int256(uint256(uint128(uint128(out)))));
        }

        uint256 usdgSpent = amountIn - leaveUsdgBehind;
        uint256 stockOut = (amountIn * stockRate) / 1e6;
        _record(address(usdg), -int256(usdgSpent));
        _record(address(stock), int256(stockOut));
        // Mint what the adapter will `take`, so the take succeeds.
        stock.mint(address(this), stockOut);
        bool usdgIsCurrency0 = key.currency0 == address(usdg);
        int256 usdgLeg = int256(-int256(usdgSpent));
        int256 stockLeg = int256(uint256(uint128(uint128(stockOut))));
        return usdgIsCurrency0
            ? BalanceDelta.wrap((usdgLeg << 128) | stockLeg)
            : BalanceDelta.wrap((int256(stockOut) << 128) | int256(uint256(uint128(uint128(uint256(-usdgLeg))))) * -1);
    }

    address internal synced;

    function sync(address currency) external {
        synced = currency;
    }

    function settle() external payable returns (uint256 paid) {
        paid = MintableToken(synced).balanceOf(address(this));
        _record(synced, int256(paid));
    }

    function take(address currency, address to, uint256 amount) external {
        _record(currency, -int256(amount));
        MintableToken(currency).transfer(to, amount);
    }
}

contract MockStockRegistry {
    address public implementation;
    mapping(address => bool) public isBlocked;

    constructor(address impl) {
        implementation = impl;
    }

    function setImplementation(address impl) external {
        implementation = impl;
    }

    function setBlocked(address account, bool blocked) external {
        isBlocked[account] = blocked;
    }
}

/// @dev A stock token. Every instance shares a codehash, which is exactly the
///      property that makes the structural checks insufficient on their own — a
///      clone passes all of them.
contract MockStock is MintableToken {
    address public immutable ACCESS_CONTROLLED_REGISTRY;
    bool public paused;
    bool public oraclePaused;
    uint256 public uiMultiplier = 1e18;
    uint256 public effectiveAt;

    constructor(string memory n, string memory s, address registry) MintableToken(n, s, 18) {
        ACCESS_CONTROLLED_REGISTRY = registry;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }

    function setEffectiveAt(uint256 t) external {
        effectiveAt = t;
    }
}

// ── the test ─────────────────────────────────────────────────────────────────

contract NuvemStockAdapterTest is Test {
    /// @dev A Wednesday, 16:00 UTC — inside the session in both DST regimes.
    uint256 internal constant OPEN_TIMESTAMP = 1_786_636_800;

    MintableToken internal weth;
    MintableToken internal usdg;
    MockPoolManager internal poolManager;
    MockStockRegistry internal registry;
    MockStock internal nvda;
    MockStock internal clone;
    MockAggregator internal ethFeed;
    MockAggregator internal usdgFeed;
    MockAggregator internal stockFeed;
    NuvemStockAdapter internal adapter;

    address internal vault = makeAddr("vault");
    address internal stockImplementation = makeAddr("stockImplementation");

    function setUp() external {
        vm.warp(OPEN_TIMESTAMP);
        _requireWeekdaySession(OPEN_TIMESTAMP);

        // WETH must sort BELOW USDG, because a Uniswap v4 PoolKey orders its
        // currencies and an inverted key silently addresses a pool that does not
        // exist. On the real chain 0x0bd7... < 0x5fc5... and it holds; here the
        // addresses come from a nonce and land either way round, so the fixture
        // redeploys until it matches reality rather than testing a world the
        // adapter would refuse to be deployed into.
        for (uint256 i = 0; i < 32; ++i) {
            MintableToken w = new MintableToken("Wrapped Ether", "WETH", 18);
            MintableToken u = new MintableToken("Global Dollar", "USDG", 6);
            if (uint160(address(w)) < uint160(address(u))) {
                weth = w;
                usdg = u;
                break;
            }
        }
        require(address(weth) != address(0), "fixture: could not order the tokens");

        registry = new MockStockRegistry(stockImplementation);
        nvda = new MockStock("NVIDIA", "NVDA", address(registry));
        clone = new MockStock("NVIDIA", "NVDA", address(registry));

        // Real numbers read off mainnet, so the fixture's arithmetic is the
        // arithmetic that has to work: ETH/USD 1876.86, USDG/USD 0.99989,
        // RHNVDA/USD 225.305, all at the 8 decimals Chainlink uses here.
        //
        // The venue rates are set close to the oracles, matching the measured
        // basis (+14.4 bps on the WETH/USDG pool and +29 bps on the hookless
        // NVDA/USDG pool), so the happy path clears its floor the way it does on
        // chain rather than by luck.
        ethFeed = new MockAggregator(187_686_000_000);
        usdgFeed = new MockAggregator(99_989_000);
        stockFeed = new MockAggregator(22_530_500_000);

        // 1e18 wei of WETH -> 1,879.56 USDG (6 dp).
        poolManager = new MockPoolManager();
        // 1e6 units of USDG -> 1/225.305 NVDA, scaled to 1e18.
        poolManager.configure(weth, usdg, nvda, 1_879_560_000, 4_438_400_000_000_000);

        adapter = _deployAdapter();

        weth.mint(vault, 100 ether);
        vm.prank(vault);
        weth.approve(address(adapter), type(uint256).max);
    }

    function _requireWeekdaySession(uint256 ts) internal pure {
        uint256 dow = ((ts / 1 days) + 4) % 7;
        require(dow != 0 && dow != 6, "fixture: weekend");
        uint256 tod = ts % 1 days;
        require(tod >= 14 hours + 30 minutes && tod < 20 hours, "fixture: outside session");
    }

    function _deployAdapter() internal returns (NuvemStockAdapter) {
        NuvemStockAdapter.StockInput[] memory stocks = new NuvemStockAdapter.StockInput[](1);
        stocks[0] = NuvemStockAdapter.StockInput({stock: address(nvda), fee: 3000, tickSpacing: 60});
        return new NuvemStockAdapter(
            address(weth),
            address(usdg),
            address(poolManager),
            address(registry),
            stockImplementation,
            address(nvda).codehash,
            200,
            4,
            stocks
        );
    }

    /**
     * THE OBVIOUS SHORTCUT, AND WHY IT IS NOT ONE.
     *
     * "Just list USDG as a stock and let the route be WETH -> USDG -> USDG."
     * The constructor accepts it — :183-191 checks only non-zero, no duplicate
     * and a positive tickSpacing — so the mistake deploys cleanly and fails at
     * runtime, which is the worst place for it to fail.
     *
     * TWO INDEPENDENT WALLS, and they matter for different reasons. The first is
     * _requireCanonicalStock: USDG is not a BeaconProxy, has no
     * ACCESS_CONTROLLED_REGISTRY(), no oraclePaused(), no effectiveAt(). That
     * one is at least CONFIGURABLE in principle — STOCK_REGISTRY and
     * STOCK_PROXY_CODEHASH are constructor arguments — so it is the wall someone
     * would try to bend. The second cannot be bent by any argument: hop 2 builds
     * its key from `usdgIsCurrency0 = uint160(USDG) < uint160(stock)`, which is
     * false when the stock IS USDG, so currency0 == currency1 == USDG. Uniswap
     * v4 requires them strictly ordered; that key addresses a pool that cannot
     * exist.
     *
     * This test pins the first wall, which is the one a caller actually hits.
     */
    function testUsdgListedAsAStockDeploysAndThenRefuses() external {
        NuvemStockAdapter.StockInput[] memory stocks = new NuvemStockAdapter.StockInput[](1);
        stocks[0] = NuvemStockAdapter.StockInput({stock: address(usdg), fee: 200, tickSpacing: 4});
        NuvemStockAdapter shortcut = new NuvemStockAdapter(
            address(weth),
            address(usdg),
            address(poolManager),
            address(registry),
            stockImplementation,
            address(nvda).codehash,
            200,
            4,
            stocks
        );

        // It exists, and it says it supports USDG. Both are true and neither helps.
        assertTrue(shortcut.isSupported(address(usdg)), "the constructor took it");

        vm.prank(vault);
        vm.expectRevert();
        shortcut.executeInvestment(address(weth), address(usdg), 1 ether, 0, uint48(block.timestamp + 1 hours));
    }

    function _invest(uint256 amountIn) internal returns (uint256) {
        vm.prank(vault);
        return adapter.executeInvestment(address(weth), address(nvda), amountIn, 0, uint48(block.timestamp + 1 hours));
    }

    /// @dev Asserts the gate fired before any of the vault's WETH moved.
    function _expectRefusalBeforePull(bytes memory err) internal {
        uint256 before = weth.balanceOf(vault);
        vm.prank(vault);
        if (err.length == 0) vm.expectRevert();
        else vm.expectRevert(err);
        adapter.executeInvestment(address(weth), address(nvda), 1 ether, 0, uint48(block.timestamp + 1 hours));
        assertEq(weth.balanceOf(vault), before, "the vault's WETH moved before the gate fired");
    }

    // ── the happy path ───────────────────────────────────────────────────────

    function testBuysAndDeliversToTheVault() external {
        uint256 out = _invest(1 ether);
        assertGt(out, 0, "bought nothing");
        assertEq(nvda.balanceOf(vault), out, "the stock must land on the vault");
        assertEq(nvda.balanceOf(address(adapter)), 0, "the adapter must not hold the stock");
        assertEq(weth.balanceOf(vault), 99 ether, "exactly the input was spent");
    }

    /**
     * NOTHING MAY BE LEFT HERE. USDG parked in this adapter is a balance an
     * external EOA can freeze and wipe with no timelock, which is precisely why
     * the route passes through it inside a single transaction instead of holding
     * it.
     */
    function testNoUsdgOrWethRemainsAfterAPurchase() external {
        _invest(1 ether);
        assertEq(usdg.balanceOf(address(adapter)), 0, "USDG residue");
        assertEq(weth.balanceOf(address(adapter)), 0, "WETH residue");
    }

    /**
     * ONE WEI, SENT BY ANYONE, STOPS EVERY PURCHASE — PERMANENTLY.
     *
     * `_assertNoResidue` compares against ABSOLUTE ZERO, and this contract has
     * no owner, no setter and no sweep. So an unsolicited transfer of a single
     * wei of WETH or USDG is not merely tolerated badly: it makes every
     * subsequent `executeInvestment` revert, for every vault pointed at this
     * adapter, with no way to clear it. Recovery is governance registering a
     * replacement and every vault admin repointing.
     *
     * The attack costs one transfer. This test exists to state the exposure in
     * executable form rather than in a comment; NuvemUsdgSavingsAdapter measures
     * residue against the balance ON ENTRY for exactly this reason, and its
     * test_aDonationDoesNotBrickIt is the other half of this pair.
     */
    function testASingleDonatedWeiBricksEveryPurchase() external {
        // ONE PURCHASE ONLY, because this file's MockPoolManager credits its
        // whole WETH balance in `settle()` rather than what arrived since
        // `sync`, so a second purchase fails as CurrencyNotSettled for reasons
        // that have nothing to do with the donation. The claim needs one call.
        weth.mint(address(adapter), 1);

        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemStockAdapter.ResidualBalance.selector, address(weth), uint256(1))
        );
        adapter.executeInvestment(address(weth), address(nvda), 1 ether, 0, uint48(block.timestamp + 60));

        // Nothing in the contract can move that wei: no owner, no setter, no
        // sweep. `testBuysAndDeliversToTheVault` shows the same call succeeding
        // without it, so the donation is the whole difference.
        assertEq(weth.balanceOf(address(adapter)), 1, "and it is still there");
    }

    /// @dev A partially filled first hop leaves WETH behind. The residue check
    ///      turns that into a revert rather than a slow leak nobody notices.
    function testAPartialFirstHopRevertsRatherThanStrandingWeth() external {
        poolManager.setUnderspend(true);
        vm.prank(vault);
        vm.expectRevert();
        adapter.executeInvestment(address(weth), address(nvda), 1 ether, 0, uint48(block.timestamp + 1 hours));
        assertEq(weth.balanceOf(address(adapter)), 0, "nothing stranded");
        assertEq(weth.balanceOf(vault), 100 ether, "the vault kept everything");
    }

    /**
     * THE PROPERTY THE ROUTE WAS RESHAPED TO GET. Both hops run inside one
     * unlock, so the USDG the first swap credits and the second swap debits
     * cancel as deltas — the adapter never holds a USDG BALANCE at any point.
     *
     * That matters because USDG can be frozen and wiped by an EOA with no
     * timelock, and burned from any holder by a supply controller with
     * `allowAnyMintAndBurnAddress = true`. A balance that never exists cannot be
     * taken.
     */
    function testTheAdapterNeverHoldsUsdg() external {
        _invest(1 ether);
        assertEq(usdg.balanceOf(address(adapter)), 0, "USDG balance after");
        // And the venue never handed it any: a `take` of USDG would have shown up
        // as a mint to this adapter, so a zero total supply held here proves the
        // intermediate leg stayed inside the accounting.
        assertEq(usdg.balanceOf(address(poolManager)), 0, "the manager kept none either");
    }

    /**
     * And the complement: a route whose intermediate legs do NOT cancel is
     * refused by the venue's own accounting, not by anything this adapter
     * remembers to check. `CurrencyNotSettled` is what the real PoolManager
     * raises when `unlock` ends with a non-zero delta.
     */
    function testAnUnbalancedIntermediateLegIsRefusedByTheVenue() external {
        poolManager.setLeaveUsdgBehind(1_000_000);
        vm.prank(vault);
        vm.expectRevert(bytes("PoolManager: CurrencyNotSettled"));
        adapter.executeInvestment(address(weth), address(nvda), 1 ether, 0, uint48(block.timestamp + 1 hours));
        assertEq(weth.balanceOf(vault), 100 ether, "the vault kept everything");
    }

    /// @dev Same shape for the input side: the pool prices the full amount but
    ///      consumes less of it, so the first hop's floor is met and only the
    ///      residue check notices the vault's WETH sitting here.
    function testWethLeftBehindRevertsEvenWhenTheFloorIsMet() external {
        poolManager.setUnderspend(true);
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemStockAdapter.ResidualBalance.selector, address(weth), 1e15)
        );
        adapter.executeInvestment(address(weth), address(nvda), 1 ether, 0, uint48(block.timestamp + 1 hours));
        assertEq(weth.balanceOf(vault), 100 ether, "the vault kept everything");
    }

    function testTheCallerCanTightenTheFloorButTheCallFailsIfUnmet() external {
        vm.prank(vault);
        vm.expectRevert();
        adapter.executeInvestment(
            address(weth), address(nvda), 1 ether, type(uint128).max, uint48(block.timestamp + 1 hours)
        );
    }

    /**
     * A shortfall on the SECOND hop, refused.
     *
     * This used to pass a floor of zero and rely on the oracle to notice. With no
     * oracle, zero means "I accept any price" and the call correctly succeeds —
     * so the floor has to be supplied, which is the whole shape of the new design:
     * a shortfall is only a shortfall relative to what the caller asked for.
     */
    function testASecondHopShortfallIsRefused() external {
        poolManager.setStockRate(4_000_000_000_000_000); // ~10% under the fair rate
        vm.prank(vault);
        vm.expectRevert();
        adapter.executeInvestment(
            address(weth), address(nvda), 1 ether, _fairOut(), uint48(block.timestamp + 1 hours)
        );
    }

    // ── identity ─────────────────────────────────────────────────────────────

    /**
     * THE CLONE. `Stock.initialize(uid, name, symbol)` has NO role check on the
     * real chain, so anyone can deploy a BeaconProxy at the genuine beacon and
     * name it "NVDA". It has the same codehash, the same registry and the same
     * implementation — it passes every structural test. Only the pinned list
     * tells it apart, which is why identity lives there and nowhere else.
     */
    function testAnIdenticalCloneIsRejectedBecauseItIsNotOnThePinnedList() external {
        assertEq(address(clone).codehash, address(nvda).codehash, "the clone really is structurally identical");
        assertEq(clone.ACCESS_CONTROLLED_REGISTRY(), nvda.ACCESS_CONTROLLED_REGISTRY(), "same registry");

        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemStockAdapter.UnsupportedTargetAsset.selector, address(clone)));
        adapter.executeInvestment(address(weth), address(clone), 1 ether, 0, uint48(block.timestamp + 1 hours));
    }

    function testOnlyWethMayBeSpent() external {
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemStockAdapter.InvalidTokenIn.selector, address(usdg)));
        adapter.executeInvestment(address(usdg), address(nvda), 1 ether, 0, uint48(block.timestamp + 1 hours));
    }

    /// @dev A beacon rotated to an implementation nobody has reviewed FAILS
    ///      CLOSED. Resuming needs a new adapter, which is a governance act.
    function testARotatedStockImplementationStopsEverything() external {
        registry.setImplementation(makeAddr("newImplementation"));
        _expectRefusalBeforePull("");
    }

    // ── halts and blocks ─────────────────────────────────────────────────────

    function testAPausedStockIsRefusedBeforeAnyMoneyMoves() external {
        nvda.setPaused(true);
        _expectRefusalBeforePull(abi.encodeWithSelector(NuvemStockAdapter.StockPaused.selector, address(nvda)));
    }

    function testAPausedOracleIsRefused() external {
        nvda.setOraclePaused(true);
        _expectRefusalBeforePull(abi.encodeWithSelector(NuvemStockAdapter.StockOraclePaused.selector, address(nvda)));
    }

    function testABlockedVaultIsRefused() external {
        registry.setBlocked(vault, true);
        _expectRefusalBeforePull(abi.encodeWithSelector(NuvemStockAdapter.AccountBlocked.selector, vault));
    }

    function testABlockedAdapterIsRefused() external {
        registry.setBlocked(address(adapter), true);
        _expectRefusalBeforePull(abi.encodeWithSelector(NuvemStockAdapter.AccountBlocked.selector, address(adapter)));
    }

    function testABlockedPoolManagerIsRefused() external {
        registry.setBlocked(address(poolManager), true);
        _expectRefusalBeforePull(
            abi.encodeWithSelector(NuvemStockAdapter.AccountBlocked.selector, address(poolManager))
        );
    }

    /// @dev The one window where the feed's price and the token's multiplier can
    ///      legitimately disagree.
    function testAScheduledCorporateActionStandsTheAdapterDown() external {
        nvda.setEffectiveAt(block.timestamp + 12 hours);
        _expectRefusalBeforePull("");
        nvda.setEffectiveAt(block.timestamp - 12 hours);
        _expectRefusalBeforePull("");
        // Two days past, and it trades again.
        nvda.setEffectiveAt(block.timestamp - 2 days);
        assertGt(_invest(1 ether), 0);
    }

    // ── time ─────────────────────────────────────────────────────────────────

    /// @dev The feeds are refreshed after every warp. Without that they age past
    ///      their bound and `StaleFeed` fires first, so removing the calendar gate
    ///      entirely would break no test — which is exactly what happened the
    ///      first time this file was written.
    function _warpAndRefresh(uint256 ts) internal {
        vm.warp(ts);
        ethFeed.set(187_686_000_000, ts);
        usdgFeed.set(99_989_000, ts);
        stockFeed.set(22_530_500_000, ts);
    }

    function testAnExpiredDeadlineIsRefused() external {
        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemStockAdapter.QuoteExpired.selector, uint48(block.timestamp - 1))
        );
        adapter.executeInvestment(address(weth), address(nvda), 1 ether, 0, uint48(block.timestamp - 1));
    }

    function testAZeroAmountIsRefused() external {
        vm.prank(vault);
        vm.expectRevert(NuvemStockAdapter.InvalidAmountIn.selector);
        adapter.executeInvestment(address(weth), address(nvda), 0, 0, uint48(block.timestamp + 1 hours));
    }

    // ── the callback ─────────────────────────────────────────────────────────

    function testTheCallbackRejectsEveryoneButThePoolManager() external {
        vm.expectRevert(abi.encodeWithSelector(NuvemStockAdapter.NotPoolManager.selector, address(this)));
        adapter.unlockCallback(abi.encode(uint256(1 ether)));
    }

    /// @dev Even the pool manager cannot invoke it outside an investment: the
    ///      flag is only set for the length of one `unlock`.
    function testThePoolManagerCannotCallBackOutsideAnInvestment() external {
        vm.prank(address(poolManager));
        vm.expectRevert(NuvemStockAdapter.UnexpectedCallback.selector);
        adapter.unlockCallback(abi.encode(uint256(1 ether)));
    }

    // ── the clock does not exist any more, and that is the point ─────────────
    //
    // The venue is a Uniswap v4 pool. It has no session, no holidays and no
    // weekend, and the gates that used to be here were OURS rather than its.
    // Measured on a Saturday against mainnet: the hookless NVDA/USDG pool quoted
    // $224.83 while the Chainlink feed sat 22 hours old at $225.31 — 0.21% apart.
    // The vault was being stopped from buying at a price nobody disputed.

    /// @dev A Saturday. Under the previous adapter this reverted `MarketClosed`.
    function testBuysOnAWeekend() external {
        vm.warp(1_786_800_000);
        uint256 dow = ((block.timestamp / 1 days) + 4) % 7;
        assertTrue(dow == 0 || dow == 6, "fixture must actually be a weekend");

        uint256 out = _invest(1 ether);
        assertGt(out, 0, "a weekend must not stop a purchase");
        assertEq(nvda.balanceOf(vault), out, "the vault received the asset");
    }

    /// @dev Thursday 08:00 UTC — a weekday, well before the US session opens.
    function testBuysOutsideSessionHours() external {
        vm.warp(1_786_608_000);
        uint256 tod = block.timestamp % 1 days;
        assertTrue(tod < 14 hours + 30 minutes || tod >= 20 hours, "fixture must be outside the session");

        assertGt(_invest(1 ether), 0, "the hour of day must not stop a purchase");
    }

    /**
     * THE ONLY FLOOR, and the whole reason removing the oracle is safe.
     *
     * `minAmountOut` reaches this contract as the HIGHER of two numbers the vault
     * already computed: the admin's `minOutRateWad`, bound into the basket hash
     * and impossible for the keeper to lower, and the keeper's per-call quote. An
     * oracle floor here was a third opinion on a figure two parties had agreed.
     */
    /// @dev What the mock pool pays for 1 WETH, derived from its configured rates
    ///      rather than from a prior investment: `settle()` hands over the mock's
    ///      whole WETH balance, so a second purchase inside one test double-counts
    ///      and trips its own CurrencyNotSettled assertion.
    function _fairOut() internal pure returns (uint256) {
        return ((1 ether * 1_879_560_000) / 1e18) * 4_438_400_000_000_000 / 1e6;
    }

    function testAFloorAboveWhatThePoolPaysIsRefused() external {
        uint256 fair = _fairOut();
        vm.prank(vault);
        vm.expectRevert(abi.encodeWithSelector(NuvemStockAdapter.InsufficientAmountOut.selector, fair + 1, fair));
        adapter.executeInvestment(address(weth), address(nvda), 1 ether, fair + 1, uint48(block.timestamp + 1 hours));
    }

    /// @dev The other direction, because a floor that refuses everything is as
    ///      useless as one that refuses nothing.
    function testAFloorExactlyAtWhatThePoolPaysIsAccepted() external {
        uint256 fair = _fairOut();
        vm.prank(vault);
        assertEq(
            adapter.executeInvestment(address(weth), address(nvda), 1 ether, fair, uint48(block.timestamp + 1 hours)),
            fair
        );
    }

    /**
     * A TERRIBLE POOL PRICE IS NOT REFUSED BY THE ADAPTER, and that is stated
     * here rather than left to be discovered. With no oracle this contract has no
     * notion of "fair"; the caller's floor is the only thing between a vault and a
     * bad fill. Mainnet carries hookless NVDA/USDG pools at 85%, 90%, 95% and
     * 99.9% fees with real liquidity, so this is the live failure mode.
     */
    function testATerriblePriceFillsWhenTheCallerAsksForNoFloor() external {
        poolManager.setStockRate(1);
        vm.prank(vault);
        uint256 out =
            adapter.executeInvestment(address(weth), address(nvda), 1 ether, 0, uint48(block.timestamp + 1 hours));
        assertGt(out, 0, "with no floor, it fills at any price");
        assertLt(out, _fairOut() / 1000, "and the price really was terrible");
    }

    /// @dev The same terrible pool, refused — by the caller's floor and nothing else.
    function testATerriblePriceIsRefusedByASaneFloor() external {
        poolManager.setStockRate(1);
        vm.prank(vault);
        vm.expectRevert();
        adapter.executeInvestment(
            address(weth), address(nvda), 1 ether, _fairOut(), uint48(block.timestamp + 1 hours)
        );
    }

    // ── configuration ────────────────────────────────────────────────────────

    function testTheAdapterExposesWhatItSupports() external view {
        assertTrue(adapter.isSupported(address(nvda)));
        assertFalse(adapter.isSupported(address(clone)));
        (uint24 fee, int24 ts, bool configured) = adapter.getStockConfig(address(nvda));
        assertTrue(configured);
        assertEq(fee, 3000);
        assertEq(ts, int24(60));

        // `configured` is a field rather than an inference from `fee != 0`,
        // because a zero-fee pool is a real thing on this chain and would
        // otherwise be indistinguishable from a stock nobody pinned.
        (uint24 cloneFee, int24 cloneTs, bool cloneConfigured) = adapter.getStockConfig(address(clone));
        assertFalse(cloneConfigured);
        assertEq(cloneFee, 0);
        assertEq(cloneTs, int24(0));
    }


    /// @dev An inverted pool key silently addresses a pool that does not exist.
    function testTheConstructorRefusesInvertedTokenOrder() external {
        NuvemStockAdapter.StockInput[] memory stocks = new NuvemStockAdapter.StockInput[](1);
        stocks[0] = NuvemStockAdapter.StockInput({stock: address(nvda), fee: 3000, tickSpacing: 60});
        vm.expectRevert(NuvemStockAdapter.InvalidConfiguration.selector);
        new NuvemStockAdapter(
            address(usdg), // deliberately swapped
            address(weth),
            address(poolManager),
            address(registry),
            stockImplementation,
            address(nvda).codehash,
            200,
            4,
            stocks
        );
    }

    function testTheConstructorRefusesADuplicateStock() external {
        NuvemStockAdapter.StockInput[] memory stocks = new NuvemStockAdapter.StockInput[](2);
        stocks[0] = NuvemStockAdapter.StockInput({stock: address(nvda), fee: 3000, tickSpacing: 60});
        stocks[1] = stocks[0];
        vm.expectRevert(NuvemStockAdapter.InvalidConfiguration.selector);
        new NuvemStockAdapter(
            address(weth),
            address(usdg),
            address(poolManager),
            address(registry),
            stockImplementation,
            address(nvda).codehash,
            200,
            4,
            stocks
        );
    }
}
