// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {SettlementExecutor} from "../../src/settlement/SettlementExecutor.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

contract ReplacementExecutorStub {}

/// @notice `setSettlementExecutor` is the vault's only migration path and had no
///         test at all. This redeploy makes it load-bearing.
contract VaultExecutorMigrationTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    uint256 internal constant ATTESTER_KEY = 0xA77E57E2;
    uint128 internal constant AGGREGATE_CAP = 15 ether;

    address internal vaultAdmin;
    address internal trader;
    address internal stranger;
    address internal attester;

    VaultFactory internal factory;
    PersonalVault internal vault;
    SettlementExecutor internal executor;
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    MockWETH internal weth;

    event SettlementExecutorUpdated(address indexed previousExecutor, address indexed nextExecutor);
    event VaultPauseUpdated(bool settlementPaused, uint64 pauseEpoch);

    function setUp() external {
        vm.warp(10 days);
        vm.roll(100);

        vaultAdmin = makeAddr("vaultAdmin");
        trader = makeAddr("trader");
        stranger = makeAddr("stranger");
        attester = vm.addr(ATTESTER_KEY);

        pauseController = new ProtocolPauseController(address(this), address(this));
        attesterRegistry = new AttesterRegistry(address(this), address(this), attester);
        weth = new MockWETH();
        factory = new VaultFactory(address(this));
        executor = new SettlementExecutor(address(factory), address(attesterRegistry), address(pauseController));
        factory.configureProtocol(
            VaultFactory.ProtocolConfiguration({
                weth: address(weth),
                pauseController: address(pauseController),
                attesterRegistry: address(attesterRegistry),
                settlementExecutor: address(executor)
            })
        );

        PersonalVault implementation = new PersonalVault(address(adapterRegistry));
        (uint32 cohortId,) = factory.registerCohort(address(implementation), address(this));

        vm.prank(vaultAdmin);
        (, address vaultAddress) = factory.createVault(
            keccak256("migration-vault"),
            cohortId,
            abi.encode(
                NuvemTypes.VaultInitialization({
                    weth: address(weth),
                    pauseController: address(pauseController),
                    attesterRegistry: address(attesterRegistry),
                    settlementExecutor: address(executor),
                    policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: AGGREGATE_CAP})
                })
            )
        );
        vault = PersonalVault(payable(vaultAddress));

        NuvemTypes.TradingAccountPolicy memory policy = NuvemTypes.TradingAccountPolicy({
            savingsBps: 2_000,
            minContributionWei: 0.0001 ether,
            maxPerSettlementWei: 2 ether,
            maxRolling30dWei: 10 ether,
            tradingFloorWei: 1 ether,
            gasReserveWei: 0.1 ether
        });
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(trader, keccak256("gmgn"), policy, uint48(block.timestamp + 1 days));
        vm.prank(trader);
        vault.acceptTradingAccount();
        vm.deal(trader, 50 ether);
        vm.roll(1_000);
    }

    /// @notice All four state effects, and both events.
    function testSetSettlementExecutorAppliesAllFourStateEffects() external {
        address next = address(new ReplacementExecutorStub());
        uint64 pauseEpochBefore = vault.localPauseEpoch();
        uint64 policyNonceBefore = vault.vaultPolicyNonce();
        assertFalse(vault.settlementPaused(), "precondition: settlement is live");

        vm.expectEmit(true, true, false, false, address(vault));
        emit SettlementExecutorUpdated(address(executor), next);
        vm.expectEmit(false, false, false, true, address(vault));
        emit VaultPauseUpdated(true, pauseEpochBefore + 1);

        vm.prank(vaultAdmin);
        vault.setSettlementExecutor(next);

        assertEq(vault.settlementExecutor(), next);
        assertTrue(vault.settlementPaused(), "settlement must be force-paused");
        assertEq(vault.localPauseEpoch(), pauseEpochBefore + 1);
        assertEq(vault.vaultPolicyNonce(), policyNonceBefore + 1);
    }

    /// @notice Swapping the executor kills every attestation already signed.
    /// @dev This is the property that makes the function safe to expose at all:
    ///      `policyHash` commits to `settlementExecutor` and `vaultPolicyNonce`,
    ///      so both move and every outstanding signature becomes unusable.
    function testSetSettlementExecutorInvalidatesEveryInFlightPolicyHash() external {
        bytes32 policyHashBefore = vault.policyHash(trader);
        NuvemTypes.SettlementAttestation memory preSigned = _attestation(500, 500, 1_000, 1_120);
        bytes memory signature = _sign(preSigned);
        address next = address(new ReplacementExecutorStub());

        vm.prank(vaultAdmin);
        vault.setSettlementExecutor(next);

        assertTrue(vault.policyHash(trader) != policyHashBefore, "policyHash must move");

        vm.expectRevert();
        vm.prank(trader);
        executor.settle{value: preSigned.contribution}(preSigned, signature);
    }

    function testSetSettlementExecutorIsAdminOnlyAndRejectsZeroAndEoas() external {
        address next = address(new ReplacementExecutorStub());

        vm.prank(trader);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.setSettlementExecutor(next);

        vm.prank(stranger);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.setSettlementExecutor(next);

        vm.prank(vaultAdmin);
        vm.expectRevert(PersonalVault.ZeroAddress.selector);
        vault.setSettlementExecutor(address(0));

        // An EOA cannot be installed. This is the strongest guard available here:
        // `configureProtocol` is one-shot, so gating on the factory's pinned
        // executor would reduce this function to a no-op and remove the only
        // migration path the vault has.
        vm.prank(vaultAdmin);
        vm.expectRevert(abi.encodeWithSelector(PersonalVault.NotAContract.selector, stranger));
        vault.setSettlementExecutor(stranger);

        assertEq(vault.settlementExecutor(), address(executor), "no failed call may have moved it");
    }

    /// @notice The forced pause is a real gate, not cosmetic.
    function testSettlementResumesOnlyAfterAdminExplicitlyUnpauses() external {
        // Reinstall the same real executor so a valid settlement is constructible
        // afterwards; only the forced pause should stand in the way.
        address interim = address(new ReplacementExecutorStub());
        vm.prank(vaultAdmin);
        vault.setSettlementExecutor(interim);
        vm.prank(vaultAdmin);
        vault.setSettlementExecutor(address(executor));
        assertTrue(vault.settlementPaused());

        NuvemTypes.SettlementAttestation memory paused = _attestation(500, 500, 1_000, 1_120);
        bytes memory pausedSignature = _sign(paused);
        vm.expectRevert(SettlementExecutor.InvalidAccountState.selector);
        vm.prank(trader);
        executor.settle{value: paused.contribution}(paused, pausedSignature);

        vm.prank(vaultAdmin);
        vault.setLocalPause(false);

        NuvemTypes.SettlementAttestation memory resumed = _attestation(500, 500, 1_000, 1_120);
        bytes memory resumedSignature = _sign(resumed);
        vm.prank(trader);
        assertEq(executor.settle{value: resumed.contribution}(resumed, resumedSignature), resumed.contribution);
    }

    /// @notice `InvalidAccountState` fires on the executor-mismatch limb.
    /// @dev This test is easy to write wrongly. `setSettlementExecutor` force-sets
    ///      `settlementPaused`, and `_validateCurrentVaultState` short-circuits
    ///      `settlementPaused || status != ACTIVE || executor mismatch` into ONE
    ///      error at ONE revert site. A test that swaps and immediately calls
    ///      settle passes on the pause limb and proves nothing. The unpause below
    ///      is what isolates the limb actually under test.
    function testInvalidAccountStateWhenVaultExecutorNoLongerMatchesTheCaller() external {
        address next = address(new ReplacementExecutorStub());
        vm.prank(vaultAdmin);
        vault.setSettlementExecutor(next);

        // Clear the forced pause so the first limb cannot fire.
        vm.prank(vaultAdmin);
        vault.setLocalPause(false);
        assertFalse(vault.settlementPaused());
        assertEq(vault.getTradingAccount(trader).status == NuvemTypes.AccountStatus.ACTIVE, true);

        // Rebuild against the POST-change adminEpoch/localPauseEpoch/policyHash so
        // the epoch and policy-hash checks cannot fire first either.
        NuvemTypes.SettlementAttestation memory fresh = _attestation(500, 500, 1_000, 1_120);
        bytes memory signature = _sign(fresh);

        vm.expectRevert(SettlementExecutor.InvalidAccountState.selector);
        vm.prank(trader);
        executor.settle{value: fresh.contribution}(fresh, signature);
    }

    /// @notice Characterises the residual admin power deliberately.
    /// @dev The vault does not check that the replacement is the factory's
    ///      configured executor (it cannot — see the guard test above). An
    ///      installed contract can therefore drive `acceptSettlement` with a
    ///      hand-built record, bypassing profit recomputation, the attester
    ///      signature and the trading reserve. It cannot MINT value: `msg.value`
    ///      must equal the contribution, so the admin funds it themselves. This
    ///      is admin-only self-harm and is pinned here as accepted, not hidden.
    function testAnInstalledExecutorCanDriveAcceptSettlementDirectly() external {
        address stub = address(new ReplacementExecutorStub());
        vm.prank(vaultAdmin);
        vault.setSettlementExecutor(stub);
        vm.prank(vaultAdmin);
        vault.setLocalPause(false);

        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(trader);
        NuvemTypes.SettlementRecord memory record = NuvemTypes.SettlementRecord({
            account: trader,
            bindingEpoch: account.bindingEpoch,
            policyNonce: account.policyNonce,
            settlementNonce: account.settlementNonce,
            policyHash: vault.policyHash(trader),
            sessionId: keccak256("hand-built-session"),
            ledgerRoot: keccak256("hand-built-ledger"),
            startBlock: 500,
            endBlock: 500,
            startBlockL2: 1_000,
            endBlockL2: 1_120,
            contribution: 0.2 ether
        });

        vm.deal(stub, 1 ether);
        vm.prank(stub);
        vault.acceptSettlement{value: 0.2 ether}(record);

        // The value came from the caller, not from thin air.
        assertEq(vault.lifetimeContribution(trader), 0.2 ether);
        assertEq(weth.balanceOf(address(vault)), 0.2 ether);
        assertEq(stub.balance, 0.8 ether);
    }

    function _attestation(uint64 startBlock, uint64 endBlock, uint64 startBlockL2, uint64 endBlockL2)
        internal
        view
        returns (NuvemTypes.SettlementAttestation memory attestation)
    {
        NuvemTypes.TradingAccount memory tradingAccount = vault.getTradingAccount(trader);
        attestation = NuvemTypes.SettlementAttestation({
            account: trader,
            vault: address(vault),
            executor: address(executor),
            chainId: block.chainid,
            bindingEpoch: tradingAccount.bindingEpoch,
            policyNonce: tradingAccount.policyNonce,
            adminEpoch: vault.adminEpoch(),
            localPauseEpoch: vault.localPauseEpoch(),
            globalPauseEpoch: pauseController.pauseEpoch(),
            settlementNonce: tradingAccount.settlementNonce,
            policyHash: vault.policyHash(trader),
            sessionId: bytes32(0),
            ledgerRoot: keccak256(abi.encode(startBlockL2, endBlockL2)),
            startBlock: startBlock,
            endBlock: endBlock,
            startBlockL2: startBlockL2,
            endBlockL2: endBlockL2,
            cashStart: 10 ether,
            cashEnd: 11 ether,
            externalDeposits: 0,
            externalWithdrawals: 0,
            realizedProfit: int256(1 ether),
            contribution: 0.2 ether,
            attesterEpoch: attesterRegistry.attesterEpoch(),
            validAfter: uint48(block.timestamp),
            deadline: uint48(block.timestamp + 10 minutes)
        });
        attestation.sessionId = executor.deriveSessionId(
            block.chainid,
            address(vault),
            trader,
            tradingAccount.bindingEpoch,
            startBlock,
            endBlock,
            startBlockL2,
            endBlockL2,
            attestation.ledgerRoot
        );
    }

    function _sign(NuvemTypes.SettlementAttestation memory attestation) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, executor.hashAttestation(attestation));
        return abi.encodePacked(r, s, v);
    }
}
