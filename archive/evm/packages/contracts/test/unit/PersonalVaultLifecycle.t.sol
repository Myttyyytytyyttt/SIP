// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {FeeController} from "../../src/fees/FeeController.sol";
import {FeeCollector} from "../../src/fees/FeeCollector.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {MockTargetToken} from "../../src/mocks/MockTargetToken.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";

contract SettlementExecutorStub {}

contract InvitationERC1271Wallet {
    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;
    mapping(bytes32 digest => bool approved) public approved;

    function approve(bytes32 digest) external {
        approved[digest] = true;
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return approved[digest] ? MAGIC_VALUE : bytes4(0);
    }
}

contract PersonalVaultLifecycleTest is Test {
    AdapterRegistry internal adapterRegistry = new AdapterRegistry(address(this), address(this));
    bytes32 internal constant PLATFORM_A = keccak256("gmgn");
    bytes32 internal constant PLATFORM_B = keccak256("platform-b");

    address internal governance;
    address internal guardian;
    address internal attester;
    address internal treasury;
    address internal vaultAdmin;
    address internal secondVaultAdmin;
    address internal tradingWalletA;
    address internal tradingWalletB;
    address internal stranger;
    address internal settlementExecutor;

    VaultFactory internal factory;
    PersonalVault internal implementation;
    PersonalVault internal vault;
    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    FeeCollector internal feeCollector;
    FeeController internal feeController;
    MockWETH internal weth;
    MockTargetToken internal target;

    uint32 internal cohortId;

    function setUp() external {
        governance = makeAddr("governance");
        guardian = makeAddr("guardian");
        attester = makeAddr("attester");
        treasury = makeAddr("treasury");
        vaultAdmin = makeAddr("vaultAdmin");
        secondVaultAdmin = makeAddr("secondVaultAdmin");
        tradingWalletA = makeAddr("tradingWalletA");
        tradingWalletB = makeAddr("tradingWalletB");
        stranger = makeAddr("stranger");
        settlementExecutor = address(new SettlementExecutorStub());

        weth = new MockWETH();
        // A second ERC-20 with no protocol role: the withdrawal tests need an
        // asset that is not WETH.
        target = new MockTargetToken("Mock Target", "MTARGET");

        pauseController = new ProtocolPauseController(governance, guardian);
        attesterRegistry = new AttesterRegistry(governance, guardian, attester);
        feeCollector = new FeeCollector(governance, treasury);
        feeController = new FeeController(governance, address(feeCollector), 0);

        implementation = new PersonalVault(address(adapterRegistry));
        factory = new VaultFactory(governance);

        vm.prank(governance);
        factory.configureProtocol(
            VaultFactory.ProtocolConfiguration({
                weth: address(weth),
                pauseController: address(pauseController),
                attesterRegistry: address(attesterRegistry),
                settlementExecutor: settlementExecutor
            })
        );

        vm.prank(governance);
        (cohortId,) = factory.registerCohort(address(implementation), address(this));

        vault = _createVault(vaultAdmin, keccak256("primary-vault"));
    }

    function testMultipleTradingWalletsRemainIndependent() external {
        _inviteAndActivate(vault, vaultAdmin, tradingWalletA, PLATFORM_A, 2_000);
        _inviteAndActivate(vault, vaultAdmin, tradingWalletB, PLATFORM_B, 3_000);

        assertEq(vault.activeTradingAccountCount(), 2);
        assertEq(factory.activeVaultOf(tradingWalletA), address(vault));
        assertEq(factory.activeVaultOf(tradingWalletB), address(vault));

        NuvemTypes.TradingAccount memory accountA = vault.getTradingAccount(tradingWalletA);
        NuvemTypes.TradingAccount memory accountB = vault.getTradingAccount(tradingWalletB);
        assertEq(uint8(accountA.status), uint8(NuvemTypes.AccountStatus.ACTIVE));
        assertEq(uint8(accountB.status), uint8(NuvemTypes.AccountStatus.ACTIVE));
        assertEq(accountA.platformId, PLATFORM_A);
        assertEq(accountB.platformId, PLATFORM_B);
        assertEq(accountA.policy.savingsBps, 2_000);
        assertEq(accountB.policy.savingsBps, 3_000);

        vm.prank(tradingWalletA);
        vault.setMySavingsBps(4_000);

        assertEq(vault.getTradingAccount(tradingWalletA).policy.savingsBps, 4_000);
        assertEq(vault.getTradingAccount(tradingWalletB).policy.savingsBps, 3_000);
    }

    function testRelayerCanAcceptTradingWalletInvitationWithEip712Signature() external {
        (address signedTrader, uint256 signedTraderKey) = makeAddrAndKey("signedTrader");
        uint48 deadline = uint48(block.timestamp + 1 days);
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(signedTrader, PLATFORM_A, _tradingPolicy(2_000), deadline);

        bytes32 digest = vault.acceptTradingAccountDigest(signedTrader);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signedTraderKey, digest);
        vault.acceptTradingAccountBySig(signedTrader, deadline, abi.encodePacked(r, s, v));

        assertEq(factory.activeVaultOf(signedTrader), address(vault));
        assertEq(uint8(vault.getTradingAccount(signedTrader).status), uint8(NuvemTypes.AccountStatus.ACTIVE));
    }

    function testRelayerCanAcceptErc1271TradingWalletInvitation() external {
        InvitationERC1271Wallet smartTrader = new InvitationERC1271Wallet();
        uint48 deadline = uint48(block.timestamp + 1 days);
        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(address(smartTrader), PLATFORM_A, _tradingPolicy(2_000), deadline);
        smartTrader.approve(vault.acceptTradingAccountDigest(address(smartTrader)));

        vault.acceptTradingAccountBySig(address(smartTrader), deadline, hex"1271");

        assertEq(factory.activeVaultOf(address(smartTrader)), address(vault));
    }

    /// @notice initData cannot smuggle a non-canonical component past the
    ///         factory's pinned configuration.
    /// @dev This used to substitute a fake FeeController. With the configuration
    ///      down to four addresses the property matters MORE, not less, so it is
    ///      retargeted onto a component that still exists rather than deleted.
    function testVaultCreationRejectsSubstitutedProtocolComponent() external {
        address fakeAdmin = makeAddr("fakeConfigAdmin");
        AttesterRegistry fakeAttesters = new AttesterRegistry(governance, guardian, attester);
        NuvemTypes.VaultInitialization memory initialization = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(fakeAttesters),
            settlementExecutor: settlementExecutor,
            policy: _vaultPolicy()
        });

        vm.expectRevert(PersonalVault.InvalidPolicy.selector);
        vm.prank(fakeAdmin);
        factory.createVault(keccak256("fake-attester-registry"), cohortId, abi.encode(initialization));

        assertEq(factory.vaultOfAdmin(fakeAdmin), address(0));
    }

    function testTradingWalletCanOnlyEditItsOwnPercentageAndAdminCanOverride() external {
        _inviteAndActivate(vault, vaultAdmin, tradingWalletA, PLATFORM_A, 2_000);
        _inviteAndActivate(vault, vaultAdmin, tradingWalletB, PLATFORM_B, 3_000);

        NuvemTypes.TradingAccount memory beforeUpdate = vault.getTradingAccount(tradingWalletA);

        vm.prank(tradingWalletA);
        vault.setMySavingsBps(3_500);

        NuvemTypes.TradingAccount memory afterUpdate = vault.getTradingAccount(tradingWalletA);
        assertEq(afterUpdate.policy.savingsBps, 3_500);
        assertEq(afterUpdate.policy.minContributionWei, beforeUpdate.policy.minContributionWei);
        assertEq(afterUpdate.policy.maxPerSettlementWei, beforeUpdate.policy.maxPerSettlementWei);
        assertEq(afterUpdate.policy.maxRolling30dWei, beforeUpdate.policy.maxRolling30dWei);
        assertEq(afterUpdate.policy.tradingFloorWei, beforeUpdate.policy.tradingFloorWei);
        assertEq(afterUpdate.policy.gasReserveWei, beforeUpdate.policy.gasReserveWei);
        assertEq(afterUpdate.policyNonce, beforeUpdate.policyNonce + 1);

        vm.prank(tradingWalletA);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.setTradingAccountSavingsBps(tradingWalletB, 9_000);

        NuvemTypes.TradingAccountPolicy memory replacementPolicy = _tradingPolicy(8_000);
        vm.prank(tradingWalletA);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.setTradingAccountPolicy(tradingWalletA, replacementPolicy);

        vm.prank(tradingWalletA);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.setLocalPause(true);

        vm.prank(vaultAdmin);
        vault.setTradingAccountSavingsBps(tradingWalletA, 7_500);
        assertEq(vault.getTradingAccount(tradingWalletA).policy.savingsBps, 7_500);
    }

    function testPausedTradingWalletRemainsExclusiveAndAdminRetainsOverride() external {
        _inviteAndActivate(vault, vaultAdmin, tradingWalletA, PLATFORM_A, 2_000);
        PersonalVault secondVault = _createVault(secondVaultAdmin, keccak256("second-vault-paused-account"));

        vm.prank(vaultAdmin);
        vault.pauseTradingAccount(tradingWalletA);

        assertEq(uint8(vault.getTradingAccount(tradingWalletA).status), uint8(NuvemTypes.AccountStatus.PAUSED));
        assertEq(factory.activeVaultOf(tradingWalletA), address(vault));

        vm.prank(vaultAdmin);
        vault.setTradingAccountSavingsBps(tradingWalletA, 4_500);
        assertEq(vault.getTradingAccount(tradingWalletA).policy.savingsBps, 4_500);

        vm.prank(tradingWalletA);
        vm.expectRevert(abi.encodeWithSelector(PersonalVault.AccountNotActive.selector, tradingWalletA));
        vault.setMySavingsBps(5_000);

        vm.prank(secondVaultAdmin);
        secondVault.inviteTradingAccount(
            tradingWalletA, PLATFORM_B, _tradingPolicy(1_000), uint48(block.timestamp + 1 days)
        );

        vm.prank(tradingWalletA);
        vm.expectRevert(abi.encodeWithSelector(PersonalVault.AccountAlreadyLinked.selector, tradingWalletA));
        secondVault.acceptTradingAccount();
    }

    function testRevokeReleasesWalletForAnotherVault() external {
        _inviteAndActivate(vault, vaultAdmin, tradingWalletA, PLATFORM_A, 2_000);
        PersonalVault secondVault = _createVault(secondVaultAdmin, keccak256("second-vault-released-account"));

        vm.prank(secondVaultAdmin);
        secondVault.inviteTradingAccount(
            tradingWalletA, PLATFORM_B, _tradingPolicy(1_000), uint48(block.timestamp + 1 days)
        );

        vm.prank(vaultAdmin);
        vault.revokeTradingAccount(tradingWalletA);

        assertEq(factory.activeVaultOf(tradingWalletA), address(0));
        assertEq(uint8(vault.getTradingAccount(tradingWalletA).status), uint8(NuvemTypes.AccountStatus.REVOKED));

        vm.prank(tradingWalletA);
        secondVault.acceptTradingAccount();

        assertEq(factory.activeVaultOf(tradingWalletA), address(secondVault));
        assertEq(uint8(secondVault.getTradingAccount(tradingWalletA).status), uint8(NuvemTypes.AccountStatus.ACTIVE));
    }

    function testRollingBucketsAndLifetimeTotalsSurviveRevokeAndReAdd() external {
        _inviteAndActivate(vault, vaultAdmin, tradingWalletA, PLATFORM_A, 2_000);
        _acceptSettlement(vault, tradingWalletA, 2 ether, keccak256("session-1"));

        NuvemTypes.RollingCapStatus memory beforeRevoke = vault.accountRollingCapStatus(tradingWalletA);
        uint128 lifetimeBefore = vault.lifetimeContribution(tradingWalletA);
        uint64 settlementNonceBefore = vault.getTradingAccount(tradingWalletA).settlementNonce;

        assertEq(beforeRevoke.spent, 2 ether);
        assertEq(lifetimeBefore, 2 ether);
        assertEq(settlementNonceBefore, 1);

        vm.prank(vaultAdmin);
        vault.revokeTradingAccount(tradingWalletA);

        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(tradingWalletA, PLATFORM_B, _tradingPolicy(3_000), uint48(block.timestamp + 1 days));
        vm.prank(tradingWalletA);
        vault.acceptTradingAccount();

        NuvemTypes.RollingCapStatus memory afterReAdd = vault.accountRollingCapStatus(tradingWalletA);
        NuvemTypes.TradingAccount memory reAdded = vault.getTradingAccount(tradingWalletA);
        assertEq(afterReAdd.spent, 2 ether);
        assertEq(vault.lifetimeContribution(tradingWalletA), lifetimeBefore);
        assertEq(reAdded.settlementNonce, settlementNonceBefore);
        assertGt(reAdded.bindingEpoch, 1);
    }

    function testRollingBucketCountsThroughDayThirtyAndReleasesAtDayThirtyOneBoundary() external {
        vm.warp(100 days + 12 hours);
        _inviteAndActivate(vault, vaultAdmin, tradingWalletA, PLATFORM_A, 2_000);
        _acceptSettlement(vault, tradingWalletA, 2 ether, keccak256("day-100-session"));

        uint256 releaseAt = 131 days;
        NuvemTypes.RollingCapStatus memory initial = vault.accountRollingCapStatus(tradingWalletA);
        assertEq(initial.spent, 2 ether);
        assertEq(initial.remaining, 98 ether);
        assertEq(initial.nextReleaseAt, releaseAt);
        assertEq(initial.nextReleaseAmount, 2 ether);

        vm.warp(releaseAt - 1);
        NuvemTypes.RollingCapStatus memory beforeRelease = vault.accountRollingCapStatus(tradingWalletA);
        assertEq(beforeRelease.spent, 2 ether);
        assertEq(beforeRelease.remaining, 98 ether);
        assertEq(beforeRelease.nextReleaseAt, releaseAt);
        assertEq(vault.aggregateRollingCapStatus().spent, 2 ether);

        vm.warp(releaseAt);
        NuvemTypes.RollingCapStatus memory released = vault.accountRollingCapStatus(tradingWalletA);
        assertEq(released.spent, 0);
        assertEq(released.remaining, 100 ether);
        assertEq(released.nextReleaseAt, 0);
        assertEq(released.nextReleaseAmount, 0);
        assertEq(vault.aggregateRollingCapStatus().spent, 0);
        assertEq(vault.lifetimeContribution(tradingWalletA), 2 ether);
    }

    function testWithdrawalsAreAdminOnlyAndRemainAvailableWhilePaused() external {
        _fundVaultWithWeth(vault, 2 ether);
        vm.deal(address(vault), 1 ether);
        address recipient = makeAddr("withdrawalRecipient");

        vm.prank(vaultAdmin);
        vault.setLocalPause(true);

        vm.prank(tradingWalletA);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.withdrawToken(address(weth), recipient, 1 ether);

        vm.prank(stranger);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.withdrawNative(payable(recipient), 0.5 ether);

        vm.prank(vaultAdmin);
        vault.withdrawToken(address(weth), recipient, 1 ether);
        vm.prank(vaultAdmin);
        vault.withdrawNative(payable(recipient), 0.5 ether);

        assertEq(weth.balanceOf(recipient), 1 ether);
        assertEq(recipient.balance, 0.5 ether);
        assertEq(weth.balanceOf(address(vault)), 1 ether);
        assertEq(address(vault).balance, 0.5 ether);
    }

    function testWithdrawalsAlwaysChargeZeroProtocolFee() external {
        _fundVaultWithWeth(vault, 2 ether);
        vm.deal(address(vault), 1 ether);
        address recipient = makeAddr("zeroFeeWithdrawalRecipient");

        vm.prank(governance);
        feeController.setFeeBps(10_000);

        vm.prank(vaultAdmin);
        vault.withdrawToken(address(weth), recipient, 1.25 ether);
        vm.prank(vaultAdmin);
        vault.withdrawNative(payable(recipient), 0.4 ether);

        assertEq(weth.balanceOf(recipient), 1.25 ether);
        assertEq(recipient.balance, 0.4 ether);
        assertEq(weth.balanceOf(address(vault)), 0.75 ether);
        assertEq(address(vault).balance, 0.6 ether);
        assertEq(weth.balanceOf(address(feeCollector)), 0);
        assertEq(address(feeCollector).balance, 0);
    }

    function testFuzzWithdrawalsNeverChargeProtocolFeeAcrossAssetsAndPauses(
        uint16 feeBpsSeed,
        uint96 wethAmountSeed,
        uint96 targetAmountSeed,
        uint96 nativeAmountSeed,
        uint8 pauseModeSeed
    ) external {
        uint16 configuredFeeBps = uint16(bound(uint256(feeBpsSeed), 0, 10_000));
        uint256 wethAmount = bound(uint256(wethAmountSeed), 1, 5 ether);
        uint256 targetAmount = bound(uint256(targetAmountSeed), 1, 5_000 ether);
        uint256 nativeAmount = bound(uint256(nativeAmountSeed), 1, 5 ether);
        uint8 pauseMode = pauseModeSeed % 4;
        address recipient = makeAddr("fuzzZeroFeeWithdrawalRecipient");

        if (configuredFeeBps != 0) {
            vm.prank(governance);
            feeController.setFeeBps(configuredFeeBps);
        }

        _fundVaultWithWeth(vault, wethAmount);
        target.mint(address(vault), targetAmount);
        vm.deal(address(vault), nativeAmount);

        if ((pauseMode & 1) != 0) {
            vm.prank(vaultAdmin);
            vault.setLocalPause(true);
        }
        if ((pauseMode & 2) != 0) {
            vm.prank(guardian);
            pauseController.pause();
        }

        uint64 feeEpochBefore = feeController.feeEpoch();
        uint256 vaultWethBefore = weth.balanceOf(address(vault));
        uint256 vaultTargetBefore = target.balanceOf(address(vault));
        uint256 vaultNativeBefore = address(vault).balance;
        uint256 recipientWethBefore = weth.balanceOf(recipient);
        uint256 recipientTargetBefore = target.balanceOf(recipient);
        uint256 recipientNativeBefore = recipient.balance;
        uint256 collectorWethBefore = weth.balanceOf(address(feeCollector));
        uint256 collectorTargetBefore = target.balanceOf(address(feeCollector));
        uint256 collectorNativeBefore = address(feeCollector).balance;

        vm.startPrank(vaultAdmin);
        vault.withdrawToken(address(weth), recipient, wethAmount);
        vault.withdrawToken(address(target), recipient, targetAmount);
        vault.withdrawNative(payable(recipient), nativeAmount);
        vm.stopPrank();

        assertEq(vaultWethBefore - weth.balanceOf(address(vault)), wethAmount);
        assertEq(vaultTargetBefore - target.balanceOf(address(vault)), targetAmount);
        assertEq(vaultNativeBefore - address(vault).balance, nativeAmount);
        assertEq(weth.balanceOf(recipient) - recipientWethBefore, wethAmount);
        assertEq(target.balanceOf(recipient) - recipientTargetBefore, targetAmount);
        assertEq(recipient.balance - recipientNativeBefore, nativeAmount);
        assertEq(weth.balanceOf(address(feeCollector)), collectorWethBefore);
        assertEq(target.balanceOf(address(feeCollector)), collectorTargetBefore);
        assertEq(address(feeCollector).balance, collectorNativeBefore);
        assertEq(feeController.feeBps(), configuredFeeBps);
        assertEq(feeController.feeEpoch(), feeEpochBefore);
    }

    function testDirectNativeDepositsCannotBypassSettlementAttribution() external {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool success,) = address(vault).call{value: 1 ether}("");
        assertFalse(success);
        assertEq(address(vault).balance, 0);
    }

    function testVaultRejectsFutureSettlementFromAuthorizedExecutor() external {
        _inviteAndActivate(vault, vaultAdmin, tradingWalletA, PLATFORM_A, 2_000);
        NuvemTypes.TradingAccount memory account = vault.getTradingAccount(tradingWalletA);
        NuvemTypes.SettlementRecord memory record = NuvemTypes.SettlementRecord({
            account: tradingWalletA,
            bindingEpoch: account.bindingEpoch,
            policyNonce: account.policyNonce,
            settlementNonce: account.settlementNonce,
            policyHash: vault.policyHash(tradingWalletA),
            sessionId: keccak256("future-session"),
            ledgerRoot: keccak256("future-ledger"),
            startBlock: uint64(block.number),
            endBlock: uint64(block.number + 1),
            startBlockL2: uint64(block.number) * 1_000,
            endBlockL2: uint64(block.number) * 1_000 + 500,
            contribution: 1 ether
        });

        vm.deal(settlementExecutor, 1 ether);
        vm.prank(settlementExecutor);
        vm.expectRevert(PersonalVault.InvalidSettlement.selector);
        vault.acceptSettlement{value: 1 ether}(record);

        assertEq(vault.getTradingAccount(tradingWalletA).settlementNonce, 0);
        assertEq(vault.accountRollingCapStatus(tradingWalletA).spent, 0);
        assertEq(weth.balanceOf(address(vault)), 0);
    }

    function testVaultAdminTransferIsTwoStepAndRevokesOldAdmin() external {
        address nextAdmin = makeAddr("nextVaultAdmin");

        vm.prank(vaultAdmin);
        vault.proposeVaultAdmin(nextAdmin);
        assertEq(vault.pendingVaultAdmin(), nextAdmin);
        assertEq(vault.vaultAdmin(), vaultAdmin);

        vm.prank(stranger);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.acceptVaultAdmin();

        vm.prank(nextAdmin);
        vault.acceptVaultAdmin();

        assertEq(vault.vaultAdmin(), nextAdmin);
        assertEq(factory.vaultOfAdmin(vaultAdmin), address(0));
        assertEq(factory.vaultOfAdmin(nextAdmin), address(vault));
        assertEq(vault.pendingVaultAdmin(), address(0));
        assertEq(vault.adminEpoch(), 2);
        assertTrue(vault.settlementPaused());

        vm.prank(vaultAdmin);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.setLocalPause(false);

        vm.prank(nextAdmin);
        vault.setLocalPause(false);
        assertFalse(vault.settlementPaused());
    }

    function testVaultAdminTransferRejectsAnAdminThatAlreadyOwnsAVault() external {
        _createVault(secondVaultAdmin, keccak256("second-admin-vault"));

        vm.prank(vaultAdmin);
        vm.expectRevert(PersonalVault.InvalidState.selector);
        vault.proposeVaultAdmin(secondVaultAdmin);

        assertEq(vault.vaultAdmin(), vaultAdmin);
        assertEq(factory.vaultOfAdmin(vaultAdmin), address(vault));
    }

    function testAdminTransferInvalidatesPendingTradingWalletInvitations() external {
        address nextAdmin = makeAddr("invitationNextAdmin");
        address pendingTrader = makeAddr("pendingTrader");

        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(pendingTrader, PLATFORM_A, _tradingPolicy(2_000), uint48(block.timestamp + 1 days));
        vm.prank(vaultAdmin);
        vault.proposeVaultAdmin(nextAdmin);
        vm.prank(nextAdmin);
        vault.acceptVaultAdmin();

        vm.prank(pendingTrader);
        vm.expectRevert(PersonalVault.InvalidState.selector);
        vault.acceptTradingAccount();

        vm.prank(nextAdmin);
        vault.cancelTradingAccountInvitation(pendingTrader);
        vm.prank(nextAdmin);
        vault.inviteTradingAccount(pendingTrader, PLATFORM_A, _tradingPolicy(2_000), uint48(block.timestamp + 1 days));
        vm.prank(pendingTrader);
        vault.acceptTradingAccount();

        assertEq(factory.activeVaultOf(pendingTrader), address(vault));
    }

    function _createVault(address admin, bytes32 salt) private returns (PersonalVault createdVault) {
        NuvemTypes.VaultInitialization memory initialization = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(pauseController),
            attesterRegistry: address(attesterRegistry),
            settlementExecutor: settlementExecutor,
            policy: _vaultPolicy()
        });

        vm.prank(admin);
        (, address vaultAddress) = factory.createVault(salt, cohortId, abi.encode(initialization));
        createdVault = PersonalVault(payable(vaultAddress));
    }

    function _inviteAndActivate(
        PersonalVault targetVault,
        address admin,
        address tradingWallet,
        bytes32 platformId,
        uint16 savingsBps
    ) private {
        vm.prank(admin);
        targetVault.inviteTradingAccount(
            tradingWallet, platformId, _tradingPolicy(savingsBps), uint48(block.timestamp + 1 days)
        );

        vm.prank(tradingWallet);
        targetVault.acceptTradingAccount();
    }

    function _acceptSettlement(PersonalVault targetVault, address account, uint128 contribution, bytes32 sessionId)
        private
    {
        NuvemTypes.TradingAccount memory tradingAccount = targetVault.getTradingAccount(account);
        NuvemTypes.SettlementRecord memory record = NuvemTypes.SettlementRecord({
            account: account,
            bindingEpoch: tradingAccount.bindingEpoch,
            policyNonce: tradingAccount.policyNonce,
            settlementNonce: tradingAccount.settlementNonce,
            policyHash: targetVault.policyHash(account),
            sessionId: sessionId,
            ledgerRoot: keccak256(abi.encode(sessionId)),
            startBlock: uint64(block.number),
            endBlock: uint64(block.number),
            startBlockL2: uint64(block.number) * 1_000,
            endBlockL2: uint64(block.number) * 1_000 + 500,
            contribution: contribution
        });

        vm.roll(block.number + 1);
        vm.deal(settlementExecutor, contribution);
        vm.prank(settlementExecutor);
        targetVault.acceptSettlement{value: contribution}(record);
    }

    function testPendingVaultAdminOfferCanBeCancelled() external {
        address candidate = makeAddr("adminCandidate");

        vm.prank(vaultAdmin);
        vault.proposeVaultAdmin(candidate);
        assertEq(vault.pendingVaultAdmin(), candidate);

        // Without an explicit cancel the only retraction is to overwrite the
        // offer with another live one, which just moves the exercisable right.
        vm.prank(vaultAdmin);
        vault.proposeVaultAdmin(address(0));
        assertEq(vault.pendingVaultAdmin(), address(0), "offer must be retractable");

        vm.prank(candidate);
        vm.expectRevert(PersonalVault.Unauthorized.selector);
        vault.acceptVaultAdmin();

        assertEq(vault.vaultAdmin(), vaultAdmin, "admin unchanged after cancellation");
    }

    function _fundVaultWithWeth(PersonalVault targetVault, uint256 amount) private {
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        assertTrue(weth.transfer(address(targetVault), amount));
    }

    function _tradingPolicy(uint16 savingsBps) private pure returns (NuvemTypes.TradingAccountPolicy memory) {
        return NuvemTypes.TradingAccountPolicy({
            savingsBps: savingsBps,
            minContributionWei: 0.01 ether,
            maxPerSettlementWei: 10 ether,
            maxRolling30dWei: 100 ether,
            tradingFloorWei: 0.25 ether,
            gasReserveWei: 0.05 ether
        });
    }

    function _vaultPolicy() private pure returns (NuvemTypes.VaultPolicy memory) {
        return NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: 500 ether});
    }
}
