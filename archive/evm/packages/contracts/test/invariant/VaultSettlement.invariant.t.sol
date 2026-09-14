// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {SettlementExecutor} from "../../src/settlement/SettlementExecutor.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {VaultLens} from "../../src/periphery/VaultLens.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

contract VaultSettlementHandler is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    uint256 internal constant MIN_PROFIT = 0.02 ether;
    uint256 internal constant MAX_PROFIT = 5 ether;

    VaultFactory public immutable factory;
    PersonalVault public immutable vault;
    PersonalVault public immutable competingVault;
    SettlementExecutor public immutable executor;
    ProtocolPauseController public immutable pauseController;

    address public immutable vaultAdmin;
    address public immutable governance;
    address public immutable guardian;
    uint256 internal immutable _attesterKey;

    address[3] internal _wallets;

    mapping(address account => uint256 amount) public savedByAccount;
    /// @dev An L2 head that advances on every action, independently of
    ///      `block.number`. `block.number` is the L1 clock, and the point of the
    ///      settlement change is that many L2 sessions fit inside one L1 block,
    ///      so the fuzzer must be able to produce that shape.
    uint64 public l2Head = 1_000_000;
    mapping(bytes32 accountEpochKey => uint64 endBlockL2) public lastAcceptedEndL2;
    bool public observedNonProgressiveL2;
    uint256 public totalSaved;
    uint256 public successfulSettlements;
    uint256 public attemptedInvalidSettlements;
    bool public unexpectedHandlerFailure;
    bool public unexpectedInvalidSettlementSuccess;
    bool public unexpectedPausedClaimSuccess;

    constructor(
        VaultFactory factory_,
        PersonalVault vault_,
        PersonalVault competingVault_,
        SettlementExecutor executor_,
        ProtocolPauseController pauseController_,
        address vaultAdmin_,
        address governance_,
        address guardian_,
        uint256 attesterKey_,
        address[3] memory wallets_
    ) {
        factory = factory_;
        vault = vault_;
        competingVault = competingVault_;
        executor = executor_;
        pauseController = pauseController_;
        vaultAdmin = vaultAdmin_;
        governance = governance_;
        guardian = guardian_;
        _attesterKey = attesterKey_;
        _wallets = wallets_;
    }

    function settle(uint256 walletSeed, uint96 profitSeed) external {
        address account = _wallet(walletSeed);
        NuvemTypes.TradingAccount memory state = vault.getTradingAccount(account);
        if (pauseController.paused() || vault.settlementPaused() || state.status != NuvemTypes.AccountStatus.ACTIVE) {
            return;
        }

        uint256 profit = bound(uint256(profitSeed), MIN_PROFIT, MAX_PROFIT);
        // Deliberately NOT an unconditional `vm.roll`. The L1 block only advances
        // sometimes, so consecutive settlements land in one L1 block and the
        // fuzzer exercises the case this whole change exists for. The L1
        // freshness rule still needs `endBlock < block.number`, so roll once if
        // the chain has never moved past the window.
        // The window must clear the L1 activation floor and the L1 freshness
        // rule; both are L1-only and both stay. Beyond that the L1 block is left
        // alone, so consecutive settlements land in one L1 block.
        if (block.number <= uint256(state.activationBlock)) vm.roll(uint256(state.activationBlock) + 1);
        if (profitSeed % 3 == 0) vm.roll(block.number + 1);
        NuvemTypes.SettlementAttestation memory attestation = _buildAttestation(account, state, profit);

        uint256 contribution = executor.previewContribution(attestation);
        if (contribution < state.policy.minContributionWei || contribution == 0) return;
        attestation.contribution = contribution;

        bytes memory signature = _sign(attestation);
        vm.prank(account);
        (bool success, bytes memory returnData) = address(executor).call{value: contribution}(
            abi.encodeCall(SettlementExecutor.settle, (attestation, signature))
        );
        if (!success) {
            unexpectedHandlerFailure = true;
            return;
        }

        uint256 savedAmount = abi.decode(returnData, (uint256));
        if (savedAmount != contribution) {
            unexpectedHandlerFailure = true;
            return;
        }

        bytes32 frontierKey = keccak256(abi.encode(account, attestation.bindingEpoch));
        uint64 previousEndL2 = lastAcceptedEndL2[frontierKey];
        if (previousEndL2 != 0 && attestation.startBlockL2 <= previousEndL2) {
            // The vault must never accept a session that failed to advance its
            // own L2 watermark. Reaching here means it did.
            observedNonProgressiveL2 = true;
        }
        lastAcceptedEndL2[frontierKey] = attestation.endBlockL2;

        savedByAccount[account] += savedAmount;
        totalSaved += savedAmount;
        successfulSettlements += 1;
    }

    function attemptInvalidSettlement(uint256 walletSeed, uint96 profitSeed) external {
        address account = _wallet(walletSeed);
        NuvemTypes.TradingAccount memory state = vault.getTradingAccount(account);
        if (pauseController.paused() || vault.settlementPaused() || state.status != NuvemTypes.AccountStatus.ACTIVE) {
            return;
        }

        uint256 profit = bound(uint256(profitSeed), MIN_PROFIT, MAX_PROFIT);
        if (block.number <= uint256(state.activationBlock)) vm.roll(uint256(state.activationBlock) + 1);
        vm.roll(block.number + 1);
        NuvemTypes.SettlementAttestation memory attestation = _buildAttestation(account, state, profit);
        uint256 validContribution = executor.previewContribution(attestation);
        if (validContribution < state.policy.minContributionWei || validContribution == 0) return;

        uint256 invalidContribution = validContribution + 1;
        attestation.contribution = invalidContribution;
        bytes memory signature = _sign(attestation);
        attemptedInvalidSettlements += 1;

        vm.prank(account);
        (bool success,) = address(executor).call{value: invalidContribution}(
            abi.encodeCall(SettlementExecutor.settle, (attestation, signature))
        );
        if (success) unexpectedInvalidSettlementSuccess = true;
    }

    function setSavingsBps(uint256 walletSeed, uint16 savingsBpsSeed) external {
        address account = _wallet(walletSeed);
        if (vault.getTradingAccount(account).status != NuvemTypes.AccountStatus.ACTIVE) return;

        uint16 savingsBps = uint16(bound(savingsBpsSeed, 0, 10_000));
        vm.prank(account);
        (bool success,) = address(vault).call(abi.encodeCall(PersonalVault.setMySavingsBps, (savingsBps)));
        if (!success) unexpectedHandlerFailure = true;
    }

    function pauseAccount(uint256 walletSeed) external {
        address account = _wallet(walletSeed);
        if (vault.getTradingAccount(account).status != NuvemTypes.AccountStatus.ACTIVE) return;

        vm.prank(vaultAdmin);
        (bool success,) = address(vault).call(abi.encodeCall(PersonalVault.pauseTradingAccount, (account)));
        if (!success) unexpectedHandlerFailure = true;
    }

    function unpauseAccount(uint256 walletSeed) external {
        address account = _wallet(walletSeed);
        if (vault.getTradingAccount(account).status != NuvemTypes.AccountStatus.PAUSED) return;

        vm.prank(vaultAdmin);
        (bool success,) = address(vault).call(abi.encodeCall(PersonalVault.unpauseTradingAccount, (account)));
        if (!success) unexpectedHandlerFailure = true;
    }

    function toggleGlobalPause(bool shouldPause) external {
        if (shouldPause == pauseController.paused()) return;

        bool success;
        if (shouldPause) {
            vm.prank(guardian);
            (success,) = address(pauseController).call(abi.encodeCall(ProtocolPauseController.pause, ()));
        } else {
            vm.prank(governance);
            (success,) = address(pauseController).call(abi.encodeCall(ProtocolPauseController.unpause, ()));
        }
        if (!success) unexpectedHandlerFailure = true;
    }

    function attemptClaimPausedAccount(uint256 walletSeed) external {
        address account = _wallet(walletSeed);
        if (vault.getTradingAccount(account).status != NuvemTypes.AccountStatus.PAUSED) return;

        vm.prank(account);
        (bool success,) = address(competingVault).call(abi.encodeCall(PersonalVault.acceptTradingAccount, ()));
        if (success) unexpectedPausedClaimSuccess = true;
    }

    function walletAt(uint256 index) external view returns (address) {
        return _wallets[index];
    }

    function _buildAttestation(address account, NuvemTypes.TradingAccount memory state, uint256 profit)
        private
        returns (NuvemTypes.SettlementAttestation memory attestation)
    {
        uint64 currentBlock = uint64(block.number - 1);
        // Advance the L2 head by a bounded amount and take the next window from
        // it. Many such windows fit inside one L1 block, which is the point.
        uint64 startBlockL2 = l2Head + 1;
        uint64 endBlockL2 = startBlockL2 + uint64(bound(profit, 1, 100));
        l2Head = endBlockL2;

        bytes32 ledgerRoot =
            keccak256(abi.encode(account, state.bindingEpoch, state.settlementNonce, currentBlock, startBlockL2));
        bytes32 sessionId = executor.deriveSessionId(
            block.chainid,
            address(vault),
            account,
            state.bindingEpoch,
            currentBlock,
            currentBlock,
            startBlockL2,
            endBlockL2,
            ledgerRoot
        );

        attestation = NuvemTypes.SettlementAttestation({
            account: account,
            vault: address(vault),
            executor: address(executor),
            chainId: block.chainid,
            bindingEpoch: state.bindingEpoch,
            policyNonce: state.policyNonce,
            adminEpoch: vault.adminEpoch(),
            localPauseEpoch: vault.localPauseEpoch(),
            globalPauseEpoch: pauseController.pauseEpoch(),
            settlementNonce: state.settlementNonce,
            policyHash: vault.policyHash(account),
            sessionId: sessionId,
            ledgerRoot: ledgerRoot,
            startBlock: currentBlock,
            endBlock: currentBlock,
            startBlockL2: startBlockL2,
            endBlockL2: endBlockL2,
            cashStart: 10 ether,
            cashEnd: 10 ether + profit,
            externalDeposits: 0,
            externalWithdrawals: 0,
            realizedProfit: int256(profit),
            contribution: 0,
            attesterEpoch: executor.attesterRegistry().attesterEpoch(),
            validAfter: uint48(block.timestamp),
            deadline: uint48(block.timestamp + 10 minutes)
        });
    }

    function _sign(NuvemTypes.SettlementAttestation memory attestation) private view returns (bytes memory signature) {
        bytes32 digest = executor.hashAttestation(attestation);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_attesterKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _wallet(uint256 seed) private view returns (address) {
        return _wallets[seed % _wallets.length];
    }
}

