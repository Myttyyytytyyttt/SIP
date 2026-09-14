// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {DeploySip, SipDeploymentBase, SipGovernanceBootstrap} from "../../script/DeploySip.s.sol";
import {VaultFactory} from "../../src/factory/VaultFactory.sol";
import {PersonalVault} from "../../src/vault/PersonalVault.sol";
import {ProtocolPauseController} from "../../src/governance/ProtocolPauseController.sol";
import {GuardianOwnable} from "../../src/governance/GuardianOwnable.sol";
import {AdapterRegistry} from "../../src/registry/AdapterRegistry.sol";
import {MockWETH} from "../../src/mocks/MockWETH.sol";
import {NuvemTypes} from "../../src/types/NuvemTypes.sol";

/// @dev `MockWETH` answers "Mock Wrapped Ether"/"mWETH", and the script REFUSES
///      that on purpose: WETH is pinned by a one-shot `configureProtocol` and a
///      wrong-but-real token there would quietly accumulate the wrong asset for
///      the life of the deployment. Overriding the two strings is the smallest
///      thing that makes the harness look like the canonical token — and the fact
///      that the plain mock does NOT pass is itself asserted below.
contract CanonicalWeth is MockWETH {
    function name() public pure override returns (string memory) {
        return "WETH";
    }

    function symbol() public pure override returns (string memory) {
        return "WETH";
    }
}

/// @dev Exposes the internals the way `FactoryOwnershipCeremony.t.sol` does, so
///      the topology tests run in-process against the SAME code path `run()`
///      broadcasts — no reimplementation of the deployment in the test.
contract SipDeploymentHarness is SipDeploymentBase {
    function deployCore(DeploymentConfig calldata config) external returns (Deployment memory) {
        return _deployCore(config);
    }
}

