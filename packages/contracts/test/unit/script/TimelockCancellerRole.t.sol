// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AdapterRegistry} from "../../../src/registry/AdapterRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {NuvemDeploymentBase, TimelockBootstrap} from "../../../script/DeployNuvem.s.sol";
import {MockWETH} from "../../../src/mocks/MockWETH.sol";
import {PersonalVault} from "../../../src/vault/PersonalVault.sol";

contract SafeShape {
    function getThreshold() external pure returns (uint256) {
        return 3;
    }

    function getOwners() external pure returns (address[] memory owners) {
        owners = new address[](5);
        for (uint256 i = 0; i < 5; ++i) {
            owners[i] = address(uint160(0x2001 + i));
        }
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        bool success;
        (success, result) = target.call(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }
}

contract CancellerHarness is NuvemDeploymentBase {
    function deployCore(DeploymentConfig calldata config) external returns (Deployment memory) {
        return _deployCore(config);
    }
}

/// @title The guardian's power to CANCEL a queued operation.
/// @notice The beacon stays upgradeable, so one governance action can still
///         replace the code that holds every user's savings. OpenZeppelin grants
///         CANCELLER_ROLE only to proposers, which on a single-proposer timelock
///         means the only address able to cancel is the one that scheduled. A
///         stolen multisig key would then face a seven-day countdown nobody could
///         interrupt. These tests pin the fix: the guardian can cancel, and can
///         do nothing else.
contract TimelockCancellerRoleTest is Test {
    CancellerHarness private harness;
    SafeShape private multisig;
    MockWETH private weth;
    NuvemDeploymentBase.Deployment private deployment;

    address private guardian;
    address private treasury;
    address private attester;
    address private outsider;

    bytes32 private constant PREDECESSOR = bytes32(0);
    bytes32 private constant SALT = keccak256("MALICIOUS_BEACON_UPGRADE");

    function setUp() external {
        harness = new CancellerHarness();
        multisig = new SafeShape();
        weth = new MockWETH();
        guardian = makeAddr("guardian");
        treasury = makeAddr("treasury");
        attester = makeAddr("attester");
        outsider = makeAddr("outsider");

        deployment = harness.deployCore(
            NuvemDeploymentBase.DeploymentConfig({
                corporateMultisig: address(multisig),
                guardian: guardian,
                treasury: treasury,
                attester: attester,
                weth: address(weth),
                initialFeeBps: 0,
                canaryApproved: false,
                governanceDelay: harness.GOVERNANCE_DELAY(),
                disposableTestDeployment: false
            })
        );
    }

    // -----------------------------------------------------------------------
    // The role set itself.
    // -----------------------------------------------------------------------

    function testGuardianHoldsTheCancellerRole() external view {
        assertTrue(
            deployment.timelock.hasRole(deployment.timelock.CANCELLER_ROLE(), guardian),
            "guardian cannot cancel, so the delay is a countdown rather than a window"
        );
    }

    function testGuardianHoldsNOTHINGElse() external view {
        assertFalse(
            deployment.timelock.hasRole(deployment.timelock.PROPOSER_ROLE(), guardian), "guardian must not propose"
        );
        assertFalse(
            deployment.timelock.hasRole(deployment.timelock.DEFAULT_ADMIN_ROLE(), guardian),
            "guardian must not administer roles"
        );
    }

    /// @dev The bootstrap takes DEFAULT_ADMIN_ROLE only long enough to make the
    ///      grant. If it kept it, that contract would be a second, undocumented
    ///      governance surface for the life of the deployment.
    function testTheBootstrapKeepsNoAdminRightsAfterwards() external view {
        bytes32 adminRole = deployment.timelock.DEFAULT_ADMIN_ROLE();
        assertTrue(deployment.timelock.hasRole(adminRole, address(deployment.timelock)), "timelock self-administration");
        assertFalse(deployment.timelock.hasRole(adminRole, address(harness)), "harness must hold no admin role");
        assertFalse(deployment.timelock.hasRole(adminRole, address(multisig)), "multisig must hold no admin role");
    }

    /// @dev The bootstrap itself, tested directly rather than through the address
    ///      it happens to have inside _deployCore: it takes DEFAULT_ADMIN_ROLE to
    ///      make one grant and gives it up in the same constructor.
    function testTheBootstrapRenouncesItsOwnAdminRole() external {
        TimelockBootstrap bootstrap = new TimelockBootstrap(7 days, address(multisig), guardian);
        TimelockController built = bootstrap.timelock();

        assertTrue(built.hasRole(built.CANCELLER_ROLE(), guardian), "the grant it existed to make");
        assertFalse(
            built.hasRole(built.DEFAULT_ADMIN_ROLE(), address(bootstrap)),
            "the bootstrap must not remain a governance surface"
        );
        assertTrue(built.hasRole(built.DEFAULT_ADMIN_ROLE(), address(built)), "self-administration survives");
    }

    function testMultisigStillProposesAndCancels() external view {
        assertTrue(deployment.timelock.hasRole(deployment.timelock.PROPOSER_ROLE(), address(multisig)));
        assertTrue(deployment.timelock.hasRole(deployment.timelock.CANCELLER_ROLE(), address(multisig)));
    }

    function testExecutionStaysOpenToAnyone() external view {
        assertTrue(
            deployment.timelock.hasRole(deployment.timelock.EXECUTOR_ROLE(), address(0)),
            "open execution is the documented design"
        );
    }

    // -----------------------------------------------------------------------
    // The scenario the role exists for.
    // -----------------------------------------------------------------------

    /// @dev THE TEST THAT MATTERS. A stolen multisig key schedules a beacon
    ///      upgrade to an implementation it controls; the guardian cancels inside
    ///      the delay; the upgrade can never execute, and the beacon still points
    ///      at the original implementation.
    function testGuardianCancelsAMaliciousBeaconUpgradeInsideTheDelay() external {
        address beacon = deployment.beacon;
        address originalImplementation = UpgradeableBeacon(beacon).implementation();
        address maliciousImplementation = address(new PersonalVault(address(new AdapterRegistry(address(this), address(this)))));

        bytes memory payload = abi.encodeCall(UpgradeableBeacon.upgradeTo, (maliciousImplementation));
        _schedule(beacon, payload);
        bytes32 id = deployment.timelock.hashOperation(beacon, 0, payload, PREDECESSOR, SALT);
        assertTrue(deployment.timelock.isOperationPending(id), "the attack is queued");

        vm.prank(guardian);
        deployment.timelock.cancel(id);

        assertFalse(deployment.timelock.isOperation(id), "the operation is gone");

        // And it cannot be executed even after the full delay has run.
        vm.warp(block.timestamp + GOVERNANCE_DELAY_PLUS_ONE);
        vm.expectRevert();
        deployment.timelock.execute(beacon, 0, payload, PREDECESSOR, SALT);

        assertEq(
            UpgradeableBeacon(beacon).implementation(),
            originalImplementation,
            "the vault implementation must be untouched"
        );
    }

    uint256 private constant GOVERNANCE_DELAY_PLUS_ONE = 7 days + 1;

    /// @dev Without a cancel the same operation goes through, which is what makes
    ///      the test above meaningful rather than a tautology.
    function testTheSameUpgradeSUCCEEDSWhenNobodyCancels() external {
        address beacon = deployment.beacon;
        address maliciousImplementation = address(new PersonalVault(address(new AdapterRegistry(address(this), address(this)))));
        bytes memory payload = abi.encodeCall(UpgradeableBeacon.upgradeTo, (maliciousImplementation));

        _schedule(beacon, payload);
        vm.warp(block.timestamp + GOVERNANCE_DELAY_PLUS_ONE);
        deployment.timelock.execute(beacon, 0, payload, PREDECESSOR, SALT);

        assertEq(
            UpgradeableBeacon(beacon).implementation(),
            maliciousImplementation,
            "the beacon is upgradeable by design; the guardian is the only thing standing in the way"
        );
    }

    function testAnOutsiderCannotCancel() external {
        bytes memory payload = abi.encodeCall(UpgradeableBeacon.upgradeTo, (address(new PersonalVault(address(new AdapterRegistry(address(this), address(this)))))));
        _schedule(deployment.beacon, payload);
        bytes32 id = deployment.timelock.hashOperation(deployment.beacon, 0, payload, PREDECESSOR, SALT);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, deployment.timelock.CANCELLER_ROLE()
            )
        );
        vm.prank(outsider);
        deployment.timelock.cancel(id);
    }

    /// @dev Restrictive-only, asserted rather than assumed: the guardian holding
    ///      a cancel must not have become a way to QUEUE anything.
    function testGuardianCannotSchedule() external {
        bytes memory payload = abi.encodeCall(UpgradeableBeacon.upgradeTo, (address(new PersonalVault(address(new AdapterRegistry(address(this), address(this)))))));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, deployment.timelock.PROPOSER_ROLE()
            )
        );
        vm.prank(guardian);
        deployment.timelock.schedule(deployment.beacon, 0, payload, PREDECESSOR, SALT, 7 days);
    }

    /// @dev A cancelled operation is not merely delayed. Re-scheduling it starts a
    ///      fresh delay, so the guardian buys another full window every time.
    function testARescheduleAfterACancelStartsTheDelayAgain() external {
        bytes memory payload = abi.encodeCall(UpgradeableBeacon.upgradeTo, (address(new PersonalVault(address(new AdapterRegistry(address(this), address(this)))))));
        _schedule(deployment.beacon, payload);
        bytes32 id = deployment.timelock.hashOperation(deployment.beacon, 0, payload, PREDECESSOR, SALT);

        vm.warp(block.timestamp + 6 days);
        vm.prank(guardian);
        deployment.timelock.cancel(id);

        _schedule(deployment.beacon, payload);
        vm.warp(block.timestamp + 1 days);
        assertFalse(deployment.timelock.isOperationReady(id), "the six days already served must not carry over");
    }

    function _schedule(address target, bytes memory payload) private {
        multisig.execute(
            address(deployment.timelock),
            abi.encodeCall(TimelockController.schedule, (target, 0, payload, PREDECESSOR, SALT, 7 days))
        );
    }
}
