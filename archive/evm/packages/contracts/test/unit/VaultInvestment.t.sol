// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The investment path, with the adapter treated as an adversary throughout.
//
// WHAT THIS FILE IS DEFENDING. `invest` hands a third-party contract an
// allowance over the user's savings and asks it to come back with something
// else. Everything that makes that acceptable is a check in the vault, and every
// check has a test here that breaks it deliberately.
//
// The four `MaliciousInvestmentAdapter` modes had ZERO consumers before this
// file: the harness existed and nothing pointed it at anything. That is the
// shape of a safety net nobody has ever dropped a weight onto.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {MockTargetToken} from "../../src/mocks/MockTargetToken.sol";
import {MaliciousInvestmentAdapter} from "../../src/mocks/MaliciousInvestmentAdapter.sol";
import {IInvestmentAdapter} from "../../src/interfaces/IInvestmentAdapter.sol";
import {VaultLens} from "../../src/periphery/VaultLens.sol";

contract InvestExecutorStub {}

/// @dev Honest adapter that serves any target, at a rate set per target, so one
///      instance can back a multi-leg basket. `shortfallBps` under-delivers on
///      purpose; `phantomBps` reports more than it mints.
contract MultiAssetAdapter is IInvestmentAdapter {
    mapping(address => uint256) public rateWad;
    uint256 public shortfallBps;
    uint256 public phantomBps;
    bool public spendLess;
    bool public spendMore;

    function setRate(address asset, uint256 wad) external {
        rateWad[asset] = wad;
    }

    function setShortfallBps(uint256 bps) external {
        shortfallBps = bps;
    }

    function setPhantomBps(uint256 bps) external {
        phantomBps = bps;
    }

    function setSpendLess(bool on) external {
        spendLess = on;
    }

    function setSpendMore(bool on) external {
        spendMore = on;
    }

    function executeInvestment(address tokenIn, address targetAsset, uint256 amountIn, uint256, uint48)
        external
        override
        returns (uint256)
    {
        uint256 pull = spendLess ? amountIn - 1 : (spendMore ? amountIn + 1 : amountIn);
        IERC20(tokenIn).transferFrom(msg.sender, address(this), pull);
        uint256 out = (amountIn * rateWad[targetAsset]) / 1e18;
        uint256 minted = (out * (10_000 - shortfallBps)) / 10_000;
        MockTargetToken(targetAsset).mint(msg.sender, minted);
        return (out * (10_000 + phantomBps)) / 10_000;
    }
}