/// @title The permanent SIP deployment, pinned.
/// @notice SIP gets ONE deployment and it is meant to be the last one. Two kinds
///         of claim are made about it, and both are tested here:
///
///         THE SHAPE, today — every code-governance surface owned by a timelock
///         whose only proposer/executor is the owner's Ledger, minDelay 0, the
///         Ledger as a DIRECT guardian, factory ownership ACCEPTED rather than
///         pending, `configureProtocol` spent, cohort 1 live, fee 0 bps.
///
///         THE PROMISES the owner accepted that shape on — that the delay can be
///         raised later, that governance can move to a Safe, and that each
///         ownership can be handed onward, all WITHOUT REDEPLOYING. A promise
///         about future governance that nothing exercises is a promise nobody has
///         checked; each one below is executed end to end.
contract DeploySipTest is Test {
    SipDeploymentHarness internal harness;
    SipDeploymentBase.Deployment internal deployment;
    CanonicalWeth internal weth;

    /// @dev The Ledger. One address, and it is deliberately the same one in every
    ///      role the deployment gives it — that IS the topology under test.
    address internal ledger = makeAddr("ownerLedger");
    address internal deployerEoa = makeAddr("deployerHotKey");
    address internal attester = makeAddr("attester");

    TimelockController internal timelock;

    function setUp() external {
        // A timestamp far from zero: at delay 0 an operation's ready-timestamp is
        // `block.timestamp`, and TimelockController reserves the literal value 1
        // as DONE. Nothing here would ever run at timestamp 1, but the suite
        // should not depend on that.
        vm.warp(10 days);
        vm.roll(1_000);

        weth = new CanonicalWeth();
        harness = new SipDeploymentHarness();
        deployment = harness.deployCore(_config());
        timelock = deployment.timelock;
    }

    function _config() internal view returns (SipDeploymentBase.DeploymentConfig memory) {
        return SipDeploymentBase.DeploymentConfig({
            owner: ledger,
            deployer: deployerEoa,
            attester: attester,
            weth: address(weth),
            expectedChainId: block.chainid
        });
    }

    // ─────────────────────────── the shape, today ───────────────────────────

    /// @notice Every code-governance surface points at the one timelock.
    function testEveryGovernanceSurfaceIsOwnedByTheTimelock() external view {
        assertEq(deployment.factory.owner(), address(timelock), "factory");
        assertEq(deployment.pauseController.owner(), address(timelock), "pause controller");
        assertEq(deployment.attesterRegistry.owner(), address(timelock), "attester registry");
        assertEq(deployment.adapterRegistry.owner(), address(timelock), "adapter registry");
        assertEq(UpgradeableBeacon(deployment.beacon).owner(), address(timelock), "beacon");
    }

    /// @notice THE STEP THAT FROZE THE FORKED DEPLOYMENT. Ownership is ACCEPTED,
    ///         not pending, and the bootstrap that briefly held it is spent.
    /// @dev On chain 4663 the forked factory still reads owner = its own bootstrap
    ///      and pendingOwner = a timelock that never accepted, so no cohort can
    ///      ever be registered on it again. minDelay 0 is what lets this
    ///      deployment finish the handover inside the deploy run instead of
    ///      leaving it to a runbook step somebody has to remember.
    function testFactoryOwnershipIsAcceptedNotPending() external view {
        assertEq(deployment.factory.pendingOwner(), address(0), "nothing may be left pending");
        assertEq(deployment.factory.owner(), address(timelock), "the timelock is the owner already");
        assertTrue(
            deployment.factory.owner() != address(deployment.factoryBootstrap), "the bootstrap must not still own it"
        );
    }

    /// @notice minDelay 0, and the timelock is administered by nobody but itself.
    function testTimelockIsZeroDelayAndSelfAdministeredOnly() external view {
        assertEq(timelock.getMinDelay(), 0, "the delay starts at zero, deliberately");

        bytes32 admin = timelock.DEFAULT_ADMIN_ROLE();
        assertTrue(timelock.hasRole(admin, address(timelock)), "the timelock administers itself");
        assertFalse(timelock.hasRole(admin, ledger), "not even the Ledger is admin");
        assertFalse(timelock.hasRole(admin, deployerEoa), "the hot key holds nothing");
        assertFalse(timelock.hasRole(admin, address(harness)), "the script holds nothing");
        assertFalse(timelock.hasRole(admin, address(deployment.governanceBootstrap)), "the bootstrap holds nothing");
    }

    /// @notice The Ledger is the only proposer, executor and canceller; the
    ///         bootstrap stripped itself in the same transaction it used its roles.
    function testOnlyTheLedgerHoldsTheTimelockRoles() external view {
        address bootstrap = address(deployment.governanceBootstrap);

        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), ledger), "ledger proposes");
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), ledger), "ledger executes");
        // Granted to every proposer by OpenZeppelin's constructor. Worth nothing
        // at delay 0 and worth everything the moment the delay is raised.
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), ledger), "ledger cancels");

        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), bootstrap), "bootstrap proposer revoked");
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), bootstrap), "bootstrap executor revoked");
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), bootstrap), "bootstrap canceller revoked");

        // Execution is NOT open. At delay 0 an open executor role would hand the
        // timing of every governance action to whoever watches the mempool.
        assertFalse(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)), "execution is not open");
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), deployerEoa), "the hot key cannot propose");
    }

    /// @notice The bootstrap cannot be re-used, by its creator or by anyone else.
    function testTheSpentBootstrapCannotActAgain() external {
        SipGovernanceBootstrap bootstrap = deployment.governanceBootstrap;

        vm.expectRevert(abi.encodeWithSelector(SipGovernanceBootstrap.NotDeployer.selector, address(this)));
        bootstrap.completeHandover(address(deployment.factory));

        // Even from the creator: the roles it needed are gone.
        vm.prank(address(harness));
        vm.expectRevert();
        bootstrap.completeHandover(address(deployment.factory));
    }

    /// @notice `configureProtocol` pinned EXACTLY the four addresses passed, and
    ///         can never be called again.
    /// @dev This is the line that cannot be redone. `isProtocolConfiguration` is
    ///      the gate every vault's `initialize` runs against, so asserting a
    ///      substituted executor FAILS the gate is as important as asserting the
    ///      right one passes.
    function testConfigureProtocolPinnedExactlyWhatWasPassedAndIsSpent() external {
        assertTrue(deployment.factory.protocolConfigured(), "configured");
        assertTrue(
            deployment.factory
                .isProtocolConfiguration(
                    address(weth),
                    address(deployment.pauseController),
                    address(deployment.attesterRegistry),
                    address(deployment.settlementExecutor)
                ),
            "the pinned set must be the set that was passed"
        );
        assertFalse(
            deployment.factory
                .isProtocolConfiguration(
                    address(weth),
                    address(deployment.pauseController),
                    address(deployment.attesterRegistry),
                    address(deployment.volumeExecutor)
                ),
            "a substituted executor must not pass the gate"
        );

        vm.prank(address(timelock));
        vm.expectRevert(VaultFactory.ProtocolAlreadyConfigured.selector);
        deployment.factory
            .configureProtocol(
                VaultFactory.ProtocolConfiguration({
                    weth: address(weth),
                    pauseController: address(deployment.pauseController),
                    attesterRegistry: address(deployment.attesterRegistry),
                    settlementExecutor: address(deployment.volumeExecutor)
                })
            );
    }

    /// @notice Cohort 1 exists and its beacon answers to the timelock.
    /// @dev `registerCohort` reverts `NotAContract(upgradeAuthority)` when the
    ///      authority has no code — the single constraint that made a
    ///      TimelockController necessary instead of pointing the beacon straight
    ///      at the Ledger.
    function testCohortOneExistsWithTheTimelockAsUpgradeAuthority() external view {
        assertEq(deployment.cohortId, 1, "cohort 1");
        assertEq(deployment.factory.cohortCount(), 1, "exactly one cohort");

        (address beacon, address initialImplementation, address upgradeAuthority,) = deployment.factory.cohorts(1);
        assertEq(beacon, deployment.beacon, "beacon");
        assertEq(initialImplementation, address(deployment.vaultImplementation), "implementation");
        assertEq(upgradeAuthority, address(timelock), "THE constraint: a contract, and it is the timelock");
        assertEq(UpgradeableBeacon(deployment.beacon).implementation(), address(deployment.vaultImplementation));

        // The adapter registry reaches vaults as an implementation IMMUTABLE, not
        // through the factory, which is why it can ever reach a vault that already
        // exists: a beacon upgrade delivers it to every proxy in the cohort.
        assertEq(
            deployment.vaultImplementation.ADAPTER_REGISTRY(),
            address(deployment.adapterRegistry),
            "the implementation carries this deployment's registry"
        );
    }

    /// @notice The fee is ZERO, and fees are the Ledger's, not the timelock's.
    /// @dev Zero because SIP already takes its slice from the user's VOLUME. A
    ///      protocol fee on top would be a second cut out of the savings the user
    ///      came for, and nobody has made that product decision.
    function testFeesAreZeroAndOwnedByTheLedgerDirectly() external view {
        assertEq(deployment.feeController.feeBps(), 0, "zero basis points");
        assertEq(deployment.feeController.owner(), ledger, "fee controller is the Ledger's");
        assertEq(deployment.feeCollector.owner(), ledger, "fee collector is the Ledger's");
        assertEq(deployment.feeCollector.treasury(), ledger, "treasury is the Ledger");
        assertEq(deployment.feeController.feeCollector(), address(deployment.feeCollector), "wired to the collector");

        // Deployed but NOT pinned: no vault can reach them, by construction.
        assertFalse(
            deployment.factory
                .isProtocolConfiguration(
                    address(weth),
                    address(deployment.pauseController),
                    address(deployment.attesterRegistry),
                    address(deployment.feeController)
                ),
            "the fee controller is not in the protocol configuration"
        );
    }

    /// @notice The worker's three permanent inputs come out of the deployment,
    ///         not out of a runbook.
    function testTheDeploymentReportsWhatTheWorkerMustBeToldAboutItself() external view {
        assertEq(deployment.deployBlock, block.number, "SIP_LOGS_FROM_BLOCK is the deploy block");
        assertEq(address(deployment.settlementExecutor.factory()), address(deployment.factory));
        assertEq(address(deployment.settlementExecutor.attesterRegistry()), address(deployment.attesterRegistry));
        assertEq(address(deployment.settlementExecutor.pauseController()), address(deployment.pauseController));
        // Phase 1 is deployed now so moving to it never needs a second deployment.
        assertEq(address(deployment.volumeExecutor.factory()), address(deployment.factory));
        assertEq(address(deployment.volumeExecutor.attesterRegistry()), address(deployment.attesterRegistry));
        assertEq(address(deployment.volumeExecutor.pauseController()), address(deployment.pauseController));
        assertEq(deployment.attesterRegistry.attester(), attester, "the attester the worker signs with");
    }

    // ──────────────────── the guardian, deliberately direct ────────────────────

    /// @notice The Ledger is guardian everywhere, and it acts WITHOUT the timelock.
    /// @dev Every guardian power is restrictive and every reversal is owner-gated,
    ///      so the guardian can never make its own emergency permanent. Routing it
    ///      through schedule/execute would add a second Ledger approval and a
    ///      mempool announcement to the one action whose whole value is speed.
    function testTheGuardianIsTheLedgerAndPausesWithoutTheTimelock() external {
        assertEq(deployment.pauseController.guardian(), ledger, "pause guardian");
        assertEq(deployment.attesterRegistry.guardian(), ledger, "attester guardian");
        assertEq(deployment.adapterRegistry.guardian(), ledger, "adapter guardian");

        vm.prank(ledger);
        deployment.pauseController.pause();
        assertTrue(deployment.pauseController.paused(), "one transaction, no schedule/execute");

        vm.prank(ledger);
        deployment.attesterRegistry.disableAttester();
        assertEq(deployment.attesterRegistry.attester(), address(0), "signer retired immediately");

        // And the reversal is NOT the guardian's: unpausing is owner-gated, so the
        // emergency power stays one-way.
        vm.prank(ledger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ledger));
        deployment.pauseController.unpause();

        vm.prank(address(timelock));
        deployment.pauseController.unpause();
        assertFalse(deployment.pauseController.paused());
    }

    /// @notice Governance registers an adapter; the guardian retires it instantly.
    /// @dev The pair is the whole guardian design in one test. `registerAdapter`
    ///      is `onlyOwner`, so the first adapter costs a full governance action
    ///      after this deployment — the registry ships EMPTY and no vault can
    ///      invest until one lands. `deactivateAdapter` is `onlyOwnerOrGuardian`,
    ///      so retiring a compromised one costs a single Ledger transaction, and
    ///      reactivating it is owner-gated again.
    function testGovernanceRegistersAnAdapterAndTheGuardianCanRetireItAtOnce() external {
        // Any address with code will do for the registry's purposes; using the
        // vault implementation keeps the test free of a throwaway contract.
        address adapter = address(deployment.vaultImplementation);
        bytes32 adapterId = keccak256("SIP_TEST_ADAPTER");

        assertEq(deployment.adapterRegistry.adapterCount(), 0, "the registry ships empty");

        bytes memory data = abi.encodeCall(AdapterRegistry.registerAdapter, (adapterId, adapter));
        bytes32 salt = keccak256("SIP_FIRST_ADAPTER");
        vm.startPrank(ledger);
        timelock.schedule(address(deployment.adapterRegistry), 0, data, bytes32(0), salt, 0);
        timelock.execute(address(deployment.adapterRegistry), 0, data, bytes32(0), salt);
        vm.stopPrank();
        assertTrue(deployment.adapterRegistry.isAdapterActive(adapterId), "governance landed it");

        vm.prank(ledger);
        deployment.adapterRegistry.deactivateAdapter(adapterId);
        assertFalse(deployment.adapterRegistry.isAdapterActive(adapterId), "one transaction, no schedule/execute");

        // And the guardian cannot undo its own emergency.
        vm.prank(ledger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ledger));
        deployment.adapterRegistry.reactivateAdapter(adapterId);
    }

    /// @notice A stranger is neither owner nor guardian anywhere.
    function testNobodyElseCanPause() external {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(GuardianOwnable.NotOwnerOrGuardian.selector, stranger));
        deployment.pauseController.pause();
    }

    // ───────────────── the promises the owner accepted this on ─────────────────

    /// @notice PROMISE 1: the delay can be raised later, through the timelock,
    ///         with no redeploy — and once raised it actually BITES.
    /// @dev `updateDelay` reverts for every caller except the timelock itself,
    ///      which is exactly why this works: the timelock is its own admin.
    function testTheDelayCanBeRaisedThroughTheTimelockAndThenBinds() external {
        (uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt) = harness.raiseDelayOperation(2 days);

        vm.startPrank(ledger);
        timelock.schedule(address(timelock), value, data, predecessor, salt, 0);
        timelock.execute(address(timelock), value, data, predecessor, salt);
        vm.stopPrank();

        assertEq(timelock.getMinDelay(), 2 days, "the delay moved without redeploying anything");

        // The new delay is real: the same schedule-then-execute pair no longer
        // lands in one block, which is the property that was missing at zero.
        bytes memory pause = abi.encodeCall(ProtocolPauseController.unpause, ());
        vm.startPrank(ledger);
        vm.expectRevert();
        timelock.schedule(address(deployment.pauseController), 0, pause, bytes32(0), keccak256("too-fast"), 0);
        timelock.schedule(address(deployment.pauseController), 0, pause, bytes32(0), keccak256("proper"), 2 days);
        vm.expectRevert();
        timelock.execute(address(deployment.pauseController), 0, pause, bytes32(0), keccak256("proper"));
        vm.stopPrank();
    }

    /// @notice PROMISE 2: governance can move to a Safe — grant the roles to it,
    ///         revoke them from the Ledger — with no redeploy.
    /// @dev Done as ONE batch, and in that order, on purpose: a batch that revoked
    ///      before granting would leave a timelock nobody can drive, which is
    ///      unrecoverable. The test asserts both halves afterwards, so a batch that
    ///      granted without revoking would not pass either.
    function testGovernanceCanMoveToASafeWithoutRedeploying() external {
        address safe = makeAddr("futureSafe");
        bytes32 proposer = timelock.PROPOSER_ROLE();
        bytes32 executor = timelock.EXECUTOR_ROLE();
        bytes32 canceller = timelock.CANCELLER_ROLE();

        address[] memory targets = new address[](6);
        uint256[] memory values = new uint256[](6);
        bytes[] memory payloads = new bytes[](6);
        for (uint256 i = 0; i < 6; ++i) {
            targets[i] = address(timelock);
        }
        payloads[0] = abi.encodeCall(IAccessControl.grantRole, (proposer, safe));
        payloads[1] = abi.encodeCall(IAccessControl.grantRole, (executor, safe));
        payloads[2] = abi.encodeCall(IAccessControl.grantRole, (canceller, safe));
        payloads[3] = abi.encodeCall(IAccessControl.revokeRole, (proposer, ledger));
        payloads[4] = abi.encodeCall(IAccessControl.revokeRole, (executor, ledger));
        payloads[5] = abi.encodeCall(IAccessControl.revokeRole, (canceller, ledger));

        bytes32 salt = keccak256("SIP_GOVERNANCE_TO_SAFE");
        vm.startPrank(ledger);
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, 0);
        timelock.executeBatch(targets, values, payloads, bytes32(0), salt);
        vm.stopPrank();

        assertTrue(timelock.hasRole(proposer, safe) && timelock.hasRole(executor, safe), "the Safe governs now");
        assertFalse(timelock.hasRole(proposer, ledger), "the Ledger no longer proposes");
        assertFalse(timelock.hasRole(executor, ledger), "the Ledger no longer executes");

        // The factory did not move, and did not need to: ownership still points at
        // the same timelock, whose driver is now a different key.
        assertEq(deployment.factory.owner(), address(timelock), "no redeploy, no re-transfer");

        bytes memory unpause = abi.encodeCall(ProtocolPauseController.unpause, ());
        vm.prank(ledger);
        vm.expectRevert();
        timelock.schedule(address(deployment.pauseController), 0, unpause, bytes32(0), keccak256("nope"), 0);

        vm.prank(safe);
        timelock.schedule(address(deployment.pauseController), 0, unpause, bytes32(0), keccak256("safe-can"), 0);
    }

    /// @notice PROMISE 3: an individual ownership can be handed onward.
    /// @dev Ownable2Step both ways: the timelock schedules the transfer, the new
    ///      governance accepts. Nothing about the vaults, the cohort or the pinned
    ///      protocol configuration changes.
    function testFactoryOwnershipCanBeHandedOnward() external {
        address nextGovernance = address(new FutureGovernance());

        bytes memory data = abi.encodeCall(Ownable.transferOwnership, (nextGovernance));
        bytes32 salt = keccak256("SIP_FACTORY_OWNERSHIP_ONWARD");

        vm.startPrank(ledger);
        timelock.schedule(address(deployment.factory), 0, data, bytes32(0), salt, 0);
        timelock.execute(address(deployment.factory), 0, data, bytes32(0), salt);
        vm.stopPrank();

        assertEq(deployment.factory.pendingOwner(), nextGovernance, "pending, as Ownable2Step requires");
        assertEq(deployment.factory.owner(), address(timelock), "still the timelock until accepted");

        FutureGovernance(payable(nextGovernance)).accept(address(deployment.factory));
        assertEq(deployment.factory.owner(), nextGovernance, "handed on, with no redeploy");
        assertTrue(deployment.factory.protocolConfigured(), "the pinned configuration is untouched");
    }

    // ─────────────────────────── refusals to run ───────────────────────────

    /// @notice A right script against a wrong RPC is the cheapest way to burn a
    ///         permanent deployment. The chain id is declared, not discovered.
    function testRefusesToDeployOnAnUnexpectedChain() external {
        SipDeploymentBase.DeploymentConfig memory config = _config();
        config.expectedChainId = block.chainid + 1;

        vm.expectRevert(
            abi.encodeWithSelector(SipDeploymentBase.ChainIdMismatch.selector, block.chainid + 1, block.chainid)
        );
        harness.deployCore(config);
    }

    /// @notice A missing SIP_CHAIN_ID must not read as "any chain".
    function testRefusesAZeroChainId() external {
        SipDeploymentBase.DeploymentConfig memory config = _config();
        config.expectedChainId = 0;

        vm.expectRevert(abi.encodeWithSelector(SipDeploymentBase.ChainIdMismatch.selector, 0, block.chainid));
        harness.deployCore(config);
    }

    /// @notice WETH is verified, not merely checked for code, because
    ///         `configureProtocol` pins it forever.
    function testRefusesATokenThatIsNotCanonicalWeth() external {
        SipDeploymentBase.DeploymentConfig memory config = _config();
        config.weth = address(new MockWETH()); // "Mock Wrapped Ether" / "mWETH"

        vm.expectRevert(SipDeploymentBase.UnexpectedWethMetadata.selector);
        harness.deployCore(config);
    }

    function testRefusesAWethAddressWithNoCode() external {
        SipDeploymentBase.DeploymentConfig memory config = _config();
        config.weth = makeAddr("notAContract");

        vm.expectRevert(
            abi.encodeWithSelector(
                SipDeploymentBase.ConfigurationMustBeContract.selector, bytes32("SIP_WETH"), config.weth
            )
        );
        harness.deployCore(config);
    }

    /// @notice Nothing address-shaped may be left blank; a blank owner must stop
    ///         the run rather than fall through to anything.
    function testRefusesBlankAddresses() external {
        SipDeploymentBase.DeploymentConfig memory config = _config();
        config.owner = address(0);
        vm.expectRevert(
            abi.encodeWithSelector(SipDeploymentBase.InvalidConfiguration.selector, bytes32("SIP_OWNER"), address(0))
        );
        harness.deployCore(config);

        config = _config();
        config.attester = address(0);
        vm.expectRevert(
            abi.encodeWithSelector(SipDeploymentBase.InvalidConfiguration.selector, bytes32("SIP_ATTESTER"), address(0))
        );
        harness.deployCore(config);
    }

    /// @notice A deployment whose governor is the hot key that deployed it looks
    ///         identical on chain and shares none of this one's properties.
    function testRefusesToMakeTheHotDeployKeyTheGovernor() external {
        SipDeploymentBase.DeploymentConfig memory config = _config();
        config.owner = deployerEoa;

        vm.expectRevert(abi.encodeWithSelector(SipDeploymentBase.GovernorMustNotBeTheDeployer.selector, deployerEoa));
        harness.deployCore(config);
    }

    // ───────────────────────────── end to end ─────────────────────────────

    /// @notice The product, against this exact topology: a user creates a vault
    ///         and binds a trading wallet to it.
    /// @dev Nothing in the governance shape may stand between a user and their own
    ///      vault. `createVault` is permissionless, and inviting a trading account
    ///      is a vault-admin action — neither touches the timelock, the guardian or
    ///      the Ledger. This test is what proves the deployment is USABLE and not
    ///      merely well-owned.
    function testAUserCanCreateAVaultAndBindATradingWallet() external {
        address vaultAdmin = makeAddr("vaultAdmin");
        address tradingWallet = makeAddr("tradingWallet");

        NuvemTypes.VaultInitialization memory init = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(deployment.pauseController),
            attesterRegistry: address(deployment.attesterRegistry),
            settlementExecutor: address(deployment.settlementExecutor),
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: 15 ether})
        });

        vm.prank(vaultAdmin);
        (bytes32 vaultId, address vaultAddress) =
            deployment.factory.createVault(keccak256("sip-vault"), deployment.cohortId, abi.encode(init));
        PersonalVault vault = PersonalVault(payable(vaultAddress));

        assertEq(vault.vaultAdmin(), vaultAdmin, "the user owns their vault");
        assertEq(deployment.factory.vaultOfAdmin(vaultAdmin), vaultAddress, "registered");
        assertEq(deployment.factory.cohortOfVault(vaultAddress), deployment.cohortId, "in cohort 1");
        assertTrue(vaultId != bytes32(0));

        NuvemTypes.TradingAccountPolicy memory policy = NuvemTypes.TradingAccountPolicy({
            savingsBps: 2_000,
            minContributionWei: 0.01 ether,
            maxPerSettlementWei: 2 ether,
            maxRolling30dWei: 10 ether,
            tradingFloorWei: 1 ether,
            gasReserveWei: 0.1 ether
        });

        vm.prank(vaultAdmin);
        vault.inviteTradingAccount(tradingWallet, keccak256("robinhood"), policy, uint48(block.timestamp + 1 days));
        vm.prank(tradingWallet);
        vault.acceptTradingAccount();

        assertEq(
            uint8(vault.getTradingAccount(tradingWallet).status),
            uint8(NuvemTypes.AccountStatus.ACTIVE),
            "the wallet is bound"
        );
        // The global exclusivity the worker's discovery depends on.
        assertEq(deployment.factory.activeVaultOf(tradingWallet), vaultAddress, "one wallet, one vault, globally");
        assertEq(vault.settlementExecutor(), address(deployment.settlementExecutor), "Phase 0 executor, as pinned");
    }

    /// @notice The Phase 1 move is a per-vault admin action, not a governance one,
    ///         and it needs no second deployment.
    /// @dev `configureProtocol` pinned the Phase 0 executor for every new vault
    ///      forever. `SipVolumeExecutor` is deployed by the same script precisely
    ///      so that switching is one vault-admin transaction against an address
    ///      that already exists.
    function testAVaultCanMoveItselfToThePhaseOneVolumeExecutor() external {
        address vaultAdmin = makeAddr("phaseOneAdmin");

        NuvemTypes.VaultInitialization memory init = NuvemTypes.VaultInitialization({
            weth: address(weth),
            pauseController: address(deployment.pauseController),
            attesterRegistry: address(deployment.attesterRegistry),
            settlementExecutor: address(deployment.settlementExecutor),
            policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: 15 ether})
        });

        vm.prank(vaultAdmin);
        (, address vaultAddress) =
            deployment.factory.createVault(keccak256("phase-one"), deployment.cohortId, abi.encode(init));
        PersonalVault vault = PersonalVault(payable(vaultAddress));

        // Re-pointing force-pauses settlement; resuming is explicit, by design.
        vm.startPrank(vaultAdmin);
        vault.setSettlementExecutor(address(deployment.volumeExecutor));
        vault.setLocalPause(false);
        vm.stopPrank();

        assertEq(vault.settlementExecutor(), address(deployment.volumeExecutor), "moved, with no redeploy");
        assertFalse(vault.settlementPaused());
    }
}

