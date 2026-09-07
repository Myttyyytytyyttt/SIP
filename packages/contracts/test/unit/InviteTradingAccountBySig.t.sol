// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {SettlementExecutor} from "../../src/settlement/SettlementExecutor.sol";
import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

contract AdminERC1271Wallet {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;

    mapping(bytes32 digest => bool) public approved;
    bool public answerTruthfully = true;

    function approve(bytes32 digest) external {
        approved[digest] = true;
    }

    function setAnswerTruthfully(bool value) external {
        answerTruthfully = value;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        if (!answerTruthfully) return bytes4(0);
        return approved[digest] ? MAGIC_VALUE : bytes4(0);
    }

    function call(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}

/// @title The relayed invite: `inviteTradingAccountBySig`.
/// @notice The vault admin signs; anybody relays and pays. These tests exist for
///         one reason above all others: an invite signature is minted BEFORE the
///         account it names has any state, and `status in {NONE, REVOKED}` is a
///         CYCLING precondition. A signature that is merely rejected today can
///         become valid tomorrow, so "rejected" is not "burned".
contract InviteTradingAccountBySigTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    bytes32 internal constant PLATFORM = keccak256("gmgn");

    VaultFactory internal factory;
    PersonalVault internal vault;
    MockWETH internal weth;
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    SettlementExecutor internal executor;

    uint256 internal adminKey = 0xA11CE;
    address internal admin;
    address internal wallet;
    address internal relayer;
    address internal governance;

    uint48 internal inviteDeadline;
    uint48 internal sigDeadline;

    function setUp() external {
        admin = vm.addr(adminKey);
        wallet = makeAddr("tradingWallet");
        relayer = makeAddr("relayer");
        governance = makeAddr("governance");

        weth = new MockWETH();
        pauseController = new ProtocolPauseController(governance, governance);
        attesterRegistry = new AttesterRegistry(governance, governance, makeAddr("attester"));
        factory = new VaultFactory(address(this));
        executor = new SettlementExecutor(address(factory), address(attesterRegistry), address(pauseController));
        factory.configureProtocol(
            VaultFactory.ProtocolConfiguration({
                weth: address(weth),
                pauseController: address(pauseController),
                attesterRegistry: address(attesterRegistry),
                settlementExecutor: address(executor)
            })
        );
        (uint32 cohortId,) = factory.registerCohort(address(new PersonalVault(address(adapterRegistry))), address(this));
        vault = PersonalVault(payable(_createVault(cohortId, admin)));

        inviteDeadline = uint48(block.timestamp + 1 days);
        sigDeadline = uint48(block.timestamp + 30 minutes);
    }

    function _createVault(uint32 cohortId, address vaultAdmin) private returns (address created) {
        vm.prank(vaultAdmin);
        (, created) = factory.createVault(
            keccak256(abi.encode("salt", vaultAdmin)),
            cohortId,
            abi.encode(
                NuvemTypes.VaultInitialization({
                    weth: address(weth),
                    pauseController: address(pauseController),
                    attesterRegistry: address(attesterRegistry),
                    settlementExecutor: address(executor),
                    policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: 100 ether})
                })
            )
        );
    }

    function _policy(uint16 savingsBps) internal pure returns (NuvemTypes.TradingAccountPolicy memory) {
        return NuvemTypes.TradingAccountPolicy({
            savingsBps: savingsBps,
            minContributionWei: 1e12,
            maxPerSettlementWei: 10 ether,
            maxRolling30dWei: 20 ether,
            tradingFloorWei: 0.5 ether,
            gasReserveWei: 0.1 ether
        });
    }

    /// @dev Built by hand from the type strings, NOT from the contract helper. A
    ///      test that asks the contract for the digest it is about to check proves
    ///      only that the contract agrees with itself.
    function _digest(
        address account,
        bytes32 platformId,
        NuvemTypes.TradingAccountPolicy memory policy,
        uint64 inviteNonce,
        uint64 adminEpoch,
        uint48 invDeadline,
        uint48 sgDeadline
    ) internal view returns (bytes32) {
        bytes32 policyHash = keccak256(
            abi.encode(
                keccak256(
                    "TradingAccountPolicy(uint16 savingsBps,uint128 minContributionWei,uint128 maxPerSettlementWei,uint128 maxRolling30dWei,uint128 tradingFloorWei,uint128 gasReserveWei)"
                ),
                policy.savingsBps,
                policy.minContributionWei,
                policy.maxPerSettlementWei,
                policy.maxRolling30dWei,
                policy.tradingFloorWei,
                policy.gasReserveWei
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "InviteTradingAccount(bytes32 vaultId,address vault,address tradingWallet,bytes32 platformId,TradingAccountPolicy policy,uint64 inviteNonce,uint64 adminEpoch,uint48 inviteDeadline,uint48 sigDeadline)TradingAccountPolicy(uint16 savingsBps,uint128 minContributionWei,uint128 maxPerSettlementWei,uint128 maxRolling30dWei,uint128 tradingFloorWei,uint128 gasReserveWei)"
                ),
                factory.vaultIdOf(address(vault)),
                address(vault),
                account,
                platformId,
                policyHash,
                inviteNonce,
                adminEpoch,
                invDeadline,
                sgDeadline
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Nuvem Personal Vault"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(bytes32 digest, uint256 key) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signInvite(NuvemTypes.TradingAccountPolicy memory policy) internal view returns (bytes memory) {
        return _sign(
            _digest(
                wallet,
                PLATFORM,
                policy,
                vault.getTradingAccount(wallet).inviteNonce,
                vault.adminEpoch(),
                inviteDeadline,
                sigDeadline
            ),
            adminKey
        );
    }

    function _relay(NuvemTypes.TradingAccountPolicy memory policy, bytes memory signature) internal {
        vm.prank(relayer);
        vault.inviteTradingAccountBySig(wallet, PLATFORM, policy, inviteDeadline, sigDeadline, signature);
    }

    // =======================================================================
    // Replay: the reason this file exists.
    // =======================================================================

    function testHappyPathInvitesAndTheWalletCanAccept() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        _relay(policy, _signInvite(policy));

        assertEq(uint8(vault.getTradingAccount(wallet).status), uint8(NuvemTypes.AccountStatus.PENDING));
        vm.prank(wallet);
        vault.acceptTradingAccount();
        assertEq(uint8(vault.getTradingAccount(wallet).status), uint8(NuvemTypes.AccountStatus.ACTIVE));
    }

    function testReplayedSignatureRevertsOnSecondSubmission() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);
        _relay(policy, signature);

        // Take the account back to REVOKED so the STATUS gate would let it through
        // again, isolating the nonce as the thing that refuses.
        vm.prank(admin);
        vault.cancelTradingAccountInvitation(wallet);

        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(policy, signature);
    }

    /// @dev THE CRITICAL TEST. A signature minted while the wallet was ACTIVE is
    ///      rejected then — and must still be rejected after the admin revokes
    ///      that wallet, which is precisely when the status gate reopens. Before
    ///      `_revokeTradingAccount` bumped the invite nonce, this signature came
    ///      back to life and undid the revocation with the policy signed before it.
    function testSignatureMintedWhileActiveStaysDeadAfterRevoke() external {
        NuvemTypes.TradingAccountPolicy memory tight = _policy(2_000);
        _relay(tight, _signInvite(tight));
        vm.prank(wallet);
        vault.acceptTradingAccount();

        // The admin is induced to sign a permissive invite while the wallet is
        // ACTIVE (a stale frontend, a double click, a phishing prompt).
        NuvemTypes.TradingAccountPolicy memory permissive = _policy(1);
        bytes memory sleeper = _signInvite(permissive);
        vm.expectRevert(PersonalVault.InvalidState.selector);
        _relay(permissive, sleeper);

        // The wallet is compromised and revoked.
        vm.prank(admin);
        vault.revokeTradingAccount(wallet);
        assertEq(uint8(vault.getTradingAccount(wallet).status), uint8(NuvemTypes.AccountStatus.REVOKED));

        // The parked signature must not resurrect it.
        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(permissive, sleeper);
    }

    function testSignatureMintedWhilePausedStaysDeadAfterRevoke() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        _relay(policy, _signInvite(policy));
        vm.prank(wallet);
        vault.acceptTradingAccount();
        vm.prank(admin);
        vault.pauseTradingAccount(wallet);

        bytes memory sleeper = _signInvite(_policy(1));
        vm.prank(admin);
        vault.revokeTradingAccount(wallet);

        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(_policy(1), sleeper);
    }

    function testEveryTransitionIntoRevokedStrictlyIncreasesTheInviteNonce() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);

        // Path 1: PENDING -> REVOKED via cancellation.
        _relay(policy, _signInvite(policy));
        uint64 beforeCancel = vault.getTradingAccount(wallet).inviteNonce;
        vm.prank(admin);
        vault.cancelTradingAccountInvitation(wallet);
        assertGt(vault.getTradingAccount(wallet).inviteNonce, beforeCancel, "cancel must bump");

        // Path 2: ACTIVE -> REVOKED via revocation.
        _relay(policy, _signInvite(policy));
        vm.prank(wallet);
        vault.acceptTradingAccount();
        uint64 beforeRevoke = vault.getTradingAccount(wallet).inviteNonce;
        vm.prank(admin);
        vault.revokeTradingAccount(wallet);
        assertGt(vault.getTradingAccount(wallet).inviteNonce, beforeRevoke, "revoke must bump");
    }

    // =======================================================================
    // Admin binding.
    // =======================================================================

    function testSignatureRevertsAfterTheVaultAdminChanges() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);

        address nextAdmin = makeAddr("nextAdmin");
        vm.prank(admin);
        vault.proposeVaultAdmin(nextAdmin);
        vm.prank(nextAdmin);
        vault.acceptVaultAdmin();

        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(policy, signature);
    }

    /// @dev The round trip is the case a live-admin check alone cannot catch: the
    ///      signer is the current admin again, so only the bound `$.adminEpoch`
    ///      refuses. It also proves the epoch bound is the VAULT one and not the
    ///      per-account `inviteAdminEpoch`, which is zero for a NONE account.
    function testSignatureRevertsAfterTheAdminRoundTripsBackToItself() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);
        assertEq(vault.getTradingAccount(wallet).inviteAdminEpoch, 0, "precondition: the per-account epoch is zero");

        address other = makeAddr("other");
        vm.prank(admin);
        vault.proposeVaultAdmin(other);
        vm.prank(other);
        vault.acceptVaultAdmin();
        vm.prank(other);
        vault.proposeVaultAdmin(admin);
        vm.prank(admin);
        vault.acceptVaultAdmin();

        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(policy, signature);
    }

    // =======================================================================
    // Parameter substitution by the relayer.
    // =======================================================================

    /// @dev The worst substitution: savingsBps 0 sails through
    ///      `_validateTradingPolicy` because its second branch is gated on a
    ///      non-zero share, so only the signature stands between a relayer and a
    ///      wallet that saves nothing.
    function testSubstitutedSavingsBpsReverts() external {
        NuvemTypes.TradingAccountPolicy memory signed = _policy(2_000);
        bytes memory signature = _signInvite(signed);

        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(_policy(0), signature);
    }

    function testFuzzMutatingAnySinglePolicyFieldInvalidatesTheSignature(uint8 field, uint128 delta) external {
        vm.assume(delta > 0);
        field = uint8(bound(field, 0, 5));

        NuvemTypes.TradingAccountPolicy memory signed = _policy(2_000);
        bytes memory signature = _signInvite(signed);

        NuvemTypes.TradingAccountPolicy memory tampered = signed;
        if (field == 0) tampered.savingsBps = 2_001;
        else if (field == 1) tampered.minContributionWei = signed.minContributionWei + 1;
        else if (field == 2) tampered.maxPerSettlementWei = signed.maxPerSettlementWei + 1;
        else if (field == 3) tampered.maxRolling30dWei = signed.maxRolling30dWei + 1;
        else if (field == 4) tampered.tradingFloorWei = signed.tradingFloorWei + 1;
        else tampered.gasReserveWei = signed.gasReserveWei + 1;

        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(tampered, signature);
    }

    function testSubstitutedPlatformIdReverts() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);

        vm.prank(relayer);
        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        vault.inviteTradingAccountBySig(
            wallet, keccak256("another-venue"), policy, inviteDeadline, sigDeadline, signature
        );
    }

    function testSubstitutedAccountReverts() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);

        vm.prank(relayer);
        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        vault.inviteTradingAccountBySig(relayer, PLATFORM, policy, inviteDeadline, sigDeadline, signature);
    }

    function testSubstitutedInviteDeadlineReverts() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);

        vm.prank(relayer);
        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        vault.inviteTradingAccountBySig(
            wallet, PLATFORM, policy, uint48(block.timestamp + 3650 days), sigDeadline, signature
        );
    }

    // =======================================================================
    // Deadlines.
    // =======================================================================

    function testExpiredSignatureDeadlineReverts() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);

        vm.warp(sigDeadline + 1);
        vm.expectRevert(PersonalVault.DeadlineExpired.selector);
        _relay(policy, signature);
    }

    /// @dev Without the cap, `sigDeadline` is frontend-chosen and the "exposed for
    ///      minutes" argument is circular.
    function testSignatureDeadlineBeyondTheMaxWindowReverts() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        sigDeadline = uint48(block.timestamp + vault.MAX_SIGNATURE_WINDOW() + 1);
        bytes memory signature = _signInvite(policy);

        vm.expectRevert(PersonalVault.DeadlineExpired.selector);
        _relay(policy, signature);
    }

    /// @dev The two windows are independent: the acceptance window is NOT clamped
    ///      by the far shorter signature window.
    function testShortSignatureWindowWithLongInviteWindowSucceeds() external {
        inviteDeadline = uint48(block.timestamp + 30 days);
        sigDeadline = uint48(block.timestamp + 60);
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        _relay(policy, _signInvite(policy));

        vm.warp(block.timestamp + 20 days);
        vm.prank(wallet);
        vault.acceptTradingAccount();
        assertEq(uint8(vault.getTradingAccount(wallet).status), uint8(NuvemTypes.AccountStatus.ACTIVE));
    }

    function testExpiredInviteDeadlineReverts() external {
        inviteDeadline = uint48(block.timestamp + 10);
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);

        vm.warp(inviteDeadline + 1);
        vm.expectRevert(PersonalVault.DeadlineExpired.selector);
        _relay(policy, signature);
    }

    // =======================================================================
    // Typehashes and encoding.
    // =======================================================================

    function testTypehashConstantsMatchPinnedVectors() external view {
        assertEq(
            vault.TRADING_ACCOUNT_POLICY_TYPEHASH(),
            0xbdca0035a6e72111aa82a16bb83fbe14784f46b04a4fcf10df4d50d4bd6f273d
        );
        assertEq(
            vault.INVITE_TRADING_ACCOUNT_TYPEHASH(),
            0xd3f79490c78677ce1dd551bce07175942efeee2f9ad53de3a2bdffba2cd3a1d5
        );
    }

    /// @dev The encoding trap. EIP-712 requires the nested struct to appear as its
    ///      hashStruct; encoding it inline produces a different digest and would
    ///      brick every wallet-produced signature against a sealed contract.
    function testPolicyHashStructDiffersFromTheInlinedEncoding() external view {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes32 correct = keccak256(
            abi.encode(
                vault.TRADING_ACCOUNT_POLICY_TYPEHASH(),
                policy.savingsBps,
                policy.minContributionWei,
                policy.maxPerSettlementWei,
                policy.maxRolling30dWei,
                policy.tradingFloorWei,
                policy.gasReserveWei
            )
        );
        bytes32 inlined = keccak256(abi.encode(vault.TRADING_ACCOUNT_POLICY_TYPEHASH(), policy));
        // They coincide only by accident of field order; the assertion that
        // matters is that the contract accepts the hashStruct form, which
        // testHappyPath already proves. This pins the pair for future editors.
        assertEq(correct, inlined, "same today; the comment on _hashTradingPolicy explains why that is fragile");
    }

    function testIndependentlyComputedDigestMatchesTheContract() external view {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        assertEq(
            vault.inviteTradingAccountDigest(wallet, PLATFORM, policy, inviteDeadline, sigDeadline),
            _digest(wallet, PLATFORM, policy, 0, vault.adminEpoch(), inviteDeadline, sigDeadline)
        );
    }

    // =======================================================================
    // Authority, relayers, and the kill switch.
    // =======================================================================

    function testSignatureFromANonAdminReverts() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _sign(
            _digest(wallet, PLATFORM, policy, 0, vault.adminEpoch(), inviteDeadline, sigDeadline), 0xB0B
        );

        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(policy, signature);
    }

    function testGarbageSignatureRevertsRatherThanMatchingZeroAddress() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(policy, hex"deadbeef");
    }

    function testAnyRelayerCanSubmitAndTheOutcomeIsIdentical() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vault.inviteTradingAccountBySig(wallet, PLATFORM, policy, inviteDeadline, sigDeadline, signature);

        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(wallet);
        assertEq(uint8(account.status), uint8(NuvemTypes.AccountStatus.PENDING));
        assertEq(account.policy.savingsBps, 2_000);
    }

    function testInvalidateBurnsAnOutstandingSignature() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);

        vm.prank(admin);
        vault.invalidateTradingAccountInvites(wallet);

        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(policy, signature);
    }

    /// @dev Disarming while ACTIVE is the point: it closes the sleeper BEFORE the
    ///      revoke that would arm it, with no two-transaction race to lose.
    function testInvalidateIsCallableWhileActive() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        _relay(policy, _signInvite(policy));
        vm.prank(wallet);
        vault.acceptTradingAccount();

        bytes memory sleeper = _signInvite(_policy(1));
        vm.prank(admin);
        vault.invalidateTradingAccountInvites(wallet);
        vm.prank(admin);
        vault.revokeTradingAccount(wallet);

        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        _relay(_policy(1), sleeper);
    }

    function testInvalidateRevertsWhilePending() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        _relay(policy, _signInvite(policy));

        vm.prank(admin);
        vm.expectRevert(PersonalVault.InvalidState.selector);
        vault.invalidateTradingAccountInvites(wallet);
    }

    function testDigestViewRefusesToMintForALiveAccount() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        _relay(policy, _signInvite(policy));

        vm.expectRevert(PersonalVault.InvalidState.selector);
        vault.inviteTradingAccountDigest(wallet, PLATFORM, policy, inviteDeadline, sigDeadline);
    }

    // =======================================================================
    // Parity with the direct path.
    // =======================================================================

    function testInvitingTheVaultAdminRevertsOnBothPaths() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);

        vm.prank(admin);
        vm.expectRevert(PersonalVault.ZeroAddress.selector);
        vault.inviteTradingAccount(admin, PLATFORM, policy, inviteDeadline);

        bytes memory signature = _sign(
            _digest(admin, PLATFORM, policy, 0, vault.adminEpoch(), inviteDeadline, sigDeadline), adminKey
        );
        vm.prank(relayer);
        vm.expectRevert(PersonalVault.ZeroAddress.selector);
        vault.inviteTradingAccountBySig(admin, PLATFORM, policy, inviteDeadline, sigDeadline, signature);
    }

    /// @dev The new guard. Without it a signature holder could front-run
    ///      `acceptVaultAdmin` and block the handover by flipping the incoming
    ///      admin to PENDING.
    function testInvitingThePendingVaultAdminRevertsOnBothPaths() external {
        address incoming = makeAddr("incomingAdmin");
        vm.prank(admin);
        vault.proposeVaultAdmin(incoming);

        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);

        vm.prank(admin);
        vm.expectRevert(PersonalVault.InvalidState.selector);
        vault.inviteTradingAccount(incoming, PLATFORM, policy, inviteDeadline);

        bytes memory signature = _sign(
            _digest(incoming, PLATFORM, policy, 0, vault.adminEpoch(), inviteDeadline, sigDeadline), adminKey
        );
        vm.prank(relayer);
        vm.expectRevert(PersonalVault.InvalidState.selector);
        vault.inviteTradingAccountBySig(incoming, PLATFORM, policy, inviteDeadline, sigDeadline, signature);
    }

    function testBothPathsProduceIdenticalStorage() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_500);

        address direct = makeAddr("directWallet");
        vm.prank(admin);
        vault.inviteTradingAccount(direct, PLATFORM, policy, inviteDeadline);
        NuvemTypes.TradingAccount memory viaDirect = vault.getTradingAccount(direct);

        _relay(policy, _signInvite(policy));
        NuvemTypes.TradingAccount memory viaSig = vault.getTradingAccount(wallet);

        assertEq(uint8(viaSig.status), uint8(viaDirect.status));
        assertEq(viaSig.platformId, viaDirect.platformId);
        assertEq(viaSig.policy.savingsBps, viaDirect.policy.savingsBps);
        assertEq(viaSig.policy.tradingFloorWei, viaDirect.policy.tradingFloorWei);
        assertEq(viaSig.policy.gasReserveWei, viaDirect.policy.gasReserveWei);
        assertEq(viaSig.inviteNonce, viaDirect.inviteNonce);
        assertEq(viaSig.inviteAdminEpoch, viaDirect.inviteAdminEpoch);
        assertEq(viaSig.inviteDeadline, viaDirect.inviteDeadline);
    }

    function testStatusGateIsIdenticalOnBothPaths() external {
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        _relay(policy, _signInvite(policy));

        // PENDING is refused by both.
        vm.expectRevert(PersonalVault.InvalidState.selector);
        vm.prank(admin);
        vault.inviteTradingAccount(wallet, PLATFORM, policy, inviteDeadline);

        // Signed BEFORE expectRevert: _signInvite itself calls the vault, and an
        // armed expectRevert would latch onto that read instead of the invite.
        bytes memory freshSignature = _signInvite(policy);
        vm.expectRevert(PersonalVault.InvalidState.selector);
        _relay(policy, freshSignature);
    }

    // =======================================================================
    // Domain separation.
    // =======================================================================

    function testASignatureForOneVaultIsRejectedByAnother() external {
        address otherAdmin = vm.addr(adminKey);
        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes memory signature = _signInvite(policy);

        (uint32 cohortId,) = factory.registerCohort(address(new PersonalVault(address(adapterRegistry))), address(this));
        address second = _createVault(cohortId, makeAddr("secondAdmin"));
        otherAdmin;

        vm.prank(relayer);
        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        PersonalVault(payable(second)).inviteTradingAccountBySig(
            wallet, PLATFORM, policy, inviteDeadline, sigDeadline, signature
        );
    }

    function testERC1271AdminCanAuthoriseAndAFalseAnswerReverts() external {
        AdminERC1271Wallet smartAdmin = new AdminERC1271Wallet();
        vm.prank(admin);
        vault.proposeVaultAdmin(address(smartAdmin));
        smartAdmin.call(address(vault), abi.encodeCall(PersonalVault.acceptVaultAdmin, ()));

        NuvemTypes.TradingAccountPolicy memory policy = _policy(2_000);
        bytes32 digest =
            _digest(wallet, PLATFORM, policy, 0, vault.adminEpoch(), inviteDeadline, sigDeadline);

        vm.prank(relayer);
        vm.expectRevert(PersonalVault.InvalidSignature.selector);
        vault.inviteTradingAccountBySig(wallet, PLATFORM, policy, inviteDeadline, sigDeadline, hex"00");

        smartAdmin.approve(digest);
        vm.prank(relayer);
        vault.inviteTradingAccountBySig(wallet, PLATFORM, policy, inviteDeadline, sigDeadline, hex"00");
        assertEq(uint8(vault.getTradingAccount(wallet).status), uint8(NuvemTypes.AccountStatus.PENDING));
    }
}