contract VaultInvestmentTest is Test {
    VaultLens internal lens = new VaultLens();
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));

    bytes32 internal constant ADAPTER_ID = keccak256("nuvem.adapter.test");
    /// @dev The owner's real settlement contribution, to the wei.
    uint128 internal constant REAL_CONTRIBUTION = 387_193_732_849_312;

    address internal governance = makeAddr("governance");
    address internal guardian = makeAddr("guardian");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal stranger = makeAddr("stranger");
    address internal tradingWallet;
    uint256 internal tradingWalletKey;
    address internal settlementExecutor = address(new InvestExecutorStub());

    MockWETH internal weth = new MockWETH();
    MockTargetToken internal stockA = new MockTargetToken("Stock A", "AAA");
    MockTargetToken internal stockB = new MockTargetToken("Stock B", "BBB");
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    VaultFactory internal factory;
    PersonalVault internal vault;
    MultiAssetAdapter internal adapter;
    uint64 internal statusEpoch;

    function setUp() external {
        (tradingWallet, tradingWalletKey) = makeAddrAndKey("tradingWallet");
        pauseController = new ProtocolPauseController(governance, guardian);
        attesterRegistry = new AttesterRegistry(governance, guardian, makeAddr("attester"));
        factory = new VaultFactory(governance);

        vm.prank(governance);
        factory.configureProtocol(
            VaultFactory.ProtocolConfiguration({
                weth: address(weth),
                pauseController: address(pauseController),
                attesterRegistry: address(attesterRegistry),
                settlementExecutor: settlementExecutor
            })
        );

        PersonalVault implementation = new PersonalVault(address(adapterRegistry));
        vm.prank(governance);
        (uint32 cohortId,) = factory.registerCohort(address(implementation), address(this));

        vm.prank(vaultAdmin);
        (, address vaultAddress) = factory.createVault(
            keccak256("investment-fixture"),
            cohortId,
            abi.encode(
                NuvemTypes.VaultInitialization({
                    weth: address(weth),
                    pauseController: address(pauseController),
                    attesterRegistry: address(attesterRegistry),
                    settlementExecutor: settlementExecutor,
                    policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: type(uint128).max})
                })
            )
        );
        vault = PersonalVault(payable(vaultAddress));

        uint48 deadline = uint48(block.timestamp + 1 days);
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(tradingWallet, keccak256("gmgn"), _accountPolicy(), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(tradingWalletKey, vault.acceptTradingAccountDigest(tradingWallet));
        vault.acceptTradingAccountBySig(tradingWallet, deadline, abi.encodePacked(r, s, v));

        adapter = new MultiAssetAdapter();
        adapter.setRate(address(stockA), 2e18);
        adapter.setRate(address(stockB), 4e18);
        adapterRegistry.registerAdapter(ADAPTER_ID, address(adapter));
        statusEpoch = adapterRegistry.adapterStatusEpoch(ADAPTER_ID);

        // Fund the vault the way a settlement would.
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 100 ether}();
        weth.transfer(address(vault), 10 ether);

        _setPolicy(1e11, 5 ether, 50 ether, true);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _accountPolicy() internal pure returns (NuvemTypes.TradingAccountPolicy memory) {
        return NuvemTypes.TradingAccountPolicy({
            savingsBps: 2_000,
            minContributionWei: 1e12,
            maxPerSettlementWei: type(uint128).max,
            maxRolling30dWei: type(uint128).max,
            tradingFloorWei: 1e15,
            gasReserveWei: 5e14
        });
    }

    function _basket() internal view returns (NuvemTypes.BasketLeg[] memory legs) {
        legs = new NuvemTypes.BasketLeg[](2);
        legs[0] = NuvemTypes.BasketLeg({targetAsset: address(stockA), weightBps: 6_000, minOutRateWad: 1e18});
        legs[1] = NuvemTypes.BasketLeg({targetAsset: address(stockB), weightBps: 4_000, minOutRateWad: 1e18});
    }

    function _oneLeg(address asset) internal pure returns (NuvemTypes.BasketLeg[] memory legs) {
        legs = new NuvemTypes.BasketLeg[](1);
        legs[0] = NuvemTypes.BasketLeg({targetAsset: asset, weightBps: 10_000, minOutRateWad: 1e18});
    }

    function _setPolicy(uint128 min, uint128 perCall, uint128 rolling, bool enabled) internal {
        vm.prank(vaultAdmin);
        vault.setInvestmentPolicy(_basket(), min, perCall, rolling, ADAPTER_ID, enabled);
    }

    function _mins(uint256 n) internal pure returns (uint256[] memory m) {
        m = new uint256[](n);
    }

    /// @dev EVERY argument is evaluated BEFORE the prank. `investmentPolicyNonce()`
    ///      is an external call, and an external call consumes a pending
    ///      `vm.prank` — so reading it inside the argument list made every one of
    ///      these tests run as the test contract and fail with `Unauthorized`,
    ///      including the ones asserting that the admin is allowed.
    function _invest(address caller, uint256 amountIn) internal {
        NuvemTypes.BasketLeg[] memory legs = _basket();
        uint256[] memory mins = _mins(2);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        vm.prank(caller);
        vault.invest(legs, amountIn, mins, deadline, statusEpoch, nonce);
    }

    /// @dev Same as `_invest`, but every read happens BEFORE `vm.expectRevert` is
    ///      armed. `expectRevert` binds to the next call of any kind, so a helper
    ///      that reads the nonce after arming it consumes the expectation on a
    ///      view that was never going to revert — and the failure reads as "did
    ///      not revert as expected", pointing at the contract instead of the test.
    function _investExpectingRevert(address caller, uint256 amountIn, bytes memory expectedError) internal {
        NuvemTypes.BasketLeg[] memory legs = _basket();
        uint256[] memory mins = _mins(2);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        if (expectedError.length == 0) vm.expectRevert();
        else vm.expectRevert(expectedError);
        vm.prank(caller);
        vault.invest(legs, amountIn, mins, deadline, statusEpoch, nonce);
    }

    function _investOneLegExpectingRevert(uint256 amountIn, bytes memory expectedError) internal {
        NuvemTypes.BasketLeg[] memory legs = _oneLeg(address(stockA));
        uint256[] memory mins = _mins(1);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        if (expectedError.length == 0) vm.expectRevert();
        else vm.expectRevert(expectedError);
        vm.prank(tradingWallet);
        vault.invest(legs, amountIn, mins, deadline, statusEpoch, nonce);
    }

    // ── the threshold ────────────────────────────────────────────────────────

    /**
     * THE ONE THE PRODUCT ASKED FOR. A hard floor anywhere in this design would
     * make the feature untestable at the size this protocol actually settles: the
     * owner's real contribution was 387,193,732,849,312 wei, so a 0.05 ETH
     * minimum would need 129 settlements before a single purchase fired.
     */
    function testThresholdCanBeSetBelowOneRealSettlement() external {
        _setPolicy(REAL_CONTRIBUTION, 5 ether, 50 ether, true);
        _invest(tradingWallet, REAL_CONTRIBUTION);
        assertEq(lens.aggregateLifetimeInvested(address(vault)), REAL_CONTRIBUTION);
        assertGt(stockA.balanceOf(address(vault)), 0, "a real-sized settlement must buy something");
    }

    function testBelowTheThresholdReverts() external {
        _setPolicy(1 ether, 5 ether, 50 ether, true);
        _investExpectingRevert(tradingWallet, 1 ether - 1, abi.encodeWithSelector(PersonalVault.InvestmentBelowThreshold.selector, 1 ether - 1, 1 ether));
    }

    function testAboveThePerCallCeilingReverts() external {
        _investExpectingRevert(tradingWallet, 6 ether, abi.encodeWithSelector(PersonalVault.InvestmentAboveCeiling.selector, 6 ether, 5 ether));
    }

    function testCannotSpendMoreWethThanTheVaultHolds() external {
        _setPolicy(1e11, 50 ether, 100 ether, true);
        _investExpectingRevert(tradingWallet, 11 ether, abi.encodeWithSelector(PersonalVault.InvalidState.selector));
    }

    // ── who may call ─────────────────────────────────────────────────────────

    function testAdminMayInvest() external {
        _invest(vaultAdmin, 1 ether);
        assertEq(lens.aggregateLifetimeInvested(address(vault)), 1 ether);
    }

    function testActiveTradingAccountMayInvest() external {
        _invest(tradingWallet, 1 ether);
        assertEq(lens.aggregateLifetimeInvested(address(vault)), 1 ether);
    }

    function testStrangerMayNot() external {
        _investExpectingRevert(stranger, 1 ether, abi.encodeWithSelector(PersonalVault.Unauthorized.selector));
    }

    /// @dev Revoking a trading wallet must remove its ability to spend savings,
    ///      not merely its ability to have savings taken from it.
    function testRevokedTradingAccountMayNot() external {
        vm.prank(vaultAdmin);
        vault.revokeTradingAccount(tradingWallet);
        _investExpectingRevert(tradingWallet, 1 ether, abi.encodeWithSelector(PersonalVault.Unauthorized.selector));
    }

    function testPausedTradingAccountMayNot() external {
        vm.prank(vaultAdmin);
        vault.pauseTradingAccount(tradingWallet);
        _investExpectingRevert(tradingWallet, 1 ether, abi.encodeWithSelector(PersonalVault.Unauthorized.selector));
    }

    // ── the basket is the admin's, not the caller's ──────────────────────────

    /**
     * THE PROPERTY THE WHOLE DESIGN RESTS ON. A caller cannot substitute an
     * asset, because it can only present legs whose hash the admin stored.
     */
    function testACallerCannotSubstituteAnAsset() external {
        NuvemTypes.BasketLeg[] memory forged = _oneLeg(address(stockB));
        uint256[] memory mins = _mins(1);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        vm.prank(tradingWallet);
        vm.expectRevert(PersonalVault.InvestmentBasketMismatch.selector);
        vault.invest(forged, 1 ether, mins, deadline, statusEpoch, nonce);
    }

    function testAStaleBasketIsRefusedAfterTheAdminChangesIt() external {
        NuvemTypes.BasketLeg[] memory old = _basket();
        vm.prank(vaultAdmin);
        vault.setInvestmentPolicy(_oneLeg(address(stockA)), 1e11, 5 ether, 50 ether, ADAPTER_ID, true);

        uint256[] memory mins = _mins(2);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        vm.prank(tradingWallet);
        vm.expectRevert(PersonalVault.InvestmentBasketMismatch.selector);
        vault.invest(old, 1 ether, mins, deadline, statusEpoch, nonce);
    }

    function testAStalePolicyNonceIsRefused() external {
        uint64 stale = vault.investmentPolicyNonce();
        _setPolicy(1e11, 5 ether, 50 ether, true);
        NuvemTypes.BasketLeg[] memory legs = _basket();
        uint256[] memory mins = _mins(2);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 current = vault.investmentPolicyNonce();
        vm.prank(tradingWallet);
        vm.expectRevert(
            abi.encodeWithSelector(PersonalVault.InvalidInvestmentPolicyNonce.selector, stale, current)
        );
        vault.invest(legs, 1 ether, mins, deadline, statusEpoch, stale);
    }

    // ── the adapter is not believed ──────────────────────────────────────────

    /// @dev The vault measures its own balance delta and discards the return
    ///      value, so an adapter that reports 20% more than it minted is refused
    ///      by arithmetic rather than by trust.
    function testAnAdapterThatOverstatesItsOutputIsRefused() external {
        adapter.setShortfallBps(2_000);
        NuvemTypes.BasketLeg[] memory legs = _basket();
        uint256[] memory mins = _minsAt(2, 2e18 * 6 / 10);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        vm.prank(tradingWallet);
        vm.expectRevert();
        vault.invest(legs, 1 ether, mins, deadline, statusEpoch, nonce);
    }

    function _minsAt(uint256 n, uint256 value) internal pure returns (uint256[] memory m) {
        m = new uint256[](n);
        for (uint256 i = 0; i < n; i++) m[i] = value;
    }

    /// @dev Exactly `amountIn`, not "at most". An adapter that spends less has
    ///      not done what it was paid for.
    function testAnAdapterThatSpendsLessThanItWasGivenIsRefused() external {
        adapter.setSpendLess(true);
        _investExpectingRevert(tradingWallet, 1 ether, abi.encodeWithSelector(PersonalVault.InvalidState.selector));
    }

    function testTheAllowanceIsZeroAfterASuccessfulPurchase() external {
        _invest(tradingWallet, 1 ether);
        assertEq(weth.allowance(address(vault), address(adapter)), 0);
    }

    function testTheAllowanceIsZeroAfterAFailedPurchase() external {
        adapter.setSpendLess(true);
        _investExpectingRevert(tradingWallet, 1 ether, abi.encodeWithSelector(PersonalVault.InvalidState.selector));
        assertEq(weth.allowance(address(vault), address(adapter)), 0, "a reverted call unwinds the approval too");
    }

    // ── the hostile adapter harness, which had no consumers ──────────────────

    function _swapInHostileAdapter(MaliciousInvestmentAdapter hostile) internal {
        bytes32 hostileId = keccak256("nuvem.adapter.hostile");
        adapterRegistry.registerAdapter(hostileId, address(hostile));
        vm.prank(vaultAdmin);
        vault.setInvestmentPolicy(_oneLeg(address(stockA)), 1e11, 5 ether, 50 ether, hostileId, true);
        statusEpoch = adapterRegistry.adapterStatusEpoch(hostileId);
    }

    function _investOneLeg(uint256 amountIn) internal {
        NuvemTypes.BasketLeg[] memory legs = _oneLeg(address(stockA));
        uint256[] memory mins = _mins(1);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        vm.prank(tradingWallet);
        vault.invest(legs, amountIn, mins, deadline, statusEpoch, nonce);
    }

    /// @dev FakeOutput: reports a number, mints nothing. The vault's own delta is
    ///      zero, so the floor is unmet.
    function testHostileFakeOutputIsRefused() external {
        MaliciousInvestmentAdapter hostile = new MaliciousInvestmentAdapter(stranger);
        hostile.configureAttack(MaliciousInvestmentAdapter.AttackMode.FakeOutput, stranger, 1e18, "");
        _swapInHostileAdapter(hostile);
        _investOneLegExpectingRevert(1 ether, "");
        assertEq(weth.balanceOf(address(vault)), 10 ether, "nothing left the vault");
    }

    /// @dev StealInput: the WETH debit looks correct because the adapter really
    ///      did pull it — it just sent it to the attacker and minted nothing.
    ///      Caught by the output floor, and the whole call unwinds.
    function testHostileStealInputIsRefused() external {
        MaliciousInvestmentAdapter hostile = new MaliciousInvestmentAdapter(stranger);
        hostile.configureAttack(MaliciousInvestmentAdapter.AttackMode.StealInput, stranger, 1e18, "");
        _swapInHostileAdapter(hostile);
        _investOneLegExpectingRevert(1 ether, "");
        assertEq(weth.balanceOf(address(vault)), 10 ether, "the steal was rolled back");
        assertEq(weth.balanceOf(stranger), 0, "the attacker kept nothing");
    }

    /// @dev Reenter: the guard is held for the whole frame, so a callback into
    ///      `invest` — or into `withdrawToken` — cannot get in.
    function testHostileReentryIsRefused() external {
        MaliciousInvestmentAdapter hostile = new MaliciousInvestmentAdapter(stranger);
        bytes memory reentry =
            abi.encodeWithSelector(PersonalVault.withdrawToken.selector, address(weth), stranger, 1 ether);
        hostile.configureAttack(MaliciousInvestmentAdapter.AttackMode.Reenter, stranger, 1e18, reentry);
        _swapInHostileAdapter(hostile);
        _investOneLegExpectingRevert(1 ether, "");
        assertEq(weth.balanceOf(stranger), 0, "reentry moved nothing");
    }

    /// @dev RevertAlways: there is deliberately NO deferral path. The keeper
    ///      classifies reverts and backs off; swallowing one would cost it the
    ///      reason.
    function testHostileRevertPropagatesRatherThanBeingSwallowed() external {
        MaliciousInvestmentAdapter hostile = new MaliciousInvestmentAdapter(stranger);
        hostile.configureAttack(MaliciousInvestmentAdapter.AttackMode.RevertAlways, stranger, 0, "");
        _swapInHostileAdapter(hostile);
        _investOneLegExpectingRevert(1 ether, abi.encodeWithSelector(MaliciousInvestmentAdapter.MaliciousAdapterRevert.selector));
    }

    // ── the registry is in charge of which adapters exist ────────────────────

    function testAGuardianCanStopEveryVaultAtOnce() external {
        adapterRegistry.deactivateAdapter(ADAPTER_ID);
        NuvemTypes.BasketLeg[] memory legs = _basket();
        uint256[] memory mins = _mins(2);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        vm.prank(tradingWallet);
        vm.expectRevert();
        vault.invest(legs, 1 ether, mins, deadline, statusEpoch, nonce);
    }

    function testAStaleAdapterStatusEpochIsRefused() external {
        NuvemTypes.BasketLeg[] memory legs = _basket();
        uint256[] memory mins = _mins(2);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        vm.prank(tradingWallet);
        vm.expectRevert();
        vault.invest(legs, 1 ether, mins, deadline, statusEpoch + 7, nonce);
    }

    // ── basket validation ────────────────────────────────────────────────────

    function _expectBadBasket(NuvemTypes.BasketLeg[] memory legs) internal {
        vm.prank(vaultAdmin);
        vm.expectRevert(PersonalVault.InvalidPolicy.selector);
        vault.setInvestmentPolicy(legs, 1e11, 5 ether, 50 ether, ADAPTER_ID, true);
    }

    function testWeightsMustSumToExactlyOneHundredPercent() external {
        NuvemTypes.BasketLeg[] memory legs = _basket();
        legs[0].weightBps = 5_999;
        _expectBadBasket(legs);
    }

    /**
     * NO DUPLICATE TARGETS, and this is the subtlest check in the file. Two legs
     * on one token alias the same balance delta, so the first leg's output
     * satisfies the second leg's floor and the second is bought with no lower
     * bound at all.
     */
    function testDuplicateTargetsAreRefused() external {
        NuvemTypes.BasketLeg[] memory legs = _basket();
        legs[1].targetAsset = address(stockA);
        _expectBadBasket(legs);
    }

    function testAZeroFloorIsRefused() external {
        NuvemTypes.BasketLeg[] memory legs = _basket();
        legs[0].minOutRateWad = 0;
        _expectBadBasket(legs);
    }

    /// @dev Bounded so the floor arithmetic is provably overflow-free without
    ///      512-bit math.
    function testAnUnboundedFloorRateIsRefused() external {
        NuvemTypes.BasketLeg[] memory legs = _basket();
        legs[0].minOutRateWad = uint128(type(uint96).max) + 1;
        _expectBadBasket(legs);
    }

    function testWethCannotBeATarget() external {
        _expectBadBasket(_oneLeg(address(weth)));
    }

    function testAnEoaCannotBeATarget() external {
        vm.prank(vaultAdmin);
        vm.expectRevert(abi.encodeWithSelector(PersonalVault.NotAContract.selector, stranger));
        vault.setInvestmentPolicy(_oneLeg(stranger), 1e11, 5 ether, 50 ether, ADAPTER_ID, true);
    }

    function testAnEmptyBasketIsRefused() external {
        _expectBadBasket(new NuvemTypes.BasketLeg[](0));
    }

    function testMoreThanEightLegsIsRefused() external {
        NuvemTypes.BasketLeg[] memory legs = new NuvemTypes.BasketLeg[](9);
        for (uint256 i = 0; i < 9; i++) {
            legs[i] = NuvemTypes.BasketLeg({
                targetAsset: address(new MockTargetToken("x", "x")),
                weightBps: i == 8 ? 1_112 : 1_111,
                minOutRateWad: 1e18
            });
        }
        _expectBadBasket(legs);
    }

    function testTheLimitLadderIsEnforced() external {
        vm.prank(vaultAdmin);
        vm.expectRevert(PersonalVault.InvalidPolicy.selector);
        vault.setInvestmentPolicy(_basket(), 5 ether, 1 ether, 50 ether, ADAPTER_ID, true);
    }

    // ── the remainder rule ───────────────────────────────────────────────────

    /**
     * Without giving the dust to the last leg the parts sum to LESS than
     * `amountIn` for almost every input, the exact-debit assertion fails, and
     * `invest` reverts forever rather than visibly. Thirds are the worst case.
     */
    function testThirdsSpendEveryWei() external {
        MockTargetToken stockC = new MockTargetToken("Stock C", "CCC");
        adapter.setRate(address(stockC), 3e18);
        NuvemTypes.BasketLeg[] memory legs = new NuvemTypes.BasketLeg[](3);
        legs[0] = NuvemTypes.BasketLeg({targetAsset: address(stockA), weightBps: 3_333, minOutRateWad: 1e18});
        legs[1] = NuvemTypes.BasketLeg({targetAsset: address(stockB), weightBps: 3_333, minOutRateWad: 1e18});
        legs[2] = NuvemTypes.BasketLeg({targetAsset: address(stockC), weightBps: 3_334, minOutRateWad: 1e18});

        vm.prank(vaultAdmin);
        vault.setInvestmentPolicy(legs, 1e11, 5 ether, 50 ether, ADAPTER_ID, true);

        uint256 before = weth.balanceOf(address(vault));
        uint256 amountIn = 1 ether + 7;
        uint256[] memory mins3 = _mins(3);
        uint48 deadline3 = uint48(block.timestamp + 1 hours);
        uint64 nonce3 = vault.investmentPolicyNonce();
        vm.prank(tradingWallet);
        vault.invest(legs, amountIn, mins3, deadline3, statusEpoch, nonce3);
        assertEq(before - weth.balanceOf(address(vault)), amountIn, "every wei was spent");
    }

    function testFuzzAwkwardAmountsAlwaysSpendExactly(uint96 raw) external {
        uint256 amountIn = bound(uint256(raw), 1e11, 5 ether);
        uint256 before = weth.balanceOf(address(vault));
        _invest(tradingWallet, amountIn);
        assertEq(before - weth.balanceOf(address(vault)), amountIn);
    }

    // ── pauses are independent ───────────────────────────────────────────────

    function testGlobalPauseStopsInvesting() external {
        vm.prank(guardian);
        pauseController.pause();
        _investExpectingRevert(tradingWallet, 1 ether, abi.encodeWithSelector(PersonalVault.ProtocolPaused.selector));
    }

    /**
     * Investment pause and settlement pause are separate on purpose: they fail
     * for unrelated reasons, and an operator has to be able to stop purchases
     * without also stopping savings from arriving.
     */
    function testInvestmentPauseDoesNotStopSettlementPause() external {
        vm.prank(vaultAdmin);
        vault.setInvestmentPause(true);
        _investExpectingRevert(tradingWallet, 1 ether, abi.encodeWithSelector(PersonalVault.InvestmentIsPaused.selector));
        assertFalse(vault.settlementPaused(), "settlement is untouched");
    }

    function testSettlementPauseDoesNotStopInvesting() external {
        vm.prank(vaultAdmin);
        vault.setLocalPause(true);
        _invest(tradingWallet, 1 ether);
        assertEq(lens.aggregateLifetimeInvested(address(vault)), 1 ether);
    }

    function testDisabledInvestingReverts() external {
        vm.prank(vaultAdmin);
        vault.setInvestmentPolicy(_basket(), 1e11, 5 ether, 50 ether, ADAPTER_ID, false);
        NuvemTypes.BasketLeg[] memory legs = _basket();
        uint256[] memory mins = _mins(2);
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint64 nonce = vault.investmentPolicyNonce();
        vm.prank(tradingWallet);
        vm.expectRevert(PersonalVault.InvestmentDisabled.selector);
        vault.invest(legs, 1 ether, mins, deadline, statusEpoch, nonce);
    }

    // ── custody ──────────────────────────────────────────────────────────────

    /**
     * THE PRODUCT PROMISE. After a purchase every unit of every bought asset is
     * in the vault, and nobody else holds any.
     */
    function testEverythingBoughtLandsInTheVault() external {
        _invest(tradingWallet, 1 ether);
        assertEq(stockA.balanceOf(address(vault)), 1.2e18, "60% at 2x");
        assertEq(stockB.balanceOf(address(vault)), 1.6e18, "40% at 4x");
        assertEq(stockA.balanceOf(address(adapter)), 0);
        assertEq(stockA.balanceOf(vaultAdmin), 0);
        assertEq(stockA.balanceOf(tradingWallet), 0);
        assertEq(stockB.balanceOf(address(adapter)), 0);
    }

    /// @dev The admin's exit works for a bought asset exactly as it does for
    ///      WETH — unpausable and fee-free, which is the one property worth
    ///      keeping unchanged.
    function testTheAdminCanWithdrawABoughtStock() external {
        _invest(tradingWallet, 1 ether);
        vm.prank(vaultAdmin);
        vault.withdrawToken(address(stockA), vaultAdmin, 1.2e18);
        assertEq(stockA.balanceOf(vaultAdmin), 1.2e18);
    }

    // ── the outflow cap the earlier removal lost ─────────────────────────────

    function testTheRollingCapRefusesOnceExhausted() external {
        _setPolicy(1e11, 2 ether, 3 ether, true);
        _invest(tradingWallet, 2 ether);
        _investExpectingRevert(tradingWallet, 2 ether, "");
    }

    function testTheRollingCapReleasesAfterThirtyOneDays() external {
        _setPolicy(1e11, 2 ether, 3 ether, true);
        _invest(tradingWallet, 2 ether);
        vm.warp(block.timestamp + 31 days);
        _invest(tradingWallet, 2 ether);
        assertEq(lens.aggregateLifetimeInvested(address(vault)), 4 ether);
    }

    function testTheCapStatusIsReadable() external {
        _setPolicy(1e11, 2 ether, 3 ether, true);
        _invest(tradingWallet, 1 ether);
        NuvemTypes.RollingCapStatus memory status = vault.investmentRollingCapStatus();
        assertEq(status.cap, 3 ether);
        assertEq(status.spent, 1 ether);
        assertEq(status.remaining, 2 ether);
    }

    // ── settlement must not notice any of this ───────────────────────────────

    /**
     * THE INTERACTION MOST LIKELY TO BREAK PRODUCTION SILENTLY. `policyHash` is
     * what every settlement attestation is signed against. If an investment
     * setter moved it, every attestation already signed would stop being
     * spendable — and nothing would say so until a settlement reverted.
     */
    function testNoInvestmentSetterDisturbsThePolicyHash() external {
        bytes32 before = vault.policyHash(tradingWallet);
        uint64 nonceBefore = vault.vaultPolicyNonce();

        vm.startPrank(vaultAdmin);
        vault.setInvestmentPolicy(_oneLeg(address(stockB)), 5e11, 3 ether, 30 ether, keccak256("other"), false);
        vault.setInvestmentPause(true);
        vault.setInvestmentPause(false);
        vm.stopPrank();

        assertEq(vault.policyHash(tradingWallet), before, "policyHash moved");
        assertEq(vault.vaultPolicyNonce(), nonceBefore, "vaultPolicyNonce moved");
    }

    function testInvestingDoesNotDisturbThePolicyHash() external {
        bytes32 before = vault.policyHash(tradingWallet);
        _invest(tradingWallet, 1 ether);
        assertEq(vault.policyHash(tradingWallet), before);
    }
}
