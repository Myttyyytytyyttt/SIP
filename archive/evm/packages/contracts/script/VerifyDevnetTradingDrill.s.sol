// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {DevnetFaucet} from "../src/devnet/DevnetFaucet.sol";
import {DevnetStockMarket} from "../src/devnet/DevnetStockMarket.sol";
import {DevnetSyntheticStock} from "../src/devnet/DevnetSyntheticStock.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";

/// @notice Read-only phase 4 verification and evidence export.
contract VerifyDevnetTradingDrill is Script {
    uint256 private constant LOCAL_CHAIN_ID = 31_337;

    error DrillInvariantFailed(bytes32 invariantId);
    error LocalChainOnly(uint256 chainId);

    struct Deployment {
        address admin;
        address traderA;
        address traderB;
        MockWETH weth;
        DevnetSyntheticStock stock;
        DevnetStockMarket market;
        DevnetFaucet faucet;
        PersonalVault vault;
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
    }

    function run() external {
        if (block.chainid != LOCAL_CHAIN_ID) revert LocalChainOnly(block.chainid);
        Deployment memory deployment = _loadDeployment();
        Results memory results = _loadResults();

        results.aggregateContribution = results.contributionA + results.contributionB;
        results.vaultWeth = deployment.weth.balanceOf(address(deployment.vault));

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
        // Every contributed wei is WETH in the vault and nowhere else.
        if (results.vaultWeth != results.aggregateContribution) {
            revert DrillInvariantFailed("VAULT_WETH");
        }
        if (address(deployment.vault).balance != 0) revert DrillInvariantFailed("VAULT_NATIVE_RESIDUE");
        if (deployment.stock.balanceOf(deployment.traderA) != 0 || deployment.stock.balanceOf(deployment.traderB) != 0)
        {
            revert DrillInvariantFailed("OPEN_STOCK_POSITION");
        }
        if (deployment.market.priceWeiPerToken() != 1.5 ether) {
            revert DrillInvariantFailed("MARKET_PRICE");
        }
        if (!deployment.faucet.hasClaimed(deployment.traderA) || !deployment.faucet.hasClaimed(deployment.traderB)) {
            revert DrillInvariantFailed("FAUCET_FUNDING");
        }

        _writeResults(deployment, results);
        console2.log("Devnet trading drill verified against post-broadcast state");
        console2.log("Evidence JSON", _resultsPath());
    }

    function _loadResults() private view returns (Results memory results) {
        results.ledgerRootA = vm.envBytes32("DEVNET_LEDGER_ROOT_A");
        results.ledgerRootB = vm.envBytes32("DEVNET_LEDGER_ROOT_B");
        results.cashStartA = vm.envUint("DEVNET_CASH_START_A");
        results.cashEndA = vm.envUint("DEVNET_CASH_END_A");
        results.cashStartB = vm.envUint("DEVNET_CASH_START_B");
        results.cashEndB = vm.envUint("DEVNET_CASH_END_B");
        if (results.cashEndA <= results.cashStartA || results.cashEndB <= results.cashStartB) {
            revert DrillInvariantFailed("NON_POSITIVE_NET_PNL");
        }
        results.profitA = results.cashEndA - results.cashStartA;
        results.profitB = results.cashEndB - results.cashStartB;
        results.contributionA = results.profitA * 2_000 / 10_000;
        results.contributionB = results.profitB * 3_000 / 10_000;
    }

    function _loadDeployment() private view returns (Deployment memory deployment) {
        string memory json = vm.readFile(_deploymentPath());
        deployment.admin = vm.parseJsonAddress(json, ".admin");
        deployment.traderA = vm.parseJsonAddress(json, ".traderA");
        deployment.traderB = vm.parseJsonAddress(json, ".traderB");
        deployment.weth = MockWETH(payable(vm.parseJsonAddress(json, ".weth")));
        deployment.stock = DevnetSyntheticStock(vm.parseJsonAddress(json, ".stock"));
        deployment.market = DevnetStockMarket(payable(vm.parseJsonAddress(json, ".market")));
        deployment.faucet = DevnetFaucet(payable(vm.parseJsonAddress(json, ".faucet")));
        deployment.vault = PersonalVault(payable(vm.parseJsonAddress(json, ".vault")));
    }

    function _writeResults(Deployment memory deployment, Results memory results) private {
        string memory objectKey = "nuvemDevnetTradingDrillResults";
        vm.serializeString(objectKey, "status", "verified");
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeUint(objectKey, "verifiedAtBlock", block.number);
        vm.serializeAddress(objectKey, "vault", address(deployment.vault));
        vm.serializeAddress(objectKey, "stock", address(deployment.stock));
        vm.serializeAddress(objectKey, "market", address(deployment.market));
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
        string memory json = vm.serializeUint(objectKey, "vaultWeth", results.vaultWeth);
        vm.writeJson(json, _resultsPath());
    }

    function _deploymentPath() private view returns (string memory) {
        return string.concat(
            vm.projectRoot(), "/deployments/devnet-trading-drill-", vm.toString(block.chainid), ".local.json"
        );
    }

    function _resultsPath() private view returns (string memory) {
        return string.concat(
            vm.projectRoot(), "/deployments/devnet-trading-drill-results-", vm.toString(block.chainid), ".local.json"
        );
    }
}