/// @dev Stand-in for "some future governance contract" in the hand-onward test.
///      It only has to have code and be able to call `acceptOwnership`; what it is
///      in reality — a Safe, a second timelock — is the owner's later choice, and
///      that choice is exactly what this deployment leaves open.
contract FutureGovernance {
    function accept(address target) external {
        (bool ok,) = target.call(abi.encodeWithSignature("acceptOwnership()"));
        require(ok, "acceptOwnership failed");
    }

    receive() external payable {}
}

/// @title The script as an operator actually runs it.
/// @notice The tests above drive `_deployCore` directly. This one goes through
///         `run()` — environment variables, `vm.addr(DEPLOYER_PRIVATE_KEY)`,
///         broadcast and all — because that is the path a real deployment takes,
///         and because the env layer is where a permanent deployment is most
///         easily wrecked: a blank variable, a stale chain id, a defaulted owner.
///         There are no defaults, and this proves it by supplying every value.
contract DeploySipScriptTest is Test {
    uint256 internal constant DEPLOYER_KEY = uint256(keccak256("SIP_TEST_DEPLOYER"));

    address internal ledger = makeAddr("scriptLedger");
    address internal attester = makeAddr("scriptAttester");
    CanonicalWeth internal weth;
    DeploySip internal script;

    /// @dev In storage rather than a local, and that is not style. `block.chainid`
    ///      compiles to the CHAINID opcode, which the optimizer is free to treat
    ///      as constant and re-read AFTER `vm.chainId` has moved it — so a local
    ///      captured "before" the cheatcode silently becomes the value after it.
    ///      A storage read cannot be folded that way.
    uint256 internal declaredChainId;

    function setUp() external {
        vm.warp(10 days);
        vm.roll(1_000);
        declaredChainId = block.chainid;
        weth = new CanonicalWeth();

        address scriptAddress = makeAddr("DeploySipScript");
        vm.etch(scriptAddress, vm.getDeployedCode("DeploySip.s.sol:DeploySip"));
        script = DeploySip(scriptAddress);
    }

    /// @dev Written per test, not in `setUp`. Foundry runs `setUp` once and
    ///      restores the EVM snapshot for each test, but `vm.setEnv` touches the
    ///      PROCESS, not the EVM — so a variable one test overwrites stays
    ///      overwritten for the next one. Writing the full set here makes each
    ///      test start from the same declared environment.
    function _writeEnvironment() private {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(DEPLOYER_KEY));
        vm.setEnv("SIP_OWNER", vm.toString(ledger));
        vm.setEnv("SIP_ATTESTER", vm.toString(attester));
        vm.setEnv("SIP_WETH", vm.toString(address(weth)));
        vm.setEnv("SIP_CHAIN_ID", vm.toString(declaredChainId));
    }

    function testTheEnvironmentDrivenRunProducesTheSameTopology() external {
        _writeEnvironment();

        SipDeploymentBase.Deployment memory deployment = script.run();
        address deployerEoa = vm.addr(DEPLOYER_KEY);
        TimelockController timelock = deployment.timelock;

        assertEq(timelock.getMinDelay(), 0, "one Ledger, zero delay");
        assertEq(deployment.factory.owner(), address(timelock), "ownership accepted inside the run");
        assertEq(deployment.factory.pendingOwner(), address(0), "nothing left pending");
        assertEq(deployment.pauseController.guardian(), ledger, "guardian direct");
        assertEq(deployment.attesterRegistry.attester(), attester, "the attester from the environment");
        assertEq(deployment.weth, address(weth), "the verified WETH");
        assertEq(deployment.cohortId, 1, "cohort 1");
        assertEq(deployment.deployBlock, block.number, "SIP_LOGS_FROM_BLOCK");
        assertEq(deployment.feeController.feeBps(), 0, "zero bps");

        // THE HOT KEY KEEPS NOTHING. It paid for the deployment and that is all it
        // ever did: no role on the timelock, no ownership anywhere.
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), ledger), "the Ledger governs");
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), deployerEoa), "the deployer does not");
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), deployerEoa), "and cannot grant itself one");
    }

    /// @notice The declared chain and the connected chain must agree — this is the
    ///         check that stands between a mainnet script and a testnet RPC.
    /// @dev The MISMATCH is created by moving the chain under the script, not by
    ///      rewriting SIP_CHAIN_ID. Environment variables live in the process, not
    ///      in the EVM, and Foundry runs test contracts in parallel, so a test that
    ///      leaves a doctored variable behind can fail a different test in a
    ///      different thread. Every test here writes the SAME environment and
    ///      varies the world instead.
    function testTheRunRefusesAChainItWasNotPointedAt() external {
        _writeEnvironment();

        vm.chainId(declaredChainId + 1);
        vm.expectRevert(
            abi.encodeWithSelector(SipDeploymentBase.ChainIdMismatch.selector, declaredChainId, declaredChainId + 1)
        );
        script.run();
    }
}
