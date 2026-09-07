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
import {VaultLens} from "../../src/periphery/VaultLens.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

/// @notice Settlement progression is enforced on the L2 range, not the L1 range.
/// @dev On Arbitrum Nitro, Solidity's `block.number` is the L1 block number. At a
///      measured ~120.2 L2 blocks per L1 block, a trader who closes one session
///      and reopens within ~12 seconds produces two genuinely distinct L2
///      sessions whose L1 ranges are IDENTICAL. The previous rule demanded
///      `startBlock > previousEndBlockL1` and so refused the second settlement
///      permanently. Foundry has one block counter, so here L1 is `block.number`
///      and L2 is modelled as free uint64s in the millions — which is exactly the
///      production relationship and is what makes this testable at all.
contract SettlementProgressionL2Test is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    VaultLens internal lens = new VaultLens();
    uint256 internal constant ATTESTER_KEY = 0xA77E57E2;
    uint128 internal constant AGGREGATE_CAP = 15 ether;

    // The one real mainnet settlement, so the headline test doubles as a
    // regression against production data.
    uint64 internal constant CANARY_START_L2 = 22_080_592;
    uint64 internal constant CANARY_END_L2 = 22_080_850;
    uint256 internal constant CANARY_REALIZED_PROFIT = 2_016_854_447_493_738;
    uint256 internal constant CANARY_CONTRIBUTION = 403_370_889_498_747;

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

        NuvemTypes.VaultInitialization memory init = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(attesterRegistry),
            settlementExecutor: address(executor),
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: AGGREGATE_CAP})
        });

        vm.prank(vaultAdmin);
        (, address vaultAddress) = factory.createVault(keccak256("progression-vault"), cohortId, abi.encode(init));
        vault = PersonalVault(payable(vaultAddress));

        _linkTrader(trader, 2_000);
        _linkTrader(secondTrader, 2_000);
        vm.deal(trader, 50 ether);
        vm.deal(secondTrader, 50 ether);
        vm.roll(1_000);
    }

    // ---------------------------------------------------------------- T1 ----

    /// @notice THE POINT OF THE WHOLE CHANGE. Two distinct L2 sessions inside one
    ///         L1 block must both settle.
    /// @dev Under the previous rule the second call reverted
    ///      `NonProgressiveBlockRange(500, 500, 500)` and the window was
    ///      forfeited permanently. Round-trippers are 43% of the measured GMGN
    ///      cohort and the only segment the product works well for.
    function testTwoDistinctL2SessionsInsideOneL1BlockBothSettle() external {
        // Session A is the real mainnet settlement's L2 window.
        NuvemTypes.SettlementAttestation memory sessionA = _attestation(
            trader,
            int256(CANARY_REALIZED_PROFIT),
            CANARY_CONTRIBUTION,
            [uint64(500), 500, CANARY_START_L2, CANARY_END_L2]
        );
        assertEq(_settle(sessionA), CANARY_CONTRIBUTION);

        // Session B: the SAME L1 block, the next L2 window. The trader re-entered
        // inside one L1 block.
        NuvemTypes.SettlementAttestation memory sessionB =
            _attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, CANARY_END_L2 + 1, CANARY_END_L2 + 150]);
        assertEq(_settle(sessionB), 0.2 ether);

        assertEq(sessionA.startBlock, sessionB.startBlock, "both windows occupy one L1 block");
        assertEq(sessionA.endBlock, sessionB.endBlock, "both windows occupy one L1 block");
        assertTrue(sessionA.sessionId != sessionB.sessionId, "session identities must differ");

        assertEq(vault.getTradingAccount(trader).settlementNonce, 2);
        uint256 total = CANARY_CONTRIBUTION + 0.2 ether;
        assertEq(vault.lifetimeContribution(trader), total);
        assertEq(vault.aggregateLifetimeContribution(), total);
        assertEq(weth.balanceOf(address(vault)), total);

        (uint64 frontierL1, uint64 frontierL2) = lens.settlementFrontier(address(vault), trader, sessionB.bindingEpoch);
        assertEq(frontierL1, 500);
        assertEq(frontierL2, CANARY_END_L2 + 150);
    }

    // ---------------------------------------------------------------- T2 ----

    /// @notice The boundary is exactly `startBlockL2 > previousEndL2`, not `>=`.
    function testAdjacentL2WindowsAreAcceptedButAnOverlapIsRefused() external {
        _settle(_attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_000, 1_120]));

        NuvemTypes.SettlementAttestation memory overlapping =
            _attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_100, 1_240]);
        bytes memory signature = _sign(overlapping);
        vm.expectRevert(
            abi.encodeWithSelector(PersonalVault.NonProgressiveBlockRange.selector, uint64(1_120), uint64(1_100), uint64(1_240))
        );
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(overlapping, signature);

        // One block later on the L2 clock and it settles.
        assertEq(_settle(_attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_121, 1_240])), 0.2 ether);
    }

    // ---------------------------------------------------------------- T3 ----

    /// @notice A window fully contained in an already-settled one is refused, and
    ///         nothing moves.
    function testL2WindowContainedInAnAlreadySettledOneIsRefused() external {
        _settle(_attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_000, 1_120]));

        uint128 accountSpentBefore = vault.accountRollingCapStatus(trader).spent;
        uint128 aggregateSpentBefore = vault.aggregateRollingCapStatus().spent;
        uint256 wethBefore = weth.balanceOf(address(vault));

        NuvemTypes.SettlementAttestation memory contained =
            _attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_050, 1_080]);
        bytes memory signature = _sign(contained);
        vm.expectRevert(
            abi.encodeWithSelector(PersonalVault.NonProgressiveBlockRange.selector, uint64(1_120), uint64(1_050), uint64(1_080))
        );
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(contained, signature);

        assertEq(vault.getTradingAccount(trader).settlementNonce, 1);
        assertEq(vault.accountRollingCapStatus(trader).spent, accountSpentBefore);
        assertEq(vault.aggregateRollingCapStatus().spent, aggregateSpentBefore);
        assertEq(weth.balanceOf(address(vault)), wethBefore);
    }

    // ---------------------------------------------------------------- T4 ----

    /// @notice Replaying the identical L2 window is refused on progression, not
    ///         on the settlement nonce.
    /// @dev The attestation is rebuilt against the CURRENT nonce so the nonce
    ///      check cannot fire first and mask the guard under test.
    function testL2WindowIdenticalToAnAlreadySettledOneIsRefused() external {
        _settle(_attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_000, 1_120]));

        NuvemTypes.SettlementAttestation memory repeated =
            _attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_000, 1_120]);
        assertEq(repeated.settlementNonce, 1, "must be built against the post-settlement nonce");

        bytes memory signature = _sign(repeated);
        vm.expectRevert(
            abi.encodeWithSelector(PersonalVault.NonProgressiveBlockRange.selector, uint64(1_120), uint64(1_000), uint64(1_120))
        );
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(repeated, signature);
    }

    // ---------------------------------------------------------------- T5 ----

    /// @notice An inverted L2 range is refused by the executor, and independently
    ///         by the vault.
    /// @dev The vault must not trust the executor for record well-formedness:
    ///      `setSettlementExecutor` lets an admin install an executor that
    ///      enforces nothing.
    function testInvertedL2RangeIsRefusedByBothExecutorAndVault() external {
        NuvemTypes.SettlementAttestation memory inverted =
            _attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_200, 1_100]);
        bytes memory signature = _sign(inverted);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementExecutor.InvalidL2BlockRange.selector, uint64(1_200), uint64(1_100))
        );
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(inverted, signature);

        // And straight into the vault, bypassing the executor entirely.
        address stubExecutor = address(new SettlementExecutorProgressionStub());
        vm.prank(vaultAdmin);
        vault.setSettlementExecutor(stubExecutor);
        vm.prank(vaultAdmin);
        vault.setLocalPause(false);

        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(trader);
        NuvemTypes.SettlementRecord memory record = NuvemTypes.SettlementRecord({
            account: trader,
            bindingEpoch: account.bindingEpoch,
            policyNonce: account.policyNonce,
            settlementNonce: account.settlementNonce,
            policyHash: vault.policyHash(trader),
            sessionId: keccak256("inverted-session"),
            ledgerRoot: keccak256("inverted-ledger"),
            startBlock: 500,
            endBlock: 500,
            startBlockL2: 1_200,
            endBlockL2: 1_100,
            contribution: 0.2 ether
        });
        vm.deal(stubExecutor, 1 ether);
        vm.prank(stubExecutor);
        vm.expectRevert(PersonalVault.InvalidSettlement.selector);
        vault.acceptSettlement{value: 0.2 ether}(record);
    }

    /// @notice A degenerate L2 window is refused, because zero is the frontier's
    ///         "nothing settled yet" sentinel.
    /// @dev THE ESCALATION THIS PREVENTS. The frontier stores endBlockL2 as a
    ///      plain uint64 and the progression guard reads zero as "no settlement
    ///      yet". So a window ending at L2 block 0 would be written back as if it
    ///      were a real height, and every later window — however far it
    ///      overlapped — would clear the guard forever. One accepted attestation
    ///      would permanently disable replay protection for that account, which
    ///      turns a single bad signature into an unbounded double-settle.
    ///
    ///      Both ends are checked, and at both layers. `startBlockL2 == 0` is
    ///      refused as well as a zero end, because a real session starts at the
    ///      block before its first buy — a height this chain passed millions of
    ///      blocks ago — and a window is only well-formed if both ends are. The
    ///      vault repeats the check rather than trusting the executor, because
    ///      `setSettlementExecutor` can repoint it at a different one.
    function testDegenerateL2WindowIsRefusedSoTheFrontierSentinelStaysSound() external {
        uint64[3][3] memory degenerate = [
            [uint64(0), 0, 0], // both ends zero: the sentinel-poisoning case
            [uint64(0), 1_120, 1], // start at genesis
            [uint64(1_000), 1_000, 2] // zero width: a session spans at least its opening buy
        ];

        for (uint256 i = 0; i < degenerate.length; i++) {
            uint64 startL2 = degenerate[i][0];
            uint64 endL2 = degenerate[i][1];
            NuvemTypes.SettlementAttestation memory bad =
                _attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, startL2, endL2]);
            bytes memory signature = _sign(bad);
            vm.expectRevert(
                abi.encodeWithSelector(SettlementExecutor.InvalidL2BlockRange.selector, startL2, endL2)
            );
            vm.prank(trader);
            executor.settle{value: 0.2 ether}(bad, signature);
        }

        // The vault refuses it too, reached directly through a stub executor so
        // the executor's own check cannot be what is being observed.
        address stubExecutor = address(new SettlementExecutorProgressionStub());
        vm.prank(vaultAdmin);
        vault.setSettlementExecutor(stubExecutor);
        vm.prank(vaultAdmin);
        vault.setLocalPause(false);

        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(trader);
        NuvemTypes.SettlementRecord memory record = NuvemTypes.SettlementRecord({
            account: trader,
            bindingEpoch: account.bindingEpoch,
            policyNonce: account.policyNonce,
            settlementNonce: account.settlementNonce,
            policyHash: vault.policyHash(trader),
            sessionId: keccak256("degenerate-session"),
            ledgerRoot: keccak256("degenerate-ledger"),
            startBlock: 500,
            endBlock: 500,
            startBlockL2: 0,
            endBlockL2: 0,
            contribution: 0.2 ether
        });
        vm.deal(stubExecutor, 1 ether);
        vm.prank(stubExecutor);
        vm.expectRevert(PersonalVault.InvalidSettlement.selector);
        vault.acceptSettlement{value: 0.2 ether}(record);

        // Nothing was recorded, so the sentinel still means what it says.
        (, uint64 frontierEndL2) = lens.settlementFrontier(address(vault), trader, account.bindingEpoch);
        assertEq(frontierEndL2, 0, "no settlement happened");
    }

    // ---------------------------------------------------------------- T6 ----

    /// @notice The L1 rules were NARROWED, not deleted.
    /// @dev Freshness and the activation floor both stay in L1, because
    ///      `block.number` and `activationBlock` are L1 numbers and no L2 head is
    ///      observable from a contract on this chain.
    function testL1FreshnessAndActivationFloorStillBindAfterProgressionMoves() external {
        // A perfectly progressive L2 window cannot rescue an unfinalised L1 range.
        NuvemTypes.SettlementAttestation memory current =
            _attestation(trader, 1 ether, 0.2 ether, [uint64(500), uint64(block.number), 1_000, 1_120]);
        bytes memory signature = _sign(current);
        vm.expectPartialRevert(SettlementExecutor.InvalidBlockRange.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(current, signature);

        // Nor an L1 start below the account's activation block.
        uint64 activationBlock = vault.getTradingAccount(trader).activationBlock;
        assertGt(activationBlock, 0);
        NuvemTypes.SettlementAttestation memory preActivation =
            _attestation(trader, 1 ether, 0.2 ether, [activationBlock - 1, activationBlock, uint64(1_000), 1_120]);
        bytes memory preActivationSignature = _sign(preActivation);
        vm.expectPartialRevert(SettlementExecutor.InvalidBlockRange.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(preActivation, preActivationSignature);
    }

    // ---------------------------------------------------------------- T7 ----

    /// @notice The L1 range must be non-decreasing, and that is a DISTINCT error.
    /// @dev `<`, not `<=`: equality is the common case for round-trippers, which
    ///      is what T1 is about. What is refused is an L1 range that rewinds
    ///      under a forward L2 range, which is an incoherent attestation. The
    ///      error is separate from `NonProgressiveBlockRange` so an operator can
    ///      tell an L2 replay from an L1 rewind.
    function testL1RangeMustBeNonDecreasingUnderADistinctError() external {
        _settle(_attestation(trader, 1 ether, 0.2 ether, [uint64(600), 700, 1_000, 1_120]));

        NuvemTypes.SettlementAttestation memory rewound =
            _attestation(trader, 1 ether, 0.2 ether, [uint64(550), 560, 1_200, 1_300]);
        bytes memory signature = _sign(rewound);
        vm.expectRevert(
            abi.encodeWithSelector(
                PersonalVault.NonProgressiveL1BlockRange.selector, uint64(700), uint64(550), uint64(560)
            )
        );
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(rewound, signature);

        // Exactly equal is fine — that is the whole point.
        assertEq(_settle(_attestation(trader, 1 ether, 0.2 ether, [uint64(700), 700, 1_200, 1_300])), 0.2 ether);
    }

    // ---------------------------------------------------------------- T8 ----

    /// @notice Progression is keyed by (account, bindingEpoch), unchanged.
    function testProgressionIsPerAccountAndPerBindingEpoch() external {
        // Overlapping L2 windows across two accounts are independent.
        _settle(_attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_000, 1_120]));
        assertEq(_settle(_attestation(secondTrader, 1 ether, 0.2 ether, [uint64(500), 500, 1_000, 1_120])), 0.2 ether);

        // A window that would be refused under the current epoch...
        NuvemTypes.SettlementAttestation memory stale =
            _attestation(trader, 1 ether, 0.2 ether, [uint64(500), 500, 1_050, 1_100]);
        bytes memory staleSignature = _sign(stale);
        vm.expectPartialRevert(PersonalVault.NonProgressiveBlockRange.selector);
        vm.prank(trader);
        executor.settle{value: 0.2 ether}(stale, staleSignature);

        // ...settles once the binding epoch rolls, because the frontier re-keys.
        vm.prank(vaultAdmin);
        vault.pauseTradingAccount(trader);
        vm.prank(vaultAdmin);
        vault.unpauseTradingAccount(trader);
        vm.roll(block.number + 1);

        uint64 activationBlock = vault.getTradingAccount(trader).activationBlock;
        assertEq(_settle(_attestation(trader, 1 ether, 0.2 ether, [uint64(activationBlock), activationBlock, 1_050, 1_100])), 0.2 ether);
    }

    // -------------------------------------------------------------------- --

    function _linkTrader(address account, uint16 savingsBps) private {
        NuvemTypes.TradingAccountPolicy memory policy = NuvemTypes.TradingAccountPolicy({
            savingsBps: savingsBps,
            minContributionWei: 0.0001 ether,
            maxPerSettlementWei: 2 ether,
            maxRolling30dWei: 10 ether,
            tradingFloorWei: 1 ether,
            gasReserveWei: 0.1 ether
        });
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(account, keccak256("gmgn"), policy, uint48(block.timestamp + 1 days));
        vm.prank(account);
        vault.acceptTradingAccount();
    }

    /// @param blocks [startBlockL1, endBlockL1, startBlockL2, endBlockL2].
    function _attestation(
        address account,
        int256 realizedProfit,
        uint256 contribution,
        uint64[4] memory blocks
    ) internal view returns (NuvemTypes.SettlementAttestation memory attestation) {
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
            ledgerRoot: keccak256(abi.encode(account, blocks[2], blocks[3])),
            startBlock: blocks[0],
            endBlock: blocks[1],
            startBlockL2: blocks[2],
            endBlockL2: blocks[3],
            cashStart: 10 ether,
            cashEnd: realizedProfit >= 0 ? 10 ether + uint256(realizedProfit) : 10 ether - uint256(-realizedProfit),
            externalDeposits: 0,
            externalWithdrawals: 0,
            realizedProfit: realizedProfit,
            contribution: contribution,
            attesterEpoch: attesterRegistry.attesterEpoch(),
            validAfter: uint48(block.timestamp),
            deadline: uint48(block.timestamp + 10 minutes)
        });
        attestation.sessionId = executor.deriveSessionId(
            block.chainid,
            address(vault),
            account,
            tradingAccount.bindingEpoch,
            blocks[0],
            blocks[1],
            blocks[2],
            blocks[3],
            attestation.ledgerRoot
        );
    }

    function _settle(NuvemTypes.SettlementAttestation memory attestation) internal returns (uint256 saved) {
        bytes memory signature = _sign(attestation);
        vm.prank(attestation.account);
        return executor.settle{value: attestation.contribution}(attestation, signature);
    }

    function _sign(NuvemTypes.SettlementAttestation memory attestation) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, executor.hashAttestation(attestation));
        return abi.encodePacked(r, s, v);
    }
}

contract SettlementExecutorProgressionStub {}
