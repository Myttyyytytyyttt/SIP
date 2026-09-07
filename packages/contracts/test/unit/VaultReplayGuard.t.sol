// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {VaultLens} from "../../src/periphery/VaultLens.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

contract ReplayGuardExecutorStub {}

/// @notice Reaches `SessionAlreadyUsed`, which had zero tests.
/// @dev It cannot be reached through `settle()`. `deriveSessionId` now binds the
///      L2 pair, so reusing a sessionId implies reusing the L2 window, and the
///      progression guard always fires first; a settle()-level replay also trips
///      `InvalidSettlementNonce` in the executor long before the vault is
///      reached. The guard is therefore defence-in-depth for a future executor
///      that is looser than this one, and the only honest way to exercise it is
///      to call `acceptSettlement` directly from a stub executor — which is
///      exactly the position `setSettlementExecutor` can put a vault in.
contract VaultReplayGuardTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    VaultLens internal lens = new VaultLens();
    uint128 internal constant AGGREGATE_CAP = 15 ether;

    address internal vaultAdmin;
    address internal trader;
    address internal secondTrader;
    address internal stubExecutor;

    VaultFactory internal factory;
    PersonalVault internal vault;
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    MockWETH internal weth;

    function setUp() external {
        vm.warp(10 days);
        vm.roll(100);

        vaultAdmin = makeAddr("vaultAdmin");
        trader = makeAddr("trader");
        secondTrader = makeAddr("secondTrader");
        stubExecutor = address(new ReplayGuardExecutorStub());

        pauseController = new ProtocolPauseController(address(this), address(this));
        attesterRegistry = new AttesterRegistry(address(this), address(this), makeAddr("attester"));
        weth = new MockWETH();
        factory = new VaultFactory(address(this));
        factory.configureProtocol(
            VaultFactory.ProtocolConfiguration({
                weth: address(weth),
                pauseController: address(pauseController),
                attesterRegistry: address(attesterRegistry),
                settlementExecutor: stubExecutor
            })
        );

        PersonalVault implementation = new PersonalVault(address(adapterRegistry));
        (uint32 cohortId,) = factory.registerCohort(address(implementation), address(this));

        vm.prank(vaultAdmin);
        (, address vaultAddress) = factory.createVault(
            keccak256("replay-guard-vault"),
            cohortId,
            abi.encode(
                NuvemTypes.VaultInitialization({
                    weth: address(weth),
                    pauseController: address(pauseController),
                    attesterRegistry: address(attesterRegistry),
                    settlementExecutor: stubExecutor,
                    policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: AGGREGATE_CAP})
                })
            )
        );
        vault = PersonalVault(payable(vaultAddress));

        _linkTrader(trader);
        _linkTrader(secondTrader);
        vm.deal(stubExecutor, 100 ether);
        vm.roll(1_000);
    }

    /// @notice The same sessionId cannot be consumed twice, even when the L2
    ///         window advances and every other check passes.
    function testSameSessionIdReplayedIntoTheVaultIsRefused() external {
        bytes32 sessionId = keccak256("reused-session");

        NuvemTypes.SettlementRecord memory first = _record(trader, sessionId, 1_000, 1_120, 0.2 ether);
        vm.prank(stubExecutor);
        vault.acceptSettlement{value: 0.2 ether}(first);

        assertTrue(lens.isSessionUsed(address(vault), trader, _bindingEpoch(trader), sessionId));

        // A strictly-advancing L2 window and the correct post-settlement nonce:
        // progression, the nonce and the policy hash all pass. Only the replay
        // guard is left to refuse it.
        NuvemTypes.SettlementRecord memory replay = _record(trader, sessionId, 1_121, 1_240, 0.2 ether);
        assertEq(replay.settlementNonce, 1, "must be built against the post-settlement nonce");

        vm.prank(stubExecutor);
        vm.expectRevert(abi.encodeWithSelector(PersonalVault.SessionAlreadyUsed.selector, sessionId));
        vault.acceptSettlement{value: 0.2 ether}(replay);

        assertEq(vault.getTradingAccount(trader).settlementNonce, 1);
        assertEq(vault.aggregateLifetimeContribution(), 0.2 ether);
    }

    /// @notice The replay key is scoped to (account, bindingEpoch, sessionId).
    function testSessionKeyIsScopedToAccountAndBindingEpoch() external {
        bytes32 sessionId = keccak256("shared-session");

        NuvemTypes.SettlementRecord memory first = _record(trader, sessionId, 1_000, 1_120, 0.2 ether);
        vm.prank(stubExecutor);
        vault.acceptSettlement{value: 0.2 ether}(first);

        // Same sessionId, different account: accepted.
        NuvemTypes.SettlementRecord memory other = _record(secondTrader, sessionId, 1_000, 1_120, 0.2 ether);
        vm.prank(stubExecutor);
        vault.acceptSettlement{value: 0.2 ether}(other);
        assertEq(vault.lifetimeContribution(secondTrader), 0.2 ether);

        // Same sessionId, same account, new binding epoch: accepted, because both
        // the frontier and the replay key re-key on bindingEpoch.
        uint64 epochBefore = _bindingEpoch(trader);
        vm.prank(vaultAdmin);
        vault.pauseTradingAccount(trader);
        vm.prank(vaultAdmin);
        vault.unpauseTradingAccount(trader);
        vm.roll(block.number + 1);
        assertTrue(_bindingEpoch(trader) != epochBefore);
        assertFalse(lens.isSessionUsed(address(vault), trader, _bindingEpoch(trader), sessionId));

        NuvemTypes.SettlementRecord memory reEpoched = _record(trader, sessionId, 1_000, 1_120, 0.2 ether);
        vm.prank(stubExecutor);
        vault.acceptSettlement{value: 0.2 ether}(reEpoched);
        assertEq(vault.lifetimeContribution(trader), 0.4 ether);
    }

    function _linkTrader(address account) private {
        NuvemTypes.TradingAccountPolicy memory policy = NuvemTypes.TradingAccountPolicy({
            savingsBps: 2_000,
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

    function _bindingEpoch(address account) private view returns (uint64) {
        return vault.getTradingAccount(account).bindingEpoch;
    }

    function _record(
        address account,
        bytes32 sessionId,
        uint64 startBlockL2,
        uint64 endBlockL2,
        uint128 contribution
    ) private view returns (NuvemTypes.SettlementRecord memory) {
        NuvemTypes.TradingAccount memory tradingAccount = vault.getTradingAccount(account);
        return NuvemTypes.SettlementRecord({
            account: account,
            bindingEpoch: tradingAccount.bindingEpoch,
            policyNonce: tradingAccount.policyNonce,
            settlementNonce: tradingAccount.settlementNonce,
            policyHash: vault.policyHash(account),
            sessionId: sessionId,
            ledgerRoot: keccak256(abi.encode(sessionId, startBlockL2)),
            startBlock: tradingAccount.activationBlock,
            endBlock: tradingAccount.activationBlock,
            startBlockL2: startBlockL2,
            endBlockL2: endBlockL2,
            contribution: contribution
        });
    }
}
