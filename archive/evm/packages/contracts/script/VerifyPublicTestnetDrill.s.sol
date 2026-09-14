// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {DevnetStockMarket} from "../src/devnet/DevnetStockMarket.sol";
import {DevnetSyntheticStock} from "../src/devnet/DevnetSyntheticStock.sol";
import {NuvemTypes} from "../src/types/NuvemTypes.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";
import {VaultFactory} from "../src/factory/VaultFactory.sol";
import {PublicTestnetDrillBase} from "./PublicTestnetDrillBase.s.sol";

/// @notice Read-only phase 4 verification and evidence export for the synthetic canary.
contract VerifyPublicTestnetDrill is PublicTestnetDrillBase {
    error DeploymentConfigMismatch(bytes32 field);
    error DrillInvariantFailed(bytes32 invariantId);

    struct Deployment {
        bytes32 runId;
        address admin;
        address vaultAdmin;
        address traderA;
        address traderB;
        address weth;
        DevnetSyntheticStock stock;
        DevnetStockMarket market;
        VaultFactory factory;
        PersonalVault vault;
        uint256 finalPriceWei;
        uint256 treasuryWethBaseline;
        uint256 vaultAdminWethBaseline;
        uint16 traderAUpdatedSavingsBps;
        uint16 traderBSavingsBps;
    }

    struct Results {
        bytes32 ledgerRootA;
        bytes32 ledgerRootB;
        uint256 cashStartA;
        uint256 cashEndA;
        uint256 cashStartB;
        uint256 cashEndB;
        uint256 profitA;
        uint256 profitB;
        uint256 contributionA;
        uint256 contributionB;
        uint256 aggregateContribution;
        uint256 vaultWeth;
        uint256 treasuryWethDelta;
        uint256 withdrawalWeth;
        uint256 withdrawalRecipientDelta;
    }

    function run() external {
        _requirePublicTestnet();
        _requireAcknowledgement();
        DrillConfig memory currentConfig = _loadConfig();
        Deployment memory deployment = _loadDeployment();
        if (deployment.runId != currentConfig.runId) revert DeploymentConfigMismatch("RUN_ID");
        if (deployment.weth != currentConfig.weth) revert DeploymentConfigMismatch("WETH");
        _validateWeth(currentConfig.weth, currentConfig.expectedWethCodeHash);

        Results memory results = _loadResults(deployment);
        _readFinalBalances(deployment, results);
        _assertFinalState(deployment, results);
        _writeResults(deployment, results);

        console2.log("PUBLIC TESTNET SYNTHETIC DRILL: VERIFIED");
        console2.log("Environment is synthetic and NOT production-like.");
        console2.log("Evidence JSON", _resultsPath());
    }

    function _loadResults(Deployment memory deployment) private view returns (Results memory results) {
        results.ledgerRootA = vm.envBytes32("PUBLIC_TESTNET_DRILL_LEDGER_ROOT_A");
        results.ledgerRootB = vm.envBytes32("PUBLIC_TESTNET_DRILL_LEDGER_ROOT_B");
        results.cashStartA = vm.envUint("PUBLIC_TESTNET_DRILL_CASH_START_A");
        results.cashEndA = vm.envUint("PUBLIC_TESTNET_DRILL_CASH_END_A");
        results.cashStartB = vm.envUint("PUBLIC_TESTNET_DRILL_CASH_START_B");
        results.cashEndB = vm.envUint("PUBLIC_TESTNET_DRILL_CASH_END_B");
        if (
            results.ledgerRootA == bytes32(0) || results.ledgerRootB == bytes32(0)
                || results.cashEndA <= results.cashStartA || results.cashEndB <= results.cashStartB
        ) revert DrillInvariantFailed("TRADE_EVIDENCE");

        results.profitA = results.cashEndA - results.cashStartA;
        results.profitB = results.cashEndB - results.cashStartB;
        results.contributionA = Math.mulDiv(results.profitA, deployment.traderAUpdatedSavingsBps, BPS_DENOMINATOR);
        results.contributionB = Math.mulDiv(results.profitB, deployment.traderBSavingsBps, BPS_DENOMINATOR);
        results.aggregateContribution = results.contributionA + results.contributionB;
        results.withdrawalWeth = results.aggregateContribution / 2;
    }

    function _readFinalBalances(Deployment memory deployment, Results memory results) private view {
        results.vaultWeth = IERC20(deployment.weth).balanceOf(address(deployment.vault));
        uint256 treasuryWeth = IERC20(deployment.weth).balanceOf(deployment.admin);
        if (treasuryWeth < deployment.treasuryWethBaseline) {
            revert DrillInvariantFailed("TREASURY_BASELINE");
        }
        results.treasuryWethDelta = treasuryWeth - deployment.treasuryWethBaseline;
        uint256 withdrawalRecipientWeth = IERC20(deployment.weth).balanceOf(deployment.vaultAdmin);
        if (withdrawalRecipientWeth < deployment.vaultAdminWethBaseline) {
            revert DrillInvariantFailed("WITHDRAWAL_BASELINE");
        }
        results.withdrawalRecipientDelta = withdrawalRecipientWeth - deployment.vaultAdminWethBaseline;
    }

    function _assertFinalState(Deployment memory deployment, Results memory results) private view {
        if (deployment.vault.lifetimeContribution(deployment.traderA) != results.contributionA) {
            revert DrillInvariantFailed("TRADER_A_CONTRIBUTION");
        }
        if (deployment.vault.lifetimeContribution(deployment.traderB) != results.contributionB) {
            revert DrillInvariantFailed("TRADER_B_CONTRIBUTION");
        }
        if (deployment.vault.aggregateLifetimeContribution() != results.aggregateContribution) {
            revert DrillInvariantFailed("AGGREGATE_CONTRIBUTION");
        }
        if (deployment.vault.activeTradingAccountCount() != 2) {
            revert DrillInvariantFailed("ACTIVE_ACCOUNTS");
        }
        if (
            !deployment.factory.isVault(address(deployment.vault))
                || deployment.factory.vaultOfAdmin(deployment.vaultAdmin) != address(deployment.vault)
                || deployment.factory.activeVaultOf(deployment.traderA) != address(deployment.vault)
                || deployment.factory.activeVaultOf(deployment.traderB) != address(deployment.vault)
        ) revert DrillInvariantFailed("PERMANENT_VAULT_BINDING");
        NuvemTypes.TradingAccount memory accountA = deployment.vault.getTradingAccount(deployment.traderA);
        NuvemTypes.TradingAccount memory accountB = deployment.vault.getTradingAccount(deployment.traderB);
        if (
            accountA.policy.savingsBps != deployment.traderAUpdatedSavingsBps
                || accountB.policy.savingsBps != deployment.traderBSavingsBps || accountA.settlementNonce != 1
                || accountB.settlementNonce != 1
        ) revert DrillInvariantFailed("ACCOUNT_STATE");
        if (deployment.stock.balanceOf(deployment.traderA) != 0 || deployment.stock.balanceOf(deployment.traderB) != 0) revert DrillInvariantFailed("OPEN_STOCK_POSITION");
        if (deployment.market.priceWeiPerToken() != deployment.finalPriceWei) {
            revert DrillInvariantFailed("MARKET_PRICE");
        }
        // Settlement charges no protocol fee anywhere, so the treasury must not
        // have moved at all.
        if (results.treasuryWethDelta != 0) revert DrillInvariantFailed("TREASURY_WETH");
        if (results.withdrawalWeth == 0 || results.withdrawalRecipientDelta != results.withdrawalWeth) {
            revert DrillInvariantFailed("ZERO_FEE_WITHDRAWAL");
        }
        // Every contributed wei is either still WETH in the vault or was
        // withdrawn intact.
        if (results.vaultWeth + results.withdrawalRecipientDelta != results.aggregateContribution) {
            revert DrillInvariantFailed("WETH_CONSERVATION");
        }
        if (address(deployment.vault).balance != 0) revert DrillInvariantFailed("VAULT_NATIVE_RESIDUE");
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
        deployment.factory = VaultFactory(vm.parseJsonAddress(json, ".factory"));
        deployment.vault = PersonalVault(payable(vm.parseJsonAddress(json, ".vault")));
        deployment.finalPriceWei = vm.parseJsonUint(json, ".finalPriceWei");
        deployment.treasuryWethBaseline = vm.parseJsonUint(json, ".treasuryWethBaseline");
        deployment.vaultAdminWethBaseline = vm.parseJsonUint(json, ".vaultAdminWethBaseline");
        deployment.traderAUpdatedSavingsBps =
            _asUint16("TRADER_A_UPDATED_BPS", vm.parseJsonUint(json, ".traderAUpdatedSavingsBps"));
        deployment.traderBSavingsBps = _asUint16("TRADER_B_BPS", vm.parseJsonUint(json, ".traderBSavingsBps"));
    }

    function _writeResults(Deployment memory deployment, Results memory results) private {
        string memory objectKey = "nuvemPublicTestnetSyntheticDrillResults";
        vm.serializeString(objectKey, "status", "verified");
        vm.serializeString(objectKey, "environment", "PUBLIC_TESTNET_SYNTHETIC_NOT_PRODUCTION");
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeUint(objectKey, "verifiedAtBlock", block.number);
        vm.serializeBytes32(objectKey, "runId", deployment.runId);
        vm.serializeAddress(objectKey, "vault", address(deployment.vault));
        vm.serializeAddress(objectKey, "weth", deployment.weth);
        vm.serializeAddress(objectKey, "syntheticStock", address(deployment.stock));
        vm.serializeAddress(objectKey, "syntheticMarket", address(deployment.market));
        vm.serializeBytes32(objectKey, "ledgerRootA", results.ledgerRootA);
        vm.serializeBytes32(objectKey, "ledgerRootB", results.ledgerRootB);
        vm.serializeUint(objectKey, "cashStartA", results.cashStartA);
        vm.serializeUint(objectKey, "cashEndA", results.cashEndA);
        vm.serializeUint(objectKey, "cashStartB", results.cashStartB);
        vm.serializeUint(objectKey, "cashEndB", results.cashEndB);
        vm.serializeUint(objectKey, "netProfitA", results.profitA);
        vm.serializeUint(objectKey, "netProfitB", results.profitB);
        vm.serializeUint(objectKey, "contributionA", results.contributionA);
        vm.serializeUint(objectKey, "contributionB", results.contributionB);
        vm.serializeUint(objectKey, "aggregateContribution", results.aggregateContribution);
        vm.serializeUint(objectKey, "vaultWeth", results.vaultWeth);
        vm.serializeUint(objectKey, "treasuryWethDelta", results.treasuryWethDelta);
        vm.serializeAddress(objectKey, "withdrawalRecipient", deployment.vaultAdmin);
        vm.serializeUint(objectKey, "withdrawalWeth", results.withdrawalWeth);
        vm.serializeUint(objectKey, "withdrawalRecipientDelta", results.withdrawalRecipientDelta);
        vm.serializeBool(objectKey, "vaultRemainsRegisteredAfterFullWethWithdrawal", true);
        string memory json = vm.serializeUint(objectKey, "withdrawalProtocolFeeBps", 0);
        vm.writeJson(json, _resultsPath());
    }
}
