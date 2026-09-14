// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {ICorporateMultisigConfig, NuvemDeploymentBase} from "../../../script/DeployNuvem.s.sol";
import {DeployLocal} from "../../../script/DeployLocal.s.sol";
import {PersonalVault} from "../../../src/vault/PersonalVault.sol";
import {MockWETH} from "../../../src/mocks/MockWETH.sol";

contract SafeShapeHarness {
    uint256 private immutable _threshold;
    uint256 private immutable _ownerCount;

    constructor(uint256 threshold_, uint256 ownerCount_) {
        _threshold = threshold_;
        _ownerCount = ownerCount_;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getOwners() external view returns (address[] memory owners) {
        owners = new address[](_ownerCount);
        for (uint256 i = 0; i < owners.length; ++i) {
            owners[i] = address(uint160(i + 1));
        }
    }
}

contract DeploymentValidationHarness is NuvemDeploymentBase {
    function validate(DeploymentConfig calldata config) external view {
        _validateConfig(config);
    }
}

contract DeploymentConfigTest is Test {
    DeploymentValidationHarness internal harness;
    MockWETH internal weth;

    /**
     * @dev CACHED IN setUp SO `_config` MAKES NO EXTERNAL CALL.
     *
     * Reading `harness.GOVERNANCE_DELAY()` inside `_config` looks harmless and is
     * not: every test here writes `vm.expectRevert(...)` and then
     * `harness.validate(_config(...))`, Solidity evaluates the argument first, and
     * that call consumes the armed expectation. The five tests that check a
     * rejected config then fail with "next call did not revert as expected" —
     * pointing at the validator, which is fine, rather than at the helper, which
     * is not. The same trap has now cost time three times in this codebase; it is
     * cheaper to have no call here at all.
     */
    uint256 internal fullDelay;
    uint256 internal minTestDelay;

    function setUp() external {
        harness = new DeploymentValidationHarness();
        weth = new MockWETH();
        fullDelay = harness.GOVERNANCE_DELAY();
        minTestDelay = harness.MIN_TEST_GOVERNANCE_DELAY();
    }

    function testRobinhoodMainnetRequiresExplicitCanaryApproval() external {
        SafeShapeHarness multisig = new SafeShapeHarness(3, 5);
        NuvemDeploymentBase.DeploymentConfig memory config = _config(address(multisig), false);

        vm.chainId(4663);
        vm.expectRevert(abi.encodeWithSelector(NuvemDeploymentBase.CanaryApprovalRequired.selector, 4663));
        harness.validate(config);

        config.canaryApproved = true;
        harness.validate(config);
    }

    function testRejectsUnsupportedChain() external {
        SafeShapeHarness multisig = new SafeShapeHarness(3, 5);
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(NuvemDeploymentBase.UnsupportedChain.selector, 1));
        harness.validate(_config(address(multisig), false));
    }

    /// @dev A zero threshold makes the Safe executable by ANYONE.
    function testRejectsZeroThreshold() external {
        SafeShapeHarness multisig = new SafeShapeHarness(0, 5);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemDeploymentBase.InvalidCorporateMultisigShape.selector, address(multisig), 0, 5)
        );
        harness.validate(_config(address(multisig), false));
    }

    /// @dev A threshold above the owner count makes it executable by NOBODY:
    ///      governance dead on arrival, discovered at the first action.
    function testRejectsThresholdAboveOwnerCount() external {
        SafeShapeHarness multisig = new SafeShapeHarness(6, 5);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemDeploymentBase.InvalidCorporateMultisigShape.selector, address(multisig), 6, 5)
        );
        harness.validate(_config(address(multisig), false));
    }

    function testRejectsOwnerlessMultisig() external {
        SafeShapeHarness multisig = new SafeShapeHarness(1, 0);
        vm.expectRevert(
            abi.encodeWithSelector(NuvemDeploymentBase.InvalidCorporateMultisigShape.selector, address(multisig), 1, 0)
        );
        harness.validate(_config(address(multisig), false));
    }

    /// @dev The shapes a solo operator actually uses. The exact 3-of-5 demand is
    ///      gone; what survives is the interface probe, which is the check that
    ///      catches a wrongly pasted address.
    function testAcceptsCoherentThresholds() external {
        harness.validate(_config(address(new SafeShapeHarness(1, 2)), false));
        harness.validate(_config(address(new SafeShapeHarness(2, 3)), false));
        harness.validate(_config(address(new SafeShapeHarness(3, 5)), false));
        harness.validate(_config(address(new SafeShapeHarness(1, 1)), false));
    }

    function testRejectsContractWithoutSafeConfigurationInterface() external {
        vm.expectRevert(
            abi.encodeWithSelector(NuvemDeploymentBase.UnsupportedCorporateMultisig.selector, address(weth))
        );
        harness.validate(_config(address(weth), false));
    }

    // ── the governance delay, and the one way to shorten it ──────────────────
    //
    // A mainnet rehearsal costs three seven-day cycles, so the delay has to be
    // shortenable or nobody will ever run one. What these pin is that shortening
    // it cannot happen by accident: the number alone is refused, and only the
    // word `disposableTestDeployment` unlocks it.

    function testAShortDelayIsRefusedWithoutTheDisposableFlag() external {
        NuvemDeploymentBase.DeploymentConfig memory config = _config(address(new SafeShapeHarness(1, 2)), false);
        config.governanceDelay = 15 minutes;
        vm.expectRevert(
            abi.encodeWithSelector(
                NuvemDeploymentBase.ShortDelayRequiresDisposableFlag.selector, 15 minutes, fullDelay
            )
        );
        harness.validate(config);
    }

    function testAShortDelayIsAcceptedOnceItIsCalledDisposable() external {
        NuvemDeploymentBase.DeploymentConfig memory config = _config(address(new SafeShapeHarness(1, 2)), false);
        config.governanceDelay = 15 minutes;
        config.disposableTestDeployment = true;
        harness.validate(config);
    }

    /**
     * THE FLOOR HOLDS EVEN FOR A REHEARSAL. At zero delay `schedule` and
     * `execute` land in the same block and the guardian could not cancel a
     * hostile operation even while watching it — which deletes the property the
     * rehearsal exists to exercise.
     */
    function testTheFloorHoldsEvenForADisposableDeployment() external {
        NuvemDeploymentBase.DeploymentConfig memory config = _config(address(new SafeShapeHarness(1, 2)), false);
        config.disposableTestDeployment = true;

        config.governanceDelay = 0;
        vm.expectRevert(
            abi.encodeWithSelector(
                NuvemDeploymentBase.InvalidGovernanceDelay.selector, 0, minTestDelay
            )
        );
        harness.validate(config);

        config.governanceDelay = 1 minutes;
        vm.expectRevert(
            abi.encodeWithSelector(
                NuvemDeploymentBase.InvalidGovernanceDelay.selector, 1 minutes, minTestDelay
            )
        );
        harness.validate(config);
    }

    /// @dev The default is the production shape, which is the right answer for a
    ///      variable nobody remembered to set.
    function testTheDefaultDelayIsTheFullOne() external {
        NuvemDeploymentBase.DeploymentConfig memory config = _config(address(new SafeShapeHarness(1, 2)), false);
        assertEq(config.governanceDelay, fullDelay, "the default must be 7 days");
        assertFalse(config.disposableTestDeployment, "and not disposable");
        harness.validate(config);
    }

    function _config(address multisig, bool canaryApproved)
        private
        view
        returns (NuvemDeploymentBase.DeploymentConfig memory)
    {
        return NuvemDeploymentBase.DeploymentConfig({
            corporateMultisig: multisig,
            guardian: address(0xA11CE),
            treasury: address(0xB0B),
            attester: address(0xCAFE),
            weth: address(weth),
            initialFeeBps: 100,
            canaryApproved: canaryApproved,
            governanceDelay: fullDelay,
            disposableTestDeployment: false
        });
    }
}

