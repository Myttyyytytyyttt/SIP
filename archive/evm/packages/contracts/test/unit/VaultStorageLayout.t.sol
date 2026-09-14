// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Where every pre-existing field of VaultStorage lives, pinned to a number.
//
// WHY THIS FILE EXISTS. `UpgradeContinuity.t.sol:110` proves the NEGATIVE case —
// that promoting an implementation across a layout change corrupts a vault. Its
// complement did not exist: nothing asserted that a change was layout-SAFE. So
// "I only appended" was an argument, not a fact, and the argument is the kind
// that is easy to make and easy to be wrong about.
//
// It is also the only check available. `forge inspect PersonalVault
// storage-layout` returns an EMPTY table, because VaultStorage is ERC-7201
// namespaced — reached through assembly at a constant slot, never declared as a
// state variable. The compiler has nothing to report. And
// `script/PrepareCohortUpgrade.s.sol` validates cohort separation, beacon
// ownership and the implementation address, and never once looks at layout: it
// will happily build an executable payload that bricks every vault in a cohort.
//
// WHAT WOULD BREAK IT. Give `NuvemTypes.VaultPolicy` a second field and it grows
// from one slot to two. `tradingAccounts` slides from S+11 to S+12 — and a
// mapping's slot IS the preimage its entries are hashed from, so every trading
// account, every frontier, every used session and all 31 aggregate buckets
// become unreachable in the same instant. The getters would still compile and
// still return something; they would simply be reading a different vault.
//
// The constants below are the layout as it stood BEFORE the investment fields
// were appended. They are hard-coded on purpose: if a future edit shifts a
// field, the getter follows it and this file does not, and the two disagree.

import {Test} from "forge-std/Test.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {VaultLens} from "../../src/periphery/VaultLens.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

contract LayoutExecutorStub {}

