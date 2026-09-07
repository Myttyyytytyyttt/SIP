// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {VaultLens} from "../../src/periphery/VaultLens.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

contract PersonalVaultV2Mock is PersonalVault {
    constructor(address adapterRegistry_) PersonalVault(adapterRegistry_) {}

    function implementationVersion() external pure returns (uint256) {
        return 2;
    }
}

contract SettlementExecutorUpgradeStub {}

/// @notice A vault laid out the way PersonalVault was BEFORE the investment path
///         was removed: four extra address/bool slots ahead of the rest.
/// @dev Only the storage struct matters here. It exists so the test below can
///      demonstrate what a cross-layout beacon promotion actually does to a live
///      vault, rather than leaving that consequence stated but unproven.
contract LegacyLayoutVault {
    bytes32 private constant VAULT_STORAGE_LOCATION =
        0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200;

    struct LegacyVaultStorage {
        bytes32 vaultId;
        address vaultAdmin;
        address pendingVaultAdmin;
        address factory;
        address weth;
        address pauseController;
        address attesterRegistry;
        address adapterRegistry; // removed by this change
        address feeController; // removed by this change
        address settlementExecutor;
        address investmentOperator; // removed by this change
        uint32 cohortId;
        uint64 adminEpoch;
        uint64 localPauseEpoch;
        uint64 vaultPolicyNonce;
        uint64 activeTradingAccountCount;
        bool settlementPaused;
        bool investmentPaused; // removed by this change
    }

    function seed(address adapterRegistry_, address feeController_, address settlementExecutor_) external {
        LegacyVaultStorage storage $ = _s();
        $.adapterRegistry = adapterRegistry_;
        $.feeController = feeController_;
        $.settlementExecutor = settlementExecutor_;
    }

    function _s() private pure returns (LegacyVaultStorage storage $) {
        bytes32 slot = VAULT_STORAGE_LOCATION;
        assembly {
            $.slot := slot
        }
    }
}

