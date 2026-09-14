// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {NuvemDeploymentBase} from "../../../script/DeployNuvem.s.sol";
import {MockWETH} from "../../../src/mocks/MockWETH.sol";

/// @dev A 3-of-5 Safe shape. The real Safe at 0x5364D009… answers these two calls
///      and nothing else is authenticated, which is itself in the threat model.
contract SafeShape {
    function getThreshold() external pure returns (uint256) {
        return 3;
    }

    function getOwners() external pure returns (address[] memory owners) {
        owners = new address[](5);
        for (uint256 i = 0; i < 5; ++i) owners[i] = address(uint160(i + 1));
    }
}

contract CeremonyHarness is NuvemDeploymentBase {
    function deployCore(DeploymentConfig calldata config) external returns (Deployment memory) {
        return _deployCore(config);
    }
}

/// @title The factory ownership handover, end to end.
/// @notice THIS IS THE STEP THAT FROZE THE PREVIOUS DEPLOYMENT, and until this
///         file existed it had no test anywhere.
///
/// @dev Read the live canary factory 0xDf411fdCc7C31e4F6bCa6F6BCaB40FE812Ab4A46
///      on chain 4663 today:
///
///        owner()        0x571ffb5e…  <- its own VaultFactoryBootstrap
///        pendingOwner() 0x48d3f86e…  <- the timelock, which never accepted
///
///      `VaultFactoryBootstrap` holds three immutable getters and no
///      administrative function of any kind, so that factory is owned by
///      something incapable of acting, waiting on a handover nobody completed.
///      No cohort can ever be registered on it and no beacon upgraded. The
///      product still runs — `createVault` is permissionless — but the
///      deployment can never be changed again.
///
///      `acceptOwnership` appeared in `script/DeployNuvem.s.sol` and
///      `script/DeployLocal.s.sol` and in no test. Worse, the one place it was
///      exercised used a DIFFERENT SHAPE: DeployLocal schedules a BATCH under the
///      salt keccak256("NUVEM_LOCAL_GOVERNANCE_BOOTSTRAP_V1", factory), while the
///      mainnet script prints the parameters for a SINGLE operation under
///      keccak256(FACTORY_OWNERSHIP_OPERATION_VERSION, factory). An operator
///      pasting the printed parameters into the Safe was therefore executing a
///      path nothing had ever run.
///
///      Every test here drives the operation through
///      `factoryOwnershipOperation`, so what is rehearsed is exactly what the
///      deploy script tells an operator to schedule.
contract FactoryOwnershipCeremonyTest is Test {
    CeremonyHarness internal harness;
    SafeShape internal safe;
    NuvemDeploymentBase.Deployment internal deployment;
    /// @dev Read once in setUp, on purpose. `harness.GOVERNANCE_DELAY()` is an
    ///      EXTERNAL call, so putting it in an argument list consumes the
    ///      preceding `vm.prank` or `vm.expectRevert` — the cheat code applies to
    ///      the getter instead of the call under test, and the assertion then
    ///      silently exercises the wrong caller. Four tests in this file failed
    ///      that way before it was hoisted.
    uint256 internal delay;

    address internal guardian = address(0x61);
    address internal treasury = address(0x71);
    address internal attester = address(0xA7);

    function setUp() external {
        harness = new CeremonyHarness();
        delay = harness.GOVERNANCE_DELAY();
        safe = new SafeShape();
        MockWETH weth = new MockWETH();

        deployment = harness.deployCore(
            NuvemDeploymentBase.DeploymentConfig({
                corporateMultisig: address(safe),
                guardian: guardian,
                treasury: treasury,
                attester: attester,
                weth: address(weth),
                initialFeeBps: 0,
                canaryApproved: true,
                governanceDelay: harness.GOVERNANCE_DELAY(),
                disposableTestDeployment: false
            })
        );
    }

    /// @dev The exact five values `deploy-mainnet.ps1` prints for an operator to
    ///      paste into the Safe.
    function _operation()
        internal
        view
        returns (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt)
    {
        return harness.factoryOwnershipOperation(address(deployment.factory));
    }

    /// @notice The state a deployment lands in, and the state the canary is stuck in.
    function testDeploymentLandsOwnedByABootstrapThatCannotAct() external {
        address factoryOwner = deployment.factory.owner();
        assertEq(deployment.factory.pendingOwner(), address(deployment.timelock), "timelock must be pending");
        assertTrue(factoryOwner != address(deployment.timelock), "the handover is NOT complete on deploy");
        assertTrue(factoryOwner.code.length > 0, "the owner is the bootstrap contract");

        // Ownable2Step means the bootstrap is still fully the owner until the
        // timelock accepts. It has no function that would let it use that.
        (bool ok,) = factoryOwner.call(abi.encodeWithSignature("transferOwnership(address)", address(this)));
        assertFalse(ok, "the bootstrap exposes no way to redirect the transfer");
    }

    /// @notice THE CEREMONY. Schedule through the Safe, wait, execute, verify.
    function testSafeSchedulesAndTheTimelockAcceptsAfterTheFullDelay() external {
        (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt) = _operation();
        assertEq(harness.GOVERNANCE_DELAY(), 7 days, "the delay is not negotiable");

        vm.prank(address(safe));
        deployment.timelock.schedule(target, value, data, predecessor, salt, delay);

        vm.warp(block.timestamp + delay);

        // Execution is open once the delay has run — deliberately, so a lost Safe
        // signer cannot strand an operation that already survived its window.
        vm.prank(address(0xBEEF));
        deployment.timelock.execute(target, value, data, predecessor, salt);

        assertEq(deployment.factory.owner(), address(deployment.timelock), "owner() must be the timelock");
        assertEq(deployment.factory.pendingOwner(), address(0), "pendingOwner() must be cleared");
    }

    /// @notice Governance actually works afterwards — which is the point of the
    ///         ceremony, and the thing the canary permanently cannot do.
    function testTheTimelockCanGovernTheFactoryOnceItOwnsIt() external {
        _completeCeremony();

        address newImplementation = address(new MockWETH());
        bytes memory registerCohort =
            abi.encodeWithSignature("registerCohort(address,address)", newImplementation, address(deployment.timelock));
        bytes32 salt = keccak256("a second cohort");

        vm.prank(address(safe));
        deployment.timelock.schedule(
            address(deployment.factory), 0, registerCohort, bytes32(0), salt, delay
        );
        vm.warp(block.timestamp + delay);
        vm.prank(address(0xBEEF));
        deployment.timelock.execute(address(deployment.factory), 0, registerCohort, bytes32(0), salt);

        assertEq(deployment.factory.cohortCount(), 2, "a second cohort was registered by governance");
    }

    /// @notice One day early is still early. The failure is loud, not silent.
    function testExecutingBeforeTheDelayHasRunReverts() external {
        (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt) = _operation();
        vm.prank(address(safe));
        deployment.timelock.schedule(target, value, data, predecessor, salt, delay);

        vm.warp(block.timestamp + delay - 1 days);
        vm.expectRevert();
        deployment.timelock.execute(target, value, data, predecessor, salt);

        assertEq(deployment.factory.pendingOwner(), address(deployment.timelock), "still pending");
    }

    /// @notice Only the Safe may propose. If the Safe address were wrong at
    ///         deployment, the factory would be frozen from birth with no way to
    ///         schedule anything — the failure mode this asserts the shape of.
    function testOnlyTheCorporateSafeCanSchedule() external {
        (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt) = _operation();

        vm.prank(address(0xBEEF));
        vm.expectRevert();
        deployment.timelock.schedule(target, value, data, predecessor, salt, delay);

        vm.prank(guardian);
        vm.expectRevert();
        deployment.timelock.schedule(target, value, data, predecessor, salt, delay);
    }

    /// @notice Running the ceremony twice fails loudly rather than doing nothing.
    /// @dev An operator who is unsure whether step 3 completed will try again.
    ///      They should meet an error, not a success that changed nothing.
    function testTheCeremonyCannotBeReplayed() external {
        _completeCeremony();
        (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt) = _operation();

        vm.prank(address(safe));
        vm.expectRevert();
        deployment.timelock.schedule(target, value, data, predecessor, salt, delay);
    }

    /// @notice The salt is derived from the factory address, so two deployments
    ///         never collide inside one timelock.
    function testTheSaltIsBoundToTheFactory() external view {
        (,,,, bytes32 salt) = _operation();
        (,,,, bytes32 other) = harness.factoryOwnershipOperation(address(0xF00));
        assertTrue(salt != other, "a different factory must produce a different operation id");
        assertEq(
            salt,
            keccak256(abi.encode(harness.FACTORY_OWNERSHIP_OPERATION_VERSION(), address(deployment.factory))),
            "the salt an operator would recompute by hand"
        );
    }

    function _completeCeremony() private {
        (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt) = _operation();
        vm.prank(address(safe));
        deployment.timelock.schedule(target, value, data, predecessor, salt, delay);
        vm.warp(block.timestamp + delay);
        deployment.timelock.execute(target, value, data, predecessor, salt);
        assertEq(deployment.factory.owner(), address(deployment.timelock));
    }
}