contract LocalDeploymentScriptTest is Test {
    function testLocalScriptDeploysAndFinalizesExpectedTopology() external {
        address scriptAddress = makeAddr("DeployLocalScript");
        vm.etch(scriptAddress, vm.getDeployedCode("DeployLocal.s.sol:DeployLocal"));

        DeployLocal.LocalDeployment memory local = DeployLocal(scriptAddress).run();
        address timelock = address(local.core.timelock);
        address corporateMultisig = address(local.corporateMultisig);

        assertEq(local.core.timelock.getMinDelay(), 7 days);
        assertTrue(local.core.timelock.hasRole(local.core.timelock.PROPOSER_ROLE(), corporateMultisig));
        assertTrue(local.core.timelock.hasRole(local.core.timelock.EXECUTOR_ROLE(), address(0)));
        assertEq(ICorporateMultisigConfig(corporateMultisig).getThreshold(), 3);
        assertEq(ICorporateMultisigConfig(corporateMultisig).getOwners().length, 5);

        assertEq(local.core.factory.owner(), timelock);
        assertEq(local.core.factory.pendingOwner(), address(0));
        assertEq(local.core.pauseController.owner(), timelock);
        assertEq(local.core.attesterRegistry.owner(), timelock);
        // FeeCollector and FeeController are deployed but are NOT pinned into
        // the factory's ProtocolConfiguration: settlement charges no protocol
        // fee, so no vault can reach them. Their ownership still matters.
        assertEq(local.core.feeController.owner(), corporateMultisig);
        assertEq(local.core.feeCollector.owner(), corporateMultisig);
        assertEq(UpgradeableBeacon(local.core.beacon).owner(), timelock);
        assertEq(UpgradeableBeacon(local.core.beacon).implementation(), address(local.core.vaultImplementation));

        assertEq(address(local.core.settlementExecutor.factory()), address(local.core.factory));
        assertEq(address(local.core.settlementExecutor.attesterRegistry()), address(local.core.attesterRegistry));
        assertEq(address(local.core.settlementExecutor.pauseController()), address(local.core.pauseController));
        assertTrue(local.core.factory.protocolConfigured());
        assertTrue(
            local.core.factory
                .isProtocolConfiguration(
                    address(local.weth),
                    address(local.core.pauseController),
                    address(local.core.attesterRegistry),
                    address(local.core.settlementExecutor)
                )
        );
        assertFalse(
            local.core.factory
                .isProtocolConfiguration(
                    address(local.weth),
                    address(local.core.pauseController),
                    address(local.core.attesterRegistry),
                    address(local.core.feeController)
                ),
            "a substituted executor must not pass the gate"
        );

        // THE ADAPTER REGISTRY IS NOT IN ProtocolConfiguration ANY MORE, and this
        // asserts where it went rather than merely asserting it is gone. It is an
        // immutable of the IMPLEMENTATION, which is the whole point: a value
        // pinned in the factory is read at `initialize`, and `initialize` runs
        // once — so it could never reach a vault that already existed. On the
        // implementation it arrives with the beacon upgrade, for every proxy in
        // the cohort, in one block and with no per-vault transaction.
        assertEq(
            local.core.vaultImplementation.ADAPTER_REGISTRY(),
            address(local.core.adapterRegistry),
            "the implementation must carry the registry this deployment created"
        );
        // Governance owns it; the guardian can retire an adapter with no delay.
        assertEq(local.core.adapterRegistry.owner(), address(local.core.timelock), "registry is timelock-owned");

        assertEq(PersonalVault(payable(local.sampleVault)).vaultAdmin(), address(local.sampleVaultAdmin));
        assertEq(local.core.factory.vaultOfAdmin(address(local.sampleVaultAdmin)), local.sampleVault);
        assertEq(local.core.factory.cohortOfVault(local.sampleVault), 1);
        assertEq(local.core.weth, address(local.weth));
    }
}
