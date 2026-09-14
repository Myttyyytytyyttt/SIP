// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AttesterRegistry} from "../src/registry/AttesterRegistry.sol";
import {DevnetFaucet} from "../src/devnet/DevnetFaucet.sol";
import {DevnetStockMarket} from "../src/devnet/DevnetStockMarket.sol";
import {DevnetSyntheticStock} from "../src/devnet/DevnetSyntheticStock.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../src/types/NuvemTypes.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";
import {ProtocolPauseController} from "../src/governance/ProtocolPauseController.sol";
import {SettlementExecutor} from "../src/settlement/SettlementExecutor.sol";
import {VaultFactory} from "../src/factory/VaultFactory.sol";
import {AdapterRegistry} from "../src/registry/AdapterRegistry.sol";

/// @notice Phase 1 of the signed-transaction local devnet drill.
/// @dev Local chain 31337 only. Never point this script at a public RPC.
contract DeployDevnetDrill is Script {
    /// @dev Timelock-owned in production; the guardian can deactivate an adapter
    ///      instantly and governance alone may register one.
    AdapterRegistry internal _adapterRegistry;
    uint256 private constant LOCAL_CHAIN_ID = 31_337;
    uint256 private constant FAUCET_CLAIM = 10 ether;
    uint256 private constant FAUCET_LIQUIDITY = 30 ether;
    uint256 private constant MARKET_LIQUIDITY = 50 ether;
    bytes32 private constant PLATFORM_A = keccak256("DEVNET_GMGN_SIM");
    bytes32 private constant PLATFORM_B = keccak256("DEVNET_BROKER_SIM");

    error LocalChainOnly(uint256 chainId);
    error DuplicateParticipant(address participant);
    error InvalidParticipant(address participant);

    struct Participants {
        uint256 adminKey;
        uint256 vaultAdminKey;
        uint256 traderAKey;
        uint256 traderBKey;
        uint256 attesterKey;
        address admin;
        address vaultAdmin;
        address traderA;
        address traderB;
        address attester;
    }

    struct Deployment {
        MockWETH weth;
        DevnetSyntheticStock stock;
        DevnetStockMarket market;
        DevnetFaucet faucet;
        ProtocolPauseController pauseController;
        AttesterRegistry attesterRegistry;
        VaultFactory factory;
        SettlementExecutor settlementExecutor;
        TimelockController cohortTimelock;
        PersonalVault vault;
        uint32 cohortId;
    }

    function run() external returns (Deployment memory deployment) {
        if (block.chainid != LOCAL_CHAIN_ID) revert LocalChainOnly(block.chainid);
        Participants memory participants = _loadParticipants();

        vm.startBroadcast(participants.adminKey);
        deployment = _deployCore(participants);
        // These are fresh derived accounts in the one-command runner. Funding
        // happens before any of them needs to pay gas.
        deployment.faucet.drip(participants.vaultAdmin);
        deployment.faucet.drip(participants.traderA);
        deployment.faucet.drip(participants.traderB);
        vm.stopBroadcast();

        vm.startBroadcast(participants.vaultAdminKey);
        deployment.vault = _createVault(deployment, participants.vaultAdmin);
        _inviteTradingAccounts(deployment.vault, participants);
        vm.stopBroadcast();

        vm.startBroadcast(participants.traderAKey);
        deployment.vault.acceptTradingAccount();
        vm.stopBroadcast();

        vm.startBroadcast(participants.traderBKey);
        deployment.vault.acceptTradingAccount();
        vm.stopBroadcast();

        _writeDeployment(deployment, participants);
        _logDeployment(deployment, participants);
    }

    function _deployCore(Participants memory participants) private returns (Deployment memory deployment) {
        deployment.weth = new MockWETH();
        deployment.stock = new DevnetSyntheticStock(participants.admin, "Nuvem Synthetic S&P 500", "nSPY");
        deployment.market = new DevnetStockMarket(participants.admin, deployment.stock, 1 ether);
        deployment.faucet = new DevnetFaucet{value: FAUCET_LIQUIDITY}(participants.admin, FAUCET_CLAIM);
        deployment.market.fundLiquidity{value: MARKET_LIQUIDITY}();

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
                    weth: address(deployment.weth),
                    pauseController: address(deployment.pauseController),
                    attesterRegistry: address(deployment.attesterRegistry),
                    settlementExecutor: address(deployment.settlementExecutor)
                })
            );

        address[] memory proposers = new address[](1);
        proposers[0] = participants.admin;
        address[] memory executors = new address[](1);
        executors[0] = participants.admin;
        deployment.cohortTimelock = new TimelockController(7 days, proposers, executors, participants.admin);

        PersonalVault implementation = new PersonalVault(address(_adapterRegistry));
        (deployment.cohortId,) =
            deployment.factory.registerCohort(address(implementation), address(deployment.cohortTimelock));

        deployment.stock.setMinter(address(deployment.market), true);
    }

    function _createVault(Deployment memory deployment, address vaultAdmin) private returns (PersonalVault vault) {
        NuvemTypes.VaultInitialization memory initialization = NuvemTypes.VaultInitialization({
            weth: address(deployment.weth),
            pauseController: address(deployment.pauseController),
            attesterRegistry: address(deployment.attesterRegistry),
            settlementExecutor: address(deployment.settlementExecutor),
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: 100 ether})
        });

        (, address vaultAddress) = deployment.factory
            .createVault(
                keccak256(abi.encode("DEVNET_TRADING_DRILL_VAULT", vaultAdmin)),
                deployment.cohortId,
                abi.encode(initialization)
            );
        return PersonalVault(payable(vaultAddress));
    }

    function _inviteTradingAccounts(PersonalVault vault, Participants memory participants) private {
        vault.inviteTradingAccount(
            participants.traderA, PLATFORM_A, _tradingPolicy(2_000), uint48(block.timestamp + 1 days)
        );
        vault.inviteTradingAccount(
            participants.traderB, PLATFORM_B, _tradingPolicy(3_000), uint48(block.timestamp + 1 days)
        );
    }

    function _tradingPolicy(uint16 savingsBps) private pure returns (NuvemTypes.TradingAccountPolicy memory) {
        return NuvemTypes.TradingAccountPolicy({
            savingsBps: savingsBps,
            minContributionWei: 0.001 ether,
            maxPerSettlementWei: 10 ether,
            maxRolling30dWei: 20 ether,
            tradingFloorWei: 0.5 ether,
            gasReserveWei: 0.1 ether
        });
    }

    function _loadParticipants() private view returns (Participants memory participants) {
        participants.adminKey = vm.envUint("DEVNET_ADMIN_PRIVATE_KEY");
        participants.vaultAdminKey = vm.envUint("DEVNET_VAULT_ADMIN_PRIVATE_KEY");
        participants.traderAKey = vm.envUint("DEVNET_TRADER_A_PRIVATE_KEY");
        participants.traderBKey = vm.envUint("DEVNET_TRADER_B_PRIVATE_KEY");
        participants.attesterKey = vm.envUint("DEVNET_ATTESTER_PRIVATE_KEY");
        participants.admin = vm.addr(participants.adminKey);
        participants.vaultAdmin = vm.addr(participants.vaultAdminKey);
        participants.traderA = vm.addr(participants.traderAKey);
        participants.traderB = vm.addr(participants.traderBKey);
        participants.attester = vm.addr(participants.attesterKey);

        address[5] memory accounts = [
            participants.admin,
            participants.vaultAdmin,
            participants.traderA,
            participants.traderB,
            participants.attester
        ];
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (accounts[i] == address(0)) revert InvalidParticipant(accounts[i]);
            for (uint256 j = i + 1; j < accounts.length; ++j) {
                if (accounts[i] == accounts[j]) revert DuplicateParticipant(accounts[i]);
            }
        }
    }

    function _deploymentPath() private view returns (string memory) {
        return string.concat(
            vm.projectRoot(), "/deployments/devnet-trading-drill-", vm.toString(block.chainid), ".local.json"
        );
    }

    function _writeDeployment(Deployment memory deployment, Participants memory participants) private {
        string memory objectKey = "nuvemDevnetTradingDrill";
        vm.serializeString(objectKey, "phase", "deployed");
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeUint(objectKey, "cohortId", deployment.cohortId);
        vm.serializeAddress(objectKey, "admin", participants.admin);
        vm.serializeAddress(objectKey, "vaultAdmin", participants.vaultAdmin);
        vm.serializeAddress(objectKey, "traderA", participants.traderA);
        vm.serializeAddress(objectKey, "traderB", participants.traderB);
        vm.serializeAddress(objectKey, "attester", participants.attester);
        vm.serializeAddress(objectKey, "weth", address(deployment.weth));
        vm.serializeAddress(objectKey, "stock", address(deployment.stock));
        vm.serializeAddress(objectKey, "market", address(deployment.market));
        vm.serializeAddress(objectKey, "faucet", address(deployment.faucet));
        vm.serializeAddress(objectKey, "pauseController", address(deployment.pauseController));
        vm.serializeAddress(objectKey, "attesterRegistry", address(deployment.attesterRegistry));
        vm.serializeAddress(objectKey, "factory", address(deployment.factory));
        vm.serializeAddress(objectKey, "settlementExecutor", address(deployment.settlementExecutor));
        vm.serializeAddress(objectKey, "cohortTimelock", address(deployment.cohortTimelock));
        string memory json = vm.serializeAddress(objectKey, "vault", address(deployment.vault));
        vm.writeJson(json, _deploymentPath());
    }

    function _logDeployment(Deployment memory deployment, Participants memory participants) private view {
        console2.log("Nuvem local devnet drill deployment");
        console2.log("Vault", address(deployment.vault));
        console2.log("Synthetic stock", address(deployment.stock));
        console2.log("Stock market", address(deployment.market));
        console2.log("Faucet", address(deployment.faucet));
        console2.log("Trader A", participants.traderA);
        console2.log("Trader B", participants.traderB);
        console2.log("Deployment JSON", _deploymentPath());
    }
}
