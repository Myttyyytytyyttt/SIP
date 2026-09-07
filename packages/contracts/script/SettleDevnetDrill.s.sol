// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {AttesterRegistry} from "../src/registry/AttesterRegistry.sol";
import {DevnetSyntheticStock} from "../src/devnet/DevnetSyntheticStock.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../src/types/NuvemTypes.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";
import {ProtocolPauseController} from "../src/governance/ProtocolPauseController.sol";
import {SettlementExecutor} from "../src/settlement/SettlementExecutor.sol";

/// @notice Phase 3: settle receipt-rooted PnL for both drill traders.
/// @dev Both traders deliberately settle against the SAME L1 range and DISJOINT
///      L2 ranges, so the drill exercises on a real chain the case that the L2
///      progression rule exists for.
contract SettleDevnetDrill is Script {
    uint256 private constant LOCAL_CHAIN_ID = 31_337;

    error AddressMismatch(address expected, address actual);
    error DrillInvariantFailed(bytes32 invariantId);
    error InvalidTradeRange(uint64 startBlock, uint64 endBlock, uint256 currentBlock);
    error InvalidL2TradeRange(uint64 startBlockL2, uint64 endBlockL2);
    error LocalChainOnly(uint256 chainId);

    struct Deployment {
        address admin;
        address vaultAdmin;
        address traderA;
        address traderB;
        address attester;
        MockWETH weth;
        DevnetSyntheticStock stock;
        ProtocolPauseController pauseController;
        AttesterRegistry attesterRegistry;
        SettlementExecutor settlementExecutor;
        PersonalVault vault;
    }

    struct TradeEvidence {
        bytes32 ledgerRootA;
        bytes32 ledgerRootB;
        uint64 startBlockA;
        uint64 endBlockA;
        uint64 startBlockB;
        uint64 endBlockB;
        uint64 startBlockL2A;
        uint64 endBlockL2A;
        uint64 startBlockL2B;
        uint64 endBlockL2B;
        uint256 cashStartA;
        uint256 cashEndA;
        uint256 cashStartB;
        uint256 cashEndB;
        uint256 profitA;
        uint256 profitB;
        uint256 contributionA;
        uint256 contributionB;
    }

    function run() external {
        if (block.chainid != LOCAL_CHAIN_ID) revert LocalChainOnly(block.chainid);
        Deployment memory deployment = _loadDeployment();
        TradeEvidence memory evidence = _loadTradeEvidence();

        uint256 vaultAdminKey = vm.envUint("DEVNET_VAULT_ADMIN_PRIVATE_KEY");
        uint256 traderAKey = vm.envUint("DEVNET_TRADER_A_PRIVATE_KEY");
        uint256 traderBKey = vm.envUint("DEVNET_TRADER_B_PRIVATE_KEY");
        uint256 attesterKey = vm.envUint("DEVNET_ATTESTER_PRIVATE_KEY");
        _requireAddress(deployment.admin, vm.addr(vm.envUint("DEVNET_ADMIN_PRIVATE_KEY")));
        _requireAddress(deployment.vaultAdmin, vm.addr(vaultAdminKey));
        _requireAddress(deployment.traderA, vm.addr(traderAKey));
        _requireAddress(deployment.traderB, vm.addr(traderBKey));
        _requireAddress(deployment.attester, vm.addr(attesterKey));

        _validateRange(evidence.startBlockA, evidence.endBlockA);
        _validateRange(evidence.startBlockB, evidence.endBlockB);
        _validateL2Range(evidence.startBlockL2A, evidence.endBlockL2A);
        _validateL2Range(evidence.startBlockL2B, evidence.endBlockL2B);
        if (
            deployment.vault.aggregateLifetimeContribution() != 0
                || deployment.weth.balanceOf(address(deployment.vault)) != 0
        ) revert DrillInvariantFailed("SETTLEMENT_NOT_FRESH");

        // Forge script simulation does not auto-mine between broadcast calls.
        // The real Anvil broadcasts do, so this roll is simulation-only. It keys
        // off the L1 heights, because `block.number` here is the L1 clock.
        uint64 highestEndBlock = evidence.endBlockA > evidence.endBlockB ? evidence.endBlockA : evidence.endBlockB;
        if (block.number <= highestEndBlock) vm.roll(uint256(highestEndBlock) + 1);

        NuvemTypes.SettlementAttestation memory attestationA = _attestation(
            deployment,
            deployment.traderA,
            evidence.cashStartA,
            evidence.cashEndA,
            int256(evidence.profitA),
            evidence.contributionA,
            [evidence.startBlockA, evidence.endBlockA, evidence.startBlockL2A, evidence.endBlockL2A],
            evidence.ledgerRootA
        );
        NuvemTypes.SettlementAttestation memory attestationB = _attestation(
            deployment,
            deployment.traderB,
            evidence.cashStartB,
            evidence.cashEndB,
            int256(evidence.profitB),
            evidence.contributionB,
            [evidence.startBlockB, evidence.endBlockB, evidence.startBlockL2B, evidence.endBlockL2B],
            evidence.ledgerRootB
        );

        bytes memory signatureA = _sign(deployment.settlementExecutor, attestationA, attesterKey);
        bytes memory signatureB = _sign(deployment.settlementExecutor, attestationB, attesterKey);

        vm.startBroadcast(traderAKey);
        deployment.settlementExecutor.settle{value: evidence.contributionA}(attestationA, signatureA);
        vm.stopBroadcast();

        vm.startBroadcast(traderBKey);
        deployment.settlementExecutor.settle{value: evidence.contributionB}(attestationB, signatureB);
        vm.stopBroadcast();

        _assertFinalState(deployment, evidence);
        console2.log("Settlement phase completed; verify on-chain state");
        console2.log("Aggregate saved WETH", deployment.vault.aggregateLifetimeContribution());
        console2.log("Vault WETH", deployment.weth.balanceOf(address(deployment.vault)));
    }

    /// @param blocks [startBlockL1, endBlockL1, startBlockL2, endBlockL2].
    function _attestation(
        Deployment memory deployment,
        address account,
        uint256 cashStart,
        uint256 cashEnd,
        int256 realizedProfit,
        uint256 contribution,
        uint64[4] memory blocks,
        bytes32 ledgerRoot
    ) private view returns (NuvemTypes.SettlementAttestation memory attestation) {
        NuvemTypes.TradingAccount memory tradingAccount = deployment.vault.getTradingAccount(account);
        attestation = NuvemTypes.SettlementAttestation({
            account: account,
            vault: address(deployment.vault),
            executor: address(deployment.settlementExecutor),
            chainId: block.chainid,
            bindingEpoch: tradingAccount.bindingEpoch,
            policyNonce: tradingAccount.policyNonce,
            adminEpoch: deployment.vault.adminEpoch(),
            localPauseEpoch: deployment.vault.localPauseEpoch(),
            globalPauseEpoch: deployment.pauseController.pauseEpoch(),
            settlementNonce: tradingAccount.settlementNonce,
            policyHash: deployment.vault.policyHash(account),
            sessionId: bytes32(0),
            ledgerRoot: ledgerRoot,
            startBlock: blocks[0],
            endBlock: blocks[1],
            startBlockL2: blocks[2],
            endBlockL2: blocks[3],
            cashStart: cashStart,
            cashEnd: cashEnd,
            externalDeposits: 0,
            externalWithdrawals: 0,
            realizedProfit: realizedProfit,
            contribution: contribution,
            attesterEpoch: deployment.attesterRegistry.attesterEpoch(),
            validAfter: uint48(block.timestamp),
            deadline: uint48(block.timestamp + 10 minutes)
        });
        attestation.sessionId = deployment.settlementExecutor
            .deriveSessionId(
                block.chainid,
                address(deployment.vault),
                account,
                tradingAccount.bindingEpoch,
                blocks[0],
                blocks[1],
                blocks[2],
                blocks[3],
                ledgerRoot
            );
    }

    function _sign(
        SettlementExecutor settlementExecutor,
        NuvemTypes.SettlementAttestation memory attestation,
        uint256 attesterKey
    ) private view returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, settlementExecutor.hashAttestation(attestation));
        return abi.encodePacked(r, s, v);
    }

    /// @dev With the investment path gone, every contributed wei is WETH held by
    ///      the vault and nowhere else. That is a stronger statement than the
    ///      three-way vault/adapter/treasury split it replaces.
    function _assertFinalState(Deployment memory deployment, TradeEvidence memory evidence) private view {
        if (deployment.vault.lifetimeContribution(deployment.traderA) != evidence.contributionA) {
            revert DrillInvariantFailed("TRADER_A_CONTRIBUTION");
        }
        if (deployment.vault.lifetimeContribution(deployment.traderB) != evidence.contributionB) {
            revert DrillInvariantFailed("TRADER_B_CONTRIBUTION");
        }
        uint256 aggregateContribution = evidence.contributionA + evidence.contributionB;
        if (deployment.vault.aggregateLifetimeContribution() != aggregateContribution) {
            revert DrillInvariantFailed("AGGREGATE_CONTRIBUTION");
        }
        if (deployment.weth.balanceOf(address(deployment.vault)) != aggregateContribution) {
            revert DrillInvariantFailed("VAULT_WETH");
        }
        if (address(deployment.vault).balance != 0) revert DrillInvariantFailed("VAULT_NATIVE_RESIDUE");
    }

    function _loadDeployment() private view returns (Deployment memory deployment) {
        string memory json = vm.readFile(_deploymentPath());
        deployment.admin = vm.parseJsonAddress(json, ".admin");
        deployment.vaultAdmin = vm.parseJsonAddress(json, ".vaultAdmin");
        deployment.traderA = vm.parseJsonAddress(json, ".traderA");
        deployment.traderB = vm.parseJsonAddress(json, ".traderB");
        deployment.attester = vm.parseJsonAddress(json, ".attester");
        deployment.weth = MockWETH(payable(vm.parseJsonAddress(json, ".weth")));
        deployment.stock = DevnetSyntheticStock(vm.parseJsonAddress(json, ".stock"));
        deployment.pauseController = ProtocolPauseController(vm.parseJsonAddress(json, ".pauseController"));
        deployment.attesterRegistry = AttesterRegistry(vm.parseJsonAddress(json, ".attesterRegistry"));
        deployment.settlementExecutor = SettlementExecutor(vm.parseJsonAddress(json, ".settlementExecutor"));
        deployment.vault = PersonalVault(payable(vm.parseJsonAddress(json, ".vault")));
    }

    function _loadTradeEvidence() private view returns (TradeEvidence memory evidence) {
        evidence.ledgerRootA = vm.envBytes32("DEVNET_LEDGER_ROOT_A");
        evidence.ledgerRootB = vm.envBytes32("DEVNET_LEDGER_ROOT_B");
        evidence.startBlockA = uint64(vm.envUint("DEVNET_TRADE_START_BLOCK_A"));
        evidence.endBlockA = uint64(vm.envUint("DEVNET_TRADE_END_BLOCK_A"));
        evidence.startBlockB = uint64(vm.envUint("DEVNET_TRADE_START_BLOCK_B"));
        evidence.endBlockB = uint64(vm.envUint("DEVNET_TRADE_END_BLOCK_B"));
        evidence.startBlockL2A = uint64(vm.envUint("DEVNET_TRADE_START_BLOCK_L2_A"));
        evidence.endBlockL2A = uint64(vm.envUint("DEVNET_TRADE_END_BLOCK_L2_A"));
        evidence.startBlockL2B = uint64(vm.envUint("DEVNET_TRADE_START_BLOCK_L2_B"));
        evidence.endBlockL2B = uint64(vm.envUint("DEVNET_TRADE_END_BLOCK_L2_B"));
        evidence.cashStartA = vm.envUint("DEVNET_CASH_START_A");
        evidence.cashEndA = vm.envUint("DEVNET_CASH_END_A");
        evidence.cashStartB = vm.envUint("DEVNET_CASH_START_B");
        evidence.cashEndB = vm.envUint("DEVNET_CASH_END_B");
        if (evidence.ledgerRootA == bytes32(0)) revert DrillInvariantFailed("LEDGER_ROOT_A");
        if (evidence.ledgerRootB == bytes32(0)) revert DrillInvariantFailed("LEDGER_ROOT_B");
        if (evidence.cashEndA <= evidence.cashStartA || evidence.cashEndB <= evidence.cashStartB) {
            revert DrillInvariantFailed("NON_POSITIVE_NET_PNL");
        }
        evidence.profitA = evidence.cashEndA - evidence.cashStartA;
        evidence.profitB = evidence.cashEndB - evidence.cashStartB;
        evidence.contributionA = evidence.profitA * 2_000 / 10_000;
        evidence.contributionB = evidence.profitB * 3_000 / 10_000;
    }

    /// @dev L1 only: `block.number` is the L1 clock, so this is the finalisation
    ///      guard. It is the script-level mirror of the executor's freshness rule.
    function _validateRange(uint64 startBlock, uint64 endBlock) private view {
        if (endBlock < startBlock || endBlock > block.number) {
            revert InvalidTradeRange(startBlock, endBlock, block.number);
        }
    }

    /// @dev L2 can only be checked for well-formedness. No L2 head is observable
    ///      from a contract on this chain, so there is no finalisation bound here.
    function _validateL2Range(uint64 startBlockL2, uint64 endBlockL2) private pure {
        if (endBlockL2 < startBlockL2 || startBlockL2 == 0) revert InvalidL2TradeRange(startBlockL2, endBlockL2);
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
