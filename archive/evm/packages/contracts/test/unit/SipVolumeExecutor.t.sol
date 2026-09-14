// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {SettlementExecutor} from "../../src/settlement/SettlementExecutor.sol";
import {SipVolumeExecutor} from "../../src/settlement/SipVolumeExecutor.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

/// @notice Mirrors `SettlementExecutor.t.sol`'s harness, with one difference that
///         is the production path: the factory is pinned to the LEGACY executor
///         (as it is on chain 4663, one-shot), the vault is created against it,
///         and then the admin re-points the vault at `SipVolumeExecutor` with
///         `setSettlementExecutor` + `setLocalPause(false)`.
contract SipVolumeExecutorTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    uint256 internal constant ATTESTER_KEY = 0xA77E57E2;
    uint16 internal constant SAVINGS_BPS = 2_000;
    uint128 internal constant MIN_CONTRIBUTION = 0.01 ether;
    uint128 internal constant ACCOUNT_CAP = 10 ether;
    uint128 internal constant AGGREGATE_CAP = 15 ether;
    uint128 internal constant MAX_PER_SETTLEMENT = 2 ether;
    uint128 internal constant TRADING_FLOOR = 1 ether;
    uint128 internal constant GAS_RESERVE = 0.1 ether;
    uint64 internal constant WINDOW_START_L2 = 5_000_000;
    uint64 internal constant WINDOW_END_L2 = 5_000_640;

    address internal vaultAdmin;
    address internal trader;
    address internal secondTrader;
    address internal attester;

    VaultFactory internal factory;
    PersonalVault internal vault;
    SettlementExecutor internal legacy;
    SipVolumeExecutor internal executor;
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    MockWETH internal weth;
    uint32 internal cohortId;

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
        legacy = new SettlementExecutor(address(factory), address(attesterRegistry), address(pauseController));
        executor = new SipVolumeExecutor(address(factory), address(attesterRegistry), address(pauseController));
        factory.configureProtocol(
            VaultFactory.ProtocolConfiguration({
                weth: address(weth),
                pauseController: address(pauseController),
                attesterRegistry: address(attesterRegistry),
                settlementExecutor: address(legacy)
            })
        );

        PersonalVault implementation = new PersonalVault(address(adapterRegistry));
        (cohortId,) = factory.registerCohort(address(implementation), address(this));

        vault = _createVault(vaultAdmin, keccak256("permanent-vault"));
        _repoint(vault, vaultAdmin);

        _linkTrader(vault, vaultAdmin, trader, SAVINGS_BPS);
        _linkTrader(vault, vaultAdmin, secondTrader, 3_000);
        vm.deal(trader, 20 ether);
        vm.deal(secondTrader, 20 ether);
        vm.roll(1_000);
    }

    // ───────────────────────────── shape pins ─────────────────────────────

    function testAttestationTypehashMatchesTheEncodedStruct() external view {
        assertEq(
            executor.VOLUME_ATTESTATION_TYPEHASH(),
            keccak256(
                "VolumeAttestation(uint256 chainId,address vault,address account,address executor,uint64 bindingEpoch,uint64 policyNonce,uint64 settlementNonce,uint64 adminEpoch,uint64 localPauseEpoch,uint64 globalPauseEpoch,uint32 attesterEpoch,bytes32 policyHash,bytes32 batchRoot,uint64 startBlockL2,uint64 endBlockL2,uint256 sumNotionalWei,uint256 owedWei,uint48 validAfter,uint48 deadline)"
            ),
            "typehash drifted from the struct"
        );
        assertEq(
            executor.VOLUME_ATTESTATION_TYPEHASH(),
            bytes32(0x79c187432aad428b01e66b863ffd4480c0273dac8f63cfae0cbb0440a3af01fa),
            "typehash value moved"
        );
    }

    /// @dev The worker's Privy policy pins `pull`'s ABI and selector; a stale
    ///      selector there is a silent DENY, not an error.
    function testPullSelectorIsPinnedForThePrivyPolicy() external pure {
        assertEq(SipVolumeExecutor.pull.selector, bytes4(0x14b1e97a), "pull selector moved");
    }

    /// @dev Mutating one field at a time is the only mechanical proof that the
    ///      abi.encode list in `hashAttestation` did not drop one.
    function testHashAttestationCommitsToEveryField() external view {
        SipVolumeExecutor.VolumeAttestation memory base = _attestation(trader, 1 ether, keccak256("batch"));
        bytes32 digest = executor.hashAttestation(base);
        SipVolumeExecutor.VolumeAttestation memory m;

        m = _clone(base);
        m.chainId += 1;
        assertTrue(executor.hashAttestation(m) != digest, "chainId");
        m = _clone(base);
        m.vault = address(1);
        assertTrue(executor.hashAttestation(m) != digest, "vault");
        m = _clone(base);
        m.account = address(1);
        assertTrue(executor.hashAttestation(m) != digest, "account");
        m = _clone(base);
        m.executor = address(1);
        assertTrue(executor.hashAttestation(m) != digest, "executor");
        m = _clone(base);
        m.bindingEpoch += 1;
        assertTrue(executor.hashAttestation(m) != digest, "bindingEpoch");
        m = _clone(base);
        m.policyNonce += 1;
        assertTrue(executor.hashAttestation(m) != digest, "policyNonce");
        m = _clone(base);
        m.settlementNonce += 1;
        assertTrue(executor.hashAttestation(m) != digest, "settlementNonce");
        m = _clone(base);
        m.adminEpoch += 1;
        assertTrue(executor.hashAttestation(m) != digest, "adminEpoch");
        m = _clone(base);
        m.localPauseEpoch += 1;
        assertTrue(executor.hashAttestation(m) != digest, "localPauseEpoch");
        m = _clone(base);
        m.globalPauseEpoch += 1;
        assertTrue(executor.hashAttestation(m) != digest, "globalPauseEpoch");
        m = _clone(base);
        m.attesterEpoch += 1;
        assertTrue(executor.hashAttestation(m) != digest, "attesterEpoch");
        m = _clone(base);
        m.policyHash = keccak256("x");
        assertTrue(executor.hashAttestation(m) != digest, "policyHash");
        m = _clone(base);
        m.batchRoot = keccak256("x");
        assertTrue(executor.hashAttestation(m) != digest, "batchRoot");
        m = _clone(base);
        m.startBlockL2 += 1;
        assertTrue(executor.hashAttestation(m) != digest, "startBlockL2");
        m = _clone(base);
        m.endBlockL2 += 1;
        assertTrue(executor.hashAttestation(m) != digest, "endBlockL2");
        m = _clone(base);
        m.sumNotionalWei += 1;
        assertTrue(executor.hashAttestation(m) != digest, "sumNotionalWei");
        m = _clone(base);
        m.owedWei += 1;
        assertTrue(executor.hashAttestation(m) != digest, "owedWei");
        m = _clone(base);
        m.validAfter += 1;
        assertTrue(executor.hashAttestation(m) != digest, "validAfter");
        m = _clone(base);
        m.deadline += 1;
        assertTrue(executor.hashAttestation(m) != digest, "deadline");
    }

    // ───────────────────────────── happy path ─────────────────────────────

    function testPullsTheWholeOwedAmountIntoTheVaultAsWeth() external {
        bytes32 batchRoot = keccak256("batch-1");
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, batchRoot);
        assertEq(a.owedWei, 0.2 ether, "20% of 1 ETH notional");
        uint256 vaultWethBefore = weth.balanceOf(address(vault));
        uint256 traderBefore = trader.balance;

        vm.expectEmit(true, true, true, true, address(executor));
        emit SipVolumeExecutor.VolumePulled(trader, address(vault), batchRoot, 1 ether, 0.2 ether, 0.2 ether, 0);
        uint256 debtAfter = _pull(a, 0.2 ether, ATTESTER_KEY);

        assertEq(debtAfter, 0);
        assertEq(weth.balanceOf(address(vault)) - vaultWethBefore, 0.2 ether, "vault WETH grows by exactly msg.value");
        assertEq(trader.balance, traderBefore - 0.2 ether);
        assertEq(address(executor).balance, 0, "the executor never holds value between transactions");
        assertEq(executor.owed(trader), 0.2 ether);
        assertEq(executor.collected(trader), 0.2 ether);
        assertEq(executor.debtOf(trader), 0);
        assertEq(executor.syntheticFrontier(trader), 2);
        assertTrue(executor.usedBatch(batchRoot));
        assertEq(vault.getTradingAccount(trader).settlementNonce, 1);
        assertEq(vault.lifetimeContribution(trader), 0.2 ether);
        assertEq(vault.accountRollingCapStatus(trader).spent, 0.2 ether);
    }

    function testVaultRecordsTheSyntheticSessionKey() external {
        bytes32 batchRoot = keccak256("batch-1");
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, batchRoot);
        bytes32 expectedSessionId =
            executor.deriveSessionId(block.chainid, address(vault), trader, a.bindingEpoch, batchRoot);

        vm.expectEmit(true, true, true, true, address(vault));
        emit PersonalVault.ContributionReceived(
            vault.vaultId(), trader, expectedSessionId, a.bindingEpoch, a.settlementNonce, 0.2 ether
        );
        _pull(a, 0.2 ether, ATTESTER_KEY);
    }

    // ───────────────────────────── carried debt ─────────────────────────────

    function testTwoPartialPullsCarryDebtAndALaterPullClearsIt() external {
        // Window 1: owed 0.2, the wallet can only spare 0.05.
        SipVolumeExecutor.VolumeAttestation memory first = _attestation(trader, 1 ether, keccak256("w1"));
        assertEq(_pull(first, 0.05 ether, ATTESTER_KEY), 0.15 ether);
        assertEq(executor.debtOf(trader), 0.15 ether);
        assertEq(executor.syntheticFrontier(trader), 2);

        // Window 2: owed 0.2 more, pays 0.1 — still partial, debt keeps growing.
        SipVolumeExecutor.VolumeAttestation memory second = _attestation(trader, 1 ether, keccak256("w2"));
        assertEq(_pull(second, 0.1 ether, ATTESTER_KEY), 0.25 ether);
        assertEq(executor.debtOf(trader), 0.25 ether);
        assertEq(executor.owed(trader), 0.4 ether);
        assertEq(executor.collected(trader), 0.15 ether);
        assertEq(executor.syntheticFrontier(trader), 4);
        assertEq(vault.getTradingAccount(trader).settlementNonce, 2);

        // Window 3: owed 0.2 more; the wallet has recovered and pays everything
        // outstanding — 0.45 — which is more than this window alone.
        SipVolumeExecutor.VolumeAttestation memory third = _attestation(trader, 1 ether, keccak256("w3"));
        bytes memory signature = _sign(third, ATTESTER_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(
                SipVolumeExecutor.ContributionExceedsOutstanding.selector, 0.45 ether + 1, 0.45 ether
            )
        );
        vm.prank(trader);
        executor.pull{value: 0.45 ether + 1}(third, signature);

        assertEq(_pull(third, 0.45 ether, ATTESTER_KEY), 0);
        assertEq(executor.debtOf(trader), 0);
        assertEq(executor.owed(trader), 0.6 ether);
        assertEq(executor.collected(trader), 0.6 ether);
        assertEq(weth.balanceOf(address(vault)), 0.6 ether);
        assertEq(vault.lifetimeContribution(trader), 0.6 ether);
        assertEq(executor.syntheticFrontier(trader), 6);
    }

    // ───────────────────────────── replay / staleness ─────────────────────────────

    function testBatchReplayRevertsEvenWithAFreshNonce() external {
        bytes32 batchRoot = keccak256("batch-1");
        SipVolumeExecutor.VolumeAttestation memory first = _attestation(trader, 1 ether, batchRoot);
        _pull(first, 0.05 ether, ATTESTER_KEY);

        // The attester re-signs the SAME batch against the now-current nonce.
        // Everything about the attestation is live; only the root is spent.
        SipVolumeExecutor.VolumeAttestation memory again = _attestation(trader, 1 ether, batchRoot);
        assertEq(again.settlementNonce, 1);
        bytes memory signature = _sign(again, ATTESTER_KEY);
        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.BatchAlreadyUsed.selector, batchRoot));
        vm.prank(trader);
        executor.pull{value: 0.05 ether}(again, signature);

        assertEq(executor.owed(trader), 0.2 ether, "a replayed batch is not owed twice");
        assertEq(vault.getTradingAccount(trader).settlementNonce, 1);
    }

    function testStaleSettlementNonceReverts() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        bytes memory signature = _sign(a, ATTESTER_KEY);
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);

        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.InvalidSettlementNonce.selector, uint64(1), uint64(0)));
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);
    }

    // ───────────────────────────── value bounds ─────────────────────────────

    function testValueAboveOwedReverts() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        bytes memory signature = _sign(a, ATTESTER_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.ContributionExceedsOutstanding.selector, 0.2 ether + 1, 0.2 ether)
        );
        vm.prank(trader);
        executor.pull{value: 0.2 ether + 1}(a, signature);
    }

    function testValueAbovePerSettlementCapReverts() external {
        // 100 ETH of notional owes 20 ETH; the policy caps one pull at 2 ETH.
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 100 ether, keccak256("batch-1"));
        bytes memory signature = _sign(a, ATTESTER_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(
                SipVolumeExecutor.ContributionExceedsPerSettlementCap.selector, 2 ether + 1, MAX_PER_SETTLEMENT
            )
        );
        vm.prank(trader);
        executor.pull{value: 2 ether + 1}(a, signature);

        // Exactly the cap goes through; the rest is carried.
        assertEq(_pull(a, 2 ether, ATTESTER_KEY), 18 ether);
    }

    function testValueAboveRollingRemaindersReverts() external {
        _setAccountPolicy(trader, SAVINGS_BPS, 8 ether, 10 ether, 0);
        _setAccountPolicy(secondTrader, SAVINGS_BPS, 8 ether, 10 ether, 0);

        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 100 ether, keccak256("t-1"));
        assertEq(_pull(a, 8 ether, ATTESTER_KEY), 12 ether);
        assertEq(vault.accountRollingCapStatus(trader).remaining, 2 ether);

        SipVolumeExecutor.VolumeAttestation memory b = _attestation(trader, 100 ether, keccak256("t-2"));
        bytes memory signature = _sign(b, ATTESTER_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.ContributionExceedsAccountRollingCap.selector, 3 ether, 2 ether)
        );
        vm.prank(trader);
        executor.pull{value: 3 ether}(b, signature);

        // The aggregate cap is 15: 8 already spent by trader, so the second
        // trader can take at most 7 even though its own remaining is 10.
        SipVolumeExecutor.VolumeAttestation memory c = _attestation(secondTrader, 100 ether, keccak256("s-1"));
        signature = _sign(c, ATTESTER_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.ContributionExceedsAggregateRollingCap.selector, 8 ether, 7 ether)
        );
        vm.prank(secondTrader);
        executor.pull{value: 8 ether}(c, signature);

        assertEq(_pull(c, 7 ether, ATTESTER_KEY), 13 ether);
        assertEq(vault.aggregateRollingCapStatus().remaining, 0);
    }

    function testValueBelowMinimumOrZeroReverts() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        bytes memory signature = _sign(a, ATTESTER_KEY);

        vm.expectRevert(SipVolumeExecutor.ZeroContribution.selector);
        vm.prank(trader);
        executor.pull(a, signature);

        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.ContributionBelowMinimum.selector, 0.005 ether, MIN_CONTRIBUTION)
        );
        vm.prank(trader);
        executor.pull{value: 0.005 ether}(a, signature);

        assertEq(executor.owed(trader), 0, "a refused pull credits nothing");
        assertFalse(executor.usedBatch(a.batchRoot));
    }

    /// @notice There is deliberately NO balance clamp: a wallet that sends more
    ///         than `balance − floor − reserve` is allowed to.
    function testNoBalanceClampAndNoExactMaximum() external {
        vm.deal(trader, TRADING_FLOOR + GAS_RESERVE + 0.05 ether);
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        // 0.2 owed; the legacy executor would have clamped this to 0.05.
        assertEq(_pull(a, 0.2 ether, ATTESTER_KEY), 0);
        assertEq(trader.balance, TRADING_FLOOR + GAS_RESERVE - 0.15 ether);
    }

    function testOwedMustMatchThePolicyBps() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        a.owedWei = 0.3 ether;
        bytes memory signature = _sign(a, ATTESTER_KEY);
        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.InvalidOwed.selector, 0.2 ether, 0.3 ether));
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);

        // A wallet that opted out (bps = 0) owes nothing, whatever is signed.
        vm.prank(trader);
        vault.setMySavingsBps(0);
        SipVolumeExecutor.VolumeAttestation memory optedOut = _attestation(trader, 1 ether, keccak256("batch-2"));
        assertEq(optedOut.owedWei, 0);
        optedOut.owedWei = 0.2 ether;
        signature = _sign(optedOut, ATTESTER_KEY);
        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.InvalidOwed.selector, 0, 0.2 ether));
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(optedOut, signature);
    }

    // ───────────────────────────── attester ─────────────────────────────

    function testWrongAttesterReverts() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));

        bytes memory wrongSignature = _sign(a, 0xBAD);
        vm.expectRevert(SipVolumeExecutor.InvalidAttesterSignature.selector);
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, wrongSignature);

        // Rotation invalidates the epoch the attestation was signed under...
        bytes memory oldSignature = _sign(a, ATTESTER_KEY);
        uint256 replacementKey = 0xB0B;
        attesterRegistry.rotateAttester(vm.addr(replacementKey));
        vm.expectRevert(SipVolumeExecutor.InvalidEpoch.selector);
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, oldSignature);

        // ...and the old key cannot sign under the new epoch.
        SipVolumeExecutor.VolumeAttestation memory fresh = _attestation(trader, 1 ether, keccak256("batch-1"));
        bytes memory staleKeySignature = _sign(fresh, ATTESTER_KEY);
        vm.expectRevert(SipVolumeExecutor.InvalidAttesterSignature.selector);
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(fresh, staleKeySignature);

        assertEq(_pull(fresh, 0.2 ether, replacementKey), 0);
    }

    // ───────────────────────────── L1 activation floor ─────────────────────────────

    function testFirstPullInsideTheActivationL1BlockReverts() external {
        address fresh = makeAddr("freshTrader");
        vm.deal(fresh, 5 ether);
        _linkTrader(vault, vaultAdmin, fresh, SAVINGS_BPS);
        uint64 activation = vault.getTradingAccount(fresh).activationBlock;
        assertEq(activation, uint64(block.number));

        SipVolumeExecutor.VolumeAttestation memory a = _attestation(fresh, 1 ether, keccak256("fresh-1"));
        bytes memory signature = _sign(a, ATTESTER_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.ActivationTooRecent.selector, activation, block.number - 1)
        );
        vm.prank(fresh);
        executor.pull{value: 0.2 ether}(a, signature);
        assertFalse(executor.usedBatch(a.batchRoot), "nothing consumed");

        vm.roll(block.number + 1);
        assertEq(_pull(a, 0.2 ether, ATTESTER_KEY), 0);
    }

    // ───────────────────────────── binding ─────────────────────────────

    function testRejectsWrongCallerChainVaultExecutorAndWindow() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        bytes memory signature = _sign(a, ATTESTER_KEY);

        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.InvalidAccount.selector, secondTrader, trader));
        vm.prank(secondTrader);
        executor.pull{value: 0.2 ether}(a, signature);

        SipVolumeExecutor.VolumeAttestation memory m = _clone(a);
        m.chainId = block.chainid + 1;
        signature = _sign(m, ATTESTER_KEY);
        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.InvalidChain.selector, block.chainid, m.chainId));
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(m, signature);

        m = _clone(a);
        m.vault = makeAddr("arbitraryRecipient");
        signature = _sign(m, ATTESTER_KEY);
        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.InvalidVault.selector, address(vault), m.vault));
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(m, signature);

        m = _clone(a);
        m.executor = address(legacy);
        signature = _sign(m, ATTESTER_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.InvalidExecutor.selector, address(executor), address(legacy))
        );
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(m, signature);

        m = _clone(a);
        m.startBlockL2 = 0;
        signature = _sign(m, ATTESTER_KEY);
        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.InvalidL2BlockRange.selector, uint64(0), m.endBlockL2));
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(m, signature);

        m = _clone(a);
        m.endBlockL2 = m.startBlockL2 - 1;
        signature = _sign(m, ATTESTER_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.InvalidL2BlockRange.selector, m.startBlockL2, m.endBlockL2)
        );
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(m, signature);

        m = _clone(a);
        m.deadline = m.validAfter + 15 minutes + 1;
        signature = _sign(m, ATTESTER_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.InvalidValidityWindow.selector, m.validAfter, m.deadline)
        );
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(m, signature);

        signature = _sign(a, ATTESTER_KEY);
        vm.warp(a.deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.AttestationExpired.selector, a.deadline, block.timestamp)
        );
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);
    }

    function testPausesPolicyChangeAndRepointFailClosed() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        bytes memory signature = _sign(a, ATTESTER_KEY);

        pauseController.pause();
        vm.expectRevert(SipVolumeExecutor.ProtocolPaused.selector);
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);
        pauseController.unpause();

        // Unpausing bumped the global pause epoch: the old attestation is dead.
        vm.expectRevert(SipVolumeExecutor.InvalidEpoch.selector);
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);

        a = _attestation(trader, 1 ether, keccak256("batch-1"));
        signature = _sign(a, ATTESTER_KEY);
        vm.prank(vaultAdmin);
        vault.setLocalPause(true);
        vm.expectRevert(SipVolumeExecutor.InvalidAccountState.selector);
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);
        vm.prank(vaultAdmin);
        vault.setLocalPause(false);

        // The trader changes their own bps: policyNonce moves, so does policyHash.
        a = _attestation(trader, 1 ether, keccak256("batch-1"));
        signature = _sign(a, ATTESTER_KEY);
        vm.prank(trader);
        vault.setMySavingsBps(3_000);
        vm.expectRevert(SipVolumeExecutor.InvalidEpoch.selector);
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);

        // Repointing the vault elsewhere makes this executor a stranger to it.
        a = _attestation(trader, 1 ether, keccak256("batch-1"));
        signature = _sign(a, ATTESTER_KEY);
        vm.startPrank(vaultAdmin);
        vault.setSettlementExecutor(address(legacy));
        vault.setLocalPause(false);
        vm.stopPrank();
        vm.expectRevert(SipVolumeExecutor.InvalidAccountState.selector);
        vm.prank(trader);
        executor.pull{value: 0.3 ether}(a, signature);
    }

    // ───────────────────────────── migration from Phase 0 ─────────────────────────────

    /// @notice A vault that settled through the legacy executor carries a REAL L2
    ///         frontier for that (account, bindingEpoch). The synthetic counter
    ///         starts at 1 and can never climb over it, so such an account has to
    ///         be re-bound (a new bindingEpoch re-keys the frontier) before its
    ///         first Phase 1 pull. This pins that operational requirement.
    /// @notice AN ACCOUNT THAT SETTLED THROUGH PHASE 0 MIGRATES WITHOUT BEING REBOUND.
    ///         The vault's frontier holds a real L2 height from the legacy
    ///         settlement; a synthetic counter starting at 1 would be refused by
    ///         NonProgressiveBlockRange forever, so the first pull seeds the
    ///         counter from the vault's own frontier and carries on from there.
    function testPhase0FrontierSeedsTheSyntheticCounterSoMigrationNeedsNoRebind() external {
        address secondAdmin = makeAddr("secondAdmin");
        address migrating = makeAddr("migratingTrader");
        vm.deal(migrating, 20 ether);
        PersonalVault legacyVault = _createVault(secondAdmin, keccak256("legacy-vault"));
        _linkTrader(legacyVault, secondAdmin, migrating, SAVINGS_BPS);
        vm.roll(block.number + 10);

        // Phase 0: one profit settlement at a real L2 height.
        uint64 activation = legacyVault.getTradingAccount(migrating).activationBlock;
        NuvemTypes.SettlementAttestation memory old =
            _legacyAttestation(legacyVault, migrating, activation, uint64(block.number - 1));
        bytes memory oldSignature = _legacySign(old, ATTESTER_KEY);
        vm.prank(migrating);
        legacy.settle{value: 0.2 ether}(old, oldSignature);
        assertEq(legacyVault.getTradingAccount(migrating).settlementNonce, 1);
        assertGt(old.endBlockL2, 0, "the legacy settlement must leave a real L2 frontier");

        // Phase 1: repoint and pull. No rebind, no pause, no admin ceremony.
        _repoint(legacyVault, secondAdmin);
        SipVolumeExecutor.VolumeAttestation memory a =
            _attestationFor(legacyVault, migrating, 1 ether, keccak256("m-1"));
        assertEq(executor.syntheticFrontier(migrating), 0, "not seeded before the first pull");
        assertEq(_pull(a, 0.2 ether, ATTESTER_KEY), 0);
        assertEq(legacyVault.getTradingAccount(migrating).settlementNonce, 2);
        // Seeded from the vault's frontier and advanced by two, so the window the
        // vault recorded sits strictly above what Phase 0 left behind.
        assertEq(executor.syntheticFrontier(migrating), old.endBlockL2 + 2, "counter continues the vault's frontier");

        // And the one after it still progresses.
        vm.roll(block.number + 1);
        a = _attestationFor(legacyVault, migrating, 1 ether, keccak256("m-2"));
        assertEq(_pull(a, 0.2 ether, ATTESTER_KEY), 0);
        assertEq(executor.syntheticFrontier(migrating), old.endBlockL2 + 4);
    }

    /// @notice The frontier slot is read from PersonalVault's live storage; if the
    ///         vault's ERC-7201 layout ever moves, the seed would silently be zero
    ///         and every migrating account would be bricked. Pin the read.
    function testSyntheticSeedMatchesTheVaultsOwnFrontierSlot() external {
        address secondAdmin = makeAddr("slotAdmin");
        address trader = makeAddr("slotTrader");
        vm.deal(trader, 20 ether);
        PersonalVault v = _createVault(secondAdmin, keccak256("slot-vault"));
        _linkTrader(v, secondAdmin, trader, SAVINGS_BPS);
        vm.roll(block.number + 10);
        uint64 activation = v.getTradingAccount(trader).activationBlock;
        NuvemTypes.SettlementAttestation memory old = _legacyAttestation(v, trader, activation, uint64(block.number - 1));
        bytes memory signature = _legacySign(old, ATTESTER_KEY);
        vm.prank(trader);
        legacy.settle{value: 0.2 ether}(old, signature);

        // The same computation VaultLens.settlementFrontier does, against the same vault.
        uint256 base = uint256(0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200) + 11;
        bytes32 outer = keccak256(abi.encode(trader, bytes32(base)));
        uint64 bindingEpoch = v.getTradingAccount(trader).bindingEpoch;
        uint256 packed = uint256(v.extsload(keccak256(abi.encode(bindingEpoch, outer))));
        assertEq(uint64(packed >> 64), old.endBlockL2, "the pinned slot is the vault's L2 frontier");
    }

    // ───────────────────────────── named revert paths ─────────────────────────────

    /// @dev All three dependencies are immutable, so a zero passed here would be
    ///      a permanently bricked executor rather than something to fix later.
    function testConstructorRejectsZeroDependencies() external {
        vm.expectRevert(SipVolumeExecutor.ZeroAddress.selector);
        new SipVolumeExecutor(address(0), address(attesterRegistry), address(pauseController));

        vm.expectRevert(SipVolumeExecutor.ZeroAddress.selector);
        new SipVolumeExecutor(address(factory), address(0), address(pauseController));

        vm.expectRevert(SipVolumeExecutor.ZeroAddress.selector);
        new SipVolumeExecutor(address(factory), address(attesterRegistry), address(0));
    }

    /// @dev `validAfter` is what keeps a worker from pre-signing the next window
    ///      and firing it early; the same signature has to become good on its own.
    function testAttestationBeforeItsWindowOpensReverts() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        a.validAfter = uint48(block.timestamp + 5 minutes);
        a.deadline = a.validAfter + 10 minutes;
        bytes memory signature = _sign(a, ATTESTER_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.AttestationNotYetValid.selector, a.validAfter, block.timestamp)
        );
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);

        vm.warp(a.validAfter);
        vm.prank(trader);
        assertEq(executor.pull{value: 0.2 ether}(a, signature), 0, "the same signature is good once the window opens");
    }

    /// @dev The other half of the window guard: a `deadline` behind its
    ///      `validAfter` is a malformed attestation, not an expired one, and the
    ///      subtraction in the span check would underflow if it were reached.
    function testInvertedValidityWindowReverts() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        a.validAfter = uint48(block.timestamp + 1);
        a.deadline = uint48(block.timestamp);
        bytes memory signature = _sign(a, ATTESTER_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.InvalidValidityWindow.selector, a.validAfter, a.deadline)
        );
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);
    }

    /// @dev The zero branch of the vault guard. A wallet the factory does not know
    ///      has no recipient, and naming someone else's vault must not give it one.
    function testCallerWithNoRegisteredVaultReverts() external {
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        assertEq(factory.activeVaultOf(stranger), address(0), "the stranger is unknown to the factory");

        SipVolumeExecutor.VolumeAttestation memory a = _attestation(stranger, 1 ether, keccak256("batch-1"));
        assertEq(a.vault, address(vault), "signed at someone else's vault");
        bytes memory signature = _sign(a, ATTESTER_KEY);

        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.InvalidVault.selector, address(0), address(vault)));
        vm.prank(stranger);
        executor.pull{value: 0.2 ether}(a, signature);
    }

    /// @dev `disableAttester` is the guardian's kill switch. It bumps the epoch, so
    ///      every attestation signed before it dies on `InvalidEpoch`; the only one
    ///      that reaches the attester check is built after the kill, and it finds
    ///      no signer at all. Distinct from a wrong signature: nothing can sign.
    function testDisabledAttesterReverts() external {
        attesterRegistry.disableAttester();
        assertEq(attesterRegistry.attester(), address(0), "no attester left to check against");

        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        assertEq(a.attesterEpoch, attesterRegistry.attesterEpoch(), "built against the live epoch");
        bytes memory signature = _sign(a, ATTESTER_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.InvalidAttester.selector, address(0), a.attesterEpoch)
        );
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);
    }

    // ───────────────────────────── policy hash ─────────────────────────────

    /// @dev `vaultPolicyNonce` sits inside `policyHash` and in none of the epoch
    ///      fields, so an admin widening the aggregate cap under a signed
    ///      attestation is caught here and nowhere else in the whole path.
    function testVaultPolicyChangedUnderASignedAttestationRevertsOnThePolicyHash() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        bytes memory signature = _sign(a, ATTESTER_KEY);

        vm.prank(vaultAdmin);
        vault.setVaultPolicy(NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: AGGREGATE_CAP + 5 ether}));

        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(trader);
        assertEq(a.bindingEpoch, account.bindingEpoch, "bindingEpoch did not move");
        assertEq(a.policyNonce, account.policyNonce, "policyNonce did not move");
        assertEq(a.adminEpoch, vault.adminEpoch(), "adminEpoch did not move");
        assertEq(a.localPauseEpoch, vault.localPauseEpoch(), "localPauseEpoch did not move");
        bytes32 currentHash = vault.policyHash(trader);
        assertTrue(currentHash != a.policyHash, "the policy hash is the only binding that moved");

        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.InvalidPolicyHash.selector, currentHash, a.policyHash));
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);

        // Nothing was consumed, and re-attesting against the policy the user
        // actually has now goes through with the same batch.
        assertFalse(executor.usedBatch(a.batchRoot));
        assertEq(_pull(_attestation(trader, 1 ether, keccak256("batch-1")), 0.2 ether, ATTESTER_KEY), 0);
    }

    /// @dev When the admin edits the ACCOUNT's policy, `policyNonce` moves too — so
    ///      a worker that refreshes the nonce off-chain clears the epoch check, and
    ///      the policy hash is the last thing between a signed attestation and caps
    ///      the user never agreed to.
    function testAccountPolicyChangedUnderASignedAttestationRevertsOnThePolicyHash() external {
        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));

        NuvemTypes.TradingAccountPolicy memory next = vault.getTradingAccount(trader).policy;
        next.maxPerSettlementWei = MAX_PER_SETTLEMENT + 3 ether;
        vm.prank(vaultAdmin);
        vault.setTradingAccountPolicy(trader, next);

        // Stale nonce and stale hash: the epoch check is the one that fires.
        bytes memory signature = _sign(a, ATTESTER_KEY);
        vm.expectRevert(SipVolumeExecutor.InvalidEpoch.selector);
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);

        // Nonce refreshed, hash still the one the attester signed over.
        SipVolumeExecutor.VolumeAttestation memory refreshed = _clone(a);
        refreshed.policyNonce = vault.getTradingAccount(trader).policyNonce;
        assertTrue(refreshed.policyNonce != a.policyNonce, "the admin edit moved the account nonce");
        bytes32 currentHash = vault.policyHash(trader);
        assertTrue(currentHash != refreshed.policyHash, "the edited policy hashes differently");
        signature = _sign(refreshed, ATTESTER_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SipVolumeExecutor.InvalidPolicyHash.selector, currentHash, refreshed.policyHash)
        );
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(refreshed, signature);
        assertEq(executor.owed(trader), 0, "a refused pull credits nothing");
    }

    // ───────────────────────────── synthetic counter ceiling ─────────────────────────────

    /// @dev The counter climbs by two per pull, so it cannot arithmetically reach
    ///      the ceiling: the only way in is to be SEEDED there from a vault
    ///      frontier that is already one short of `uint64` max. Driven from the
    ///      vault's own slot, because that read is the guard's only input.
    function testSyntheticFrontierSeededAtTheCeilingReverts() external {
        uint64 ceiling = type(uint64).max - 1;
        uint256 base = uint256(0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200) + 11;
        bytes32 outer = keccak256(abi.encode(trader, bytes32(base)));
        uint64 bindingEpoch = vault.getTradingAccount(trader).bindingEpoch;
        vm.store(address(vault), keccak256(abi.encode(bindingEpoch, outer)), bytes32(uint256(ceiling) << 64));

        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, 1 ether, keccak256("batch-1"));
        bytes memory signature = _sign(a, ATTESTER_KEY);
        vm.expectRevert(abi.encodeWithSelector(SipVolumeExecutor.SyntheticFrontierExhausted.selector, trader));
        vm.prank(trader);
        executor.pull{value: 0.2 ether}(a, signature);

        // The guard sits after the effects, so this also pins that they roll back.
        assertEq(executor.owed(trader), 0);
        assertEq(executor.collected(trader), 0);
        assertFalse(executor.usedBatch(a.batchRoot));
    }

    // ───────────────────────────── fuzz ─────────────────────────────

    /// @notice `msg.value` never exceeds `owedWei` on a fresh account, whatever the
    ///         caller sends; when it is within bounds the vault's WETH grows by
    ///         exactly `msg.value` and the debt is the remainder.
    function testFuzzValueNeverExceedsOwed(uint96 notionalRaw, uint96 valueRaw) external {
        uint256 notional = bound(uint256(notionalRaw), 0.05 ether, 75 ether);
        uint256 value = bound(uint256(valueRaw), 1, 20 ether);
        _setAccountPolicy(trader, SAVINGS_BPS, AGGREGATE_CAP, AGGREGATE_CAP, MIN_CONTRIBUTION);
        vm.deal(trader, 30 ether);

        SipVolumeExecutor.VolumeAttestation memory a = _attestation(trader, notional, keccak256("fuzz"));
        uint256 owedWei = notional * SAVINGS_BPS / 10_000;
        assertEq(a.owedWei, owedWei);
        assertLe(owedWei, AGGREGATE_CAP, "harness keeps owed under every cap so the owed bound is the one hit");
        bytes memory signature = _sign(a, ATTESTER_KEY);
        uint256 vaultWethBefore = weth.balanceOf(address(vault));

        if (value > owedWei) {
            vm.expectRevert(
                abi.encodeWithSelector(SipVolumeExecutor.ContributionExceedsOutstanding.selector, value, owedWei)
            );
            vm.prank(trader);
            executor.pull{value: value}(a, signature);
            assertEq(weth.balanceOf(address(vault)), vaultWethBefore);
            assertEq(executor.collected(trader), 0);
            return;
        }
        if (value < MIN_CONTRIBUTION) {
            vm.expectRevert(
                abi.encodeWithSelector(SipVolumeExecutor.ContributionBelowMinimum.selector, value, MIN_CONTRIBUTION)
            );
            vm.prank(trader);
            executor.pull{value: value}(a, signature);
            return;
        }

        vm.prank(trader);
        uint256 debtAfter = executor.pull{value: value}(a, signature);
        assertEq(weth.balanceOf(address(vault)) - vaultWethBefore, value, "vault WETH == msg.value");
        assertEq(debtAfter, owedWei - value);
        assertEq(executor.debtOf(trader), owedWei - value);
        assertLe(executor.collected(trader), executor.owed(trader));
        assertEq(address(executor).balance, 0);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _createVault(address admin, bytes32 salt) internal returns (PersonalVault created) {
        NuvemTypes.VaultInitialization memory init = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(attesterRegistry),
            settlementExecutor: address(legacy),
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: AGGREGATE_CAP})
        });
        vm.prank(admin);
        (, address vaultAddress) = factory.createVault(salt, cohortId, abi.encode(init));
        created = PersonalVault(payable(vaultAddress));
    }

    /// @dev The production migration: `setSettlementExecutor` force-pauses and
    ///      bumps the local pause epoch + vault policy nonce; resuming is explicit.
    function _repoint(PersonalVault target, address admin) internal {
        vm.startPrank(admin);
        target.setSettlementExecutor(address(executor));
        target.setLocalPause(false);
        vm.stopPrank();
        assertEq(target.settlementExecutor(), address(executor));
        assertFalse(target.settlementPaused());
    }

    function _linkTrader(PersonalVault target, address admin, address account, uint16 savingsBps) internal {
        NuvemTypes.TradingAccountPolicy memory policy = NuvemTypes.TradingAccountPolicy({
            savingsBps: savingsBps,
            minContributionWei: MIN_CONTRIBUTION,
            maxPerSettlementWei: MAX_PER_SETTLEMENT,
            maxRolling30dWei: ACCOUNT_CAP,
            tradingFloorWei: TRADING_FLOOR,
            gasReserveWei: GAS_RESERVE
        });
        vm.prank(admin);
        target.inviteTradingAccount(
            account, keccak256(abi.encodePacked("platform", account)), policy, uint48(block.timestamp + 1 days)
        );
        vm.prank(account);
        target.acceptTradingAccount();
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

    function _attestation(address account, uint256 sumNotionalWei, bytes32 batchRoot)
        internal
        view
        returns (SipVolumeExecutor.VolumeAttestation memory)
    {
        return _attestationFor(vault, account, sumNotionalWei, batchRoot);
    }

    function _attestationFor(PersonalVault target, address account, uint256 sumNotionalWei, bytes32 batchRoot)
        internal
        view
        returns (SipVolumeExecutor.VolumeAttestation memory a)
    {
        NuvemTypes.TradingAccount memory tradingAccount = target.getTradingAccount(account);
        a = SipVolumeExecutor.VolumeAttestation({
            chainId: block.chainid,
            vault: address(target),
            account: account,
            executor: address(executor),
            bindingEpoch: tradingAccount.bindingEpoch,
            policyNonce: tradingAccount.policyNonce,
            settlementNonce: tradingAccount.settlementNonce,
            adminEpoch: target.adminEpoch(),
            localPauseEpoch: target.localPauseEpoch(),
            globalPauseEpoch: pauseController.pauseEpoch(),
            attesterEpoch: attesterRegistry.attesterEpoch(),
            policyHash: target.policyHash(account),
            batchRoot: batchRoot,
            startBlockL2: WINDOW_START_L2,
            endBlockL2: WINDOW_END_L2,
            sumNotionalWei: sumNotionalWei,
            owedWei: sumNotionalWei * tradingAccount.policy.savingsBps / 10_000,
            validAfter: uint48(block.timestamp),
            deadline: uint48(block.timestamp + 10 minutes)
        });
    }

    /// @dev Memory structs assign by reference; a mutation study needs real copies.
    function _clone(SipVolumeExecutor.VolumeAttestation memory a)
        internal
        pure
        returns (SipVolumeExecutor.VolumeAttestation memory)
    {
        return abi.decode(abi.encode(a), (SipVolumeExecutor.VolumeAttestation));
    }

    function _pull(SipVolumeExecutor.VolumeAttestation memory a, uint256 value, uint256 signerKey)
        internal
        returns (uint256 debtAfter)
    {
        bytes memory signature = _sign(a, signerKey);
        vm.prank(a.account);
        return executor.pull{value: value}(a, signature);
    }

    function _sign(SipVolumeExecutor.VolumeAttestation memory a, uint256 signerKey)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, executor.hashAttestation(a));
        return abi.encodePacked(r, s, v);
    }

    // Legacy (Phase 0) helpers, ported from SettlementExecutor.t.sol for the
    // migration test only.

    function _legacyAttestation(PersonalVault target, address account, uint64 startBlock, uint64 endBlock)
        internal
        view
        returns (NuvemTypes.SettlementAttestation memory a)
    {
        NuvemTypes.TradingAccount memory tradingAccount = target.getTradingAccount(account);
        a = NuvemTypes.SettlementAttestation({
            account: account,
            vault: address(target),
            executor: address(legacy),
            chainId: block.chainid,
            bindingEpoch: tradingAccount.bindingEpoch,
            policyNonce: tradingAccount.policyNonce,
            adminEpoch: target.adminEpoch(),
            localPauseEpoch: target.localPauseEpoch(),
            globalPauseEpoch: pauseController.pauseEpoch(),
            settlementNonce: tradingAccount.settlementNonce,
            policyHash: target.policyHash(account),
            sessionId: bytes32(0),
            ledgerRoot: keccak256(abi.encode(account, startBlock, endBlock)),
            startBlock: startBlock,
            endBlock: endBlock,
            startBlockL2: WINDOW_START_L2,
            endBlockL2: WINDOW_END_L2,
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
        a.sessionId = legacy.deriveSessionId(
            a.chainId,
            a.vault,
            a.account,
            a.bindingEpoch,
            a.startBlock,
            a.endBlock,
            a.startBlockL2,
            a.endBlockL2,
            a.ledgerRoot
        );
    }

    function _legacySign(NuvemTypes.SettlementAttestation memory a, uint256 signerKey)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, legacy.hashAttestation(a));
        return abi.encodePacked(r, s, v);
    }
}
