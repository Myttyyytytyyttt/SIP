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

contract SettlementExecutorTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    uint256 internal constant ATTESTER_KEY = 0xA77E57E2;
    uint128 internal constant ACCOUNT_CAP = 10 ether;
    uint128 internal constant AGGREGATE_CAP = 15 ether;
    uint128 internal constant MAX_PER_SETTLEMENT = 2 ether;
    uint128 internal constant TRADING_FLOOR = 1 ether;
    uint128 internal constant GAS_RESERVE = 0.1 ether;
    /// @dev Synthetic L2-per-L1 ratio for helpers. Foundry has one block counter,
    ///      so L1 is `block.number` and L2 is modelled as a free uint64 derived
    ///      from it. Any test that cares about L2 sets the pair explicitly.
    uint64 internal constant L2_PER_L1 = 1_000;

    address internal vaultAdmin;
    address internal trader;
    address internal secondTrader;
    address internal attester;

    VaultFactory internal factory;
    PersonalVault internal vault;
    SettlementExecutor internal executor;
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    MockWETH internal weth;

    function setUp() external {
        vm.warp(10 days);
        vm.roll(100);

        vaultAdmin = makeAddr("vaultAdmin");
        trader = makeAddr("trader");
        secondTrader = makeAddr("secondTrader");
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

        NuvemTypes.VaultPolicy memory vaultPolicy = NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: AGGREGATE_CAP});
        NuvemTypes.VaultInitialization memory init = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(attesterRegistry),
            settlementExecutor: address(executor),
            policy: vaultPolicy
        });

        vm.prank(vaultAdmin);
        (, address vaultAddress) = factory.createVault(keccak256("permanent-vault"), cohortId, abi.encode(init));
        vault = PersonalVault(payable(vaultAddress));

        _linkTrader(trader, 2_000);
        _linkTrader(secondTrader, 3_000);
        vm.deal(trader, 20 ether);
        vm.deal(secondTrader, 20 ether);
        vm.roll(1_000);
    }

    function testAttestationTypehashMatchesTheEncodedStruct() external view {
        // The struct, the typehash string, and the abi.encode list in
        // hashAttestation are three separate places that must agree. Editing two
        // of the three compiles cleanly and silently produces a wrong digest,
        // which would make every attester signature unverifiable. Nothing else
        // in the suite catches that, so pin the literal.
        assertEq(
            executor.SETTLEMENT_ATTESTATION_TYPEHASH(),
            keccak256(
                "SettlementAttestation(address account,address vault,address executor,uint256 chainId,uint64 bindingEpoch,uint64 policyNonce,uint64 adminEpoch,uint64 localPauseEpoch,uint64 globalPauseEpoch,uint64 settlementNonce,bytes32 policyHash,bytes32 sessionId,bytes32 ledgerRoot,uint64 startBlock,uint64 endBlock,uint64 startBlockL2,uint64 endBlockL2,uint256 cashStart,uint256 cashEnd,uint256 externalDeposits,uint256 externalWithdrawals,int256 realizedProfit,uint256 contribution,uint32 attesterEpoch,uint48 validAfter,uint48 deadline)"
            ),
            "typehash drifted from the struct"
        );
        assertEq(
            executor.SETTLEMENT_ATTESTATION_TYPEHASH(),
            bytes32(0x9bd2dea2a8725d725c0b7631f3b26111f1dd7142a802dd34794d9d32180d6aae),
            "typehash value moved"
        );
    }

    /// @notice Binds `hashAttestation`'s abi.encode list to the struct itself.
    /// @dev The typehash test above pins the STRING against the CONSTANT — two of
    ///      the three places that must agree. It cannot see a field that was
    ///      added to the struct and the string but omitted from the abi.encode
    ///      list; that compiles cleanly and silently produces a digest which does
    ///      not commit to the field, so anyone holding a signature could vary it.
    ///      Mutating one field at a time and asserting the digest MOVES is the
    ///      only mechanical check for that, so it is the one this suite lacked.
    function testHashAttestationCommitsToEveryFieldItClaimsTo() external view {
        NuvemTypes.SettlementAttestation memory base = _baseAttestation(trader, 100, 110);
        base.cashStart = 10 ether;
        base.cashEnd = 11 ether;
        base.realizedProfit = int256(1 ether);
        base.contribution = 0.2 ether;
        base.sessionId = _sessionId(base);
        bytes32 digest = executor.hashAttestation(base);

        NuvemTypes.SettlementAttestation memory m = base;
        m.startBlockL2 = base.startBlockL2 + 1;
        assertTrue(executor.hashAttestation(m) != digest, "startBlockL2 is not committed");

        m = base;
        m.endBlockL2 = base.endBlockL2 + 1;
        assertTrue(executor.hashAttestation(m) != digest, "endBlockL2 is not committed");

        m = base;
        m.endBlock = base.endBlock + 1;
        assertTrue(executor.hashAttestation(m) != digest, "endBlock is not committed");

        m = base;
        m.startBlock = base.startBlock - 1;
        assertTrue(executor.hashAttestation(m) != digest, "startBlock is not committed");

        m = base;
        m.ledgerRoot = keccak256("different-root");
        assertTrue(executor.hashAttestation(m) != digest, "ledgerRoot is not committed");

        m = base;
        m.realizedProfit = base.realizedProfit + 1;
        assertTrue(executor.hashAttestation(m) != digest, "realizedProfit is not committed");

        m = base;
        m.contribution = base.contribution + 1;
        assertTrue(executor.hashAttestation(m) != digest, "contribution is not committed");
    }

    /// @notice The Solidity half of the cross-package selector guard.
    /// @dev packages/session-engine-old hardcodes this selector and recognises a
    ///      settlement with `tx.input.startsWith(SETTLE_SELECTOR)`. A stale
    ///      constant makes that predicate return false with no error at all, so
    ///      settlements get misclassified and profit accounting is corrupted
    ///      silently. This fails `forge test` the moment the struct moves, which
    ///      is how the person editing the struct learns the constant exists.
    function testSettleSelectorIsPinnedForCrossPackageConsumers() external pure {
        assertEq(SettlementExecutor.settle.selector, bytes4(0xc8f2629d), "settle selector moved");
    }

    /// @dev Same class of hazard: `deriveSessionId` gained the L2 pair, so every
    ///      off-chain caller must move with it.
    function testDeriveSessionIdSelectorIsPinned() external pure {
        assertEq(SettlementExecutor.deriveSessionId.selector, bytes4(0x689ad24d), "deriveSessionId selector moved");
    }

    function testSettlesExactProfitShareIntoRegisteredVaultAsWeth() external {
        NuvemTypes.SettlementAttestation memory attestation = _attestation(trader, 1 ether, 0.2 ether, 100, 110);

        uint256 saved = _settle(attestation, ATTESTER_KEY);

        assertEq(saved, 0.2 ether);
        assertEq(weth.balanceOf(address(vault)), 0.2 ether);
        assertEq(vault.lifetimeContribution(trader), 0.2 ether);
        assertEq(vault.aggregateLifetimeContribution(), 0.2 ether);
        assertEq(vault.getTradingAccount(trader).settlementNonce, 1);
    }

    function testRecomputesProfitFromCashAndExternalFlows() external {
        NuvemTypes.SettlementAttestation memory attestation = _baseAttestation(trader, 100, 110);
        attestation.cashStart = 5 ether;
        attestation.cashEnd = 7 ether;
        attestation.externalDeposits = 1 ether;
        attestation.externalWithdrawals = 0.5 ether;
        attestation.realizedProfit = 1.5 ether;
        attestation.contribution = 0.3 ether;
        attestation.sessionId = _sessionId(attestation);

        assertEq(_settle(attestation, ATTESTER_KEY), 0.3 ether);
    }

    function testExternalDepositIsExcludedFromRealizedProfit() external {
        NuvemTypes.SettlementAttestation memory attestation =
            _cashFlowAttestation(trader, 100, 110, 5 ether, 9 ether, 3 ether, 0, 0.2 ether);

        assertEq(attestation.realizedProfit, int256(1 ether));
        assertEq(_settle(attestation, ATTESTER_KEY), 0.2 ether);
        assertEq(vault.lifetimeContribution(trader), 0.2 ether);
    }

    function testExternalWithdrawalDoesNotHideRealizedProfit() external {
        NuvemTypes.SettlementAttestation memory attestation =
            _cashFlowAttestation(trader, 100, 110, 5 ether, 3 ether, 0, 3 ether, 0.2 ether);

        assertEq(attestation.realizedProfit, int256(1 ether));
        assertEq(_settle(attestation, ATTESTER_KEY), 0.2 ether);
        assertEq(vault.lifetimeContribution(trader), 0.2 ether);
    }

    function testCrossWindowPositionShowsCashDeltaIsNotPerWindowRealizedProfit() external {
        // Buy an asset for 5 ETH in one window, then sell it for 6 ETH in the
        // next. The round-trip profit is 1 ETH, but independent cash deltas
        // report a 5 ETH loss followed by 6 ETH profit. A production attester
        // therefore needs explicit realized cost-basis semantics; raw wallet
        // cash cannot safely represent realized PnL across open positions.
        int256 buyWindowProfit = executor.calculateRealizedProfit(10 ether, 5 ether, 0, 0);
        int256 sellWindowProfit = executor.calculateRealizedProfit(5 ether, 11 ether, 0, 0);
        int256 roundTripProfit = executor.calculateRealizedProfit(10 ether, 11 ether, 0, 0);

        assertEq(buyWindowProfit, -int256(5 ether));
        assertEq(sellWindowProfit, int256(6 ether));
        assertEq(roundTripProfit, int256(1 ether));
        assertEq(buyWindowProfit + sellWindowProfit, roundTripProfit);

        NuvemTypes.SettlementAttestation memory buyWindow = _baseAttestation(trader, 100, 110);
        buyWindow.cashStart = 10 ether;
        buyWindow.cashEnd = 5 ether;
        buyWindow.realizedProfit = -int256(5 ether);
        buyWindow.sessionId = _sessionId(buyWindow);
        bytes memory buySignature = _sign(buyWindow, ATTESTER_KEY);

        vm.expectPartialRevert(SettlementExecutor.ContributionBelowMinimum.selector);
        vm.prank(trader);
        executor.settle(buyWindow, buySignature);
        assertEq(vault.getTradingAccount(trader).settlementNonce, 0);

        NuvemTypes.SettlementAttestation memory sellWindow = _baseAttestation(trader, 111, 120);
        sellWindow.cashStart = 5 ether;
        sellWindow.cashEnd = 11 ether;
        sellWindow.realizedProfit = int256(6 ether);
        sellWindow.contribution = 1.2 ether;
        sellWindow.sessionId = _sessionId(sellWindow);

        assertEq(_settle(sellWindow, ATTESTER_KEY), 1.2 ether);
        assertEq(vault.lifetimeContribution(trader), 1.2 ether);
    }

    function testRejectsAttesterProfitThatDoesNotMatchLedger() external {
        NuvemTypes.SettlementAttestation memory attestation = _attestation(trader, 1 ether, 0, 100, 110);
        attestation.realizedProfit = 2 ether;
        attestation.contribution = 0.4 ether;
        bytes memory signature = _sign(attestation, ATTESTER_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SettlementExecutor.InvalidRealizedProfit.selector, int256(1 ether), int256(2 ether))
        );
        vm.prank(trader);
        executor.settle{value: 0.4 ether}(attestation, signature);
    }

    function testTrustedAttesterCanAuthorizeCoherentFalseProfitButCapsBoundContribution() external {
        _setAccountPolicy(trader, 10_000, 8 ether, 10 ether, 0);

        // There are no trades behind this test ledger. The current attester can
        // nevertheless sign internally coherent cash inputs reporting 100 ETH
        // profit. Contracts cannot distinguish that lie from a real ledger.
        NuvemTypes.SettlementAttestation memory first = _attestation(trader, 100 ether, 8 ether, 100, 110);
        assertEq(_settle(first, ATTESTER_KEY), 8 ether);

        NuvemTypes.SettlementAttestation memory second = _attestation(trader, 100 ether, 2 ether, 111, 120);
        assertEq(_settle(second, ATTESTER_KEY), 2 ether);

        NuvemTypes.SettlementAttestation memory exhausted = _attestation(trader, 100 ether, 0, 121, 130);
        assertEq(executor.previewContribution(exhausted), 0);
        bytes memory exhaustedSignature = _sign(exhausted, ATTESTER_KEY);
        vm.expectPartialRevert(SettlementExecutor.ContributionBelowMinimum.selector);
        vm.prank(trader);
        executor.settle(exhausted, exhaustedSignature);

        assertEq(vault.lifetimeContribution(trader), 10 ether);
        assertEq(vault.accountRollingCapStatus(trader).spent, 10 ether);
        assertEq(vault.accountRollingCapStatus(trader).remaining, 0);
        assertEq(vault.aggregateRollingCapStatus().spent, 10 ether);
    }

    function testRejectsFutureBlockRangeWithoutConsumingSettlementState() external {
        uint64 futureBlock = uint64(block.number + 1);
        NuvemTypes.SettlementAttestation memory future = _attestation(trader, 1 ether, 0.2 ether, 100, futureBlock);
        bytes memory signature = _sign(future, ATTESTER_KEY);

        vm.expectRevert(abi.encodeWithSelector(SettlementExecutor.InvalidBlockRange.selector, uint64(100), futureBlock));
        vm.prank(trader);
        executor.settle{value: future.contribution}(future, signature);

        assertEq(vault.getTradingAccount(trader).settlementNonce, 0);
        assertEq(vault.accountRollingCapStatus(trader).spent, 0);
        assertEq(vault.aggregateRollingCapStatus().spent, 0);
        assertEq(weth.balanceOf(address(vault)), 0);

        NuvemTypes.SettlementAttestation memory current = _attestation(trader, 1 ether, 0.2 ether, 100, 110);
        assertEq(_settle(current, ATTESTER_KEY), 0.2 ether);
    }

    function testRejectsRangeEndingInCurrentBlock() external {
        uint64 currentBlock = uint64(block.number);
        NuvemTypes.SettlementAttestation memory attestation =
            _attestation(trader, 1 ether, 0.2 ether, 100, currentBlock);
        bytes memory signature = _sign(attestation, ATTESTER_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SettlementExecutor.InvalidBlockRange.selector, uint64(100), currentBlock)
        );
        vm.prank(trader);
        executor.settle{value: attestation.contribution}(attestation, signature);

        assertEq(vault.getTradingAccount(trader).settlementNonce, 0);
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    function testRejectsContributionBelowOrAboveExactMaximum() external {
        NuvemTypes.SettlementAttestation memory attestation = _attestation(trader, 1 ether, 0, 100, 110);
        attestation.contribution = 0.1 ether;
        bytes memory signature = _sign(attestation, ATTESTER_KEY);

        vm.expectRevert(abi.encodeWithSelector(SettlementExecutor.InvalidContribution.selector, 0.2 ether, 0.1 ether));
        vm.prank(trader);
        executor.settle{value: 0.1 ether}(attestation, signature);

        attestation.contribution = 0.3 ether;
        signature = _sign(attestation, ATTESTER_KEY);
        vm.expectRevert(abi.encodeWithSelector(SettlementExecutor.InvalidContribution.selector, 0.2 ether, 0.3 ether));
        vm.prank(trader);
        executor.settle{value: 0.3 ether}(attestation, signature);
    }

    function testTradingReserveLimitsContributionUsingPreCallBalance() external {
        vm.deal(trader, TRADING_FLOOR + GAS_RESERVE + 0.05 ether);
        NuvemTypes.SettlementAttestation memory attestation = _attestation(trader, 1 ether, 0.05 ether, 100, 110);

        assertEq(_settle(attestation, ATTESTER_KEY), 0.05 ether);
        assertEq(trader.balance, TRADING_FLOOR + GAS_RESERVE);
    }

    function testRollingCapsApplyPerAccountAndAcrossUnlimitedAccounts() external {
        _setAccountPolicy(trader, 10_000, 8 ether, 10 ether, 0);
        _setAccountPolicy(secondTrader, 10_000, 8 ether, 10 ether, 0);

        NuvemTypes.SettlementAttestation memory first = _attestation(trader, 8 ether, 8 ether, 100, 110);
        assertEq(_settle(first, ATTESTER_KEY), 8 ether);

        NuvemTypes.SettlementAttestation memory second = _attestation(secondTrader, 10 ether, 7 ether, 111, 120);
        assertEq(_settle(second, ATTESTER_KEY), 7 ether);

        assertEq(vault.accountRollingCapStatus(trader).spent, 8 ether);
        assertEq(vault.accountRollingCapStatus(secondTrader).spent, 7 ether);
        assertEq(vault.aggregateRollingCapStatus().spent, AGGREGATE_CAP);
        assertEq(vault.aggregateRollingCapStatus().remaining, 0);
    }

    function testOldAttestationInvalidAfterTradingWalletChangesPercentage() external {
        NuvemTypes.SettlementAttestation memory stale = _attestation(trader, 1 ether, 0.2 ether, 100, 110);

        vm.prank(trader);
        vault.setMySavingsBps(3_000);

        bytes memory signature = _sign(stale, ATTESTER_KEY);
        vm.expectRevert(SettlementExecutor.InvalidEpoch.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(stale, signature);

        NuvemTypes.SettlementAttestation memory current = _attestation(trader, 1 ether, 0.3 ether, 100, 110);
        assertEq(_settle(current, ATTESTER_KEY), 0.3 ether);
    }

    function testRejectsReplayAndOverlappingBlockRange() external {
        NuvemTypes.SettlementAttestation memory first = _attestation(trader, 1 ether, 0.2 ether, 100, 110);
        bytes memory firstSignature = _sign(first, ATTESTER_KEY);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(first, firstSignature);

        vm.expectPartialRevert(SettlementExecutor.InvalidSettlementNonce.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(first, firstSignature);

        // The overlap is now an L2 overlap. The L1 ranges [100,110] and [110,120]
        // share block 110, which is deliberately permitted; what is refused is
        // that the second L2 window starts on top of the settled L2 frontier.
        NuvemTypes.SettlementAttestation memory overlap = _attestation(trader, 1 ether, 0.2 ether, 110, 120);
        bytes memory overlapSignature = _sign(overlap, ATTESTER_KEY);
        vm.expectPartialRevert(PersonalVault.NonProgressiveBlockRange.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(overlap, overlapSignature);
    }

    function testRejectsWrongSignerChainCallerVaultAndSession() external {
        NuvemTypes.SettlementAttestation memory attestation = _attestation(trader, 1 ether, 0.2 ether, 100, 110);

        bytes memory wrongSignature = _sign(attestation, 0xBAD);
        vm.expectRevert(SettlementExecutor.InvalidAttesterSignature.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(attestation, wrongSignature);

        bytes memory validSignature = _sign(attestation, ATTESTER_KEY);
        vm.expectPartialRevert(SettlementExecutor.InvalidAccount.selector);
        vm.prank(secondTrader);
        executor.settle{value: 0.2 ether}(attestation, validSignature);

        attestation.chainId = block.chainid + 1;
        attestation.sessionId = _sessionId(attestation);
        validSignature = _sign(attestation, ATTESTER_KEY);
        vm.expectPartialRevert(SettlementExecutor.InvalidChain.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(attestation, validSignature);

        attestation.chainId = block.chainid;
        attestation.vault = makeAddr("arbitraryRecipient");
        validSignature = _sign(attestation, ATTESTER_KEY);
        vm.expectPartialRevert(SettlementExecutor.InvalidVault.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(attestation, validSignature);

        attestation.vault = address(vault);
        attestation.sessionId = bytes32(uint256(123));
        validSignature = _sign(attestation, ATTESTER_KEY);
        vm.expectPartialRevert(SettlementExecutor.InvalidSessionId.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(attestation, validSignature);
    }

    function testPauseRotationDeadlineAndPolicyEpochFailClosed() external {
        NuvemTypes.SettlementAttestation memory attestation = _attestation(trader, 1 ether, 0.2 ether, 100, 110);

        pauseController.pause();
        bytes memory signature = _sign(attestation, ATTESTER_KEY);
        vm.expectRevert(SettlementExecutor.ProtocolPaused.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(attestation, signature);
        pauseController.unpause();

        address replacementAttester = makeAddr("replacementAttester");
        attesterRegistry.rotateAttester(replacementAttester);
        vm.expectRevert(SettlementExecutor.InvalidEpoch.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(attestation, signature);

        vm.warp(attestation.deadline + 1);
        vm.expectPartialRevert(SettlementExecutor.AttestationExpired.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(attestation, signature);
    }

    function testRejectsAttestationValidityLongerThanFifteenMinutes() external {
        NuvemTypes.SettlementAttestation memory attestation = _attestation(trader, 1 ether, 0.2 ether, 100, 110);
        attestation.deadline = attestation.validAfter + 15 minutes + 1;
        bytes memory signature = _sign(attestation, ATTESTER_KEY);

        vm.expectPartialRevert(SettlementExecutor.InvalidValidityWindow.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(attestation, signature);
    }

    function testNegativeOrDustProfitCannotSettle() external {
        NuvemTypes.SettlementAttestation memory loss = _attestation(trader, -int256(1 ether), 0, 100, 110);
        bytes memory signature = _sign(loss, ATTESTER_KEY);

        vm.expectPartialRevert(SettlementExecutor.ContributionBelowMinimum.selector);
        vm.prank(trader);
        executor.settle(loss, signature);

        NuvemTypes.SettlementAttestation memory dust = _attestation(trader, int256(0.01 ether), 0.002 ether, 100, 110);
        signature = _sign(dust, ATTESTER_KEY);
        vm.expectPartialRevert(SettlementExecutor.ContributionBelowMinimum.selector);
        vm.prank(trader);
        executor.settle{value: 0.002 ether}(dust, signature);
    }

    function testBreakEvenCannotSettleOrConsumeState() external {
        NuvemTypes.SettlementAttestation memory breakEven = _attestation(trader, 0, 0, 100, 110);
        bytes memory signature = _sign(breakEven, ATTESTER_KEY);

        vm.expectPartialRevert(SettlementExecutor.ContributionBelowMinimum.selector);
        vm.prank(trader);
        executor.settle(breakEven, signature);

        assertEq(vault.getTradingAccount(trader).settlementNonce, 0);
        assertEq(vault.lifetimeContribution(trader), 0);
        assertEq(vault.accountRollingCapStatus(trader).spent, 0);
        assertEq(vault.aggregateRollingCapStatus().spent, 0);
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    function testFuzzPreviewNeverExceedsProfitPolicyCapsOrAvailable(
        uint96 profitRaw,
        uint96 balanceRaw,
        uint16 savingsBps
    ) external {
        savingsBps = uint16(bound(savingsBps, 1, 10_000));
        uint256 profit = bound(uint256(profitRaw), 0.01 ether, 100 ether);
        uint256 balance = bound(uint256(balanceRaw), 0, 100 ether);
        _setAccountPolicy(trader, savingsBps, MAX_PER_SETTLEMENT, ACCOUNT_CAP, 0);
        vm.deal(trader, balance);

        NuvemTypes.SettlementAttestation memory attestation = _attestation(trader, int256(profit), 0, 100, 110);
        uint256 preview = executor.previewContribution(attestation);
        uint256 percentageMaximum = profit * savingsBps / 10_000;
        uint256 reserved = TRADING_FLOOR + GAS_RESERVE;
        uint256 available = balance > reserved ? balance - reserved : 0;

        assertLe(preview, percentageMaximum);
        assertLe(preview, MAX_PER_SETTLEMENT);
        assertLe(preview, ACCOUNT_CAP);
        assertLe(preview, AGGREGATE_CAP);
        assertLe(preview, available);
    }

    function _linkTrader(address account, uint16 savingsBps) internal {
        NuvemTypes.TradingAccountPolicy memory policy = NuvemTypes.TradingAccountPolicy({
            savingsBps: savingsBps,
            minContributionWei: 0.01 ether,
            maxPerSettlementWei: MAX_PER_SETTLEMENT,
            maxRolling30dWei: ACCOUNT_CAP,
            tradingFloorWei: TRADING_FLOOR,
            gasReserveWei: GAS_RESERVE
        });
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(
            account, keccak256(abi.encodePacked("platform", account)), policy, uint48(block.timestamp + 1 days)
        );
        vm.prank(account);
        vault.acceptTradingAccount();
    }

    function _setAccountPolicy(
        address account,
        uint16 savingsBps,
        uint128 maxPerSettlement,
        uint128 rollingCap,
        uint128 minimum
    ) internal {
        NuvemTypes.TradingAccountPolicy memory current = vault.getTradingAccount(account).policy;
        current.savingsBps = savingsBps;
        current.maxPerSettlementWei = maxPerSettlement;
        current.maxRolling30dWei = rollingCap;
        current.minContributionWei = minimum;
        vm.prank(vaultAdmin);
        vault.setTradingAccountPolicy(account, current);
    }

    function _attestation(
        address account,
        int256 realizedProfit,
        uint256 contribution,
        uint64 startBlock,
        uint64 endBlock
    ) internal view returns (NuvemTypes.SettlementAttestation memory attestation) {
        attestation = _baseAttestation(account, startBlock, endBlock);
        if (realizedProfit >= 0) {
            attestation.cashStart = 10 ether;
            attestation.cashEnd = 10 ether + uint256(realizedProfit);
        } else {
            attestation.cashStart = 10 ether;
            attestation.cashEnd = 10 ether - uint256(-realizedProfit);
        }
        attestation.realizedProfit = realizedProfit;
        attestation.contribution = contribution;
        attestation.sessionId = _sessionId(attestation);
    }

    function _cashFlowAttestation(
        address account,
        uint64 startBlock,
        uint64 endBlock,
        uint256 cashStart,
        uint256 cashEnd,
        uint256 externalDeposits,
        uint256 externalWithdrawals,
        uint256 contribution
    ) internal view returns (NuvemTypes.SettlementAttestation memory attestation) {
        attestation = _baseAttestation(account, startBlock, endBlock);
        attestation.cashStart = cashStart;
        attestation.cashEnd = cashEnd;
        attestation.externalDeposits = externalDeposits;
        attestation.externalWithdrawals = externalWithdrawals;
        attestation.realizedProfit =
            executor.calculateRealizedProfit(cashStart, cashEnd, externalDeposits, externalWithdrawals);
        attestation.contribution = contribution;
        attestation.sessionId = _sessionId(attestation);
    }

    function _baseAttestation(address account, uint64 startBlock, uint64 endBlock)
        internal
        view
        returns (NuvemTypes.SettlementAttestation memory attestation)
    {
        NuvemTypes.TradingAccount memory tradingAccount = vault.getTradingAccount(account);
        attestation = NuvemTypes.SettlementAttestation({
            account: account,
            vault: address(vault),
            executor: address(executor),
            chainId: block.chainid,
            bindingEpoch: tradingAccount.bindingEpoch,
            policyNonce: tradingAccount.policyNonce,
            adminEpoch: vault.adminEpoch(),
            localPauseEpoch: vault.localPauseEpoch(),
            globalPauseEpoch: pauseController.pauseEpoch(),
            settlementNonce: tradingAccount.settlementNonce,
            policyHash: vault.policyHash(account),
            sessionId: bytes32(0),
            ledgerRoot: keccak256(abi.encode(account, startBlock, endBlock)),
            startBlock: startBlock,
            endBlock: endBlock,
            startBlockL2: startBlock * L2_PER_L1,
            endBlockL2: endBlock * L2_PER_L1,
            cashStart: 0,
            cashEnd: 0,
            externalDeposits: 0,
            externalWithdrawals: 0,
            realizedProfit: 0,
            contribution: 0,
            attesterEpoch: attesterRegistry.attesterEpoch(),
            validAfter: uint48(block.timestamp),
            deadline: uint48(block.timestamp + 10 minutes)
        });
    }

    function _sessionId(NuvemTypes.SettlementAttestation memory attestation) internal view returns (bytes32) {
        return executor.deriveSessionId(
            attestation.chainId,
            attestation.vault,
            attestation.account,
            attestation.bindingEpoch,
            attestation.startBlock,
            attestation.endBlock,
            attestation.startBlockL2,
            attestation.endBlockL2,
            attestation.ledgerRoot
        );
    }

    function _settle(NuvemTypes.SettlementAttestation memory attestation, uint256 signerKey)
        internal
        returns (uint256 saved)
    {
        bytes memory signature = _sign(attestation, signerKey);
        vm.prank(attestation.account);
        return executor.settle{value: attestation.contribution}(attestation, signature);
    }

    function _sign(NuvemTypes.SettlementAttestation memory attestation, uint256 signerKey)
        internal
        view
        returns (bytes memory signature)
    {
        bytes32 digest = executor.hashAttestation(attestation);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
