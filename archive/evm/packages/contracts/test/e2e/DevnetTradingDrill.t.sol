// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {DevnetFaucet} from "../../src/devnet/DevnetFaucet.sol";
import {DevnetStockMarket} from "../../src/devnet/DevnetStockMarket.sol";
import {DevnetSyntheticStock} from "../../src/devnet/DevnetSyntheticStock.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {SettlementExecutor} from "../../src/settlement/SettlementExecutor.sol";
import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

contract DevnetTradingDrillTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    uint256 private constant ATTESTER_KEY = 0xA77E57E2;
    bytes32 private constant PLATFORM_A = keccak256("DEVNET_GMGN_SIM");
    bytes32 private constant PLATFORM_B = keccak256("DEVNET_BROKER_SIM");

    address private vaultAdmin;
    address private traderA;
    address private traderB;
    address private attester;
    address private treasury;

    MockWETH private weth;
    DevnetSyntheticStock private stock;
    DevnetStockMarket private market;
    DevnetFaucet private faucet;
    ProtocolPauseController private pauseController;
    AttesterRegistry private attesterRegistry;
    VaultFactory private factory;
    SettlementExecutor private executor;
    PersonalVault private vault;

    function setUp() external {
        vm.warp(30 days);
        vm.roll(100);
        vm.deal(address(this), 200 ether);

        vaultAdmin = makeAddr("devnetVaultAdmin");
        traderA = makeAddr("devnetTraderA");
        traderB = makeAddr("devnetTraderB");
        attester = vm.addr(ATTESTER_KEY);
        treasury = makeAddr("devnetTreasury");

        weth = new MockWETH();
        stock = new DevnetSyntheticStock(address(this), "Nuvem Synthetic S&P 500", "nSPY");
        market = new DevnetStockMarket(address(this), stock, 1 ether);
        faucet = new DevnetFaucet{value: 20 ether}(address(this), 10 ether);
        market.fundLiquidity{value: 50 ether}();

        pauseController = new ProtocolPauseController(address(this), address(this));
        attesterRegistry = new AttesterRegistry(address(this), address(this), attester);
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

        // The synthetic market and stock stay: they are how the traders make
        // real profit, which is the whole point of an end-to-end test.
        stock.setMinter(address(market), true);

        NuvemTypes.VaultInitialization memory initialization = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(attesterRegistry),
            settlementExecutor: address(executor),
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: 100 ether})
        });

        vm.prank(vaultAdmin);
        (, address vaultAddress) =
            factory.createVault(keccak256("DEVNET_TRADING_DRILL_VAULT"), cohortId, abi.encode(initialization));
        vault = PersonalVault(payable(vaultAddress));

        _inviteAndActivate(traderA, PLATFORM_A, 2_000);
        _inviteAndActivate(traderB, PLATFORM_B, 3_000);
    }

    function testE2E_MultiPlatformTradingAndSettlementConservesEveryContributedWei() external {
        _claimFaucet(traderA);
        _claimFaucet(traderB);

        vm.roll(101);
        uint64 tradeBlock = uint64(vm.getBlockNumber());
        uint48 tradeDeadline = uint48(block.timestamp + 15 minutes);

        vm.prank(traderA);
        assertEq(market.buy{value: 4 ether}(4 ether, tradeDeadline), 4 ether);
        vm.prank(traderB);
        assertEq(market.buy{value: 2 ether}(2 ether, tradeDeadline), 2 ether);

        market.setPriceWeiPerToken(1.5 ether);

        vm.startPrank(traderA);
        stock.approve(address(market), 4 ether);
        assertEq(market.sell(4 ether, 6 ether, tradeDeadline), 6 ether);
        vm.stopPrank();

        vm.startPrank(traderB);
        stock.approve(address(market), 2 ether);
        assertEq(market.sell(2 ether, 3 ether, tradeDeadline), 3 ether);
        vm.stopPrank();

        assertEq(traderA.balance, 12 ether, "trader A must realize 2 ETH profit");
        assertEq(traderB.balance, 11 ether, "trader B must realize 1 ETH profit");
        assertEq(stock.balanceOf(traderA), 0);
        assertEq(stock.balanceOf(traderB), 0);

        vm.roll(102);
        NuvemTypes.SettlementAttestation memory attestationA =
            _attestation(traderA, 4 ether, 6 ether, 2 ether, 0.4 ether, tradeBlock, "trade-a");
        NuvemTypes.SettlementAttestation memory attestationB =
            _attestation(traderB, 2 ether, 3 ether, 1 ether, 0.3 ether, tradeBlock, "trade-b");

        assertEq(_settle(attestationA), 0.4 ether);
        assertEq(_settle(attestationB), 0.3 ether);

        assertEq(weth.balanceOf(address(vault)), 0.7 ether);
        assertEq(vault.lifetimeContribution(traderA), 0.4 ether);
        assertEq(vault.lifetimeContribution(traderB), 0.3 ether);
        assertEq(vault.aggregateLifetimeContribution(), 0.7 ether);
        assertEq(vault.activeTradingAccountCount(), 2);

        // Both traders settled inside the SAME L1 block (`tradeBlock`) on
        // DISJOINT L2 windows. Under the old L1 progression rule that shape was
        // the one this change exists to unblock, so assert it explicitly rather
        // than letting it pass as an accident of the fixture.
        assertEq(attestationA.startBlock, attestationB.startBlock, "both settled in one L1 block");
        assertTrue(attestationB.startBlockL2 > attestationA.endBlockL2, "L2 windows must be disjoint");
        assertTrue(attestationA.sessionId != attestationB.sessionId, "session identities must differ");

        // With no investment path, every contributed wei is WETH held by the
        // vault and nowhere else. That is stronger than the three-way
        // vault/adapter/treasury split this replaced.
        assertEq(weth.balanceOf(address(vault)), vault.aggregateLifetimeContribution());
        assertEq(weth.balanceOf(address(vault)), 0.7 ether);
        assertEq(address(vault).balance, 0, "no native residue may remain in the vault");
        assertEq(weth.balanceOf(treasury), 0, "settlement charges no protocol fee");
    }

    function testE2E_RejectsProfitClaimThatContradictsSignedCashFields() external {
        _claimFaucet(traderA);
        vm.roll(101);
        uint64 tradeBlock = uint64(vm.getBlockNumber());
        uint48 deadline = uint48(block.timestamp + 15 minutes);

        vm.prank(traderA);
        market.buy{value: 4 ether}(4 ether, deadline);
        market.setPriceWeiPerToken(0.75 ether);
        vm.startPrank(traderA);
        stock.approve(address(market), 4 ether);
        market.sell(4 ether, 3 ether, deadline);
        vm.stopPrank();
        assertEq(traderA.balance, 9 ether);

        vm.roll(102);
        NuvemTypes.SettlementAttestation memory loss =
            _attestation(traderA, 4 ether, 3 ether, -int256(1 ether), 0, tradeBlock, "loss");

        bytes memory lossSignature = _sign(loss);
        vm.expectRevert(abi.encodeWithSelector(SettlementExecutor.ContributionBelowMinimum.selector, 0, 0.001 ether));
        vm.prank(traderA);
        executor.settle(loss, lossSignature);

        NuvemTypes.SettlementAttestation memory falsified = loss;
        // This only proves realizedProfit cannot contradict the signed cash
        // fields. A compromised attester can still falsify all fields
        // consistently; receipt verification is an off-chain trust boundary.
        falsified.realizedProfit = 1 ether;
        falsified.contribution = 0.2 ether;
        bytes memory falsifiedSignature = _sign(falsified);

        vm.expectRevert(
            abi.encodeWithSelector(SettlementExecutor.InvalidRealizedProfit.selector, -int256(1 ether), int256(1 ether))
        );
        vm.prank(traderA);
        executor.settle{value: 0.2 ether}(falsified, falsifiedSignature);

        assertEq(vault.getTradingAccount(traderA).settlementNonce, 0);
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    function testDevnetFaucetAndMarketEnforceReplaySlippageAndDeadline() external {
        _claimFaucet(traderA);

        vm.expectRevert(abi.encodeWithSelector(DevnetFaucet.AlreadyClaimed.selector, traderA));
        vm.prank(traderA);
        faucet.claim();

        uint48 deadline = uint48(block.timestamp + 10 minutes);
        vm.expectRevert(abi.encodeWithSelector(DevnetStockMarket.InsufficientOutput.selector, 2 ether, 1 ether));
        vm.prank(traderA);
        market.buy{value: 1 ether}(2 ether, deadline);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(DevnetStockMarket.DeadlineExpired.selector, deadline, block.timestamp));
        vm.prank(traderA);
        market.buy{value: 1 ether}(1 ether, deadline);

        assertEq(traderA.balance, 10 ether);
        assertEq(stock.balanceOf(traderA), 0);
    }

    function _claimFaucet(address trader) private {
        vm.prank(trader);
        faucet.claim();
        assertEq(trader.balance, 10 ether);
    }

    function _inviteAndActivate(address account, bytes32 platformId, uint16 savingsBps) private {
        NuvemTypes.TradingAccountPolicy memory policy = NuvemTypes.TradingAccountPolicy({
            savingsBps: savingsBps,
            minContributionWei: 0.001 ether,
            maxPerSettlementWei: 10 ether,
            maxRolling30dWei: 20 ether,
            tradingFloorWei: 0.5 ether,
            gasReserveWei: 0.1 ether
        });

        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(account, platformId, policy, uint48(block.timestamp + 1 days));
        vm.prank(account);
        vault.acceptTradingAccount();
    }

    function _attestation(
        address account,
        uint256 cashStart,
        uint256 cashEnd,
        int256 realizedProfit,
        uint256 contribution,
        uint64 tradeBlock,
        string memory ledgerLabel
    ) private view returns (NuvemTypes.SettlementAttestation memory attestation) {
        // Foundry has a single block counter, so L1 is `block.number` and the L2
        // window is modelled explicitly. Each account gets its own disjoint slice
        // of the same L1 block, which is exactly the production relationship.
        uint64 startBlockL2 = tradeBlock * 1_000 + (account == traderA ? 0 : 500);
        uint64 endBlockL2 = startBlockL2 + 400;
        NuvemTypes.TradingAccount memory tradingAccount = vault.getTradingAccount(account);
        bytes32 ledgerRoot = keccak256(
            abi.encode(
                ledgerLabel, address(market), address(stock), account, cashStart, cashEnd, market.priceWeiPerToken()
            )
        );

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
            ledgerRoot: ledgerRoot,
            startBlock: tradeBlock,
            endBlock: tradeBlock,
            startBlockL2: startBlockL2,
            endBlockL2: endBlockL2,
            cashStart: cashStart,
            cashEnd: cashEnd,
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
            tradeBlock,
            tradeBlock,
            startBlockL2,
            endBlockL2,
            ledgerRoot
        );
    }

    function _settle(NuvemTypes.SettlementAttestation memory attestation) private returns (uint256 saved) {
        bytes memory signature = _sign(attestation);
        vm.prank(attestation.account);
        return executor.settle{value: attestation.contribution}(attestation, signature);
    }

    function _sign(NuvemTypes.SettlementAttestation memory attestation) private view returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTER_KEY, executor.hashAttestation(attestation));
        return abi.encodePacked(r, s, v);
    }
}
