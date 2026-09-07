// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AttesterRegistry} from "../src/registry/AttesterRegistry.sol";
import {DevnetStockMarket} from "../src/devnet/DevnetStockMarket.sol";
import {DevnetSyntheticStock} from "../src/devnet/DevnetSyntheticStock.sol";
import {NuvemTypes} from "../src/types/NuvemTypes.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";
import {ProtocolPauseController} from "../src/governance/ProtocolPauseController.sol";
import {SettlementExecutor} from "../src/settlement/SettlementExecutor.sol";
import {VaultFactory} from "../src/factory/VaultFactory.sol";
import {PublicTestnetDrillBase} from "./PublicTestnetDrillBase.s.sol";
import {AdapterRegistry} from "../src/registry/AdapterRegistry.sol";

/// @notice Phase 1: deploy an isolated synthetic canary on Robinhood Chain testnet.
/// @dev This deliberately uses EOA administration and a zero-delay cohort timelock.
///      It is not representative of production governance.
contract DeployPublicTestnetDrill is PublicTestnetDrillBase {
    AdapterRegistry internal _adapterRegistry;
    error FundingTransferFailed(address recipient, uint256 amount);

    struct Deployment {
        DevnetSyntheticStock stock;
        DevnetStockMarket market;
        ProtocolPauseController pauseController;
        AttesterRegistry attesterRegistry;
        VaultFactory factory;
        SettlementExecutor settlementExecutor;
        TimelockController cohortTimelock;
        PersonalVault vault;
        uint32 cohortId;
    }

    function run() external returns (Deployment memory deployment) {
        _requirePublicTestnet();
        _requireAcknowledgement();
        _requireBroadcastConfirmation();
        Participants memory participants = _loadParticipants();
        DrillConfig memory config = _loadConfig();
        _validateConfig(config, participants);
        TradeEconomics memory economics = _tradeEconomics(config);
        uint256 treasuryWethBaseline = IERC20(config.weth).balanceOf(participants.admin);
        uint256 vaultAdminWethBaseline = IERC20(config.weth).balanceOf(participants.vaultAdmin);

        vm.startBroadcast(participants.adminKey);
        deployment = _deploySyntheticTopology(participants, config);
        deployment.market.fundLiquidity{value: config.marketLiquidityWei}();
        _fundParticipant(participants.vaultAdmin, config.vaultAdminFundingWei);
        _fundParticipant(participants.traderA, config.traderAFundingWei);
        _fundParticipant(participants.traderB, config.traderBFundingWei);
        vm.stopBroadcast();

        vm.startBroadcast(participants.vaultAdminKey);
        deployment.vault = _createVault(deployment, config, participants.vaultAdmin);
        _inviteTradingAccounts(deployment.vault, participants, config);
        vm.stopBroadcast();

        vm.startBroadcast(participants.traderAKey);
        deployment.vault.acceptTradingAccount();
        vm.stopBroadcast();

        vm.startBroadcast(participants.traderBKey);
        deployment.vault.acceptTradingAccount();
        vm.stopBroadcast();

        _writeDeployment(deployment, participants, config, economics, treasuryWethBaseline, vaultAdminWethBaseline);
        _logDeployment(deployment, participants, config);
    }

    function _deploySyntheticTopology(Participants memory participants, DrillConfig memory config)
        private
        returns (Deployment memory deployment)
    {
        deployment.stock = new DevnetSyntheticStock(participants.admin, "Nuvem Public Testnet Synthetic Stock", "nTEST");
        deployment.market = new DevnetStockMarket(participants.admin, deployment.stock, config.initialPriceWeiPerToken);
        deployment.pauseController = new ProtocolPauseController(participants.admin, participants.admin);
        deployment.attesterRegistry =
            new AttesterRegistry(participants.admin, participants.admin, participants.attester);
        deployment.factory = new VaultFactory(participants.admin);
        deployment.settlementExecutor = new SettlementExecutor(
            address(deployment.factory), address(deployment.attesterRegistry), address(deployment.pauseController)
        );

        _adapterRegistry = new AdapterRegistry(participants.admin, participants.admin);

        deployment.factory
            .configureProtocol(
                VaultFactory.ProtocolConfiguration({
                    weth: config.weth,
                    pauseController: address(deployment.pauseController),
                    attesterRegistry: address(deployment.attesterRegistry),
                    settlementExecutor: address(deployment.settlementExecutor)
                })
            );

        address[] memory proposers = new address[](1);
        proposers[0] = participants.admin;
        address[] memory executors = new address[](1);
        executors[0] = participants.admin;
        deployment.cohortTimelock = new TimelockController(0, proposers, executors, participants.admin);

        PersonalVault implementation = new PersonalVault(address(_adapterRegistry));
        (deployment.cohortId,) =
            deployment.factory.registerCohort(address(implementation), address(deployment.cohortTimelock));

        deployment.stock.setMinter(address(deployment.market), true);
    }

    function _createVault(Deployment memory deployment, DrillConfig memory config, address vaultAdmin)
        private
        returns (PersonalVault vault)
    {
        uint128 rollingCap = _maxRollingContribution(config);
        NuvemTypes.VaultInitialization memory initialization = NuvemTypes.VaultInitialization({
            weth: config.weth,
            pauseController: address(deployment.pauseController),
            attesterRegistry: address(deployment.attesterRegistry),
            settlementExecutor: address(deployment.settlementExecutor),
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: rollingCap})
        });

        (, address vaultAddress) = deployment.factory
            .createVault(
                keccak256(abi.encode("PUBLIC_TESTNET_SYNTHETIC_DRILL", config.runId, vaultAdmin)),
                deployment.cohortId,
                abi.encode(initialization)
            );
        return PersonalVault(payable(vaultAddress));
    }

    function _inviteTradingAccounts(PersonalVault vault, Participants memory participants, DrillConfig memory config)
        private
    {
        uint48 invitationDeadline = uint48(block.timestamp) + config.inviteLifetimeSeconds;
        vault.inviteTradingAccount(
            participants.traderA,
            PLATFORM_A,
            _tradingPolicy(config, config.traderAInitialSavingsBps),
            invitationDeadline
        );
        vault.inviteTradingAccount(
            participants.traderB, PLATFORM_B, _tradingPolicy(config, config.traderBSavingsBps), invitationDeadline
        );
    }

    function _tradingPolicy(DrillConfig memory config, uint16 savingsBps)
        private
        pure
        returns (NuvemTypes.TradingAccountPolicy memory)
    {
        return NuvemTypes.TradingAccountPolicy({
            savingsBps: savingsBps,
            minContributionWei: config.minContributionWei,
            maxPerSettlementWei: _maxPerSettlement(config),
            maxRolling30dWei: _maxRollingContribution(config),
            tradingFloorWei: config.tradingFloorWei,
            gasReserveWei: config.gasReserveWei
        });
    }

    function _fundParticipant(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = payable(recipient).call{value: amount}("");
        if (!success) revert FundingTransferFailed(recipient, amount);
    }

    function _writeDeployment(
        Deployment memory deployment,
        Participants memory participants,
        DrillConfig memory config,
        TradeEconomics memory economics,
        uint256 treasuryWethBaseline,
        uint256 vaultAdminWethBaseline
    ) private {
        string memory objectKey = "nuvemPublicTestnetSyntheticDrill";
        vm.serializeString(objectKey, "environment", "PUBLIC_TESTNET_SYNTHETIC_NOT_PRODUCTION");
        vm.serializeString(objectKey, "phase", "deployed");
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeBytes32(objectKey, "runId", config.runId);
        vm.serializeBytes32(objectKey, "expectedWethCodeHash", config.expectedWethCodeHash);
        vm.serializeUint(objectKey, "cohortId", deployment.cohortId);
        vm.serializeAddress(objectKey, "admin", participants.admin);
        vm.serializeAddress(objectKey, "vaultAdmin", participants.vaultAdmin);
        vm.serializeAddress(objectKey, "traderA", participants.traderA);
        vm.serializeAddress(objectKey, "traderB", participants.traderB);
        vm.serializeAddress(objectKey, "attester", participants.attester);
        vm.serializeAddress(objectKey, "weth", config.weth);
        vm.serializeAddress(objectKey, "stock", address(deployment.stock));
        vm.serializeAddress(objectKey, "market", address(deployment.market));
        vm.serializeAddress(objectKey, "pauseController", address(deployment.pauseController));
        vm.serializeAddress(objectKey, "attesterRegistry", address(deployment.attesterRegistry));
        vm.serializeAddress(objectKey, "factory", address(deployment.factory));
        vm.serializeAddress(objectKey, "settlementExecutor", address(deployment.settlementExecutor));
        vm.serializeAddress(objectKey, "cohortTimelock", address(deployment.cohortTimelock));
        vm.serializeAddress(objectKey, "vault", address(deployment.vault));
        vm.serializeUint(objectKey, "vaultAdminFundingWei", config.vaultAdminFundingWei);
        vm.serializeUint(objectKey, "traderAFundingWei", config.traderAFundingWei);
        vm.serializeUint(objectKey, "traderBFundingWei", config.traderBFundingWei);
        vm.serializeUint(objectKey, "marketLiquidityWei", config.marketLiquidityWei);
        vm.serializeUint(objectKey, "participantGasBudgetWei", config.participantGasBudgetWei);
        vm.serializeUint(objectKey, "tradeAmountAWei", config.tradeAmountAWei);
        vm.serializeUint(objectKey, "tradeAmountBWei", config.tradeAmountBWei);
        vm.serializeUint(objectKey, "stockAmountA", economics.stockAmountA);
        vm.serializeUint(objectKey, "stockAmountB", economics.stockAmountB);
        vm.serializeUint(objectKey, "sellAmountAWei", economics.sellAmountA);
        vm.serializeUint(objectKey, "sellAmountBWei", economics.sellAmountB);
        vm.serializeUint(objectKey, "grossProfitAWei", economics.grossProfitA);
        vm.serializeUint(objectKey, "grossProfitBWei", economics.grossProfitB);
        vm.serializeUint(objectKey, "initialPriceWei", config.initialPriceWeiPerToken);
        vm.serializeUint(objectKey, "finalPriceWei", config.finalPriceWeiPerToken);
        vm.serializeUint(objectKey, "traderAInitialSavingsBps", config.traderAInitialSavingsBps);
        vm.serializeUint(objectKey, "traderAUpdatedSavingsBps", config.traderAUpdatedSavingsBps);
        vm.serializeUint(objectKey, "traderBSavingsBps", config.traderBSavingsBps);
        vm.serializeUint(objectKey, "minContributionWei", config.minContributionWei);
        vm.serializeUint(objectKey, "tradingFloorWei", config.tradingFloorWei);
        vm.serializeUint(objectKey, "gasReserveWei", config.gasReserveWei);
        vm.serializeUint(objectKey, "transactionDeadlineSeconds", config.transactionDeadlineSeconds);
        vm.serializeUint(objectKey, "treasuryWethBaseline", treasuryWethBaseline);
        string memory json = vm.serializeUint(objectKey, "vaultAdminWethBaseline", vaultAdminWethBaseline);
        vm.writeJson(json, _deploymentPath());
    }

    function _logDeployment(Deployment memory deployment, Participants memory participants, DrillConfig memory config)
        private
        view
    {
        console2.log("PUBLIC TESTNET SYNTHETIC DRILL DEPLOYED");
        console2.log("Environment: synthetic, EOA-administered, NOT production-like");
        console2.log("Run ID");
        console2.logBytes32(config.runId);
        console2.log("Vault", address(deployment.vault));
        console2.log("Synthetic stock", address(deployment.stock));
        console2.log("Synthetic market", address(deployment.market));
        console2.log("Trader A", participants.traderA);
        console2.log("Trader B", participants.traderB);
        console2.log("Deployment JSON", _deploymentPath());
    }
}