contract VaultStorageLayoutTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    VaultLens internal lens = new VaultLens();
    /// @dev keccak256(abi.encode(uint256(keccak256("nuvem.storage.PersonalVault")) - 1)) & ~bytes32(uint256(0xff))
    uint256 internal constant BASE =
        uint256(0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200);

    // The pre-existing layout, READ OFF A LIVE VAULT rather than derived on
    // paper. Deriving it by hand got the packing wrong: `settlementExecutor` is
    // an address with 12 spare bytes in its slot, and the compiler greedily fills
    // them with `cohortId` and `adminEpoch`, shifting everything below by one
    // slot from where a naive reading of the struct puts it. That mistake is
    // exactly the class this file exists to catch, so it is worth stating that
    // the numbers below are measured, not reasoned.
    uint256 internal constant SLOT_VAULT_ID = BASE + 0;
    uint256 internal constant SLOT_VAULT_ADMIN = BASE + 1;
    uint256 internal constant SLOT_PENDING_ADMIN = BASE + 2;
    uint256 internal constant SLOT_FACTORY = BASE + 3;
    uint256 internal constant SLOT_WETH = BASE + 4;
    uint256 internal constant SLOT_PAUSE_CONTROLLER = BASE + 5;
    uint256 internal constant SLOT_ATTESTER_REGISTRY = BASE + 6;
    /// @dev settlementExecutor(20) | cohortId(4) | adminEpoch(8) — a full slot.
    uint256 internal constant SLOT_EXECUTOR_PACKED = BASE + 7;
    /// @dev localPauseEpoch(8) | vaultPolicyNonce(8) | activeTradingAccountCount(8) | settlementPaused(1)
    uint256 internal constant SLOT_EPOCHS_PACKED = BASE + 8;
    uint256 internal constant SLOT_VAULT_POLICY = BASE + 9;
    uint256 internal constant SLOT_TRADING_ACCOUNTS = BASE + 10;
    uint256 internal constant SLOT_AGGREGATE_BUCKETS = BASE + 14;
    uint256 internal constant SLOT_LIFETIME_CONTRIBUTIONS = BASE + 45;
    uint256 internal constant SLOT_AGGREGATE_LIFETIME_CONTRIBUTIONS = BASE + 46;

    address internal governance;
    address internal guardian;
    address internal vaultAdmin;
    address internal tradingWallet;
    address internal settlementExecutor;

    MockWETH internal weth;
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    VaultFactory internal factory;
    PersonalVault internal vault;

    function setUp() external {
        governance = makeAddr("governance");
        guardian = makeAddr("guardian");
        vaultAdmin = makeAddr("vaultAdmin");
        tradingWallet = makeAddr("tradingWallet");
        settlementExecutor = address(new LayoutExecutorStub());

        weth = new MockWETH();
        pauseController = new ProtocolPauseController(governance, guardian);
        attesterRegistry = new AttesterRegistry(governance, guardian, makeAddr("attester"));

        PersonalVault implementation = new PersonalVault(address(adapterRegistry));
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

        vm.prank(governance);
        (uint32 cohortId,) = factory.registerCohort(address(implementation), address(this));

        NuvemTypes.VaultInitialization memory initialization = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(attesterRegistry),
            settlementExecutor: settlementExecutor,
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: 12_345 ether})
        });

        vm.prank(vaultAdmin);
        (, address vaultAddress) = factory.createVault(keccak256("layout-fixture"), cohortId, abi.encode(initialization));
        vault = PersonalVault(payable(vaultAddress));

        // Populate the mappings so a slid mapping slot shows up as lost data
        // rather than as a zero that was always zero.
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(
            tradingWallet,
            keccak256("gmgn"),
            NuvemTypes.TradingAccountPolicy({
                savingsBps: 2_000,
                minContributionWei: 1e12,
                maxPerSettlementWei: type(uint128).max,
                maxRolling30dWei: type(uint128).max,
                tradingFloorWei: 1e15,
                gasReserveWei: 5e14
            }),
            uint48(block.timestamp + 1 days)
        );
    }

    function _slot(uint256 slot) internal view returns (bytes32) {
        return vm.load(address(vault), bytes32(slot));
    }

    function _addressAt(uint256 slot) internal view returns (address) {
        return address(uint160(uint256(_slot(slot))));
    }

    /**
     * THE ONE THAT MATTERS. Each getter is compared against the raw slot the
     * pre-append layout put it in. Insert a field anywhere above and the getter
     * follows the shift while the constant does not.
     */
    function testPreExistingScalarsAreStillAtTheirOriginalSlots() external view {
        assertEq(_slot(SLOT_VAULT_ID), vault.vaultId(), "vaultId moved");
        assertEq(_addressAt(SLOT_VAULT_ADMIN), vault.vaultAdmin(), "vaultAdmin moved");
        assertEq(_addressAt(SLOT_FACTORY), lens.factory(address(vault)), "factory moved");
        assertEq(_addressAt(SLOT_WETH), lens.weth(address(vault)), "weth moved");
        assertEq(_addressAt(SLOT_PAUSE_CONTROLLER), lens.pauseController(address(vault)), "pauseController moved");
        assertEq(_addressAt(SLOT_ATTESTER_REGISTRY), lens.attesterRegistry(address(vault)), "attesterRegistry moved");
        assertEq(_addressAt(SLOT_PENDING_ADMIN), vault.pendingVaultAdmin(), "pendingVaultAdmin moved");
    }

    function testExecutorSlotStillPacksTheCohortAndAdminEpochBehindTheAddress() external view {
        uint256 packed = uint256(_slot(SLOT_EXECUTOR_PACKED));
        assertEq(address(uint160(packed)), vault.settlementExecutor(), "settlementExecutor moved");
        assertEq(uint32(packed >> 160), lens.cohortId(address(vault)), "cohortId moved within its slot");
        assertEq(uint64(packed >> 192), vault.adminEpoch(), "adminEpoch moved within its slot");
    }

    function testEpochSlotIsStillLaidOutTheSameWay() external view {
        uint256 packed = uint256(_slot(SLOT_EPOCHS_PACKED));
        assertEq(uint64(packed), vault.localPauseEpoch(), "localPauseEpoch moved within its slot");
        assertEq(uint64(packed >> 64), vault.vaultPolicyNonce(), "vaultPolicyNonce moved within its slot");
        assertEq(uint64(packed >> 128), vault.activeTradingAccountCount(), "activeTradingAccountCount moved");
        assertEq((packed >> 192) & 1, vault.settlementPaused() ? 1 : 0, "settlementPaused moved");
    }

    /**
     * `VaultPolicy` must stay ONE slot. This is the assertion that fires the day
     * someone adds an investment field to it, which is the single change most
     * likely to be attempted and most catastrophic if it lands.
     */
    function testVaultPolicyStillOccupiesExactlyOneSlot() external view {
        assertEq(
            uint128(uint256(_slot(SLOT_VAULT_POLICY))),
            lens.getVaultPolicy(address(vault)).maxAggregateRolling30dWei,
            "vaultPolicy moved"
        );
        // The slot immediately after must still be the tradingAccounts mapping,
        // whose base slot reads as zero. A second VaultPolicy field would put
        // data here instead.
        assertEq(uint256(_slot(SLOT_TRADING_ACCOUNTS)), 0, "a field appeared where tradingAccounts starts");
    }

    /**
     * A populated mapping proves the point the scalars cannot: a mapping's slot
     * is the preimage its entries hash from, so a slide does not shift the data,
     * it strands it.
     */
    function testTradingAccountMappingStillResolvesToItsEntry() external view {
        bytes32 entry = keccak256(abi.encode(tradingWallet, bytes32(SLOT_TRADING_ACCOUNTS)));
        // First word of TradingAccount: status(1) — PENDING == 1 after an invite.
        assertEq(uint8(uint256(vm.load(address(vault), entry))), 1, "tradingAccounts base slot moved");
        assertEq(uint8(uint256(vault.getTradingAccount(tradingWallet).status)), 1, "getter disagrees with raw slot");
    }

    function testAggregateBucketsStillOccupyThirtyOneSlots() external view {
        // 31 buckets run S+14..S+44 inclusive, then S+45 is the
        // lifetimeContributions mapping base and S+46 the aggregate scalar.
        assertEq(SLOT_LIFETIME_CONTRIBUTIONS - SLOT_AGGREGATE_BUCKETS, 31, "bucket array length changed");
        assertEq(
            uint128(uint256(_slot(SLOT_AGGREGATE_LIFETIME_CONTRIBUTIONS))),
            vault.aggregateLifetimeContribution(),
            "aggregateLifetimeContributions moved"
        );
    }

    /**
     * The appended `aggregateLifetimeInvested` claims the free upper half of the
     * slot that already held `aggregateLifetimeContributions`. That is only sound
     * because those 16 bytes have never been written by any version of this
     * contract — so on a vault created before the append they must read zero.
     */
    function testTheClaimedHalfSlotIsUnwrittenOnAFreshVault() external view {
        assertEq(uint256(_slot(SLOT_AGGREGATE_LIFETIME_CONTRIBUTIONS)) >> 128, 0, "upper half was not free");
    }

    /**
     * The append may claim the upper half of S+46 and everything from S+47
     * onwards, and nothing before. If any of it landed earlier, one of the
     * assertions above would already have failed — this states the boundary
     * explicitly so the reason is legible rather than inferred.
     */
    function testNothingNewLandedOnTheLifetimeContributionsMapping() external view {
        assertEq(uint256(_slot(SLOT_LIFETIME_CONTRIBUTIONS)), 0, "a field appeared at the lifetimeContributions mapping base");
    }
}
