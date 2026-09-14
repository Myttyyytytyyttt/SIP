// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {NuvemTypes} from "../types/NuvemTypes.sol";
import {IVaultFactory} from "../interfaces/IVaultFactory.sol";
import {IProtocolPauseController} from "../interfaces/IProtocolPauseController.sol";
import {IWETH} from "../interfaces/IWETH.sol";
import {IAdapterRegistry} from "../interfaces/IAdapterRegistry.sol";
import {IInvestmentAdapter} from "../interfaces/IInvestmentAdapter.sol";
import {NuvemReentrancyGuardUpgradeable} from "../utils/NuvemReentrancyGuardUpgradeable.sol";

contract PersonalVault is Initializable, EIP712Upgradeable, NuvemReentrancyGuardUpgradeable {
    /// @notice The registry `invest()` resolves adapters through. See the
    ///         constructor for why this is an immutable and not a storage field.
    address public immutable ADAPTER_REGISTRY;

    using SafeERC20 for IERC20;

    bytes32 private constant ACCEPT_TRADING_ACCOUNT_TYPEHASH = keccak256(
        "AcceptTradingAccount(bytes32 vaultId,address vault,address tradingWallet,uint64 inviteNonce,uint64 adminEpoch,uint48 deadline)"
    );

    /// @dev Public so a sealed, non-upgradeable contract stays self-describing to
    ///      any wallet or indexer that has to rebuild these digests.
    bytes32 public constant TRADING_ACCOUNT_POLICY_TYPEHASH = keccak256(
        "TradingAccountPolicy(uint16 savingsBps,uint128 minContributionWei,uint128 maxPerSettlementWei,uint128 maxRolling30dWei,uint128 tradingFloorWei,uint128 gasReserveWei)"
    );

    bytes32 public constant INVITE_TRADING_ACCOUNT_TYPEHASH = keccak256(
        "InviteTradingAccount(bytes32 vaultId,address vault,address tradingWallet,bytes32 platformId,TradingAccountPolicy policy,uint64 inviteNonce,uint64 adminEpoch,uint48 inviteDeadline,uint48 sigDeadline)TradingAccountPolicy(uint16 savingsBps,uint128 minContributionWei,uint128 maxPerSettlementWei,uint128 maxRolling30dWei,uint128 tradingFloorWei,uint128 gasReserveWei)"
    );

    /// @dev Hard cap on how long a single invite signature stays usable.
    ///      Without it `sigDeadline` is a frontend-chosen uint48, and the claim
    ///      that a relayed invite is exposed only for minutes becomes circular:
    ///      the same malicious frontend that would substitute a policy would set
    ///      the deadline to its maximum. A raw unix timestamp is exactly the field
    ///      a human cannot sanity-check in a wallet prompt.
    uint48 public constant MAX_SIGNATURE_WINDOW = 1 hours;

    // keccak256(abi.encode(uint256(keccak256("nuvem.storage.PersonalVault")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_STORAGE_LOCATION =
        0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200;

    /// @custom:storage-location erc7201:nuvem.storage.PersonalVault
    struct VaultStorage {
        bytes32 vaultId;
        address vaultAdmin;
        address pendingVaultAdmin;
        address factory;
        address weth;
        address pauseController;
        address attesterRegistry;
        address settlementExecutor;
        uint32 cohortId;
        uint64 adminEpoch;
        uint64 localPauseEpoch;
        uint64 vaultPolicyNonce;
        uint64 activeTradingAccountCount;
        bool settlementPaused;
        NuvemTypes.VaultPolicy vaultPolicy;
        mapping(address account => NuvemTypes.TradingAccount) tradingAccounts;
        mapping(address account => mapping(uint64 bindingEpoch => NuvemTypes.SettlementFrontier)) frontier;
        mapping(bytes32 sessionKey => bool used) usedSessions;
        mapping(address account => NuvemTypes.DailySpendBucket[31]) accountBuckets;
        NuvemTypes.DailySpendBucket[31] aggregateBuckets;
        mapping(address account => uint128 amount) lifetimeContributions;
        uint128 aggregateLifetimeContributions;
        // ─────────────────────────────────────────────────────────────────────
        // v2: the investment path. APPEND ONLY. NOTHING ABOVE THIS LINE MOVES.
        //
        // WHY THE RULE IS ABSOLUTE, worked through on the field directly above:
        // `NuvemTypes.VaultPolicy` at `vaultPolicy` occupies exactly one slot
        // today. Give it a second field and `tradingAccounts` slides from S+11 to
        // S+12 — and a mapping's slot IS its hash preimage. Every account, every
        // frontier, every used session and all 31 aggregate buckets become
        // unreachable at once, and `aggregateBuckets` starts reading 31 slots
        // that belong to something else. That is a live vault destroyed by a
        // one-line struct change that compiles and passes every test.
        //
        // So: `VaultPolicy` is frozen, and everything new arrives here, after the
        // last existing member. The last member of this struct must stay a
        // fixed-size array, a mapping, or a scalar nobody will grow —
        // `investmentBuckets` is [31] forever.
        //
        // Verify with `forge inspect PersonalVault storage-layout` before and
        // after, and diff. No script in this repo checks it, and
        // PrepareCohortUpgrade cannot: it validates ownership and addresses and
        // never layout.
        // ─────────────────────────────────────────────────────────────────────

        /// @dev Packs into the free upper 16 bytes of the slot holding
        ///      `aggregateLifetimeContributions`. Provably zero in every vault
        ///      that exists, because nothing has ever written there.
        uint128 aggregateLifetimeInvested;
        /// @dev NOTE ON THIS SLOT. It used to open with `address adapterRegistry`,
        ///      which now lives in the implementation's bytecode as
        ///      ADAPTER_REGISTRY. Removing it repacks THIS slot — the nonce and
        ///      both flags shift down by 160 bits — and moves NOTHING below it,
        ///      because 8 + 1 + 1 bytes still fit in one word and `adapterId`
        ///      stays at S+48.
        ///
        ///      Safe because the slot is provably virgin: these fields have never
        ///      existed in a deployed implementation, and the ONE vault on mainnet
        ///      (0x0b5036…6BBD, the only VaultDeployed event the factory has ever
        ///      emitted) reads zero here. Repacking a slot that has only ever held
        ///      zero cannot misread anything.
        /// @dev Bumped by every investment setter. Deliberately NOT the same
        ///      counter as `vaultPolicyNonce`, which lives inside `policyHash`:
        ///      changing a basket must not invalidate a settlement in flight.
        uint64 investmentPolicyNonce;
        bool investmentEnabled;
        bool investmentPaused;
        /// @dev Which registered adapter this vault buys through.
        bytes32 adapterId;
        /// @dev keccak256(abi.encode(BasketLeg[])). See NuvemTypes.BasketLeg for
        ///      why the legs themselves are never stored.
        bytes32 investmentBasketHash;
        /// @dev The threshold. NO FLOOR CONSTANT EXISTS ANYWHERE — a hard minimum
        ///      here is what would make the system untestable at the sizes it
        ///      actually settles (~3.9e14 wei). Only the relative ladder in
        ///      `_validateInvestmentLimits` applies.
        uint128 minInvestmentWei;
        uint128 maxInvestmentPerCallWei;
        uint128 maxInvestmentRolling30dWei;
        /// @dev The outflow cap the earlier removal lost. Reuses `_rollingStatus`
        ///      and `_consumeBucket` verbatim, so it is built on code that two
        ///      invariants already exercise.
        NuvemTypes.DailySpendBucket[31] investmentBuckets;
    }

    error Unauthorized();
    error ZeroAddress();
    error InvalidState();
    error InvalidPolicy();
    error InvalidPercentage(uint16 savingsBps);
    error DeadlineExpired();
    error InvalidSignature();
    error AccountNotActive(address account);
    error AccountAlreadyLinked(address account);
    error InvalidSettlement();
    error SessionAlreadyUsed(bytes32 sessionId);
    /// @dev Raised on the L2 range, which is where session progression is
    ///      enforced. Name and shape are unchanged from when it guarded the L1
    ///      range so existing off-chain error handling keeps its meaning; only
    ///      the numbers fed to it moved clocks.
    error NonProgressiveBlockRange(uint64 previousEndBlock, uint64 startBlock, uint64 endBlock);
    /// @dev Raised on the L1 range, which is only required to be non-decreasing.
    ///      Distinct from `NonProgressiveBlockRange` on purpose: an L2 collision
    ///      is a genuine replay, an L1 rewind is an incoherent attestation, and
    ///      an operator must be able to tell them apart.
    error NonProgressiveL1BlockRange(uint64 previousEndBlock, uint64 startBlock, uint64 endBlock);
    error RollingCapExceeded(uint128 cap, uint128 spent, uint128 requested);
    error ProtocolPaused();
    error NotAContract(address account);
    error InvestmentDisabled();
    error InvestmentIsPaused();
    error InvestmentBasketMismatch();
    error InvalidInvestmentPolicyNonce(uint64 expected, uint64 actual);
    error InvestmentBelowThreshold(uint256 amountIn, uint128 minInvestmentWei);
    error InvestmentAboveCeiling(uint256 amountIn, uint128 maxPerCallWei);
    error InsufficientInvestmentOutput(address targetAsset, uint256 required, uint256 received);

    event TradingAccountInvited(
        address indexed account, bytes32 indexed platformId, uint16 savingsBps, uint64 inviteNonce, uint48 deadline
    );
    event TradingAccountInvitationCancelled(address indexed account, uint64 inviteNonce);
    /// @dev Additive to TradingAccountInvited, which both paths emit. This one
    ///      only records WHO relayed, which the shared event cannot carry.
    event TradingAccountInvitedBySig(
        address indexed account, address indexed relayer, uint64 inviteNonce, uint48 sigDeadline
    );
    event TradingAccountInvitesInvalidated(address indexed account, uint64 inviteNonce);
    event TradingAccountActivated(
        address indexed account, bytes32 indexed platformId, uint64 bindingEpoch, uint64 activationBlock
    );
    event TradingAccountPaused(address indexed account, uint64 bindingEpoch);
    event TradingAccountRevoked(address indexed account, uint64 bindingEpoch, uint64 revocationBlock);
    event TradingAccountPolicyUpdated(
        address indexed account, uint64 policyNonce, uint16 savingsBps, address indexed actor
    );
    event VaultPolicyUpdated(uint64 indexed policyNonce, bytes32 indexed policyHash);
    event VaultPauseUpdated(bool settlementPaused, uint64 pauseEpoch);
    event SettlementExecutorUpdated(address indexed previousExecutor, address indexed nextExecutor);
    event ContributionReceived(
        bytes32 indexed vaultId,
        address indexed tradingWallet,
        bytes32 indexed sessionId,
        uint64 bindingEpoch,
        uint64 settlementNonce,
        uint256 amount
    );
    event RollingCapConsumed(
        address indexed tradingWallet,
        uint32 indexed dayIndex,
        uint128 amount,
        uint128 accountSpentAfter,
        uint128 aggregateSpentAfter
    );
    event Withdrawal(address indexed token, address indexed recipient, uint256 amount);
    event VaultAdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event VaultAdminTransferred(address indexed previousAdmin, address indexed newAdmin, uint64 adminEpoch);
    /// @dev `legs` is the canonical copy of the basket — storage keeps only the hash.
    /// @dev `encodedLegs` is abi.encode(BasketLeg[]) — the same bytes the hash is
    ///      taken over, and the canonical copy, since storage keeps only the hash.
    event InvestmentPolicyUpdated(
        uint64 indexed policyNonce,
        bytes32 indexed basketHash,
        bytes32 indexed adapterId,
        bool enabled,
        uint128 minInvestmentWei,
        uint128 maxPerCallWei,
        uint128 maxRolling30dWei,
        bytes encodedLegs
    );
    event InvestmentPauseUpdated(bool paused);
    event InvestmentExecuted(uint64 indexed policyNonce, address indexed adapter, uint256 amountIn, uint256 totalOut);

    /**
     * @dev The adapter registry is an IMMUTABLE OF THE IMPLEMENTATION, not a
     *      field of each vault's storage. That is the whole design of the
     *      investment path's reachability, and it is worth stating plainly.
     *
     *      IT WAS STORAGE, AND STORAGE COULD NEVER REACH AN EXISTING VAULT.
     *      `initialize` is `initializer`, so it runs exactly once per proxy and
     *      has already run for every vault that exists. A registry written there
     *      is therefore unreachable forever for any vault created before the
     *      field existed: measured on mainnet, the one live vault reads
     *      address(0) at that slot before AND after a beacon upgrade, and no
     *      function in the contract can change it. `setInvestmentPolicy` would
     *      still succeed, the admin would see `enabled` and an emitted event, and
     *      every `invest()` would revert with empty returndata against address
     *      zero. That is the silent-failure shape this codebase exists to refuse.
     *
     *      An immutable lives in the implementation's BYTECODE, so every proxy on
     *      the beacon picks it up in the same block the upgrade lands, with no
     *      per-vault migration and no transaction from anybody.
     *
     *      IT IS ALSO A STRICTER AUTHORITY. The storage version was supplied by
     *      whoever created the vault and merely checked against the factory. This
     *      one is chosen by whoever deploys the implementation — which, on a
     *      cohort beacon, is governance behind a seven-day delay.
     *
     *      Zero is REFUSED rather than treated as "investing disabled". An
     *      implementation that cannot invest is a coherent thing to want, but it
     *      is not this contract, and allowing zero here would recreate exactly the
     *      configuration that produced the silent failure above.
     */
    constructor(address adapterRegistry_) {
        if (adapterRegistry_ == address(0)) revert ZeroAddress();
        if (adapterRegistry_.code.length == 0) revert NotAContract(adapterRegistry_);
        ADAPTER_REGISTRY = adapterRegistry_;
        _disableInitializers();
    }

    modifier onlyVaultAdmin() {
        _requireVaultAdmin();
        _;
    }

    function _requireVaultAdmin() private view {
        if (msg.sender != _getVaultStorage().vaultAdmin) revert Unauthorized();
    }

    function initialize(
        bytes32 vaultId_,
        address vaultAdmin_,
        address factory_,
        uint32 cohortId_,
        bytes calldata initData
    ) external initializer {
        if (msg.sender != factory_) revert Unauthorized();
        if (vaultId_ == bytes32(0) || vaultAdmin_ == address(0) || factory_ == address(0)) {
            revert ZeroAddress();
        }

        NuvemTypes.VaultInitialization memory config = abi.decode(initData, (NuvemTypes.VaultInitialization));
        _validateInitialization(config, factory_);

        __EIP712_init("Nuvem Personal Vault", "1");
        _nuvemReentrancyGuardInit();

        VaultStorage storage $ = _getVaultStorage();
        $.vaultId = vaultId_;
        $.vaultAdmin = vaultAdmin_;
        $.factory = factory_;
        $.cohortId = cohortId_;
        $.weth = config.weth;
        $.pauseController = config.pauseController;
        $.attesterRegistry = config.attesterRegistry;
        $.settlementExecutor = config.settlementExecutor;
        $.vaultPolicy = config.policy;
        $.adminEpoch = 1;
        $.localPauseEpoch = 1;
        $.vaultPolicyNonce = 1;
    }









    function settlementExecutor() external view returns (address) {
        return _getVaultStorage().settlementExecutor;
    }

    /// @notice The furthest point `account` has settled to within `bindingEpoch`.
    /// @dev Exists so off-chain recovery can read the progression watermark
    ///      directly instead of treating a local journal as authoritative or
    ///      rebuilding it by decoding settle calldata.

    /// @notice Whether `sessionId` has already been consumed by `account` within
    ///         `bindingEpoch`.

    function adminEpoch() external view returns (uint64) {
        return _getVaultStorage().adminEpoch;
    }

    function localPauseEpoch() external view returns (uint64) {
        return _getVaultStorage().localPauseEpoch;
    }


    function settlementPaused() public view returns (bool) {
        return _getVaultStorage().settlementPaused;
    }



    function getTradingAccount(address account) external view returns (NuvemTypes.TradingAccount memory) {
        return _getVaultStorage().tradingAccounts[account];
    }

    function inviteTradingAccount(
        address account,
        bytes32 platformId,
        NuvemTypes.TradingAccountPolicy calldata policy,
        uint48 deadline
    ) external onlyVaultAdmin {
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.TradingAccount storage tradingAccount = _requireInvitable($, account, policy, deadline);
        _writeInvite($, tradingAccount, account, platformId, policy, deadline);
    }

    /// @notice Invite a trading wallet with an offline vault-admin signature.
    /// @dev Same invite, authorised by a signature instead of by being the sender,
    ///      so a relayer pays the gas and the admin only signs. The two paths run
    ///      the SAME `_requireInvitable` and `_writeInvite`, which is why no check
    ///      can exist on one and not the other.
    ///
    ///      `msg.sender` is deliberately unbound: any relayer must be able to pay.
    ///      Every material parameter is committed to by the digest, so a relayer
    ///      that front-runs another produces a byte-identical outcome and only
    ///      changes who paid.
    /// @param inviteDeadline How long the INVITE stays acceptable. Shared with the
    ///        direct path and therefore deliberately uncapped.
    /// @param sigDeadline How long THIS SIGNATURE may be used. Bounded by
    ///        MAX_SIGNATURE_WINDOW; see the constant.
    function inviteTradingAccountBySig(
        address account,
        bytes32 platformId,
        NuvemTypes.TradingAccountPolicy calldata policy,
        uint48 inviteDeadline,
        uint48 sigDeadline,
        bytes calldata signature
    ) external nonReentrant {
        VaultStorage storage $ = _getVaultStorage();
        if (sigDeadline <= block.timestamp) revert DeadlineExpired();
        if (sigDeadline > block.timestamp + MAX_SIGNATURE_WINDOW) revert DeadlineExpired();

        NuvemTypes.TradingAccount storage tradingAccount = _requireInvitable($, account, policy, inviteDeadline);

        // The nonce and the epoch are read LIVE from storage and hashed in, never
        // taken from calldata. A stale signature therefore fails to hash-match,
        // and there is no separate equality check for a later edit to drop.
        bytes32 digest = _inviteTradingAccountDigest(
            $, account, platformId, policy, tradingAccount.inviteNonce, inviteDeadline, sigDeadline
        );
        // Authorisation LAST: every check above is read-only and signature
        // independent, so a malformed request never pays for an ecrecover or an
        // ERC-1271 staticcall, and nothing is written before the signature holds.
        if (!SignatureChecker.isValidSignatureNow($.vaultAdmin, digest, signature)) revert InvalidSignature();

        _writeInvite($, tradingAccount, account, platformId, policy, inviteDeadline);
        emit TradingAccountInvitedBySig(account, msg.sender, tradingAccount.inviteNonce, sigDeadline);
    }

    /// @notice The digest a client signs to authorise an invite.
    /// @dev Status-gated on purpose. An ungated view is a first-class product
    ///      surface for minting a digest against a PENDING or ACTIVE account —
    ///      a signature that lands only later, once the account has been revoked.
    function inviteTradingAccountDigest(
        address account,
        bytes32 platformId,
        NuvemTypes.TradingAccountPolicy calldata policy,
        uint48 inviteDeadline,
        uint48 sigDeadline
    ) external view returns (bytes32) {
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.AccountStatus status = $.tradingAccounts[account].status;
        if (status != NuvemTypes.AccountStatus.NONE && status != NuvemTypes.AccountStatus.REVOKED) {
            revert InvalidState();
        }
        return _inviteTradingAccountDigest(
            $, account, platformId, policy, $.tradingAccounts[account].inviteNonce, inviteDeadline, sigDeadline
        );
    }

    /// @notice Burn every outstanding invite signature for `account` in one call.
    /// @dev Callable in any state EXCEPT PENDING, and being callable while ACTIVE
    ///      is the point: it is the only way to disarm a signature BEFORE the
    ///      revoke that would otherwise arm it, with no two-transaction race for
    ///      an attacker to win. PENDING is excluded because bumping the nonce
    ///      there would kill the outstanding ACCEPT signature while leaving the
    ///      status PENDING and `acceptTradingAccount()` still callable — a
    ///      half-cancelled state. `cancelTradingAccountInvitation` covers PENDING;
    ///      it already sets REVOKED and bumps the nonce.
    function invalidateTradingAccountInvites(address account) external onlyVaultAdmin {
        NuvemTypes.TradingAccount storage tradingAccount = _getVaultStorage().tradingAccounts[account];
        if (tradingAccount.status == NuvemTypes.AccountStatus.PENDING) revert InvalidState();
        tradingAccount.inviteNonce += 1;
        emit TradingAccountInvitesInvalidated(account, tradingAccount.inviteNonce);
    }

    function cancelTradingAccountInvitation(address account) external onlyVaultAdmin {
        NuvemTypes.TradingAccount storage tradingAccount = _getVaultStorage().tradingAccounts[account];
        if (tradingAccount.status != NuvemTypes.AccountStatus.PENDING) revert InvalidState();
        tradingAccount.status = NuvemTypes.AccountStatus.REVOKED;
        tradingAccount.inviteDeadline = 0;
        tradingAccount.inviteNonce += 1;
        emit TradingAccountInvitationCancelled(account, tradingAccount.inviteNonce);
    }

    function acceptTradingAccount() external nonReentrant {
        _activateTradingAccount(msg.sender);
    }

    function acceptTradingAccountBySig(address account, uint48 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[account];
        if (deadline != tradingAccount.inviteDeadline || deadline <= block.timestamp) {
            revert DeadlineExpired();
        }
        if (!SignatureChecker.isValidSignatureNow(
                account, _acceptTradingAccountDigest($, account, deadline), signature
            )) {
            revert InvalidSignature();
        }
        _activateTradingAccount(account);
    }

    function acceptTradingAccountDigest(address account) external view returns (bytes32) {
        VaultStorage storage $ = _getVaultStorage();
        return _acceptTradingAccountDigest($, account, $.tradingAccounts[account].inviteDeadline);
    }

    function setMySavingsBps(uint16 nextSavingsBps) external {
        _setSavingsBps(msg.sender, nextSavingsBps, msg.sender);
    }

    function setTradingAccountSavingsBps(address account, uint16 nextSavingsBps) external onlyVaultAdmin {
        _setSavingsBps(account, nextSavingsBps, msg.sender);
    }

    function setTradingAccountPolicy(address account, NuvemTypes.TradingAccountPolicy calldata policy)
        external
        onlyVaultAdmin
    {
        _validateTradingPolicy(policy);
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[account];
        if (
            tradingAccount.status != NuvemTypes.AccountStatus.ACTIVE
                && tradingAccount.status != NuvemTypes.AccountStatus.PAUSED
        ) revert AccountNotActive(account);
        tradingAccount.policy = policy;
        tradingAccount.policyNonce += 1;
        emit TradingAccountPolicyUpdated(account, tradingAccount.policyNonce, policy.savingsBps, msg.sender);
    }

    function pauseTradingAccount(address account) external onlyVaultAdmin nonReentrant {
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[account];
        if (tradingAccount.status != NuvemTypes.AccountStatus.ACTIVE) revert AccountNotActive(account);
        tradingAccount.status = NuvemTypes.AccountStatus.PAUSED;
        tradingAccount.bindingEpoch += 1;
        tradingAccount.policyNonce += 1;
        $.activeTradingAccountCount -= 1;
        emit TradingAccountPaused(account, tradingAccount.bindingEpoch);
    }

    function unpauseTradingAccount(address account) external onlyVaultAdmin nonReentrant {
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[account];
        if (tradingAccount.status != NuvemTypes.AccountStatus.PAUSED) revert InvalidState();
        if (IVaultFactory($.factory).activeVaultOf(account) != address(this)) {
            revert InvalidState();
        }
        tradingAccount.status = NuvemTypes.AccountStatus.ACTIVE;
        tradingAccount.bindingEpoch += 1;
        tradingAccount.policyNonce += 1;
        tradingAccount.activationBlock = uint64(block.number);
        $.activeTradingAccountCount += 1;
        emit TradingAccountActivated(
            account, tradingAccount.platformId, tradingAccount.bindingEpoch, tradingAccount.activationBlock
        );
    }

    function revokeTradingAccount(address account) external onlyVaultAdmin nonReentrant {
        _revokeTradingAccount(account);
    }

    function revokeMyTradingAccount() external nonReentrant {
        _revokeTradingAccount(msg.sender);
    }

    function setVaultPolicy(NuvemTypes.VaultPolicy calldata nextPolicy) external onlyVaultAdmin {
        _validateVaultPolicy(nextPolicy);
        VaultStorage storage $ = _getVaultStorage();
        $.vaultPolicy = nextPolicy;
        $.vaultPolicyNonce += 1;
        emit VaultPolicyUpdated($.vaultPolicyNonce, _vaultPolicyHash($));
    }

    function setLocalPause(bool pauseSettlements) external onlyVaultAdmin {
        VaultStorage storage $ = _getVaultStorage();
        if ($.settlementPaused == pauseSettlements) return;
        $.settlementPaused = pauseSettlements;
        $.localPauseEpoch += 1;
        emit VaultPauseUpdated(pauseSettlements, $.localPauseEpoch);
    }

    // ─────────────────────────── the investment path ───────────────────────────
    //
    // WHAT THE VAULT GUARANTEES, and it is the whole design in one sentence: the
    // caller of `invest` chooses WHEN and, within the admin's bounds, HOW MUCH —
    // and nothing else. Which assets, in what proportion, at what floor, and where
    // the output lands all come from state the vault admin signed for. So a
    // compromised keeper can, at worst, buy the user's own basket into the user's
    // own vault at a price the user bounded.
    //
    // `IInvestmentAdapter` has no recipient parameter and takes no arbitrary
    // calldata, which is what makes "the output lands in the vault" structural
    // rather than a check that could be forgotten.

    /**
     * @notice Sets the whole investment policy in one transaction.
     *
     * @dev ONE setter, not five. Basket, limits, adapter and the switch are a
     *      coherent whole, and splitting them created a state the vault had to
     *      defend against explicitly — "enabled with no basket", which reads to an
     *      operator as working and to the user as savings that quietly stopped
     *      moving. Setting them together makes that state unrepresentable rather
     *      than merely rejected, and costs ~900 fewer bytes of runtime in a
     *      contract that has none to spare.
     *
     *      THERE IS NO ABSOLUTE FLOOR ON `minInvestment`, and adding one would be
     *      a bug: this protocol settles ~3.9e14 wei at a time, so any hard minimum
     *      large enough to look sensible makes the investment path untestable at
     *      the sizes it actually runs at. Only the relative ladder is enforced.
     */
    function setInvestmentPolicy(
        NuvemTypes.BasketLeg[] calldata legs,
        uint128 minInvestment,
        uint128 maxPerCall,
        uint128 maxRolling30d,
        bytes32 nextAdapterId,
        bool enabled
    ) external onlyVaultAdmin {
        if (minInvestment == 0 || minInvestment > maxPerCall || maxPerCall > maxRolling30d) revert InvalidPolicy();
        if (enabled && nextAdapterId == bytes32(0)) revert InvalidPolicy();
        // NO RUNTIME CHECK ON ADAPTER_REGISTRY HERE, and its absence is measured
        // rather than assumed. The constructor refuses a zero registry outright,
        // so an implementation that could reach this branch cannot be deployed —
        // `test_5_an_implementation_without_a_registry_cannot_exist` asserts both
        // refusals. A belt-and-braces check here cost bytes this contract does not
        // have: it is a beacon implementation sealed into a cohort, and the
        // headroom it would spend is the headroom a future bug fix needs.
        _validateBasket(legs);

        VaultStorage storage $ = _getVaultStorage();
        bytes memory encoded = abi.encode(legs);
        $.investmentBasketHash = keccak256(encoded);
        $.minInvestmentWei = minInvestment;
        $.maxInvestmentPerCallWei = maxPerCall;
        $.maxInvestmentRolling30dWei = maxRolling30d;
        $.adapterId = nextAdapterId;
        $.investmentEnabled = enabled;
        $.investmentPolicyNonce += 1;
        // `encoded` is the canonical copy of the basket — storage keeps only the
        // hash, and these are the same bytes it is taken over, so emitting them
        // costs nothing extra to produce.
        emit InvestmentPolicyUpdated(
            $.investmentPolicyNonce, $.investmentBasketHash, nextAdapterId, enabled, minInvestment, maxPerCall, maxRolling30d, encoded
        );
    }

    /// @notice Stops investing without disturbing the configuration.
    /// @dev Separate from `setLocalPause`, which stops SETTLEMENT. Conflating them
    ///      would mean halting purchases also halts savings arriving, and halting
    ///      savings also halts purchases; they fail for unrelated reasons and an
    ///      operator needs to stop one without the other.
    function setInvestmentPause(bool paused) external onlyVaultAdmin {
        VaultStorage storage $ = _getVaultStorage();
        $.investmentPaused = paused;
        emit InvestmentPauseUpdated(paused);
    }

    /**
     * @notice Buys the configured basket with `amountIn` of the vault's WETH.
     *
     * @param legs        the basket, checked against the stored hash
     * @param amountIn    gross WETH to spend, inside the admin's threshold and ceiling
     * @param minAmountsOut per-leg lower bounds; may only TIGHTEN the admin's floors
     * @param deadline    wall-clock bound on the whole call
     * @param expectedAdapterStatusEpoch  the registry epoch the caller believes current
     * @param expectedInvestmentPolicyNonce the config the caller believes current
     *
     * @dev NO DEFERRAL. An earlier version of this path caught adapter failures and
     *      emitted an event so the caller could carry on. That exists for a caller
     *      that cannot handle a revert; this one is a keeper with a revert
     *      classification table, backoff and a circuit breaker, and swallowing the
     *      revert would cost it the reason. Everything here either completes or
     *      undoes itself.
     */
    function invest(
        NuvemTypes.BasketLeg[] calldata legs,
        uint256 amountIn,
        uint256[] calldata minAmountsOut,
        uint48 deadline,
        uint64 expectedAdapterStatusEpoch,
        uint64 expectedInvestmentPolicyNonce
    ) external nonReentrant {
        VaultStorage storage $ = _getVaultStorage();
        _requireInvestmentAuthority($);

        if (block.timestamp > deadline) revert DeadlineExpired();
        if (!$.investmentEnabled) revert InvestmentDisabled();
        if ($.investmentPaused) revert InvestmentIsPaused();
        if (IProtocolPauseController($.pauseController).paused()) revert ProtocolPaused();
        if (expectedInvestmentPolicyNonce != $.investmentPolicyNonce) {
            revert InvalidInvestmentPolicyNonce(expectedInvestmentPolicyNonce, $.investmentPolicyNonce);
        }
        // The hash IS the compare-and-swap on the basket: a caller holding legs
        // the admin has replaced cannot present them, whatever it believes.
        if (keccak256(abi.encode(legs)) != $.investmentBasketHash) revert InvestmentBasketMismatch();
        if (minAmountsOut.length != legs.length) revert InvalidPolicy();

        address weth_ = $.weth;
        if (amountIn < $.minInvestmentWei) revert InvestmentBelowThreshold(amountIn, $.minInvestmentWei);
        if (amountIn > $.maxInvestmentPerCallWei) {
            revert InvestmentAboveCeiling(amountIn, $.maxInvestmentPerCallWei);
        }
        if (amountIn > IERC20(weth_).balanceOf(address(this))) revert InvalidState();

        // Checked before the adapter runs, consumed after it succeeds. The
        // reentrancy guard is held for this whole frame and nothing else writes
        // `investmentBuckets`, so there is no window between the two; consuming
        // first would mean unwinding the bucket on every revert path instead.
        NuvemTypes.RollingCapStatus memory cap = _rollingStatus($.investmentBuckets, $.maxInvestmentRolling30dWei);
        if (uint256(cap.spent) + amountIn > cap.cap) {
            revert RollingCapExceeded(cap.cap, cap.spent, uint128(amountIn));
        }

        address adapter = IAdapterRegistry(ADAPTER_REGISTRY).resolveActiveAdapter($.adapterId, expectedAdapterStatusEpoch);

        uint256 assigned;
        uint256 totalOut;
        for (uint256 i = 0; i < legs.length; ++i) {
            // THE LAST LEG ABSORBS THE ROUNDING DUST. Without it the per-leg
            // amounts sum to less than `amountIn` for almost every input, the
            // exact-debit assertion fails, and `invest` reverts forever rather
            // than visibly.
            uint256 legAmount = i + 1 == legs.length
                ? amountIn - assigned
                : (amountIn * legs[i].weightBps) / NuvemTypes.BPS_DENOMINATOR;
            if (legAmount == 0) revert InvestmentBelowThreshold(0, 1);
            assigned += legAmount;

            // Both factors are bounded — `legAmount <= maxInvestmentPerCallWei`
            // which is a uint128, and `minOutRateWad` is capped at uint96 in
            // _validateBasket — so this cannot reach 2^256 and does not need
            // 512-bit math. Measured: Math.mulDiv costs 91 bytes here.
            uint256 floor = (legAmount * legs[i].minOutRateWad) / NuvemTypes.OUTPUT_RATE_SCALE;
            if (minAmountsOut[i] > floor) floor = minAmountsOut[i];

            totalOut += _investLeg(weth_, adapter, legs[i].targetAsset, legAmount, floor, deadline);
        }

        _consumeBucket($.investmentBuckets, uint128(amountIn));
        $.aggregateLifetimeInvested += uint128(amountIn);
        emit InvestmentExecuted($.investmentPolicyNonce, adapter, amountIn, totalOut);
    }

    /// @dev One leg, with the adapter treated as hostile throughout.
    function _investLeg(
        address weth_,
        address adapter,
        address targetAsset,
        uint256 legAmount,
        uint256 floor,
        uint48 deadline
    ) private returns (uint256 received) {
        uint256 wethBefore = IERC20(weth_).balanceOf(address(this));
        uint256 targetBefore = IERC20(targetAsset).balanceOf(address(this));

        // `approve` and not `forceApprove`: the allowance is provably zero on
        // entry, because it is zeroed on the line below on every path out of this
        // function and nothing else in the contract ever approves. forceApprove's
        // reset-then-retry dance costs 260 bytes to handle a state that cannot
        // occur here, and WETH is pinned by the factory so it is not a token that
        // might return false instead of reverting.
        IERC20(weth_).approve(adapter, legAmount);
        // The RETURN VALUE IS DISCARDED. An adapter that reports more than it
        // delivered is the cheapest attack there is, so the vault measures its
        // own balances and believes nothing it is told.
        IInvestmentAdapter(adapter).executeInvestment(weth_, targetAsset, legAmount, floor, deadline);
        IERC20(weth_).approve(adapter, 0);

        // Exactly `legAmount`, not "at most": an adapter that spends less has not
        // done what it was paid for, and one that spends more took what it was
        // not offered. Both are the same refusal.
        if (wethBefore - IERC20(weth_).balanceOf(address(this)) != legAmount) revert InvalidState();

        received = IERC20(targetAsset).balanceOf(address(this)) - targetBefore;
        if (received < floor) revert InsufficientInvestmentOutput(targetAsset, floor, received);
    }

    /// @dev Admin, or a trading account this vault currently considers ACTIVE.
    ///      Both principals already exist; a separate operator role would have
    ///      been a third name for the same authority and one more key to lose.
    function _requireInvestmentAuthority(VaultStorage storage $) private view {
        if (msg.sender == $.vaultAdmin) return;
        if ($.tradingAccounts[msg.sender].status == NuvemTypes.AccountStatus.ACTIVE) return;
        revert Unauthorized();
    }

    function _validateBasket(NuvemTypes.BasketLeg[] calldata legs) private view {
        if (legs.length == 0 || legs.length > NuvemTypes.MAX_BASKET_LEGS) revert InvalidPolicy();
        VaultStorage storage $ = _getVaultStorage();
        uint256 total;
        for (uint256 i = 0; i < legs.length; ++i) {
            NuvemTypes.BasketLeg calldata leg = legs[i];
            if (leg.weightBps == 0) revert InvalidPolicy();
            // A zero floor is the hole where an operator quotes itself no
            // slippage at all, so it is refused rather than defaulted.
            // Bounded, not merely non-zero: the floor is computed with plain
            // multiplication, and `legAmount <= maxInvestmentPerCallWei <= 2^128`
            // times a rate under 2^96 cannot reach 2^256. A zero rate is the hole
            // where an operator quotes itself no slippage at all.
            if (leg.minOutRateWad == 0 || leg.minOutRateWad > type(uint96).max) revert InvalidPolicy();
            if (leg.targetAsset == address(0) || leg.targetAsset == $.weth || leg.targetAsset == address(this)) {
                revert InvalidPolicy();
            }
            if (leg.targetAsset.code.length == 0) revert NotAContract(leg.targetAsset);
            // NO DUPLICATE TARGETS. Two legs on one token alias the same balance
            // delta, so one leg's output satisfies both floors and the second is
            // bought with no lower bound at all. n <= 8 makes this 28 comparisons.
            for (uint256 j = 0; j < i; ++j) {
                if (legs[j].targetAsset == leg.targetAsset) revert InvalidPolicy();
            }
            total += leg.weightBps;
        }
        if (total != NuvemTypes.BPS_DENOMINATOR) revert InvalidPolicy();
    }

    function vaultId() external view returns (bytes32) {
        return _getVaultStorage().vaultId;
    }

    function vaultAdmin() external view returns (address) {
        return _getVaultStorage().vaultAdmin;
    }

    function pendingVaultAdmin() external view returns (address) {
        return _getVaultStorage().pendingVaultAdmin;
    }

    function vaultPolicyNonce() external view returns (uint64) {
        return _getVaultStorage().vaultPolicyNonce;
    }

    function activeTradingAccountCount() external view returns (uint64) {
        return _getVaultStorage().activeTradingAccountCount;
    }

    function aggregateLifetimeContribution() external view returns (uint128) {
        return _getVaultStorage().aggregateLifetimeContributions;
    }

    function lifetimeContribution(address account) external view returns (uint128) {
        return _getVaultStorage().lifetimeContributions[account];
    }

    /**
     * @notice Reads one raw storage slot.
     *
     * @dev THIS EXPOSES NOTHING NEW. Every field reachable through it was a public
     *      getter before; what changed is that eight dispatcher entries and eight
     *      return paths became one. Measured, that is the difference between the
     *      investment path fitting under EIP-170 and not.
     *
     *      `VaultLens` turns slots back into named values. The getters
     *      `SettlementExecutor` calls on the money path — `getTradingAccount`,
     *      `settlementPaused`, `settlementExecutor`, `adminEpoch`,
     *      `localPauseEpoch`, `policyHash` and the two rolling-cap views — were
     *      deliberately NOT removed: a lens between the executor and the vault
     *      would be a second contract that has to be correct for a settlement to
     *      be correct, and it must never be put on that path.
     */
    function extsload(bytes32 slot) external view returns (bytes32 value) {
        assembly ("memory-safe") {
            value := sload(slot)
        }
    }

    function investmentPolicyNonce() external view returns (uint64) {
        return _getVaultStorage().investmentPolicyNonce;
    }

    function investmentRollingCapStatus() external view returns (NuvemTypes.RollingCapStatus memory) {
        VaultStorage storage $ = _getVaultStorage();
        return _rollingStatus($.investmentBuckets, $.maxInvestmentRolling30dWei);
    }

    /// @notice Repoints the vault at a replacement settlement executor.
    /// @dev Deliberately force-pauses settlement and bumps both the local pause
    ///      epoch and the vault policy nonce, which moves `policyHash` and so
    ///      kills every attestation already signed against the old executor.
    ///      Resuming is a separate, explicit admin act.
    ///
    ///      This cannot be gated on `IVaultFactory.isProtocolConfiguration`:
    ///      `configureProtocol` is one-shot, so the factory's pinned executor
    ///      never changes and such a gate would reduce this function to a no-op,
    ///      removing the only migration path a vault has. The contract check
    ///      below is the strongest guard available here; beyond it this is
    ///      admin-only self-harm, and it is pinned as such in the tests.
    function setSettlementExecutor(address nextExecutor) external onlyVaultAdmin {
        if (nextExecutor == address(0)) revert ZeroAddress();
        if (nextExecutor.code.length == 0) revert NotAContract(nextExecutor);
        VaultStorage storage $ = _getVaultStorage();
        address previous = $.settlementExecutor;
        $.settlementExecutor = nextExecutor;
        $.settlementPaused = true;
        $.localPauseEpoch += 1;
        $.vaultPolicyNonce += 1;
        emit SettlementExecutorUpdated(previous, nextExecutor);
        emit VaultPauseUpdated(true, $.localPauseEpoch);
    }

    /// @notice Offers vault administration to `nextAdmin`, or cancels an
    ///         outstanding offer when passed the zero address.
    /// @dev Cancellation matters: an offer never expires, so without this the
    ///      only way to retract one is to overwrite it with another live offer,
    ///      which just moves the exercisable right to a different address.
    function proposeVaultAdmin(address nextAdmin) external onlyVaultAdmin {
        VaultStorage storage $ = _getVaultStorage();
        if (nextAdmin != address(0)) {
            if (nextAdmin == $.vaultAdmin) revert ZeroAddress();
            NuvemTypes.AccountStatus status = $.tradingAccounts[nextAdmin].status;
            if (
                (status != NuvemTypes.AccountStatus.NONE && status != NuvemTypes.AccountStatus.REVOKED)
                    || IVaultFactory($.factory).activeVaultOf(nextAdmin) != address(0)
                    || IVaultFactory($.factory).vaultOfAdmin(nextAdmin) != address(0)
            ) {
                revert InvalidState();
            }
        }
        $.pendingVaultAdmin = nextAdmin;
        emit VaultAdminTransferStarted($.vaultAdmin, nextAdmin);
    }

    function acceptVaultAdmin() external {
        VaultStorage storage $ = _getVaultStorage();
        if (msg.sender != $.pendingVaultAdmin) revert Unauthorized();
        NuvemTypes.AccountStatus status = $.tradingAccounts[msg.sender].status;
        if (
            (status != NuvemTypes.AccountStatus.NONE && status != NuvemTypes.AccountStatus.REVOKED)
                || IVaultFactory($.factory).activeVaultOf(msg.sender) != address(0)
        ) {
            revert InvalidState();
        }
        address previous = $.vaultAdmin;
        IVaultFactory($.factory).transferVaultAdmin(previous, msg.sender);
        $.vaultAdmin = msg.sender;
        $.pendingVaultAdmin = address(0);
        $.adminEpoch += 1;
        $.localPauseEpoch += 1;
        $.settlementPaused = true;
        emit VaultAdminTransferred(previous, msg.sender, $.adminEpoch);
        emit VaultPauseUpdated(true, $.localPauseEpoch);
    }

    /// @notice The binding every settlement attestation is signed against.
    /// @dev DO NOT "tidy" the last argument into `$.vaultPolicy` now that
    ///      `VaultPolicy` happens to hold exactly one field. It is encoded as a
    ///      DISCRETE `uint128` on purpose, and keeping it discrete is what makes
    ///      the preimage byte-identical across the removal of the investment
    ///      path. Encoding the struct instead would silently change every
    ///      attestation binding while looking equivalent.
    function policyHash(address account) public view returns (bytes32) {
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[account];
        return keccak256(
            abi.encode(
                $.vaultId,
                address(this),
                account,
                tradingAccount.bindingEpoch,
                tradingAccount.policyNonce,
                $.vaultPolicyNonce,
                $.adminEpoch,
                $.settlementExecutor,
                tradingAccount.policy,
                $.vaultPolicy.maxAggregateRolling30dWei
            )
        );
    }

    function accountRollingCapStatus(address account) public view returns (NuvemTypes.RollingCapStatus memory) {
        VaultStorage storage $ = _getVaultStorage();
        return _rollingStatus($.accountBuckets[account], $.tradingAccounts[account].policy.maxRolling30dWei);
    }

    function aggregateRollingCapStatus() public view returns (NuvemTypes.RollingCapStatus memory) {
        VaultStorage storage $ = _getVaultStorage();
        return _rollingStatus($.aggregateBuckets, $.vaultPolicy.maxAggregateRolling30dWei);
    }



    function acceptSettlement(NuvemTypes.SettlementRecord calldata record) external payable nonReentrant {
        VaultStorage storage $ = _getVaultStorage();
        if (msg.sender != $.settlementExecutor) revert Unauthorized();
        if ($.settlementPaused || IProtocolPauseController($.pauseController).paused()) {
            revert ProtocolPaused();
        }
        if (msg.value != record.contribution || record.contribution == 0) {
            revert InvalidSettlement();
        }

        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[record.account];
        if (tradingAccount.status != NuvemTypes.AccountStatus.ACTIVE) {
            revert AccountNotActive(record.account);
        }
        if (
            record.bindingEpoch != tradingAccount.bindingEpoch || record.policyNonce != tradingAccount.policyNonce
                || record.settlementNonce != tradingAccount.settlementNonce
                || record.policyHash != policyHash(record.account)
        ) revert InvalidSettlement();
        // L1 bounds. Freshness and the activation floor are L1-only because
        // `block.number` and `activationBlock` are both L1 numbers here.
        // The L2 window must be non-degenerate, and this vault checks it itself
        // rather than trusting the executor to have done so. `setSettlementExecutor`
        // lets an admin repoint this vault at a different executor, so every
        // invariant the frontier depends on has to hold here too.
        //
        // Zero is the frontier's "no settlement yet" sentinel (see the guard
        // below). Storing a real endBlockL2 of 0 would therefore look like an
        // empty frontier forever, and every subsequent window would clear the
        // progression check no matter how far it overlapped — one settlement
        // permanently disabling replay protection for the account. Refusing the
        // degenerate window is what makes the sentinel sound.
        if (
            record.startBlock < tradingAccount.activationBlock || record.endBlock < record.startBlock
                || record.endBlock >= block.number || record.startBlockL2 == 0
                || record.endBlockL2 <= record.startBlockL2
        ) {
            revert InvalidSettlement();
        }

        NuvemTypes.SettlementFrontier storage frontier = $.frontier[record.account][record.bindingEpoch];
        uint64 previousEndL2 = frontier.endBlockL2;
        uint64 previousEndL1 = frontier.endBlockL1;

        // Session progression is enforced on the L2 range, because a trading
        // session is an event in L2 time. At ~120 L2 blocks per L1 block, two
        // genuinely distinct sessions opened within ~12 seconds of each other
        // occupy the SAME L1 block, so an L1 strict-increase rule refuses the
        // second one permanently. This is the guard that replaced it.
        if (previousEndL2 != 0 && record.startBlockL2 <= previousEndL2) {
            revert NonProgressiveBlockRange(previousEndL2, record.startBlockL2, record.endBlockL2);
        }
        // The L1 range is only required to be NON-DECREASING (`<`, not `<=`).
        // Equality is the common case for round-trippers — it is precisely what
        // the change above exists to permit — so this must never demand a strict
        // increase. It still catches an attestation whose L1 range rewinds under
        // a forward L2 range, which is incoherent, and it is free: both ends of
        // the frontier share one storage slot.
        if (previousEndL1 != 0 && record.startBlock < previousEndL1) {
            revert NonProgressiveL1BlockRange(previousEndL1, record.startBlock, record.endBlock);
        }

        bytes32 sessionKey = _sessionKey(record.account, record.bindingEpoch, record.sessionId);
        if ($.usedSessions[sessionKey]) revert SessionAlreadyUsed(record.sessionId);

        NuvemTypes.RollingCapStatus memory accountCap = accountRollingCapStatus(record.account);
        NuvemTypes.RollingCapStatus memory aggregateCap = aggregateRollingCapStatus();
        if (uint256(accountCap.spent) + record.contribution > accountCap.cap) {
            revert RollingCapExceeded(accountCap.cap, accountCap.spent, record.contribution);
        }
        if (uint256(aggregateCap.spent) + record.contribution > aggregateCap.cap) {
            revert RollingCapExceeded(aggregateCap.cap, aggregateCap.spent, record.contribution);
        }

        tradingAccount.settlementNonce += 1;
        frontier.endBlockL1 = record.endBlock;
        frontier.endBlockL2 = record.endBlockL2;
        $.usedSessions[sessionKey] = true;
        _consumeBucket($.accountBuckets[record.account], record.contribution);
        _consumeBucket($.aggregateBuckets, record.contribution);
        $.lifetimeContributions[record.account] += record.contribution;
        $.aggregateLifetimeContributions += record.contribution;

        IWETH($.weth).deposit{value: msg.value}();

        uint128 accountSpentAfter = accountRollingCapStatus(record.account).spent;
        uint128 aggregateSpentAfter = aggregateRollingCapStatus().spent;
        emit RollingCapConsumed(
            record.account,
            uint32(block.timestamp / 1 days),
            record.contribution,
            accountSpentAfter,
            aggregateSpentAfter
        );
        emit ContributionReceived(
            $.vaultId,
            record.account,
            record.sessionId,
            record.bindingEpoch,
            record.settlementNonce,
            record.contribution
        );
    }

    /// @notice Withdraws the requested ERC-20 amount without deducting a Nuvem protocol fee.
    /// @dev Never consults FeeController. Recipient deltas remain subject to the token's own transfer mechanics.
    function withdrawToken(address token, address recipient, uint256 amount) external onlyVaultAdmin nonReentrant {
        if (token == address(0) || recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
        emit Withdrawal(token, recipient, amount);
    }

    /// @notice Withdraws the requested native amount without deducting a Nuvem protocol fee.
    /// @dev Never consults FeeController and never charges a protocol fee.
    function withdrawNative(address payable recipient, uint256 amount) external onlyVaultAdmin nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert InvalidState();
        emit Withdrawal(address(0), recipient, amount);
    }

    function _activateTradingAccount(address account) private {
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[account];
        if (tradingAccount.status != NuvemTypes.AccountStatus.PENDING) revert InvalidState();
        if (tradingAccount.inviteDeadline <= block.timestamp) revert DeadlineExpired();
        if (tradingAccount.inviteAdminEpoch != $.adminEpoch) revert InvalidState();

        address existingVault = IVaultFactory($.factory).activeVaultOf(account);
        if (existingVault != address(0) && existingVault != address(this)) {
            revert AccountAlreadyLinked(account);
        }
        IVaultFactory($.factory).linkTradingAccount(account);

        tradingAccount.status = NuvemTypes.AccountStatus.ACTIVE;
        tradingAccount.bindingEpoch += 1;
        tradingAccount.policyNonce += 1;
        tradingAccount.activationBlock = uint64(block.number);
        tradingAccount.revocationBlock = 0;
        tradingAccount.inviteDeadline = 0;
        tradingAccount.inviteAdminEpoch = 0;
        $.activeTradingAccountCount += 1;

        emit TradingAccountActivated(
            account, tradingAccount.platformId, tradingAccount.bindingEpoch, tradingAccount.activationBlock
        );
    }

    function _revokeTradingAccount(address account) private {
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[account];
        bool wasActive = tradingAccount.status == NuvemTypes.AccountStatus.ACTIVE;
        if (!wasActive && tradingAccount.status != NuvemTypes.AccountStatus.PAUSED) {
            revert InvalidState();
        }
        if (wasActive) {
            $.activeTradingAccountCount -= 1;
        }
        IVaultFactory($.factory).unlinkTradingAccount(account);
        tradingAccount.status = NuvemTypes.AccountStatus.REVOKED;
        tradingAccount.bindingEpoch += 1;
        tradingAccount.policyNonce += 1;
        // REVOKED is a state an account can be invited OUT of again, so an invite
        // signature minted while this account was ACTIVE would otherwise become
        // valid the moment it is revoked — undoing the revocation with the policy
        // signed before it. Bumping here makes "every entry into REVOKED strictly
        // increases inviteNonce" total: cancelTradingAccountInvitation is the only
        // other way in, and it already bumps.
        tradingAccount.inviteNonce += 1;
        tradingAccount.revocationBlock = uint64(block.number);
        emit TradingAccountRevoked(account, tradingAccount.bindingEpoch, tradingAccount.revocationBlock);
    }

    function _setSavingsBps(address account, uint16 nextSavingsBps, address actor) private {
        if (nextSavingsBps > NuvemTypes.BPS_DENOMINATOR) {
            revert InvalidPercentage(nextSavingsBps);
        }
        VaultStorage storage $ = _getVaultStorage();
        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[account];
        if (
            tradingAccount.status != NuvemTypes.AccountStatus.ACTIVE
                && !(tradingAccount.status == NuvemTypes.AccountStatus.PAUSED && actor == $.vaultAdmin)
        ) {
            revert AccountNotActive(account);
        }
        NuvemTypes.TradingAccountPolicy memory nextPolicy = tradingAccount.policy;
        nextPolicy.savingsBps = nextSavingsBps;
        _validateTradingPolicy(nextPolicy);
        tradingAccount.policy = nextPolicy;
        tradingAccount.policyNonce += 1;
        emit TradingAccountPolicyUpdated(account, tradingAccount.policyNonce, nextSavingsBps, actor);
    }

    function _acceptTradingAccountDigest(VaultStorage storage $, address account, uint48 deadline)
        private
        view
        returns (bytes32)
    {
        NuvemTypes.TradingAccount storage tradingAccount = $.tradingAccounts[account];
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ACCEPT_TRADING_ACCOUNT_TYPEHASH,
                    $.vaultId,
                    address(this),
                    account,
                    tradingAccount.inviteNonce,
                    tradingAccount.inviteAdminEpoch,
                    deadline
                )
            )
        );
    }

    /// @dev Every precondition an invite must satisfy, on BOTH paths.
    function _requireInvitable(
        VaultStorage storage $,
        address account,
        NuvemTypes.TradingAccountPolicy calldata policy,
        uint48 inviteDeadline
    ) private view returns (NuvemTypes.TradingAccount storage tradingAccount) {
        if (account == address(0) || account == $.vaultAdmin) revert ZeroAddress();
        // Inviting the PENDING admin would flip it to a trading account, and
        // `acceptVaultAdmin` requires its target be NONE or REVOKED. Without this
        // guard a signature holder could front-run the handover and block it.
        if (account == $.pendingVaultAdmin) revert InvalidState();
        if (inviteDeadline <= block.timestamp) revert DeadlineExpired();
        _validateTradingPolicy(policy);

        tradingAccount = $.tradingAccounts[account];
        if (
            tradingAccount.status != NuvemTypes.AccountStatus.NONE
                && tradingAccount.status != NuvemTypes.AccountStatus.REVOKED
        ) revert InvalidState();
    }

    /// @dev Every effect an invite has, on BOTH paths, including the event.
    function _writeInvite(
        VaultStorage storage $,
        NuvemTypes.TradingAccount storage tradingAccount,
        address account,
        bytes32 platformId,
        NuvemTypes.TradingAccountPolicy calldata policy,
        uint48 inviteDeadline
    ) private {
        tradingAccount.status = NuvemTypes.AccountStatus.PENDING;
        tradingAccount.platformId = platformId;
        tradingAccount.policy = policy;
        tradingAccount.inviteNonce += 1;
        tradingAccount.inviteAdminEpoch = $.adminEpoch;
        tradingAccount.inviteDeadline = inviteDeadline;

        emit TradingAccountInvited(account, platformId, policy.savingsBps, tradingAccount.inviteNonce, inviteDeadline);
    }

    /// @dev EIP-712 hashStruct of the policy.
    ///
    ///      DO NOT tidy this into `abi.encode(TRADING_ACCOUNT_POLICY_TYPEHASH, policy)`.
    ///      That form silently follows the Solidity declaration order in
    ///      NuvemTypes, so repacking the struct there would change this hash while
    ///      the frozen type string above stayed the same, and every wallet-produced
    ///      signature would stop verifying against a contract that cannot be fixed.
    function _hashTradingPolicy(NuvemTypes.TradingAccountPolicy calldata policy) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TRADING_ACCOUNT_POLICY_TYPEHASH,
                policy.savingsBps,
                policy.minContributionWei,
                policy.maxPerSettlementWei,
                policy.maxRolling30dWei,
                policy.tradingFloorWei,
                policy.gasReserveWei
            )
        );
    }

    /// @dev `$.adminEpoch` is bound, NOT `tradingAccount.inviteAdminEpoch`.
    ///      The latter looks like the natural mirror of the accept digest and is
    ///      the wrong field here: `_activateTradingAccount` zeroes it and
    ///      `cancelTradingAccountInvitation` leaves it stale, so on exactly the
    ///      NONE/REVOKED accounts this function serves it carries no information
    ///      about the current admin. Binding it would look correct and protect
    ///      nothing across an admin change.
    function _inviteTradingAccountDigest(
        VaultStorage storage $,
        address account,
        bytes32 platformId,
        NuvemTypes.TradingAccountPolicy calldata policy,
        uint64 inviteNonce,
        uint48 inviteDeadline,
        uint48 sigDeadline
    ) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    INVITE_TRADING_ACCOUNT_TYPEHASH,
                    $.vaultId,
                    address(this),
                    account,
                    platformId,
                    _hashTradingPolicy(policy),
                    inviteNonce,
                    $.adminEpoch,
                    inviteDeadline,
                    sigDeadline
                )
            )
        );
    }

    function _validateInitialization(NuvemTypes.VaultInitialization memory config, address factory_) private view {
        if (
            config.weth == address(0) || config.pauseController == address(0) || config.attesterRegistry == address(0)
                || config.settlementExecutor == address(0)
        ) revert ZeroAddress();
        // FOUR ARGUMENTS, which is what the factory deployed on mainnet has.
        // The five-argument form was added when the adapter registry lived in
        // ProtocolConfiguration; the live factory answers only the four-argument
        // selector and `configureProtocol` is one-shot, so it can never gain the
        // fifth. Calling the five-argument version here made `createVault` revert
        // for every new vault the moment the beacon was upgraded — measured on a
        // mainnet fork, FailedCall() on all three initData shapes.
        if (!IVaultFactory(factory_)
                .isProtocolConfiguration(
                    config.weth, config.pauseController, config.attesterRegistry, config.settlementExecutor
                )) revert InvalidPolicy();
        _validateVaultPolicy(config.policy);
    }

    function _validateTradingPolicy(NuvemTypes.TradingAccountPolicy memory policy) private pure {
        if (policy.savingsBps > NuvemTypes.BPS_DENOMINATOR) {
            revert InvalidPercentage(policy.savingsBps);
        }
        if (
            policy.savingsBps != 0
                && (policy.maxPerSettlementWei == 0
                    || policy.maxRolling30dWei == 0
                    || policy.minContributionWei > policy.maxPerSettlementWei
                    || policy.maxPerSettlementWei > policy.maxRolling30dWei)
        ) revert InvalidPolicy();
    }

    function _validateVaultPolicy(NuvemTypes.VaultPolicy memory policy) private pure {
        if (policy.maxAggregateRolling30dWei == 0) revert InvalidPolicy();
    }

    function _sessionKey(address account, uint64 bindingEpoch, bytes32 sessionId) private pure returns (bytes32) {
        return keccak256(abi.encode(account, bindingEpoch, sessionId));
    }

    function _vaultPolicyHash(VaultStorage storage $) private view returns (bytes32) {
        return keccak256(
            abi.encode($.vaultId, address(this), $.vaultPolicyNonce, $.adminEpoch, $.settlementExecutor, $.vaultPolicy)
        );
    }

    function _rollingStatus(NuvemTypes.DailySpendBucket[31] storage buckets, uint128 cap)
        private
        view
        returns (NuvemTypes.RollingCapStatus memory status)
    {
        uint32 currentDay = uint32(block.timestamp / 1 days);
        uint32 lowerDay = currentDay > 30 ? currentDay - 30 : 0;
        uint256 spent;
        uint32 oldestDay = type(uint32).max;
        uint128 oldestAmount;

        for (uint256 i = 0; i < 31; ++i) {
            NuvemTypes.DailySpendBucket storage bucket = buckets[i];
            if (bucket.amount != 0 && bucket.dayIndex >= lowerDay && bucket.dayIndex <= currentDay) {
                spent += bucket.amount;
                if (bucket.dayIndex < oldestDay) {
                    oldestDay = bucket.dayIndex;
                    oldestAmount = bucket.amount;
                }
            }
        }

        uint128 spent128 = uint128(spent);
        status.cap = cap;
        status.spent = spent128;
        status.remaining = spent128 >= cap ? 0 : cap - spent128;
        if (oldestDay != type(uint32).max) {
            status.nextReleaseAt = uint48(uint256(oldestDay + 31) * 1 days);
            status.nextReleaseAmount = oldestAmount;
        }
    }

    function _consumeBucket(NuvemTypes.DailySpendBucket[31] storage buckets, uint128 amount) private {
        uint32 currentDay = uint32(block.timestamp / 1 days);
        NuvemTypes.DailySpendBucket storage bucket = buckets[currentDay % 31];
        if (bucket.dayIndex != currentDay) {
            bucket.dayIndex = currentDay;
            bucket.amount = amount;
        } else {
            bucket.amount += amount;
        }
    }

    function _getVaultStorage() private pure returns (VaultStorage storage $) {
        bytes32 slot = VAULT_STORAGE_LOCATION;
        assembly {
            $.slot := slot
        }
    }

    receive() external payable {
        revert Unauthorized();
    }
}
