// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {PublicTestnetDrillBase} from "./PublicTestnetDrillBase.s.sol";

/// @notice Read-only validation for the public-testnet synthetic drill.
contract PreflightPublicTestnetDrill is PublicTestnetDrillBase {
    function run() external view {
        _requirePublicTestnet();
        _requireAcknowledgement();
        Participants memory participants = _loadParticipants();
        DrillConfig memory config = _loadConfig();
        _validateConfig(config, participants);
        TradeEconomics memory economics = _tradeEconomics(config);

        console2.log("PUBLIC TESTNET SYNTHETIC DRILL PREFLIGHT: OK");
        console2.log("Chain ID", block.chainid);
        console2.log("Deployer", participants.admin);
        console2.log("Configured WETH", config.weth);
        console2.log("Required deployer balance", _requiredDeployerBalance(config));
        console2.log("Available deployer balance", participants.admin.balance);
        console2.log("Market liquidity", config.marketLiquidityWei);
        console2.log("Gross synthetic profit A", economics.grossProfitA);
        console2.log("Gross synthetic profit B", economics.grossProfitB);
        console2.log("No transaction was broadcast.");
    }
}
