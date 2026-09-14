// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {AttesterRegistry} from "../src/registry/AttesterRegistry.sol";
import {DevnetSyntheticStock} from "../src/devnet/DevnetSyntheticStock.sol";
import {NuvemTypes} from "../src/types/NuvemTypes.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";
import {ProtocolPauseController} from "../src/governance/ProtocolPauseController.sol";
import {SettlementExecutor} from "../src/settlement/SettlementExecutor.sol";
import {PublicTestnetDrillBase} from "./PublicTestnetDrillBase.s.sol";

/// @notice Phase 3: settle receipt-rooted net PnL for both drill traders, then
///         prove that a withdrawal never charges a protocol fee.
contract SettlePublicTestnetDrill is PublicTestnetDrillBase {
    error AddressMismatch(address expected, address actual);
    error DeploymentConfigMismatch(bytes32 field);
    error DrillInvariantFailed(bytes32 invariantId);
    error InvalidTradeRange(uint64 startBlock, uint64 endBlock, uint256 currentBlock);
    error InvalidL2TradeRange(uint64 startBlockL2, uint64 endBlockL2);
    error TradeBlockNotFinalized(uint64 endBlock, uint256 currentBlock);

    struct Deployment {
        bytes32 runId;
        address admin;
        address vaultAdmin;
        address traderA;
        address traderB;
        address attester;
        address weth;
        DevnetSyntheticStock stock;
        ProtocolPauseController pauseController;
        AttesterRegistry attesterRegistry;
        SettlementExecutor settlementExecutor;
        PersonalVault vault;
        uint256 treasuryWethBaseline;
        uint256 vaultAdminWethBaseline;
        uint16 traderAUpdatedSavingsBps;
        uint16 traderBSavingsBps;
        uint128 minContributionWei;
        uint48 transactionDeadlineSeconds;
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
        _requirePublicTestnet();
        _requireAcknowledgement();
        _requireBroadcastConfirmation();
        Participants memory participants = _loadParticipants();
        DrillConfig memory currentConfig = _loadConfig();
        Deployment memory deployment = _loadDeployment();
        _validateBinding(deployment, currentConfig, participants);
        TradeEvidence memory evidence = _loadTradeEvidence(deployment);
        _validateFreshState(deployment);
        _validateRange(evidence.startBlockA, evidence.endBlockA);
        _validateRange(evidence.startBlockB, evidence.endBlockB);
        _validateL2Range(evidence.startBlockL2A, evidence.endBlockL2A);
        _validateL2Range(evidence.startBlockL2B, evidence.endBlockL2B);

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

        if (deployment.settlementExecutor.previewContribution(attestationA) != evidence.contributionA) {
            revert DrillInvariantFailed("PREVIEW_CONTRIBUTION_A");
        }
        if (deployment.settlementExecutor.previewContribution(attestationB) != evidence.contributionB) {
            revert DrillInvariantFailed("PREVIEW_CONTRIBUTION_B");
        }

        bytes memory signatureA = _sign(deployment.settlementExecutor, attestationA, participants.attesterKey);
        bytes memory signatureB = _sign(deployment.settlementExecutor, attestationB, participants.attesterKey);

        vm.startBroadcast(participants.traderAKey);
        deployment.settlementExecutor.settle{value: evidence.contributionA}(attestationA, signatureA);
        vm.stopBroadcast();

        vm.startBroadcast(participants.traderBKey);
        deployment.settlementExecutor.settle{value: evidence.contributionB}(attestationB, signatureB);
        vm.stopBroadcast();

        uint256 aggregateContribution = evidence.contributionA + evidence.contributionB;
        uint256 withdrawalAmount = aggregateContribution / 2;
        if (withdrawalAmount == 0) revert DrillInvariantFailed("WITHDRAWAL_ROUNDING");

        uint256 recipientBeforeWithdrawal = IERC20(deployment.weth).balanceOf(deployment.vaultAdmin);
        if (recipientBeforeWithdrawal != deployment.vaultAdminWethBaseline) {
            revert DrillInvariantFailed("WITHDRAWAL_BASELINE");
        }

        // Withdrawals are an explicit 0-bps product invariant.
        vm.startBroadcast(participants.vaultAdminKey);
        deployment.vault.withdrawToken(deployment.weth, deployment.vaultAdmin, withdrawalAmount);
        vm.stopBroadcast();

        if (IERC20(deployment.weth).balanceOf(deployment.vaultAdmin) != recipientBeforeWithdrawal + withdrawalAmount) {
            revert DrillInvariantFailed("WITHDRAWAL_RECIPIENT_DELTA");
        }

        _assertFinalState(deployment, evidence, withdrawalAmount);
        console2.log("PUBLIC TESTNET SYNTHETIC SETTLEMENT COMPLETED");
        console2.log("Aggregate net-profit contribution", aggregateContribution);
        console2.log("Zero-fee WETH withdrawal", withdrawalAmount);
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
        _requireAddress(deployment.attester, participants.attester);
        if (deployment.runId != currentConfig.runId) revert DeploymentConfigMismatch("RUN_ID");
        if (deployment.weth != currentConfig.weth) revert DeploymentConfigMismatch("WETH");
        _validateWeth(currentConfig.weth, currentConfig.expectedWethCodeHash);
    }

    function _validateFreshState(Deployment memory deployment) private view {
        if (
            deployment.vault.aggregateLifetimeContribution() != 0
                || IERC20(deployment.weth).balanceOf(address(deployment.vault)) != 0
                || IERC20(deployment.weth).balanceOf(deployment.admin) != deployment.treasuryWethBaseline
                || IERC20(deployment.weth).balanceOf(deployment.vaultAdmin) != deployment.vaultAdminWethBaseline
        ) revert DrillInvariantFailed("SETTLEMENT_NOT_FRESH");

        NuvemTypes.TradingAccount memory accountA = deployment.vault.getTradingAccount(deployment.traderA);
        NuvemTypes.TradingAccount memory accountB = deployment.vault.getTradingAccount(deployment.traderB);
        if (
            accountA.policy.savingsBps != deployment.traderAUpdatedSavingsBps
                || accountB.policy.savingsBps != deployment.traderBSavingsBps
        ) revert DrillInvariantFailed("SAVINGS_BPS");
    }

    function _loadTradeEvidence(Deployment memory deployment) private view returns (TradeEvidence memory evidence) {
        evidence.ledgerRootA = vm.envBytes32("PUBLIC_TESTNET_DRILL_LEDGER_ROOT_A");
        evidence.ledgerRootB = vm.envBytes32("PUBLIC_TESTNET_DRILL_LEDGER_ROOT_B");
        evidence.startBlockA = _asUint64(vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_A"));
        evidence.endBlockA = _asUint64(vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_A"));
        evidence.startBlockB = _asUint64(vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_B"));
        evidence.endBlockB = _asUint64(vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_B"));
        evidence.startBlockL2A = _asUint64(vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_L2_A"));
        evidence.endBlockL2A = _asUint64(vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_L2_A"));
        evidence.startBlockL2B = _asUint64(vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_START_BLOCK_L2_B"));
        evidence.endBlockL2B = _asUint64(vm.envUint("PUBLIC_TESTNET_DRILL_TRADE_END_BLOCK_L2_B"));
        evidence.cashStartA = vm.envUint("PUBLIC_TESTNET_DRILL_CASH_START_A");
        evidence.cashEndA = vm.envUint("PUBLIC_TESTNET_DRILL_CASH_END_A");
        evidence.cashStartB = vm.envUint("PUBLIC_TESTNET_DRILL_CASH_START_B");
        evidence.cashEndB = vm.envUint("PUBLIC_TESTNET_DRILL_CASH_END_B");

        if (evidence.ledgerRootA == bytes32(0) || evidence.ledgerRootB == bytes32(0)) {
            revert DrillInvariantFailed("LEDGER_ROOT");
        }
        if (evidence.cashEndA <= evidence.cashStartA || evidence.cashEndB <= evidence.cashStartB) {
            revert DrillInvariantFailed("NON_POSITIVE_NET_PNL");
        }
        evidence.profitA = evidence.cashEndA - evidence.cashStartA;
        evidence.profitB = evidence.cashEndB - evidence.cashStartB;
        evidence.contributionA = Math.mulDiv(evidence.profitA, deployment.traderAUpdatedSavingsBps, BPS_DENOMINATOR);
        evidence.contributionB = Math.mulDiv(evidence.profitB, deployment.traderBSavingsBps, BPS_DENOMINATOR);
        if (
            evidence.contributionA < deployment.minContributionWei
                || evidence.contributionB < deployment.minContributionWei
        ) revert DrillInvariantFailed("CONTRIBUTION_BELOW_MINIMUM");
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
            deadline: uint48(block.timestamp) + deployment.transactionDeadlineSeconds
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

    function _assertFinalState(
        Deployment memory deployment,
        TradeEvidence memory evidence,
        uint256 withdrawalAmount
    ) private view {
        uint256 aggregateContribution = evidence.contributionA + evidence.contributionB;
        if (deployment.vault.lifetimeContribution(deployment.traderA) != evidence.contributionA) {
            revert DrillInvariantFailed("TRADER_A_CONTRIBUTION");
        }
        if (deployment.vault.lifetimeContribution(deployment.traderB) != evidence.contributionB) {
            revert DrillInvariantFailed("TRADER_B_CONTRIBUTION");
        }
        if (deployment.vault.aggregateLifetimeContribution() != aggregateContribution) {
            revert DrillInvariantFailed("AGGREGATE_CONTRIBUTION");
        }
        // Every contributed wei is either still WETH in the vault or was
        // withdrawn intact. Nothing is skimmed anywhere in between.
        if (
            IERC20(deployment.weth).balanceOf(address(deployment.vault)) != aggregateContribution - withdrawalAmount
        ) revert DrillInvariantFailed("VAULT_WETH");
        if (
            IERC20(deployment.weth).balanceOf(deployment.vaultAdmin)
                != deployment.vaultAdminWethBaseline + withdrawalAmount
        ) revert DrillInvariantFailed("WITHDRAWAL_WETH");
        if (IERC20(deployment.weth).balanceOf(deployment.admin) != deployment.treasuryWethBaseline) {
            revert DrillInvariantFailed("TREASURY_UNCHANGED");
        }
        if (address(deployment.vault).balance != 0) revert DrillInvariantFailed("VAULT_NATIVE_RESIDUE");
    }

    /// @dev L1 only, and this is the script-level mirror of the executor's
    ///      freshness rule: `block.number` is the L1 clock.
    function _validateRange(uint64 startBlock, uint64 endBlock) private view {
        if (endBlock < startBlock) {
            revert InvalidTradeRange(startBlock, endBlock, block.number);
        }
        if (endBlock >= block.number) revert TradeBlockNotFinalized(endBlock, block.number);
    }

    /// @dev L2 can only be checked for well-formedness; no L2 head is observable
    ///      on-chain, so there is deliberately no finalisation bound here.
    function _validateL2Range(uint64 startBlockL2, uint64 endBlockL2) private pure {
        if (endBlockL2 < startBlockL2 || startBlockL2 == 0) revert InvalidL2TradeRange(startBlockL2, endBlockL2);
    }

    function _loadDeployment() private view returns (Deployment memory deployment) {
        string memory json = vm.readFile(_deploymentPath());
        deployment.runId = vm.parseJsonBytes32(json, ".runId");
        deployment.admin = vm.parseJsonAddress(json, ".admin");
        deployment.vaultAdmin = vm.parseJsonAddress(json, ".vaultAdmin");
        deployment.traderA = vm.parseJsonAddress(json, ".traderA");
        deployment.traderB = vm.parseJsonAddress(json, ".traderB");
        deployment.attester = vm.parseJsonAddress(json, ".attester");
        deployment.weth = vm.parseJsonAddress(json, ".weth");
        deployment.stock = DevnetSyntheticStock(vm.parseJsonAddress(json, ".stock"));
        deployment.pauseController = ProtocolPauseController(vm.parseJsonAddress(json, ".pauseController"));
        deployment.attesterRegistry = AttesterRegistry(vm.parseJsonAddress(json, ".attesterRegistry"));
        deployment.settlementExecutor = SettlementExecutor(vm.parseJsonAddress(json, ".settlementExecutor"));
        deployment.vault = PersonalVault(payable(vm.parseJsonAddress(json, ".vault")));
        deployment.treasuryWethBaseline = vm.parseJsonUint(json, ".treasuryWethBaseline");
        deployment.vaultAdminWethBaseline = vm.parseJsonUint(json, ".vaultAdminWethBaseline");
        deployment.traderAUpdatedSavingsBps =
            _asUint16("TRADER_A_UPDATED_BPS", vm.parseJsonUint(json, ".traderAUpdatedSavingsBps"));
        deployment.traderBSavingsBps = _asUint16("TRADER_B_BPS", vm.parseJsonUint(json, ".traderBSavingsBps"));
        deployment.minContributionWei = _asUint128("MIN_CONTRIBUTION", vm.parseJsonUint(json, ".minContributionWei"));
        deployment.transactionDeadlineSeconds =
            _asUint48("TX_DEADLINE", vm.parseJsonUint(json, ".transactionDeadlineSeconds"));
    }

    function _asUint64(uint256 value) private pure returns (uint64) {
        if (value > type(uint64).max) revert DrillInvariantFailed("UINT64_RANGE");
        return uint64(value);
    }

    function _requireAddress(address expected, address actual) private pure {
        if (expected != actual) revert AddressMismatch(expected, actual);
    }
}
