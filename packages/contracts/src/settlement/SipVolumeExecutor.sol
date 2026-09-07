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

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

/// @title SipVolumeExecutor
/// @notice Phase 1 of the volume skim. A trading wallet pays `bps × Σnotional`
///         — or whatever it can — into its own PersonalVault against a signed
///         volume attestation. The vault is not changed: it is re-pointed at this
///         contract with `setSettlementExecutor` and keeps enforcing its caps,
///         its nonce and its replay guard exactly as before.
/// @dev Immutable and ownerless. No withdrawal, no recipient other than the
///      account's registered vault, no arbitrary call. Where this differs from
///      `SettlementExecutor` is deliberate and is the whole point of Phase 1:
///
///      - THE CALLER DECIDES `msg.value`. There is no balance clamp and no
///        exact-maximum rule. A pull may be partial; what is not collected stays
///        as debt in this contract's storage and can be paid down later.
///      - REPLAY IS PER BATCH ROOT, in this contract's own storage, so an
///        attestation that was only partially collected can never be presented
///        twice while the vault's frontier stays a plain counter.
///      - THE VAULT'S L2 FRONTIER IS SYNTHETIC. `acceptSettlement` orders windows
///        on L2 heights; a late fill discovered after a window closed would be
///        unskimmable behind a real frontier. So the record the vault sees
///        carries a per-account counter (`c+1 .. c+2`) and the attested L2 range
///        lives only in the signature.
contract SipVolumeExecutor is EIP712, ReentrancyGuard {
    uint48 public constant MAX_ATTESTATION_VALIDITY = 15 minutes;

    /// @dev Field order is the struct's. Pinned by the test suite against both the
    ///      literal string and the constant value.
    bytes32 public constant VOLUME_ATTESTATION_TYPEHASH = keccak256(
        "VolumeAttestation(uint256 chainId,address vault,address account,address executor,uint64 bindingEpoch,uint64 policyNonce,uint64 settlementNonce,uint64 adminEpoch,uint64 localPauseEpoch,uint64 globalPauseEpoch,uint32 attesterEpoch,bytes32 policyHash,bytes32 batchRoot,uint64 startBlockL2,uint64 endBlockL2,uint256 sumNotionalWei,uint256 owedWei,uint48 validAfter,uint48 deadline)"
    );

    /// @param batchRoot     commits the sorted fill hashes of the closed window;
    ///                      anyone with a public RPC can recompute it.
    /// @param startBlockL2  the closed window `(cursor, closeAt]`, L2 heights.
    ///                      Committed by the signature, never handed to the vault.
    /// @param sumNotionalWei gross cash notional of every fill in the window.
    /// @param owedWei       `sumNotionalWei × savingsBps / 10_000`, recomputed here.
    struct VolumeAttestation {
        uint256 chainId;
        address vault;
        address account;
        address executor;
        uint64 bindingEpoch;
        uint64 policyNonce;
        uint64 settlementNonce;
        uint64 adminEpoch;
        uint64 localPauseEpoch;
        uint64 globalPauseEpoch;
        uint32 attesterEpoch;
        bytes32 policyHash;
        bytes32 batchRoot;
        uint64 startBlockL2;
        uint64 endBlockL2;
        uint256 sumNotionalWei;
        uint256 owedWei;
        uint48 validAfter;
        uint48 deadline;
    }

    IVaultFactory public immutable factory;
    IAttesterRegistry public immutable attesterRegistry;
    IProtocolPauseController public immutable pauseController;

    /// @notice Batch roots already collected against, in whole or in part.
    mapping(bytes32 batchRoot => bool used) public usedBatch;
    /// @notice Everything ever attested as owed by an account, in wei.
    mapping(address account => uint256 wei_) public owed;
    /// @notice Everything an account has actually paid into its vault through here.
    mapping(address account => uint256 wei_) public collected;
    /// @notice The synthetic L2 counter the vault's frontier is driven with.
    /// @dev Zero means "not seeded yet", not "starts at zero": an account that
    ///      settled through the legacy executor left a REAL L2 height in the
    ///      vault's frontier (millions), so a counter starting at 1 would make
    ///      its first pull here revert NonProgressiveBlockRange forever. The
    ///      first pull seeds it from the vault's own frontier instead.
    mapping(address account => uint64 counter) public syntheticFrontier;

    /// @dev PersonalVault's ERC-7201 base slot + 11 — `frontier[account][bindingEpoch]`,
    ///      whose two ends share one word. The same slot VaultLens.settlementFrontier
    ///      reads; pinned by test, because a layout change would silently reseed at zero.
    /// keccak256(abi.encode(uint256(keccak256("nuvem.storage.PersonalVault")) - 1)) & ~bytes32(uint256(0xff))
    uint256 private constant SLOT_FRONTIER =
        uint256(0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200) + 11;

    error ZeroAddress();
    error ProtocolPaused();
    error InvalidAccount(address expected, address actual);
    error InvalidVault(address expected, address actual);
    error InvalidExecutor(address expected, address actual);
    error InvalidChain(uint256 expected, uint256 actual);
    error InvalidValidityWindow(uint48 validAfter, uint48 deadline);
    error AttestationNotYetValid(uint48 validAfter, uint256 timestamp);
    error AttestationExpired(uint48 deadline, uint256 timestamp);
    error InvalidL2BlockRange(uint64 startBlockL2, uint64 endBlockL2);
    error InvalidAccountState();
    error InvalidEpoch();
    error InvalidPolicyHash(bytes32 expected, bytes32 actual);
    error InvalidSettlementNonce(uint64 expected, uint64 actual);
    error InvalidOwed(uint256 expected, uint256 actual);
    error InvalidAttester(address attester, uint32 epoch);
    error InvalidAttesterSignature();
    error BatchAlreadyUsed(bytes32 batchRoot);
    error ZeroContribution();
    error ContributionExceedsOutstanding(uint256 contribution, uint256 outstanding);
    error ContributionExceedsPerSettlementCap(uint256 contribution, uint256 cap);
    error ContributionExceedsAccountRollingCap(uint256 contribution, uint256 remaining);
    error ContributionExceedsAggregateRollingCap(uint256 contribution, uint256 remaining);
    error ContributionBelowMinimum(uint256 contribution, uint256 minimum);
    error ActivationTooRecent(uint64 activationBlock, uint256 settledBlock);
    error SyntheticFrontierExhausted(address account);

    event VolumePulled(
        address indexed account,
        address indexed vault,
        bytes32 indexed batchRoot,
        uint256 sumNotionalWei,
        uint256 owedWei,
        uint256 contribution,
        uint256 debtAfter
    );

    constructor(address factory_, address attesterRegistry_, address pauseController_)
        EIP712("SipVolumeExecutor", "1")
    {
        if (factory_ == address(0) || attesterRegistry_ == address(0) || pauseController_ == address(0)) {
            revert ZeroAddress();
        }
        factory = IVaultFactory(factory_);
        attesterRegistry = IAttesterRegistry(attesterRegistry_);
        pauseController = IProtocolPauseController(pauseController_);
    }

    /// @notice Pays `msg.value` of what the account owes into its registered vault.
    /// @dev `msg.value` is bounded by what is outstanding (carried debt plus this
    ///      window's owed), by the account policy's per-settlement cap, by both
    ///      rolling remainders and from below by `minContributionWei`. It is NOT
    ///      clamped to the wallet's balance, and there is no "exact maximum": the
    ///      caller reads those views itself and sends what it can.
    function pull(VolumeAttestation calldata a, bytes calldata attesterSignature)
        external
        payable
        nonReentrant
        returns (uint256 debtAfter)
    {
        if (pauseController.paused()) revert ProtocolPaused();

        address registeredVault = factory.activeVaultOf(msg.sender);
        _validateAttestationBinding(a, msg.sender, registeredVault);

        INuvemVault vault = INuvemVault(registeredVault);
        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(msg.sender);
        _validateCurrentVaultState(a, vault, account);

        // The bps rule is the user's, held by the vault, and this is where it is
        // enforced. Without it a signer could attest any `owedWei` against an
        // account that set `savingsBps` to zero. It is the volume analogue of the
        // old executor's `InvalidRealizedProfit`: recompute, then compare.
        uint256 expectedOwed = Math.mulDiv(a.sumNotionalWei, account.policy.savingsBps, NuvemTypes.BPS_DENOMINATOR);
        if (a.owedWei != expectedOwed) revert InvalidOwed(expectedOwed, a.owedWei);

        address currentAttester = attesterRegistry.attester();
        if (!attesterRegistry.isCurrentAttester(currentAttester, a.attesterEpoch)) {
            revert InvalidAttester(currentAttester, a.attesterEpoch);
        }
        if (!SignatureChecker.isValidSignatureNow(currentAttester, hashAttestation(a), attesterSignature)) {
            revert InvalidAttesterSignature();
        }

        if (usedBatch[a.batchRoot]) revert BatchAlreadyUsed(a.batchRoot);

        // Bounds, in the order the design lists them. `outstanding` is the carried
        // debt plus this window: the bound is what lets a later pull clear debt
        // an earlier, partial one left behind.
        uint256 outstanding = owed[msg.sender] + a.owedWei - collected[msg.sender];
        if (msg.value == 0) revert ZeroContribution();
        if (msg.value > outstanding) revert ContributionExceedsOutstanding(msg.value, outstanding);
        if (msg.value > account.policy.maxPerSettlementWei) {
            revert ContributionExceedsPerSettlementCap(msg.value, account.policy.maxPerSettlementWei);
        }
        uint256 accountRemaining = vault.accountRollingCapStatus(msg.sender).remaining;
        if (msg.value > accountRemaining) revert ContributionExceedsAccountRollingCap(msg.value, accountRemaining);
        uint256 aggregateRemaining = vault.aggregateRollingCapStatus().remaining;
        if (msg.value > aggregateRemaining) {
            revert ContributionExceedsAggregateRollingCap(msg.value, aggregateRemaining);
        }
        if (msg.value < account.policy.minContributionWei) {
            revert ContributionBelowMinimum(msg.value, account.policy.minContributionWei);
        }

        // `block.number` is the L1 height on this chain, and the vault demands
        // `endBlock < block.number` and `startBlock >= activationBlock`. Both
        // ends are the previous L1 block, so a pull cannot happen in the L1 block
        // the account was activated in. Named here rather than left to the
        // vault's generic `InvalidSettlement`, because a worker retries this one.
        if (block.number <= account.activationBlock) {
            revert ActivationTooRecent(account.activationBlock, block.number - 1);
        }
        uint64 settledBlock = uint64(block.number - 1);

        // Effects, all before the value leaves.
        usedBatch[a.batchRoot] = true;
        owed[msg.sender] += a.owedWei;
        collected[msg.sender] += msg.value;
        debtAfter = outstanding - msg.value;

        uint64 counter = syntheticFrontier[msg.sender];
        if (counter == 0) counter = _vaultFrontierEndL2(registeredVault, msg.sender, a.bindingEpoch);
        if (counter > type(uint64).max - 2) revert SyntheticFrontierExhausted(msg.sender);
        syntheticFrontier[msg.sender] = counter + 2;

        NuvemTypes.SettlementRecord memory record = NuvemTypes.SettlementRecord({
            account: msg.sender,
            bindingEpoch: a.bindingEpoch,
            policyNonce: a.policyNonce,
            settlementNonce: a.settlementNonce,
            policyHash: a.policyHash,
            sessionId: deriveSessionId(block.chainid, registeredVault, msg.sender, a.bindingEpoch, a.batchRoot),
            ledgerRoot: a.batchRoot,
            startBlock: settledBlock,
            endBlock: settledBlock,
            startBlockL2: counter + 1,
            endBlockL2: counter + 2,
            contribution: uint128(msg.value)
        });

        vault.acceptSettlement{value: msg.value}(record);

        emit VolumePulled(msg.sender, registeredVault, a.batchRoot, a.sumNotionalWei, a.owedWei, msg.value, debtAfter);
    }

    /// @notice Attested-but-uncollected wei for an account.
    /// @dev The vault's own settled L2 frontier for this account and binding epoch,
    ///      read straight from its storage. A legacy Phase 0 settlement left a real
    ///      L2 height there; seeding from it is what lets an account move to this
    ///      executor without being rebound. Zero (nothing ever settled) seeds zero,
    ///      and the first window is then 1..2 as it always was.
    function _vaultFrontierEndL2(address vaultAddress, address account, uint64 bindingEpoch) private view returns (uint64) {
        bytes32 outer = keccak256(abi.encode(account, bytes32(SLOT_FRONTIER)));
        uint256 packed = uint256(IExtsload(vaultAddress).extsload(keccak256(abi.encode(bindingEpoch, outer))));
        return uint64(packed >> 64);
    }

    function debtOf(address account) external view returns (uint256) {
        return owed[account] - collected[account];
    }

    /// @notice The replay key the vault records for a pull. The batch root is
    ///         what makes it unique; the rest binds it to one vault and binding.
    function deriveSessionId(uint256 chainId, address vault, address account, uint64 bindingEpoch, bytes32 batchRoot)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainId, vault, account, bindingEpoch, batchRoot));
    }

    function hashAttestation(VolumeAttestation calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VOLUME_ATTESTATION_TYPEHASH,
                    a.chainId,
                    a.vault,
                    a.account,
                    a.executor,
                    a.bindingEpoch,
                    a.policyNonce,
                    a.settlementNonce,
                    a.adminEpoch,
                    a.localPauseEpoch,
                    a.globalPauseEpoch,
                    a.attesterEpoch,
                    a.policyHash,
                    a.batchRoot,
                    a.startBlockL2,
                    a.endBlockL2,
                    a.sumNotionalWei,
                    a.owedWei,
                    a.validAfter,
                    a.deadline
                )
            )
        );
    }

    function _validateAttestationBinding(VolumeAttestation calldata a, address caller, address registeredVault)
        private
        view
    {
        if (a.account != caller) revert InvalidAccount(caller, a.account);
        if (registeredVault == address(0) || a.vault != registeredVault) {
            revert InvalidVault(registeredVault, a.vault);
        }
        if (a.executor != address(this)) revert InvalidExecutor(address(this), a.executor);
        if (a.chainId != block.chainid) revert InvalidChain(block.chainid, a.chainId);
        if (a.deadline < a.validAfter || a.deadline - a.validAfter > MAX_ATTESTATION_VALIDITY) {
            revert InvalidValidityWindow(a.validAfter, a.deadline);
        }
        if (block.timestamp < a.validAfter) revert AttestationNotYetValid(a.validAfter, block.timestamp);
        if (block.timestamp > a.deadline) revert AttestationExpired(a.deadline, block.timestamp);
        // The attested L2 window is informational here — the vault never sees it —
        // so it is only checked for shape. A single-block window is legitimate: the
        // worker closes `(cursor, closeAt]` and closeAt may be cursor + 1.
        if (a.startBlockL2 == 0 || a.endBlockL2 < a.startBlockL2) {
            revert InvalidL2BlockRange(a.startBlockL2, a.endBlockL2);
        }
    }

    function _validateCurrentVaultState(
        VolumeAttestation calldata a,
        INuvemVault vault,
        NuvemTypes.TradingAccount memory account
    ) private view {
        if (
            vault.settlementPaused() || account.status != NuvemTypes.AccountStatus.ACTIVE
                || vault.settlementExecutor() != address(this)
        ) revert InvalidAccountState();
        if (
            a.bindingEpoch != account.bindingEpoch || a.policyNonce != account.policyNonce
                || a.adminEpoch != vault.adminEpoch() || a.localPauseEpoch != vault.localPauseEpoch()
                || a.globalPauseEpoch != pauseController.pauseEpoch()
                || a.attesterEpoch != attesterRegistry.attesterEpoch()
        ) revert InvalidEpoch();

        bytes32 currentPolicyHash = vault.policyHash(a.account);
        if (a.policyHash != currentPolicyHash) revert InvalidPolicyHash(currentPolicyHash, a.policyHash);
        if (a.settlementNonce != account.settlementNonce) {
            revert InvalidSettlementNonce(account.settlementNonce, a.settlementNonce);
        }
    }
}
