// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {NuvemTypes} from "../types/NuvemTypes.sol";
import {IVaultFactory} from "../interfaces/IVaultFactory.sol";
import {INuvemVault} from "../interfaces/INuvemVault.sol";
import {IAttesterRegistry} from "../interfaces/IAttesterRegistry.sol";
import {IProtocolPauseController} from "../interfaces/IProtocolPauseController.sol";

/// @title SettlementExecutor
/// @notice The only target authorized for a trading account's restricted
///         session key. It can move ETH only into that account's registered
///         PersonalVault and only against a current signed attestation.
/// @dev This contract is intentionally immutable and has no administrative
///      withdrawal, arbitrary recipient, or arbitrary-call surface.
contract SettlementExecutor is EIP712, ReentrancyGuard {
    uint48 public constant MAX_ATTESTATION_VALIDITY = 15 minutes;

    bytes32 public constant SETTLEMENT_ATTESTATION_TYPEHASH = keccak256(
        "SettlementAttestation(address account,address vault,address executor,uint256 chainId,uint64 bindingEpoch,uint64 policyNonce,uint64 adminEpoch,uint64 localPauseEpoch,uint64 globalPauseEpoch,uint64 settlementNonce,bytes32 policyHash,bytes32 sessionId,bytes32 ledgerRoot,uint64 startBlock,uint64 endBlock,uint64 startBlockL2,uint64 endBlockL2,uint256 cashStart,uint256 cashEnd,uint256 externalDeposits,uint256 externalWithdrawals,int256 realizedProfit,uint256 contribution,uint32 attesterEpoch,uint48 validAfter,uint48 deadline)"
    );

    IVaultFactory public immutable factory;
    IAttesterRegistry public immutable attesterRegistry;
    IProtocolPauseController public immutable pauseController;

    error ZeroAddress();
    error ProtocolPaused();
    error InvalidAccount(address expected, address actual);
    error InvalidVault(address expected, address actual);
    error InvalidExecutor(address expected, address actual);
    error InvalidChain(uint256 expected, uint256 actual);
    error InvalidAccountState();
    error InvalidEpoch();
    error InvalidPolicyHash(bytes32 expected, bytes32 actual);
    error InvalidSettlementNonce(uint64 expected, uint64 actual);
    error AttestationNotYetValid(uint48 validAfter, uint256 timestamp);
    error AttestationExpired(uint48 deadline, uint256 timestamp);
    error InvalidValidityWindow(uint48 validAfter, uint48 deadline);
    error InvalidBlockRange(uint64 startBlock, uint64 endBlock);
    error InvalidL2BlockRange(uint64 startBlockL2, uint64 endBlockL2);
    error InvalidSessionId(bytes32 expected, bytes32 actual);
    error InvalidRealizedProfit(int256 expected, int256 actual);
    error InvalidContribution(uint256 expected, uint256 actual);
    error ContributionBelowMinimum(uint256 contribution, uint256 minimum);
    error InvalidAttester(address attester, uint32 epoch);
    error InvalidAttesterSignature();
    error ArithmeticOverflow();

    event SettlementExecuted(
        bytes32 indexed sessionId,
        address indexed account,
        address indexed vault,
        uint64 settlementNonce,
        int256 realizedProfit,
        uint256 contribution,
        bytes32 ledgerRoot
    );

    constructor(address factory_, address attesterRegistry_, address pauseController_)
        EIP712("Nuvem Settlement Executor", "1")
    {
        if (factory_ == address(0) || attesterRegistry_ == address(0) || pauseController_ == address(0)) {
            revert ZeroAddress();
        }
        factory = IVaultFactory(factory_);
        attesterRegistry = IAttesterRegistry(attesterRegistry_);
        pauseController = IProtocolPauseController(pauseController_);
    }

    /// @notice Executes the exact maximum contribution currently allowed by
    ///         profit, policy, rolling caps, and the trading reserve.
    function settle(NuvemTypes.SettlementAttestation calldata attestation, bytes calldata attesterSignature)
        external
        payable
        nonReentrant
        returns (uint256 savedAmount)
    {
        if (pauseController.paused()) revert ProtocolPaused();

        address registeredVault = factory.activeVaultOf(msg.sender);
        _validateAttestationBinding(attestation, msg.sender, registeredVault);

        INuvemVault vault = INuvemVault(registeredVault);
        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(msg.sender);
        _validateCurrentVaultState(attestation, vault, account);

        int256 realizedProfit = calculateRealizedProfit(
            attestation.cashStart, attestation.cashEnd, attestation.externalDeposits, attestation.externalWithdrawals
        );
        if (attestation.realizedProfit != realizedProfit) {
            revert InvalidRealizedProfit(realizedProfit, attestation.realizedProfit);
        }

        uint256 accountBalanceBefore = _checkedAdd(msg.sender.balance, msg.value);
        savedAmount = _calculateContribution(vault, msg.sender, account, realizedProfit, accountBalanceBefore);
        if (savedAmount == 0 || savedAmount < account.policy.minContributionWei) {
            revert ContributionBelowMinimum(savedAmount, account.policy.minContributionWei);
        }
        if (attestation.contribution != savedAmount || msg.value != savedAmount) {
            revert InvalidContribution(savedAmount, attestation.contribution);
        }

        address currentAttester = attesterRegistry.attester();
        if (!attesterRegistry.isCurrentAttester(currentAttester, attestation.attesterEpoch)) {
            revert InvalidAttester(currentAttester, attestation.attesterEpoch);
        }
        if (!SignatureChecker.isValidSignatureNow(currentAttester, hashAttestation(attestation), attesterSignature)) {
            revert InvalidAttesterSignature();
        }

        NuvemTypes.SettlementRecord memory record = NuvemTypes.SettlementRecord({
            account: msg.sender,
            bindingEpoch: attestation.bindingEpoch,
            policyNonce: attestation.policyNonce,
            settlementNonce: attestation.settlementNonce,
            policyHash: attestation.policyHash,
            sessionId: attestation.sessionId,
            ledgerRoot: attestation.ledgerRoot,
            startBlock: attestation.startBlock,
            endBlock: attestation.endBlock,
            startBlockL2: attestation.startBlockL2,
            endBlockL2: attestation.endBlockL2,
            contribution: uint128(savedAmount)
        });

        vault.acceptSettlement{value: savedAmount}(record);

        emit SettlementExecuted(
            attestation.sessionId,
            msg.sender,
            registeredVault,
            attestation.settlementNonce,
            realizedProfit,
            savedAmount,
            attestation.ledgerRoot
        );
    }

    /// @notice Returns the contribution for the account's current balance,
    ///         before the call value has been debited.
    function previewContribution(NuvemTypes.SettlementAttestation calldata attestation)
        external
        view
        returns (uint256 contribution)
    {
        address registeredVault = factory.activeVaultOf(attestation.account);
        if (registeredVault == address(0) || registeredVault != attestation.vault) {
            revert InvalidVault(registeredVault, attestation.vault);
        }
        INuvemVault vault = INuvemVault(registeredVault);
        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(attestation.account);
        int256 realizedProfit = calculateRealizedProfit(
            attestation.cashStart, attestation.cashEnd, attestation.externalDeposits, attestation.externalWithdrawals
        );
        return _calculateContribution(vault, attestation.account, account, realizedProfit, attestation.account.balance);
    }

    function calculateRealizedProfit(
        uint256 cashStart,
        uint256 cashEnd,
        uint256 externalDeposits,
        uint256 externalWithdrawals
    ) public pure returns (int256 realizedProfit) {
        uint256 positive = _checkedAdd(cashEnd, externalWithdrawals);
        uint256 negative = _checkedAdd(cashStart, externalDeposits);
        if (positive >= negative) {
            uint256 positiveDelta = positive - negative;
            if (positiveDelta > uint256(type(int256).max)) revert ArithmeticOverflow();
            return int256(positiveDelta);
        }

        uint256 negativeDelta = negative - positive;
        if (negativeDelta > uint256(type(int256).max)) revert ArithmeticOverflow();
        return -int256(negativeDelta);
    }

    /// @notice Derives the replay key for a trading session.
    /// @dev The L2 pair is part of the identity, not decoration. Two genuinely
    ///      distinct L2 sessions opened within one L1 block share `startBlock`
    ///      and `endBlock` exactly, so without the L2 heights their identities
    ///      would differ only through `ledgerRoot` — which this contract treats
    ///      as opaque bytes32 and cannot verify. Binding them here is what makes
    ///      the vault's `usedSessions` guard key on the window actually signed.
    function deriveSessionId(
        uint256 chainId,
        address vault,
        address account,
        uint64 bindingEpoch,
        uint64 startBlock,
        uint64 endBlock,
        uint64 startBlockL2,
        uint64 endBlockL2,
        bytes32 ledgerRoot
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                chainId, vault, account, bindingEpoch, startBlock, endBlock, startBlockL2, endBlockL2, ledgerRoot
            )
        );
    }

    function hashAttestation(NuvemTypes.SettlementAttestation calldata attestation) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SETTLEMENT_ATTESTATION_TYPEHASH,
                    attestation.account,
                    attestation.vault,
                    attestation.executor,
                    attestation.chainId,
                    attestation.bindingEpoch,
                    attestation.policyNonce,
                    attestation.adminEpoch,
                    attestation.localPauseEpoch,
                    attestation.globalPauseEpoch,
                    attestation.settlementNonce,
                    attestation.policyHash,
                    attestation.sessionId,
                    attestation.ledgerRoot,
                    attestation.startBlock,
                    attestation.endBlock,
                    attestation.startBlockL2,
                    attestation.endBlockL2,
                    attestation.cashStart,
                    attestation.cashEnd,
                    attestation.externalDeposits,
                    attestation.externalWithdrawals,
                    attestation.realizedProfit,
                    attestation.contribution,
                    attestation.attesterEpoch,
                    attestation.validAfter,
                    attestation.deadline
                )
            )
        );
    }

    function _validateAttestationBinding(
        NuvemTypes.SettlementAttestation calldata attestation,
        address caller,
        address registeredVault
    ) private view {
        if (attestation.account != caller) revert InvalidAccount(caller, attestation.account);
        if (registeredVault == address(0) || attestation.vault != registeredVault) {
            revert InvalidVault(registeredVault, attestation.vault);
        }
        if (attestation.executor != address(this)) {
            revert InvalidExecutor(address(this), attestation.executor);
        }
        if (attestation.chainId != block.chainid) {
            revert InvalidChain(block.chainid, attestation.chainId);
        }
        if (
            attestation.deadline < attestation.validAfter
                || attestation.deadline - attestation.validAfter > MAX_ATTESTATION_VALIDITY
        ) {
            revert InvalidValidityWindow(attestation.validAfter, attestation.deadline);
        }
        if (block.timestamp < attestation.validAfter) {
            revert AttestationNotYetValid(attestation.validAfter, block.timestamp);
        }
        if (block.timestamp > attestation.deadline) {
            revert AttestationExpired(attestation.deadline, block.timestamp);
        }
        // Freshness lives entirely in L1 and stays here. `block.number` is the L1
        // number on this chain, so it is the only clock an attested height can be
        // bounded against.
        if (attestation.endBlock < attestation.startBlock || attestation.endBlock >= block.number) {
            revert InvalidBlockRange(attestation.startBlock, attestation.endBlock);
        }
        // The L2 range can only be checked for well-formedness. There is no
        // observable L2 head on this chain, so `endBlockL2` is NOT bounded above
        // by anything here; it is only ordered, by the vault, against the
        // account's settlement frontier.
        //
        // BOTH BOUNDS ARE STRICT, AND THAT IS LOad-BEARING RATHER THAN TIDY.
        // The vault stores the frontier as a plain uint64 and reads zero as
        // "no settlement yet" (PersonalVault.sol:529). So an accepted window
        // ending at L2 block 0 would write that sentinel back as if it were a
        // real height, and every later window — overlapping or not — would then
        // pass the progression guard forever. One signature would permanently
        // disable replay protection for that account.
        //
        // Rejecting the degenerate window here is what keeps the sentinel safe.
        // `startBlockL2 == 0` is refused rather than merely `endBlockL2 == 0`
        // because a window is only well-formed if both ends are, and a real one
        // cannot start at genesis: the session engine sets startBlockL2 to the
        // block BEFORE the first buy, so it is a height this chain passed
        // millions of blocks ago. Equality is refused for the same reason — a
        // session spans at least the buy that opened it.
        if (attestation.startBlockL2 == 0 || attestation.endBlockL2 <= attestation.startBlockL2) {
            revert InvalidL2BlockRange(attestation.startBlockL2, attestation.endBlockL2);
        }

        bytes32 expectedSessionId = deriveSessionId(
            attestation.chainId,
            registeredVault,
            caller,
            attestation.bindingEpoch,
            attestation.startBlock,
            attestation.endBlock,
            attestation.startBlockL2,
            attestation.endBlockL2,
            attestation.ledgerRoot
        );
        if (attestation.sessionId != expectedSessionId) {
            revert InvalidSessionId(expectedSessionId, attestation.sessionId);
        }
    }

    function _validateCurrentVaultState(
        NuvemTypes.SettlementAttestation calldata attestation,
        INuvemVault vault,
        NuvemTypes.TradingAccount memory account
    ) private view {
        if (
            vault.settlementPaused() || account.status != NuvemTypes.AccountStatus.ACTIVE
                || vault.settlementExecutor() != address(this)
        ) revert InvalidAccountState();
        if (
            attestation.bindingEpoch != account.bindingEpoch || attestation.policyNonce != account.policyNonce
                || attestation.adminEpoch != vault.adminEpoch()
                || attestation.localPauseEpoch != vault.localPauseEpoch()
                || attestation.globalPauseEpoch != pauseController.pauseEpoch()
                || attestation.attesterEpoch != attesterRegistry.attesterEpoch()
        ) revert InvalidEpoch();

        bytes32 currentPolicyHash = vault.policyHash(attestation.account);
        if (attestation.policyHash != currentPolicyHash) {
            revert InvalidPolicyHash(currentPolicyHash, attestation.policyHash);
        }
        if (attestation.settlementNonce != account.settlementNonce) {
            revert InvalidSettlementNonce(account.settlementNonce, attestation.settlementNonce);
        }
        // The activation floor is and can only be an L1 floor: `activationBlock`
        // is written as `uint64(block.number)`, and no L2 activation height is
        // observable from inside a contract on this chain. Accepted consequence:
        // at ~120 L2 blocks per L1 block, a window whose L2 start predates
        // activation by up to ~120 L2 blocks still clears this check. An L2
        // activation floor is the attester's job, not the executor's.
        if (attestation.startBlock < account.activationBlock || attestation.endBlock < attestation.startBlock) {
            revert InvalidBlockRange(attestation.startBlock, attestation.endBlock);
        }
    }

    function _calculateContribution(
        INuvemVault vault,
        address accountAddress_,
        NuvemTypes.TradingAccount memory account,
        int256 realizedProfit,
        uint256 accountBalanceBefore
    ) private view returns (uint256 contribution) {
        if (realizedProfit <= 0 || account.policy.savingsBps == 0) return 0;

        contribution = Math.mulDiv(uint256(realizedProfit), account.policy.savingsBps, NuvemTypes.BPS_DENOMINATOR);
        contribution = Math.min(contribution, account.policy.maxPerSettlementWei);
        contribution = Math.min(contribution, vault.accountRollingCapStatus(accountAddress_).remaining);
        contribution = Math.min(contribution, vault.aggregateRollingCapStatus().remaining);

        uint256 reserved = _checkedAdd(account.policy.tradingFloorWei, account.policy.gasReserveWei);
        uint256 available = accountBalanceBefore > reserved ? accountBalanceBefore - reserved : 0;
        contribution = Math.min(contribution, available);
    }

    function _checkedAdd(uint256 a, uint256 b) private pure returns (uint256 result) {
        unchecked {
            result = a + b;
        }
        if (result < a) revert ArithmeticOverflow();
    }
}