contract UpgradeContinuityTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    VaultLens internal lens = new VaultLens();
    uint256 internal constant MAX_VAULT_IMPLEMENTATION_SIZE = 24_000;
    /// @dev A ratchet, not a limit. Removing the investment path freed ~5 KB; the
    ///      24,000 guard alone would let all of it be re-spent silently and the
    ///      next feature would "not fit" again, which is exactly how commit
    ///      63d59bb lost the per-period outflow cap. Raising this number must be
    ///      a deliberate act with a reason attached.
    ///
    ///      RAISED 20,600 -> 23,700 for the investment path: the basket policy,
    ///      the threshold and its two ceilings, the per-period outflow cap the
    ///      earlier removal lost, and `invest()` itself. 20,425 -> 23,567.
    ///
    ///      WHAT IT COST AND WHAT PAID FOR IT, because a number this large should
    ///      not be taken on trust. The naive shape of this feature measured 26,070
    ///      bytes — 1,494 OVER EIP-170, so it could not ship at all. Four measured
    ///      changes brought it back: optimizer_runs 200 -> 20 (-454, and see
    ///      foundry.toml for why 20 rather than 1); one `setInvestmentPolicy`
    ///      instead of five separate setters (-552); plain arithmetic in place of
    ///      Math.mulDiv where the operands are bounded, and `approve` in place of
    ///      `forceApprove` where the allowance is provably zero (-351); and eight
    ///      getters with no on-chain consumer replaced by one `extsload` plus
    ///      `VaultLens` (-1,050).
    ///
    ///      Three things that looked like savings and were measured to be losses,
    ///      recorded so nobody re-tries them: returning a struct instead of
    ///      several scalar getters is BIGGER; emitting `bytes` instead of a
    ///      dynamic array is BIGGER; and one basket-wide adapter call instead of a
    ///      per-leg loop is BIGGER, because allocating the memory arrays to
    ///      describe the basket costs more than the loop it removes.
    ///
    ///      RAISED 23,700 -> 24,000 for the ADAPTER REGISTRY IMMUTABLE, and this
    ///      one is a deliberate decision rather than a measurement, so it is worth
    ///      the paragraph.
    ///
    ///      What it buys: the registry moved out of per-vault storage and into the
    ///      implementation's bytecode. That is not a refactor, it is the
    ///      difference between the investment path working and not. A value
    ///      written in `initialize` can only ever reach vaults created AFTER it
    ///      exists, because `initialize` runs once — so on the live vault it read
    ///      address(0) before and after a beacon upgrade, `setInvestmentPolicy`
    ///      still succeeded and emitted its event, and every `invest()` reverted
    ///      against address zero with empty returndata. An immutable arrives with
    ///      the upgrade, for every proxy on the beacon, in one block.
    ///      Proven end to end against mainnet state in
    ///      test/ForkInvestAfterUpgrade.t.sol.
    ///
    ///      What it costs: 23,656 -> 23,691, only 35 bytes. The ratchet moves 300
    ///      because at 9 bytes of headroom it would fire on every future change
    ///      and stop being a signal. 24,000 leaves 576 bytes under EIP-170 —
    ///      enough for a real bug fix, and still a hard stop well before the
    ///      protocol limit.
    ///
    ///      What was NOT done to fit: the first attempt measured 24,108, over the
    ///      old ratchet by 408. Removing one unreachable belt-and-braces check in
    ///      `setInvestmentPolicy` took it to 23,691 — 417 bytes for a single `if`,
    ///      because via_ir's inlining is sharply non-linear here. The optimizer
    ///      sweep in foundry.toml was re-measured at the same time and 20 is still
    ///      the minimum. So the headroom was earned before the ratchet was moved,
    ///      not instead of moving it.
    ///
    ///      Headroom left: 309 bytes under the repo guard, 885 under EIP-170.
    ///      It has to be spent BEFORE this implementation is sealed into a cohort,
    ///      because afterwards nothing can be added at any price.
    ///
    ///      PREVIOUSLY: RAISED 20,000 -> 20,600 for `inviteTradingAccountBySig` and its two
    ///      companions (`inviteTradingAccountDigest`,
    ///      `invalidateTradingAccountInvites`), which cost 1,784 bytes: 18,641 ->
    ///      20,425. The spend buys the gasless "add a trading wallet" path the
    ///      product needs, and it has to be spent BEFORE this implementation is
    ///      sealed into cohort 1, because afterwards nothing can be added at any
    ///      price. The new headroom is 175 bytes, deliberately tight — the next
    ///      feature should have to justify itself the same way.
    uint256 internal constant VAULT_IMPLEMENTATION_SIZE_RATCHET = 24_000;

    function testVaultImplementationsKeepDeploymentHeadroom() external {
        PersonalVault implementation = new PersonalVault(address(adapterRegistry));
        PersonalVaultV2Mock nextImplementation = new PersonalVaultV2Mock(address(adapterRegistry));

        uint256 size = address(implementation).code.length;
        console2.log("PersonalVault runtime bytes", size);
        console2.log("Headroom against the repo guard", MAX_VAULT_IMPLEMENTATION_SIZE - size);
        console2.log("Headroom against EIP-170", uint256(24_576) - size);

        assertLt(size, MAX_VAULT_IMPLEMENTATION_SIZE);
        assertLt(address(nextImplementation).code.length, MAX_VAULT_IMPLEMENTATION_SIZE);
        assertLt(size, VAULT_IMPLEMENTATION_SIZE_RATCHET, "re-spending the headroom this contract cannot get back");
    }

    /// @notice Demonstrates that this implementation must never be promoted onto
    ///         a beacon whose vaults carry the pre-change storage layout.
    /// @dev Removing adapterRegistry, feeController, investmentOperator and
    ///      investmentPaused from VaultStorage shifts settlementExecutor from
    ///      offset 9 to offset 7 and everything after it. `PrepareCohortUpgrade`
    ///      validates cohort separation, beacon ownership and the canary
    ///      implementation address — it does NOT validate storage layout, so it
    ///      would happily build an executable timelock payload doing exactly
    ///      this. The live canary vault must stay on its own cohort; this
    ///      implementation belongs only to a new cohort on the new factory.
    function testNewImplementationMisreadsALegacyStorageLayout() external {
        address legacyAdapterRegistry = makeAddr("legacyAdapterRegistry");
        address legacyFeeController = makeAddr("legacyFeeController");
        address legacySettlementExecutor = makeAddr("legacySettlementExecutor");

        LegacyLayoutVault legacy = new LegacyLayoutVault();
        legacy.seed(legacyAdapterRegistry, legacyFeeController, legacySettlementExecutor);

        // Swap the code while keeping the storage. This is exactly what a beacon
        // upgrade does to every vault in the cohort.
        vm.etch(address(legacy), address(new PersonalVault(address(adapterRegistry))).code);

        // The slot the new implementation calls `settlementExecutor` is the slot
        // the old one called `adapterRegistry`.
        address readThroughNewLayout = PersonalVault(payable(address(legacy))).settlementExecutor();

        assertEq(readThroughNewLayout, legacyAdapterRegistry, "the new layout reads the old adapterRegistry slot");
        assertTrue(
            readThroughNewLayout != legacySettlementExecutor,
            "a cross-layout promotion silently repoints the vault's settlement executor"
        );
    }

    function testBeaconUpgradePreservesPermanentVaultIdentityFundsAndPolicies() external {
        address admin = makeAddr("admin");
        address trader = makeAddr("trader");
        address settlementExecutor = address(new SettlementExecutorUpgradeStub());
        address attester = makeAddr("attester");

        MockWETH weth = new MockWETH();
        ProtocolPauseController pauseController = new ProtocolPauseController(address(this), address(this));
        AttesterRegistry attesterRegistry = new AttesterRegistry(address(this), address(this), attester);

        VaultFactory factory = new VaultFactory(address(this));
        factory.configureProtocol(
            VaultFactory.ProtocolConfiguration({
                weth: address(weth),
                pauseController: address(pauseController),
                attesterRegistry: address(attesterRegistry),
                settlementExecutor: settlementExecutor
            })
        );
        PersonalVault implementation = new PersonalVault(address(adapterRegistry));
        (uint32 cohortId, address beaconAddress) = factory.registerCohort(address(implementation), address(this));

        NuvemTypes.VaultPolicy memory vaultPolicy = NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: 100 ether});
        NuvemTypes.VaultInitialization memory init = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(attesterRegistry),
            settlementExecutor: settlementExecutor,
            policy: vaultPolicy
        });

        vm.prank(admin);
        (bytes32 vaultId, address proxy) = factory.createVault(keccak256("permanent"), cohortId, abi.encode(init));
        PersonalVault vault = PersonalVault(payable(proxy));

        NuvemTypes.TradingAccountPolicy memory tradingPolicy = NuvemTypes.TradingAccountPolicy({
            savingsBps: 3_000,
            minContributionWei: 0.01 ether,
            maxPerSettlementWei: 5 ether,
            maxRolling30dWei: 20 ether,
            tradingFloorWei: 1 ether,
            gasReserveWei: 0.1 ether
        });
        vm.prank(admin);
        vault.inviteTradingAccount(trader, keccak256("gmgn"), tradingPolicy, uint48(block.timestamp + 1 days));
        vm.prank(trader);
        vault.acceptTradingAccount();

        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(trader);
        NuvemTypes.SettlementRecord memory record = NuvemTypes.SettlementRecord({
            account: trader,
            bindingEpoch: account.bindingEpoch,
            policyNonce: account.policyNonce,
            settlementNonce: account.settlementNonce,
            policyHash: vault.policyHash(trader),
            sessionId: keccak256("upgrade-session"),
            ledgerRoot: keccak256("upgrade-ledger"),
            startBlock: uint64(block.number),
            endBlock: uint64(block.number),
            startBlockL2: 5_000,
            endBlockL2: 5_400,
            contribution: 1 ether
        });
        vm.roll(block.number + 1);
        vm.deal(settlementExecutor, 1 ether);
        vm.prank(settlementExecutor);
        vault.acceptSettlement{value: 1 ether}(record);

        uint64 policyNonceBefore = vault.vaultPolicyNonce();
        uint64 pauseEpochBefore = vault.localPauseEpoch();

        PersonalVaultV2Mock nextImplementation = new PersonalVaultV2Mock(address(adapterRegistry));
        UpgradeableBeacon(beaconAddress).upgradeTo(address(nextImplementation));
        PersonalVaultV2Mock upgraded = PersonalVaultV2Mock(payable(proxy));

        assertEq(upgraded.implementationVersion(), 2);
        assertEq(address(upgraded), proxy);
        assertEq(upgraded.vaultId(), vaultId);
        assertEq(upgraded.vaultAdmin(), admin);
        assertEq(upgraded.settlementExecutor(), settlementExecutor);
        assertEq(upgraded.vaultPolicyNonce(), policyNonceBefore);
        assertEq(upgraded.localPauseEpoch(), pauseEpochBefore);
        assertEq(factory.vaultOfAdmin(admin), proxy);
        assertEq(factory.activeVaultOf(trader), proxy);
        assertEq(upgraded.getTradingAccount(trader).policy.savingsBps, 3_000);
        assertEq(upgraded.getTradingAccount(trader).settlementNonce, 1);
        assertEq(upgraded.lifetimeContribution(trader), 1 ether);
        assertEq(upgraded.aggregateLifetimeContribution(), 1 ether);
        assertEq(weth.balanceOf(proxy), 1 ether);

        // The settlement frontier must survive the implementation swap: a cohort
        // upgrade that reset it would let every settled window be replayed.
        (uint64 frontierL1, uint64 frontierL2) = lens.settlementFrontier(address(upgraded), trader, record.bindingEpoch);
        assertEq(frontierL1, record.endBlock);
        assertEq(frontierL2, record.endBlockL2);
        assertTrue(lens.isSessionUsed(address(upgraded), trader, record.bindingEpoch, record.sessionId));

        NuvemTypes.SettlementRecord memory nonProgressive = record;
        nonProgressive.settlementNonce = 1;
        nonProgressive.sessionId = keccak256("post-upgrade-session");
        nonProgressive.startBlockL2 = record.endBlockL2;
        nonProgressive.endBlockL2 = record.endBlockL2 + 100;
        vm.deal(settlementExecutor, 1 ether);
        vm.prank(settlementExecutor);
        vm.expectPartialRevert(PersonalVault.NonProgressiveBlockRange.selector);
        upgraded.acceptSettlement{value: 1 ether}(nonProgressive);

        vm.expectRevert();
        upgraded.initialize(vaultId, admin, address(factory), cohortId, abi.encode(init));
    }
}
