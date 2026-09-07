// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {DevnetStockMarket} from "../src/devnet/DevnetStockMarket.sol";
import {DevnetSyntheticStock} from "../src/devnet/DevnetSyntheticStock.sol";
import {NuvemTypes} from "../src/types/NuvemTypes.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";
import {PublicTestnetDrillBase} from "./PublicTestnetDrillBase.s.sol";

/// @notice Phase 2: change one account's savings BPS and execute synthetic profitable trades.
contract ExecutePublicTestnetTrades is PublicTestnetDrillBase {
    error AddressMismatch(address expected, address actual);
    error DeploymentConfigMismatch(bytes32 field);
    error DrillStateNotFresh(bytes32 field);
    error InsufficientTradingBalance(address account, uint256 required, uint256 available);

    struct Deployment {
        bytes32 runId;
        address admin;
        address vaultAdmin;
        address traderA;
        address traderB;
        address weth;
        DevnetSyntheticStock stock;
        DevnetStockMarket market;
        PersonalVault vault;
        uint256 participantGasBudgetWei;
        uint256 tradeAmountAWei;
        uint256 tradeAmountBWei;
        uint256 stockAmountA;
        uint256 stockAmountB;
        uint256 sellAmountAWei;
        uint256 sellAmountBWei;
        uint256 initialPriceWei;
        uint256 finalPriceWei;
        uint16 traderAInitialSavingsBps;
        uint16 traderAUpdatedSavingsBps;
        uint16 traderBSavingsBps;
        uint128 tradingFloorWei;
        uint128 gasReserveWei;
        uint48 transactionDeadlineSeconds;
    }

    function run() external {
        _requirePublicTestnet();
        _requireAcknowledgement();
        _requireBroadcastConfirmation();
        Participants memory participants = _loadParticipants();
        DrillConfig memory currentConfig = _loadConfig();
        Deployment memory deployment = _loadDeployment();
        _validateBinding(deployment, currentConfig, participants);
        _validateFreshState(deployment);
        _requireTradingBalance(deployment.traderA, deployment.tradeAmountAWei, deployment);
        _requireTradingBalance(deployment.traderB, deployment.tradeAmountBWei, deployment);

        uint48 deadline = uint48(block.timestamp) + deployment.transactionDeadlineSeconds;

        vm.startBroadcast(participants.traderAKey);
        deployment.vault.setMySavingsBps(deployment.traderAUpdatedSavingsBps);
        deployment.market.buy{value: deployment.tradeAmountAWei}(deployment.stockAmountA, deadline);
        vm.stopBroadcast();

        vm.startBroadcast(participants.traderBKey);
        deployment.market.buy{value: deployment.tradeAmountBWei}(deployment.stockAmountB, deadline);
        vm.stopBroadcast();

        vm.startBroadcast(participants.adminKey);
        deployment.market.setPriceWeiPerToken(deployment.finalPriceWei);
        vm.stopBroadcast();

        vm.startBroadcast(participants.traderAKey);
        deployment.stock.approve(address(deployment.market), deployment.stockAmountA);
        deployment.market.sell(deployment.stockAmountA, deployment.sellAmountAWei, deadline);
        vm.stopBroadcast();

        vm.startBroadcast(participants.traderBKey);
        deployment.stock.approve(address(deployment.market), deployment.stockAmountB);
        deployment.market.sell(deployment.stockAmountB, deployment.sellAmountBWei, deadline);
        vm.stopBroadcast();

        _validateCompletedState(deployment);
        console2.log("PUBLIC TESTNET SYNTHETIC TRADES COMPLETED");
        console2.log("Trader A savings BPS", deployment.traderAUpdatedSavingsBps);
        console2.log("Trader B savings BPS", deployment.traderBSavingsBps);
        console2.log("Trader A synthetic sale proceeds", deployment.sellAmountAWei);
        console2.log("Trader B synthetic sale proceeds", deployment.sellAmountBWei);
        console2.log("Derive gas-inclusive receipt evidence before settlement.");
    }

    function _validateBinding(
        Deployment memory deployment,
        DrillConfig memory currentConfig,
        Participants memory participants
    ) private view {
        _requireAddress(deployment.admin, participants.admin);
        _requireAddress(deployment.vaultAdmin, participants.vaultAdmin);
        _requireAddress(deployment.traderA, participants.traderA);
        _requireAddress(deployment.traderB, participants.traderB);
        if (deployment.runId != currentConfig.runId) revert DeploymentConfigMismatch("RUN_ID");
        if (deployment.weth != currentConfig.weth) revert DeploymentConfigMismatch("WETH");
        _validateWeth(currentConfig.weth, currentConfig.expectedWethCodeHash);
    }

    function _validateFreshState(Deployment memory deployment) private view {
        if (deployment.market.priceWeiPerToken() != deployment.initialPriceWei) {
            revert DrillStateNotFresh("MARKET_PRICE");
        }
        if (deployment.stock.balanceOf(deployment.traderA) != 0 || deployment.stock.balanceOf(deployment.traderB) != 0) revert DrillStateNotFresh("STOCK_BALANCE");
        if (deployment.vault.aggregateLifetimeContribution() != 0) {
            revert DrillStateNotFresh("VAULT_CONTRIBUTION");
        }

        NuvemTypes.TradingAccount memory accountA = deployment.vault.getTradingAccount(deployment.traderA);
        NuvemTypes.TradingAccount memory accountB = deployment.vault.getTradingAccount(deployment.traderB);
        if (accountA.status != NuvemTypes.AccountStatus.ACTIVE || accountB.status != NuvemTypes.AccountStatus.ACTIVE) {
            revert DrillStateNotFresh("ACCOUNT_STATUS");
        }
        if (
            accountA.policy.savingsBps != deployment.traderAInitialSavingsBps
                || accountB.policy.savingsBps != deployment.traderBSavingsBps
        ) revert DrillStateNotFresh("ACCOUNT_BPS");
    }

    function _validateCompletedState(Deployment memory deployment) private view {
        if (deployment.stock.balanceOf(deployment.traderA) != 0 || deployment.stock.balanceOf(deployment.traderB) != 0) revert DrillStateNotFresh("OPEN_STOCK_POSITION");
        if (deployment.market.priceWeiPerToken() != deployment.finalPriceWei) {
            revert DrillStateNotFresh("FINAL_PRICE");
        }
        NuvemTypes.TradingAccount memory accountA = deployment.vault.getTradingAccount(deployment.traderA);
        NuvemTypes.TradingAccount memory accountB = deployment.vault.getTradingAccount(deployment.traderB);
        if (
            accountA.policy.savingsBps != deployment.traderAUpdatedSavingsBps
                || accountB.policy.savingsBps != deployment.traderBSavingsBps
        ) revert DrillStateNotFresh("UPDATED_BPS");
    }

    function _requireTradingBalance(address account, uint256 tradeAmount, Deployment memory deployment) private view {
        uint256 required = tradeAmount + deployment.tradingFloorWei + deployment.gasReserveWei;
        uint256 available = account.balance;
        if (available < required) revert InsufficientTradingBalance(account, required, available);
    }

    function _loadDeployment() private view returns (Deployment memory deployment) {
        string memory json = vm.readFile(_deploymentPath());
        deployment.runId = vm.parseJsonBytes32(json, ".runId");
        deployment.admin = vm.parseJsonAddress(json, ".admin");
        deployment.vaultAdmin = vm.parseJsonAddress(json, ".vaultAdmin");
        deployment.traderA = vm.parseJsonAddress(json, ".traderA");
        deployment.traderB = vm.parseJsonAddress(json, ".traderB");
        deployment.weth = vm.parseJsonAddress(json, ".weth");
        deployment.stock = DevnetSyntheticStock(vm.parseJsonAddress(json, ".stock"));
        deployment.market = DevnetStockMarket(payable(vm.parseJsonAddress(json, ".market")));
        deployment.vault = PersonalVault(payable(vm.parseJsonAddress(json, ".vault")));
        deployment.participantGasBudgetWei = vm.parseJsonUint(json, ".participantGasBudgetWei");
        deployment.tradeAmountAWei = vm.parseJsonUint(json, ".tradeAmountAWei");
        deployment.tradeAmountBWei = vm.parseJsonUint(json, ".tradeAmountBWei");
        deployment.stockAmountA = vm.parseJsonUint(json, ".stockAmountA");
        deployment.stockAmountB = vm.parseJsonUint(json, ".stockAmountB");
        deployment.sellAmountAWei = vm.parseJsonUint(json, ".sellAmountAWei");
        deployment.sellAmountBWei = vm.parseJsonUint(json, ".sellAmountBWei");
        deployment.initialPriceWei = vm.parseJsonUint(json, ".initialPriceWei");
        deployment.finalPriceWei = vm.parseJsonUint(json, ".finalPriceWei");
        deployment.traderAInitialSavingsBps =
            _asUint16("TRADER_A_INITIAL_BPS", vm.parseJsonUint(json, ".traderAInitialSavingsBps"));
        deployment.traderAUpdatedSavingsBps =
            _asUint16("TRADER_A_UPDATED_BPS", vm.parseJsonUint(json, ".traderAUpdatedSavingsBps"));
        deployment.traderBSavingsBps = _asUint16("TRADER_B_BPS", vm.parseJsonUint(json, ".traderBSavingsBps"));
        deployment.tradingFloorWei = _asUint128("TRADING_FLOOR", vm.parseJsonUint(json, ".tradingFloorWei"));
        deployment.gasReserveWei = _asUint128("GAS_RESERVE", vm.parseJsonUint(json, ".gasReserveWei"));
        deployment.transactionDeadlineSeconds =
            _asUint48("TX_DEADLINE", vm.parseJsonUint(json, ".transactionDeadlineSeconds"));
    }

    function _requireAddress(address expected, address actual) private pure {
        if (expected != actual) revert AddressMismatch(expected, actual);
    }
}
