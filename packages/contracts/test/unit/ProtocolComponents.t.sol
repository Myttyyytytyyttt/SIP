// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {GuardianOwnable} from "../../src/governance/GuardianOwnable.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../../src/registry/AttesterRegistry.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";
import {FeeController} from "../../src/fees/FeeController.sol";
import {FeeCollector} from "../../src/fees/FeeCollector.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {MockTargetToken} from "../../src/mocks/MockTargetToken.sol";
import {MockInvestmentAdapter} from "../../src/mocks/MockInvestmentAdapter.sol";

contract ProtocolComponentsTest is Test {
    address internal governance;
    address internal guardian;
    address internal replacementGuardian;
    address internal stranger;
    address internal initialAttester;
    address internal replacementAttester;
    address internal treasury;

    ProtocolPauseController internal pauseController;
    AttesterRegistry internal attesterRegistry;
    AdapterRegistry internal adapterRegistry;
    FeeCollector internal feeCollector;
    FeeController internal feeController;
    MockWETH internal weth;
    MockTargetToken internal target;
    MockInvestmentAdapter internal adapter;

    function setUp() external {
        governance = makeAddr("governance");
        guardian = makeAddr("guardian");
        replacementGuardian = makeAddr("replacementGuardian");
        stranger = makeAddr("stranger");
        initialAttester = makeAddr("initialAttester");
        replacementAttester = makeAddr("replacementAttester");
        treasury = makeAddr("treasury");

        pauseController = new ProtocolPauseController(governance, guardian);
        attesterRegistry = new AttesterRegistry(governance, guardian, initialAttester);
        adapterRegistry = new AdapterRegistry(governance, guardian);
        feeCollector = new FeeCollector(governance, treasury);
        feeController = new FeeController(governance, address(feeCollector), 0);

        weth = new MockWETH();
        target = new MockTargetToken("Mock Target", "MTARGET");
        adapter = new MockInvestmentAdapter(address(weth), address(target), 1e18);
    }

    function testGovernanceCannotRenounceAnyProtocolOwnership() external {
        // Renouncing is a one-step, irreversible path that would strand each of
        // these surfaces: every guardian action is restrictive and only the
        // owner can reverse it, so an ownerless registry keeps an emergency
        // pause or attester disable in force permanently.
        vm.startPrank(governance);
        vm.expectRevert(GuardianOwnable.RenounceDisabled.selector);
        pauseController.renounceOwnership();
        vm.expectRevert(GuardianOwnable.RenounceDisabled.selector);
        attesterRegistry.renounceOwnership();
        vm.expectRevert(GuardianOwnable.RenounceDisabled.selector);
        adapterRegistry.renounceOwnership();
        vm.expectRevert(FeeController.RenounceDisabled.selector);
        feeController.renounceOwnership();
        vm.expectRevert(FeeCollector.RenounceDisabled.selector);
        feeCollector.renounceOwnership();
        vm.stopPrank();

        assertEq(pauseController.owner(), governance);
        assertEq(attesterRegistry.owner(), governance);
        assertEq(adapterRegistry.owner(), governance);
        assertEq(feeController.owner(), governance);
        assertEq(feeCollector.owner(), governance);
    }

    function testGuardianCanPauseButOnlyGovernanceCanUnpause() external {
        assertFalse(pauseController.paused());
        assertEq(pauseController.pauseEpoch(), 0);

        vm.prank(guardian);
        pauseController.pause();

        assertTrue(pauseController.paused());
        assertEq(pauseController.pauseEpoch(), 1);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        pauseController.unpause();

        vm.prank(governance);
        pauseController.unpause();

        assertFalse(pauseController.paused());
        assertEq(pauseController.pauseEpoch(), 2);
    }

    function testGuardianRotationImmediatelyRevokesOldGuardian() external {
        vm.prank(governance);
        pauseController.setGuardian(replacementGuardian);

        assertEq(pauseController.guardian(), replacementGuardian);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GuardianOwnable.NotOwnerOrGuardian.selector, guardian));
        pauseController.pause();

        vm.prank(replacementGuardian);
        pauseController.pause();
        assertTrue(pauseController.paused());
    }

    function testStrangerCannotUseGuardianPowers() external {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(GuardianOwnable.NotOwnerOrGuardian.selector, stranger));
        pauseController.pause();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(GuardianOwnable.NotOwnerOrGuardian.selector, stranger));
        attesterRegistry.disableAttester();
    }

    function testAttesterDisableAndRotationsAlwaysAdvanceEpoch() external {
        assertEq(attesterRegistry.attester(), initialAttester);
        assertEq(attesterRegistry.attesterEpoch(), 1);
        assertTrue(attesterRegistry.isCurrentAttester(initialAttester, 1));

        vm.prank(guardian);
        attesterRegistry.disableAttester();

        assertEq(attesterRegistry.attester(), address(0));
        assertEq(attesterRegistry.attesterEpoch(), 2);
        assertFalse(attesterRegistry.isCurrentAttester(initialAttester, 1));

        vm.prank(governance);
        attesterRegistry.rotateAttester(replacementAttester);

        assertEq(attesterRegistry.attester(), replacementAttester);
        assertEq(attesterRegistry.attesterEpoch(), 3);
        assertTrue(attesterRegistry.isCurrentAttester(replacementAttester, 3));

        vm.prank(governance);
        attesterRegistry.rotateAttester(initialAttester);

        assertEq(attesterRegistry.attesterEpoch(), 4);
        assertTrue(attesterRegistry.isCurrentAttester(initialAttester, 4));
        assertFalse(attesterRegistry.isCurrentAttester(initialAttester, 1));
    }

    function testGuardianCannotRotateAttester() external {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        attesterRegistry.rotateAttester(replacementAttester);
    }

    function testAdapterIdIsImmutableAcrossDeactivationAndReactivation() external {
        bytes32 adapterId = keccak256("mock-adapter-v1");
        MockInvestmentAdapter otherAdapter = new MockInvestmentAdapter(address(weth), address(target), 2e18);

        vm.prank(governance);
        adapterRegistry.registerAdapter(adapterId, address(adapter));

        assertEq(adapterRegistry.adapterCount(), 1);
        assertEq(adapterRegistry.adapterIdAt(0), adapterId);
        assertEq(adapterRegistry.getAdapter(adapterId), address(adapter));
        assertEq(adapterRegistry.adapterRuntimeCodeHash(adapterId), address(adapter).codehash);
        assertTrue(adapterRegistry.isAdapterActive(adapterId));
        assertEq(adapterRegistry.adapterStatusEpoch(adapterId), 1);

        vm.prank(guardian);
        adapterRegistry.deactivateAdapter(adapterId);

        assertFalse(adapterRegistry.isAdapterActive(adapterId));
        assertEq(adapterRegistry.adapterStatusEpoch(adapterId), 2);

        vm.prank(governance);
        vm.expectRevert(abi.encodeWithSelector(AdapterRegistry.AdapterAlreadyRegistered.selector, adapterId));
        adapterRegistry.registerAdapter(adapterId, address(otherAdapter));

        vm.prank(governance);
        adapterRegistry.reactivateAdapter(adapterId);

        assertTrue(adapterRegistry.isAdapterActive(adapterId));
        assertEq(adapterRegistry.getAdapter(adapterId), address(adapter));
        assertEq(adapterRegistry.adapterStatusEpoch(adapterId), 3);
    }

    function testAdapterFailsClosedIfItsRuntimeCodeChanges() external {
        bytes32 adapterId = keccak256("mock-adapter-v1");
        bytes32 registeredCodeHash = address(adapter).codehash;

        vm.prank(governance);
        adapterRegistry.registerAdapter(adapterId, address(adapter));

        vm.etch(address(adapter), hex"00");

        assertEq(adapterRegistry.adapterRuntimeCodeHash(adapterId), registeredCodeHash);
        assertFalse(adapterRegistry.isAdapterActive(adapterId));

        vm.prank(guardian);
        adapterRegistry.deactivateAdapter(adapterId);

        vm.prank(governance);
        vm.expectRevert(
            abi.encodeWithSelector(
                AdapterRegistry.AdapterCodeChanged.selector, adapterId, registeredCodeHash, address(adapter).codehash
            )
        );
        adapterRegistry.reactivateAdapter(adapterId);
    }

    function testOnlyGovernanceCanReactivateAdapter() external {
        bytes32 adapterId = keccak256("mock-adapter-v1");

        vm.prank(governance);
        adapterRegistry.registerAdapter(adapterId, address(adapter));

        vm.prank(guardian);
        adapterRegistry.deactivateAdapter(adapterId);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        adapterRegistry.reactivateAdapter(adapterId);

        assertFalse(adapterRegistry.isAdapterActive(adapterId));
    }

    function testFeeSupportsImmediateZeroAndOneHundredPercent() external {
        uint256 grossAmount = 3.7 ether;

        (uint256 zeroFee, uint256 zeroFeeNet) = feeController.previewFee(grossAmount);
        assertEq(zeroFee, 0);
        assertEq(zeroFeeNet, grossAmount);
        assertEq(feeController.feeEpoch(), 1);

        vm.prank(governance);
        feeController.setFeeBps(10_000);

        (uint256 fullFee, uint256 fullFeeNet) = feeController.previewFee(grossAmount);
        assertEq(fullFee, grossAmount);
        assertEq(fullFeeNet, 0);
        assertEq(feeController.feeBps(), 10_000);
        assertEq(feeController.feeEpoch(), 2);
    }

    function testFeeConfigurationIsGovernanceOnlyAndEveryChangeAdvancesEpoch() external {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        feeController.setFeeBps(100);

        vm.prank(governance);
        vm.expectRevert(abi.encodeWithSelector(FeeController.FeeBpsTooHigh.selector, 10_001));
        feeController.setFeeBps(10_001);

        vm.prank(governance);
        feeController.setFeeBps(100);
        assertEq(feeController.feeEpoch(), 2);

        address replacementCollector = makeAddr("replacementCollector");
        vm.prank(governance);
        feeController.setFeeCollector(replacementCollector);

        assertEq(feeController.feeCollector(), replacementCollector);
        assertEq(feeController.feeEpoch(), 3);
    }

    function testFeeCollectorSendsWethAndERC20OnlyToTreasury() external {
        vm.deal(address(this), 2 ether);
        weth.deposit{value: 1 ether}();
        assertTrue(weth.transfer(address(feeCollector), 1 ether));
        target.mint(address(feeCollector), 500e18);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FeeCollector.NotTreasuryOrOwner.selector, stranger));
        feeCollector.withdrawERC20(address(weth), 1 ether);

        vm.prank(governance);
        feeCollector.withdrawERC20(address(weth), 1 ether);
        assertEq(weth.balanceOf(treasury), 1 ether);

        vm.prank(treasury);
        uint256 withdrawn = feeCollector.withdrawAllERC20(address(target));
        assertEq(withdrawn, 500e18);
        assertEq(target.balanceOf(treasury), 500e18);
        assertEq(target.balanceOf(address(feeCollector)), 0);
    }

    function testFuzzFeePreviewConservesGrossAmount(uint96 grossAmount, uint16 feeBps) external {
        feeBps = uint16(bound(feeBps, 0, 10_000));

        if (feeBps != 0) {
            vm.prank(governance);
            feeController.setFeeBps(feeBps);
        }

        (uint256 feeAmount, uint256 netAmount) = feeController.previewFee(grossAmount);
        assertEq(feeAmount + netAmount, grossAmount);
        assertLe(feeAmount, grossAmount);
    }
}
