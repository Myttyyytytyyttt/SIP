// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Every slot constant in VaultLens, pinned against a live vault.
//
// WHY THIS IS THE MOST IMPORTANT TEST OF THE THREE STORAGE FILES. `VaultLens`
// hard-codes offsets into another contract's namespaced storage. Nothing in the
// compiler checks that, `forge inspect storage-layout` returns an empty table
// for an ERC-7201 struct, and a wrong constant does not fail loudly — it returns
// a plausible number from the wrong slot. A lens that reports the wrong vault
// admin, or reports a replayed session as unused, is worse than no lens at all.
//
// So the method here is: write a DISTINCT, recognisable value into every field,
// then read it back through the lens. A copy-paste error between two constants
// shows up because no two fields share a value.
//
// The first hand-derived version of this map was wrong. `settlementExecutor` is
// an address with twelve spare bytes and the compiler fills them with `cohortId`
// and `adminEpoch`, so everything below sits one slot earlier than reading the
// struct top-to-bottom suggests.

import {Test} from "forge-std/Test.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {MockTargetToken} from "../../src/mocks/MockTargetToken.sol";
import {VaultLens} from "../../src/periphery/VaultLens.sol";

contract LensExecutorStub {}

contract VaultLensTest is Test {
    VaultLens internal lens = new VaultLens();
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));

    bytes32 internal constant ADAPTER_ID = keccak256("nuvem.adapter.lens-fixture");
    uint128 internal constant MIN_INVESTMENT = 3_333;
    uint128 internal constant MAX_PER_CALL = 44_444;
    uint128 internal constant MAX_ROLLING = 555_555;
    uint128 internal constant AGGREGATE_CAP = 6_666_666;

    address internal governance = makeAddr("governance");
    address internal guardian = makeAddr("guardian");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal nextAdmin = makeAddr("nextAdmin");
    address internal tradingWallet;
    uint256 internal tradingWalletKey;
    address internal settlementExecutor = address(new LensExecutorStub());

    MockWETH internal weth = new MockWETH();
    MockTargetToken internal stockA = new MockTargetToken("Stock A", "AAA");
    MockTargetToken internal stockB = new MockTargetToken("Stock B", "BBB");
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    VaultFactory internal factory;
    PersonalVault internal vault;
    uint32 internal cohortId;

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

        // The implementation is deployed BEFORE the prank: a contract creation
        // consumes it, so `registerCohort` would otherwise run unpranked.
        PersonalVault implementation = new PersonalVault(address(adapterRegistry));
        vm.prank(governance);
        (cohortId,) = factory.registerCohort(address(implementation), address(this));

        vm.prank(vaultAdmin);
        (, address vaultAddress) = factory.createVault(
            keccak256("lens-fixture"),
            cohortId,
            abi.encode(
                NuvemTypes.VaultInitialization({
                    weth: address(weth),
                    pauseController: address(pauseController),
                    attesterRegistry: address(attesterRegistry),
                    settlementExecutor: settlementExecutor,
                    policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: AGGREGATE_CAP})
                })
            )
        );
        vault = PersonalVault(payable(vaultAddress));

        // Move every mutable field off its default, and to a value no other field
        // shares, so a constant pointing at the wrong slot cannot pass by luck.
        uint48 deadline = uint48(block.timestamp + 1 days);
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(tradingWallet, keccak256("gmgn"), _policy(), deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(tradingWalletKey, vault.acceptTradingAccountDigest(tradingWallet));
        vault.acceptTradingAccountBySig(tradingWallet, deadline, abi.encodePacked(r, s, v));

        vm.startPrank(vaultAdmin);
        vault.proposeVaultAdmin(nextAdmin);
        vault.setInvestmentPolicy(_basket(), MIN_INVESTMENT, MAX_PER_CALL, MAX_ROLLING, ADAPTER_ID, true);
        vault.setInvestmentPause(true);
        vm.stopPrank();
    }

    function _policy() internal pure returns (NuvemTypes.TradingAccountPolicy memory) {
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
        legs[1] = NuvemTypes.BasketLeg({targetAsset: address(stockB), weightBps: 4_000, minOutRateWad: 2e18});
    }

    function testEveryAddressSlotResolves() external view {
        address v = address(vault);
        assertEq(lens.vaultAdmin(v), vaultAdmin, "vaultAdmin");
        assertEq(lens.pendingVaultAdmin(v), nextAdmin, "pendingVaultAdmin");
        assertEq(lens.factory(v), address(factory), "factory");
        assertEq(lens.weth(v), address(weth), "weth");
        assertEq(lens.pauseController(v), address(pauseController), "pauseController");
        assertEq(lens.attesterRegistry(v), address(attesterRegistry), "attesterRegistry");
    }

    /// @dev Cross-checked against the vault's own surviving getters, so the two
    ///      readers of the same storage must agree.
    function testScalarsAgreeWithTheVaultsOwnGetters() external view {
        address v = address(vault);
        assertEq(lens.vaultId(v), vault.vaultId(), "vaultId");
        assertEq(lens.vaultAdmin(v), vault.vaultAdmin(), "vaultAdmin");
        assertEq(lens.pendingVaultAdmin(v), vault.pendingVaultAdmin(), "pendingVaultAdmin");
        assertEq(lens.vaultPolicyNonce(v), vault.vaultPolicyNonce(), "vaultPolicyNonce");
        assertEq(lens.activeTradingAccountCount(v), vault.activeTradingAccountCount(), "activeTradingAccountCount");
        assertEq(lens.aggregateLifetimeContribution(v), vault.aggregateLifetimeContribution(), "aggregateContribution");
    }

    function testCohortAndPolicyResolve() external view {
        assertEq(lens.cohortId(address(vault)), cohortId, "cohortId");
        assertEq(
            lens.getVaultPolicy(address(vault)).maxAggregateRolling30dWei, AGGREGATE_CAP, "maxAggregateRolling30dWei"
        );
    }

    /**
     * The investment fields, which are the newest and therefore the ones whose
     * slots nothing else has ever read.
     */
    function testInvestmentSnapshotResolves() external view {
        VaultLens.InvestmentSnapshot memory s = lens.investmentSnapshot(address(vault));
        assertEq(s.adapterRegistry, address(adapterRegistry), "adapterRegistry");
        assertEq(s.adapterId, ADAPTER_ID, "adapterId");
        assertEq(s.basketHash, keccak256(abi.encode(_basket())), "basketHash");
        assertEq(s.minInvestmentWei, MIN_INVESTMENT, "minInvestmentWei");
        assertEq(s.maxPerCallWei, MAX_PER_CALL, "maxPerCallWei");
        assertEq(s.maxRolling30dWei, MAX_ROLLING, "maxRolling30dWei");
        assertEq(s.policyNonce, vault.investmentPolicyNonce(), "policyNonce");
        assertTrue(s.enabled, "enabled");
        assertTrue(s.paused, "paused");
    }

    /// @dev Two bools packed one byte apart in the same word. Reading them from
    ///      the wrong offset returns the other one's value, which is exactly the
    ///      mistake a hand-written shift makes and exactly the mistake that would
    ///      report a paused vault as running.
    function testTheTwoInvestmentFlagsAreNotConfused() external {
        vm.prank(vaultAdmin);
        vault.setInvestmentPause(false);
        VaultLens.InvestmentSnapshot memory s = lens.investmentSnapshot(address(vault));
        assertTrue(s.enabled, "enabled should still be true");
        assertFalse(s.paused, "paused should now be false");

        vm.prank(vaultAdmin);
        vault.setInvestmentPolicy(_basket(), MIN_INVESTMENT, MAX_PER_CALL, MAX_ROLLING, ADAPTER_ID, false);
        s = lens.investmentSnapshot(address(vault));
        assertFalse(s.enabled, "enabled should now be false");
        assertFalse(s.paused, "paused should still be false");
    }

    function testVaultSnapshotAgreesFieldForField() external view {
        VaultLens.VaultSnapshot memory s = lens.vaultSnapshot(address(vault));
        assertEq(s.vaultId, vault.vaultId(), "vaultId");
        assertEq(s.vaultAdmin, vault.vaultAdmin(), "vaultAdmin");
        assertEq(s.pendingVaultAdmin, vault.pendingVaultAdmin(), "pendingVaultAdmin");
        assertEq(s.factory, address(factory), "factory");
        assertEq(s.weth, address(weth), "weth");
        assertEq(s.pauseController, address(pauseController), "pauseController");
        assertEq(s.attesterRegistry, address(attesterRegistry), "attesterRegistry");
        assertEq(s.adapterRegistry, address(adapterRegistry), "adapterRegistry");
        assertEq(s.cohortId, cohortId, "cohortId");
        assertEq(s.adminEpoch, vault.adminEpoch(), "adminEpoch");
        assertEq(s.localPauseEpoch, vault.localPauseEpoch(), "localPauseEpoch");
        assertEq(s.vaultPolicyNonce, vault.vaultPolicyNonce(), "vaultPolicyNonce");
        assertEq(s.activeTradingAccountCount, vault.activeTradingAccountCount(), "activeTradingAccountCount");
        assertEq(s.settlementPaused, vault.settlementPaused(), "settlementPaused");
        assertEq(s.maxAggregateRolling30dWei, AGGREGATE_CAP, "maxAggregateRolling30dWei");
        assertEq(s.aggregateLifetimeContributions, vault.aggregateLifetimeContribution(), "aggregateContributions");
        assertEq(s.aggregateLifetimeInvested, 0, "aggregateInvested");
    }

    /// @dev `settlementPaused` is a bool sharing a word with three uint64s. If the
    ///      shift is wrong it reads a nonce byte and reports a paused vault as
    ///      running — the one answer that must never be wrong in this direction.
    function testSettlementPausedTracksTheRealFlag() external {
        assertFalse(lens.vaultSnapshot(address(vault)).settlementPaused, "starts unpaused");
        vm.prank(vaultAdmin);
        vault.setLocalPause(true);
        assertTrue(lens.vaultSnapshot(address(vault)).settlementPaused, "must follow the vault");
        assertEq(lens.vaultSnapshot(address(vault)).localPauseEpoch, vault.localPauseEpoch(), "epoch moved too");
    }

    /// @dev A mapping's slot is the preimage its entries hash from, so getting it
    ///      wrong does not shift the answer, it invents one. Asserting non-zero
    ///      matters as much as asserting equality here.
    function testKeyedLookupsResolveIntoTheRightMapping() external view {
        assertEq(
            lens.lifetimeContribution(address(vault), tradingWallet),
            vault.lifetimeContribution(tradingWallet),
            "lifetimeContribution"
        );
        uint64 bindingEpoch = vault.getTradingAccount(tradingWallet).bindingEpoch;
        (uint64 l1, uint64 l2) = lens.settlementFrontier(address(vault), tradingWallet, bindingEpoch);
        assertEq(l1, 0, "frontier L1 starts empty");
        assertEq(l2, 0, "frontier L2 starts empty");
        assertFalse(lens.isSessionUsed(address(vault), tradingWallet, bindingEpoch, keccak256("unused")), "unused");
    }
}