contract VaultSettlementInvariantTest is StdInvariant, Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    VaultLens internal lens = new VaultLens();
    uint256 internal constant ATTESTER_KEY = 0xA77E57E2;
    uint128 internal constant ACCOUNT_CAP = 5 ether;
    uint128 internal constant AGGREGATE_CAP = 10 ether;

    VaultFactory internal factory;
    PersonalVault internal vault;
    PersonalVault internal competingVault;
    SettlementExecutor internal executor;
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    MockWETH internal weth;
    VaultSettlementHandler internal handler;

    address internal vaultAdmin;
    address internal competingVaultAdmin;
    address internal guardian;
    address[3] internal wallets;

    function setUp() external {
        vm.warp(10 days);
        vm.roll(100);

        vaultAdmin = makeAddr("invariantVaultAdmin");
        competingVaultAdmin = makeAddr("invariantCompetingVaultAdmin");
        guardian = makeAddr("invariantGuardian");
        wallets = [makeAddr("invariantTraderA"), makeAddr("invariantTraderB"), makeAddr("invariantTraderC")];

        weth = new MockWETH();
        pauseController = new ProtocolPauseController(address(this), guardian);
        attesterRegistry = new AttesterRegistry(address(this), guardian, vm.addr(ATTESTER_KEY));
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

        NuvemTypes.VaultInitialization memory initialization = _vaultInitialization();
        vm.prank(vaultAdmin);
        (, address vaultAddress) =
            factory.createVault(keccak256("invariant-primary-vault"), cohortId, abi.encode(initialization));
        vault = PersonalVault(payable(vaultAddress));

        vm.prank(competingVaultAdmin);
        (, address competingVaultAddress) =
            factory.createVault(keccak256("invariant-competing-vault"), cohortId, abi.encode(initialization));
        competingVault = PersonalVault(payable(competingVaultAddress));

        for (uint256 i = 0; i < wallets.length; ++i) {
            _activatePrimaryWallet(wallets[i], i);
            _inviteCompetingWallet(wallets[i], i);
            vm.deal(wallets[i], 100 ether);
        }

        handler = new VaultSettlementHandler(
            factory,
            vault,
            competingVault,
            executor,
            pauseController,
            vaultAdmin,
            address(this),
            guardian,
            ATTESTER_KEY,
            wallets
        );
        vm.deal(address(handler), 100 ether);

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.settle.selector;
        selectors[1] = handler.attemptInvalidSettlement.selector;
        selectors[2] = handler.setSavingsBps.selector;
        selectors[3] = handler.pauseAccount.selector;
        selectors[4] = handler.unpauseAccount.selector;
        selectors[5] = handler.toggleGlobalPause.selector;
        selectors[6] = handler.attemptClaimPausedAccount.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariantAccountSpentNeverExceedsItsCap() external view {
        for (uint256 i = 0; i < wallets.length; ++i) {
            NuvemTypes.RollingCapStatus memory status = vault.accountRollingCapStatus(wallets[i]);
            assertLe(status.spent, status.cap);
            assertEq(uint256(status.spent) + status.remaining, status.cap);
        }
    }

    function invariantAggregateSpentNeverExceedsItsCap() external view {
        NuvemTypes.RollingCapStatus memory status = vault.aggregateRollingCapStatus();
        assertLe(status.spent, status.cap);
        assertEq(uint256(status.spent) + status.remaining, status.cap);
    }

    function invariantLifetimeAttributionSumsExactly() external view {
        uint256 attributed;
        for (uint256 i = 0; i < wallets.length; ++i) {
            uint256 accountLifetime = vault.lifetimeContribution(wallets[i]);
            attributed += accountLifetime;
            assertEq(accountLifetime, handler.savedByAccount(wallets[i]));
        }

        assertEq(attributed, vault.aggregateLifetimeContribution());
        assertEq(attributed, handler.totalSaved());
    }

    function invariantSettlementCannotExtractVaultValue() external view {
        uint256 lifetime = vault.aggregateLifetimeContribution();
        assertEq(weth.balanceOf(address(vault)), lifetime);
        assertEq(address(vault).balance, 0);
        assertEq(address(executor).balance, 0);
    }

    function invariantGlobalBindingSurvivesAccountPause() external view {
        for (uint256 i = 0; i < wallets.length; ++i) {
            NuvemTypes.AccountStatus status = vault.getTradingAccount(wallets[i]).status;
            if (status == NuvemTypes.AccountStatus.ACTIVE || status == NuvemTypes.AccountStatus.PAUSED) {
                assertEq(factory.activeVaultOf(wallets[i]), address(vault));
            }
        }

        assertFalse(handler.unexpectedPausedClaimSuccess());
    }

    /// @notice Every accepted settlement strictly advanced its account's L2
    ///         watermark, and the fuzzer actually reached the shape that used to
    ///         be impossible.
    /// @dev The second half matters as much as the first: without it this
    ///      invariant could pass vacuously on a run where the L1 block happened
    ///      to advance before every settlement, which is precisely the case the
    ///      old rule already handled.
    function invariantEveryAcceptedSessionStrictlyAdvancedItsL2Watermark() external view {
        assertFalse(handler.observedNonProgressiveL2(), "a non-progressive L2 window was accepted");
        for (uint256 i = 0; i < wallets.length; ++i) {
            uint64 bindingEpoch = vault.getTradingAccount(wallets[i]).bindingEpoch;
            (, uint64 frontierL2) = lens.settlementFrontier(address(vault), wallets[i], bindingEpoch);
            assertEq(frontierL2, handler.lastAcceptedEndL2(keccak256(abi.encode(wallets[i], bindingEpoch))));
        }
    }

    function invariantHandlerNeverObservedUnexpectedExecution() external view {
        assertFalse(handler.unexpectedHandlerFailure());
        assertFalse(handler.unexpectedInvalidSettlementSuccess());
    }

    function _activatePrimaryWallet(address account, uint256 index) private {
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(
            account,
            keccak256(abi.encode("primary-platform", index)),
            _tradingPolicy(),
            uint48(block.timestamp + 30 days)
        );
        vm.prank(account);
        vault.acceptTradingAccount();
    }

    function _inviteCompetingWallet(address account, uint256 index) private {
        vm.prank(competingVaultAdmin);
        competingVault.inviteTradingAccount(
            account,
            keccak256(abi.encode("competing-platform", index)),
            _tradingPolicy(),
            uint48(block.timestamp + 30 days)
        );
    }

    function _tradingPolicy() private pure returns (NuvemTypes.TradingAccountPolicy memory) {
        return NuvemTypes.TradingAccountPolicy({
            savingsBps: 5_000,
            minContributionWei: 0.01 ether,
            maxPerSettlementWei: 1.5 ether,
            maxRolling30dWei: ACCOUNT_CAP,
            tradingFloorWei: 1 ether,
            gasReserveWei: 0.1 ether
        });
    }

    function _vaultInitialization() private view returns (NuvemTypes.VaultInitialization memory) {
        return NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(attesterRegistry),
            settlementExecutor: address(executor),
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: AGGREGATE_CAP})
        });
    }
}
