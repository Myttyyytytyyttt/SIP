// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DevnetFaucet} from "../src/devnet/DevnetFaucet.sol";
import {DevnetStockMarket} from "../src/devnet/DevnetStockMarket.sol";
import {DevnetSyntheticStock} from "../src/devnet/DevnetSyntheticStock.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";

/// @notice Phase 2 of the local drill: signed buy/approve/sell transactions.
contract ExecuteDevnetTrades is Script {
    uint256 private constant LOCAL_CHAIN_ID = 31_337;

    error AddressMismatch(address expected, address actual);
    error DrillStateNotFresh();
    error LocalChainOnly(uint256 chainId);

    struct Deployment {
        address vaultAdmin;
        address traderA;
        address traderB;
        DevnetSyntheticStock stock;
        DevnetStockMarket market;
        DevnetFaucet faucet;
        PersonalVault vault;
    }

    function run() external {
        if (block.chainid != LOCAL_CHAIN_ID) revert LocalChainOnly(block.chainid);
        Deployment memory deployment = _loadDeployment();

        uint256 adminKey = vm.envUint("DEVNET_ADMIN_PRIVATE_KEY");
        uint256 traderAKey = vm.envUint("DEVNET_TRADER_A_PRIVATE_KEY");
        uint256 traderBKey = vm.envUint("DEVNET_TRADER_B_PRIVATE_KEY");
        _requireAddress(deployment.traderA, vm.addr(traderAKey));
        _requireAddress(deployment.traderB, vm.addr(traderBKey));

        if (
            deployment.market.priceWeiPerToken() != 1 ether
                || IERC20(address(deployment.stock)).balanceOf(deployment.traderA) != 0
                || IERC20(address(deployment.stock)).balanceOf(deployment.traderB) != 0
                || deployment.vault.aggregateLifetimeContribution() != 0
                || !deployment.faucet.hasClaimed(deployment.traderA)
                || !deployment.faucet.hasClaimed(deployment.traderB)
        ) revert DrillStateNotFresh();

        uint48 deadline = uint48(block.timestamp + 15 minutes);

        vm.startBroadcast(traderAKey);
        deployment.market.buy{value: 4 ether}(4 ether, deadline);
        vm.stopBroadcast();

        vm.startBroadcast(traderBKey);
        deployment.market.buy{value: 2 ether}(2 ether, deadline);
        vm.stopBroadcast();

        vm.startBroadcast(adminKey);
        deployment.market.setPriceWeiPerToken(1.5 ether);
        vm.stopBroadcast();

        vm.startBroadcast(traderAKey);
        deployment.stock.approve(address(deployment.market), 4 ether);
        deployment.market.sell(4 ether, 6 ether, deadline);
        vm.stopBroadcast();

        vm.startBroadcast(traderBKey);
        deployment.stock.approve(address(deployment.market), 2 ether);
        deployment.market.sell(2 ether, 3 ether, deadline);
        vm.stopBroadcast();

        if (
            deployment.stock.balanceOf(deployment.traderA) != 0 || deployment.stock.balanceOf(deployment.traderB) != 0
                || deployment.market.priceWeiPerToken() != 1.5 ether
        ) revert DrillStateNotFresh();

        console2.log("Synthetic-stock transaction phase prepared/completed");
        console2.log("Trader A gross cash flow: 4 ETH -> 6 ETH");
        console2.log("Trader B gross cash flow: 2 ETH -> 3 ETH");
        console2.log("Verify broadcast receipts and derive ledger roots before settlement.");
    }

    function _loadDeployment() private view returns (Deployment memory deployment) {
        string memory json = vm.readFile(_deploymentPath());
        deployment.vaultAdmin = vm.parseJsonAddress(json, ".vaultAdmin");
        deployment.traderA = vm.parseJsonAddress(json, ".traderA");
        deployment.traderB = vm.parseJsonAddress(json, ".traderB");
        deployment.stock = DevnetSyntheticStock(vm.parseJsonAddress(json, ".stock"));
        deployment.market = DevnetStockMarket(payable(vm.parseJsonAddress(json, ".market")));
        deployment.faucet = DevnetFaucet(payable(vm.parseJsonAddress(json, ".faucet")));
        deployment.vault = PersonalVault(payable(vm.parseJsonAddress(json, ".vault")));
    }

    function _deploymentPath() private view returns (string memory) {
        return string.concat(
            vm.projectRoot(), "/deployments/devnet-trading-drill-", vm.toString(block.chainid), ".local.json"
        );
    }

    function _requireAddress(address expected, address actual) private pure {
        if (expected != actual) revert AddressMismatch(expected, actual);
    }
}
