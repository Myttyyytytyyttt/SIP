// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {VaultFactory} from "../src/factory/VaultFactory.sol";
import {FeeCollector} from "../src/fees/FeeCollector.sol";
import {FeeController} from "../src/fees/FeeController.sol";
import {ProtocolPauseController} from "../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../src/registry/AttesterRegistry.sol";
import {SettlementExecutor} from "../src/settlement/SettlementExecutor.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";
import {AdapterRegistry} from "../src/registry/AdapterRegistry.sol";

interface IOwnable2Step {
    function acceptOwnership() external;
}

/// @notice Minimal Safe-compatible configuration surface checked at deployment.
interface ICorporateMultisigConfig {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice One-shot bootstrap that builds the timelock with a guardian able to
///         CANCEL, and keeps no power over it afterwards.
/// @dev The whole point is the cancel role. OpenZeppelin grants CANCELLER_ROLE
///      only to the proposers (TimelockController.sol constructor), so on a
///      timelock whose sole proposer is the corporate multisig, the only address
///      that can cancel a queued operation is the one that queued it. A stolen
///      multisig key could therefore schedule a malicious beacon upgrade and
///      nothing could stop it inside the delay — the delay would be a countdown,
///      not a defence. Granting the guardian CANCELLER_ROLE turns the delay back
///      into a window somebody can act in, and it grants nothing else: the
///      guardian cannot propose and cannot execute, so the role is purely
///      restrictive, exactly like its pause and disable-attester powers.
///
///      This is a contract rather than three lines in the script because the
///      grant must be sent by whoever holds DEFAULT_ADMIN_ROLE, and the script's
///      caller identity is not stable: under `vm.startBroadcast` an external call
///      from the script carries the broadcaster as msg.sender, while in a plain
///      local run or a test harness it carries the script/harness address. Inside
///      this constructor msg.sender is always this contract, in every context.
contract TimelockBootstrap {
    TimelockController public immutable timelock;

    constructor(uint256 delay, address proposer, address guardian) {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;

        // Execution is intentionally open after an operation has been proposed
        // by the multisig and has survived the full delay.
        address[] memory executors = new address[](1);
        executors[0] = address(0);

        TimelockController deployed = new TimelockController(delay, proposers, executors, address(this));
        deployed.grantRole(deployed.CANCELLER_ROLE(), guardian);
        // Admin rights exist only for the line above. The timelock keeps its own
        // DEFAULT_ADMIN_ROLE (self-administration), so the role set stays
        // changeable later through a normal timelocked operation.
        deployed.renounceRole(deployed.DEFAULT_ADMIN_ROLE(), address(this));
        timelock = deployed;
    }
}

/// @notice One-shot bootstrap that registers the initial cohort without leaving
///         the deployer as factory owner.
/// @dev After construction this contract exposes no method capable of calling
///      the factory. Factory governance remains frozen until the timelock calls
///      `acceptOwnership` after its mandatory delay.
contract VaultFactoryBootstrap {
    VaultFactory public immutable factory;
    SettlementExecutor public immutable settlementExecutor;
    uint32 public immutable cohortId;
    address public immutable beacon;

    constructor(
        address vaultImplementation,
        address timelock,
        address weth,
        address pauseController,
        address attesterRegistry
    ) {
        VaultFactory deployedFactory = new VaultFactory(address(this));
        SettlementExecutor deployedExecutor =
            new SettlementExecutor(address(deployedFactory), attesterRegistry, pauseController);
        deployedFactory.configureProtocol(
            VaultFactory.ProtocolConfiguration({
                weth: weth,
                pauseController: pauseController,
                attesterRegistry: attesterRegistry,
                settlementExecutor: address(deployedExecutor)
            })
        );
        (uint32 initialCohortId, address initialBeacon) = deployedFactory.registerCohort(vaultImplementation, timelock);
        deployedFactory.transferOwnership(timelock);

        factory = deployedFactory;
        settlementExecutor = deployedExecutor;
        cohortId = initialCohortId;
        beacon = initialBeacon;
    }
}

/// @notice Shared deployment topology used by production-style and local scripts.
abstract contract NuvemDeploymentBase is Script {
    uint256 public constant LOCAL_CHAIN_ID = 31_337;
    uint256 public constant ROBINHOOD_TESTNET_CHAIN_ID = 46_630;
    uint256 public constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
    uint256 public constant GOVERNANCE_DELAY = 7 days;
    bytes32 public constant FACTORY_OWNERSHIP_OPERATION_VERSION = keccak256("NUVEM_ACCEPT_FACTORY_OWNERSHIP_V1");

    struct DeploymentConfig {
        address corporateMultisig;
        address guardian;
        address treasury;
        address attester;
        address weth;
        uint16 initialFeeBps;
        bool canaryApproved;
        /**
         * @dev The timelock delay. Defaults to GOVERNANCE_DELAY, and may be
         *      shortened ONLY together with `disposableTestDeployment`.
         *
         *      A short delay is a legitimate thing to want: an end-to-end mainnet
         *      rehearsal otherwise costs three governance cycles at seven days
         *      each — three weeks to find out whether a swap works. What it is not
         *      is a thing to do quietly, because the delay is the only window in
         *      which the guardian's CANCELLER_ROLE means anything. Without it a
         *      single proposer key upgrades the beacon of every vault in the
         *      cohort in one transaction, and the cancel role becomes decoration.
         */
        uint256 governanceDelay;
        /**
         * @dev Names what a short delay makes this deployment: disposable.
         *
         *      Separate from `governanceDelay` on purpose. A number can be lowered
         *      by editing an environment variable and it looks like tuning; this
         *      cannot be set without writing the word down, and it is what
         *      `_validateConfig` keys its refusal on.
         *
         *      NEVER set it on a deployment that will hold anyone else's money.
         */
        bool disposableTestDeployment;
    }

    struct Deployment {
        TimelockController timelock;
        ProtocolPauseController pauseController;
        AttesterRegistry attesterRegistry;
        FeeCollector feeCollector;
        FeeController feeController;
        SettlementExecutor settlementExecutor;
        VaultFactory factory;
        AdapterRegistry adapterRegistry;
        PersonalVault vaultImplementation;
        VaultFactoryBootstrap factoryBootstrap;
        uint32 cohortId;
        address beacon;
        address weth;
    }

    /**
     * @dev The shortest delay a rehearsal may use.
     *
     * Fifteen minutes, not zero, and not a round number chosen for looks: it is
     * long enough that `schedule` and `execute` cannot land in the same block, so
     * the guardian's cancel window still exists and the thing being rehearsed is
     * still the real mechanism. Short enough that three governance cycles cost an
     * afternoon instead of three weeks.
     */
    uint256 public constant MIN_TEST_GOVERNANCE_DELAY = 15 minutes;

    error UnsupportedChain(uint256 chainId);
    error CanaryApprovalRequired(uint256 chainId);
    error InvalidGovernanceDelay(uint256 supplied, uint256 minimum);
    error ShortDelayRequiresDisposableFlag(uint256 supplied, uint256 fullDelay);
    error InvalidConfiguration(bytes32 field, address value);
    error ConfigurationMustBeContract(bytes32 field, address value);
    error UnsupportedCorporateMultisig(address multisig);
    error InvalidCorporateMultisigShape(address multisig, uint256 threshold, uint256 ownerCount);
    error FeeBpsTooHigh(uint256 feeBps);

    event DeploymentPrepared(
        address indexed factory,
        address indexed timelock,
        address indexed settlementExecutor,
        address vaultImplementation,
        address beacon,
        uint32 cohortId,
        address weth
    );

    function _deployCore(DeploymentConfig memory config) internal returns (Deployment memory deployment) {
        _validateConfig(config);

        deployment.timelock =
            new TimelockBootstrap(config.governanceDelay, config.corporateMultisig, config.guardian).timelock();
        deployment.pauseController = new ProtocolPauseController(address(deployment.timelock), config.guardian);
        deployment.attesterRegistry =
            new AttesterRegistry(address(deployment.timelock), config.guardian, config.attester);
        // Fee changes and treasury rotation are deliberately immediate multisig
        // actions, separate from code governance. FeeCollector and FeeController
        // are deployed but are NOT pinned into the factory's ProtocolConfiguration:
        // settlement charges no protocol fee, so no vault can reach them. They are
        // the treasury plumbing a future settlement-time fee would land in.
        //
        // DEPLOYING THE REGISTRY IS NOT THE SAME AS BEING ABLE TO INVEST. It
        // starts EMPTY, and `registerAdapter` is `onlyOwner` on a registry owned
        // by the timelock — so the first adapter costs a full governance cycle
        // after this script has run, and no vault can invest until it lands.
        deployment.feeCollector = new FeeCollector(config.corporateMultisig, config.treasury);
        deployment.feeController =
            new FeeController(config.corporateMultisig, address(deployment.feeCollector), config.initialFeeBps);

        // ORDER MATTERS AND IS FORCED BY THE DESIGN. The adapter registry is an
        // IMMUTABLE of the PersonalVault implementation, so it has to exist before
        // the implementation is constructed. It is timelock-owned like every other
        // governance surface, with the guardian able to deactivate an adapter
        // instantly and without a delay.
        //
        // It is deliberately NOT pinned into the factory. Pinning it there made it
        // a per-vault value chosen at creation, which could never reach a vault
        // that already existed — `initialize` runs once. As an implementation
        // immutable it reaches every proxy in the cohort the moment the beacon
        // upgrade lands.
        deployment.adapterRegistry = new AdapterRegistry(address(deployment.timelock), config.guardian);
        deployment.vaultImplementation = new PersonalVault(address(deployment.adapterRegistry));
        deployment.factoryBootstrap = new VaultFactoryBootstrap(
            address(deployment.vaultImplementation),
            address(deployment.timelock),
            config.weth,
            address(deployment.pauseController),
            address(deployment.attesterRegistry)
        );
        deployment.factory = deployment.factoryBootstrap.factory();
        deployment.settlementExecutor = deployment.factoryBootstrap.settlementExecutor();
        deployment.cohortId = deployment.factoryBootstrap.cohortId();
        deployment.beacon = deployment.factoryBootstrap.beacon();
        deployment.weth = config.weth;

        emit DeploymentPrepared(
            address(deployment.factory),
            address(deployment.timelock),
            address(deployment.settlementExecutor),
            address(deployment.vaultImplementation),
            deployment.beacon,
            deployment.cohortId,
            deployment.weth
        );
    }

    /// @notice Operation the corporate multisig must schedule on the timelock.
    /// @dev Once executed, the bootstrap contract loses the factory ownership
    ///      recorded during construction and the timelock becomes final owner.
    function factoryOwnershipOperation(address factory)
        public
        pure
        returns (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt)
    {
        target = factory;
        value = 0;
        data = abi.encodeCall(IOwnable2Step.acceptOwnership, ());
        predecessor = bytes32(0);
        salt = keccak256(abi.encode(FACTORY_OWNERSHIP_OPERATION_VERSION, factory));
    }

    function _validateConfig(DeploymentConfig memory config) internal view {
        if (
            block.chainid != LOCAL_CHAIN_ID && block.chainid != ROBINHOOD_TESTNET_CHAIN_ID
                && block.chainid != ROBINHOOD_MAINNET_CHAIN_ID
        ) {
            revert UnsupportedChain(block.chainid);
        }
        if (block.chainid == ROBINHOOD_MAINNET_CHAIN_ID && !config.canaryApproved) {
            revert CanaryApprovalRequired(block.chainid);
        }

        // THE DELAY, AND THE ONE WAY TO SHORTEN IT.
        //
        // Below the full delay this deployment is disposable by construction, and
        // saying so is the price of the shortcut. The check is deliberately not
        // "warn and continue": a mainnet timelock with a five-minute delay that
        // someone later points real users at is indistinguishable, on chain, from
        // one that was meant to be safe.
        if (config.governanceDelay == 0) revert InvalidGovernanceDelay(0, MIN_TEST_GOVERNANCE_DELAY);
        if (config.governanceDelay < GOVERNANCE_DELAY && !config.disposableTestDeployment) {
            revert ShortDelayRequiresDisposableFlag(config.governanceDelay, GOVERNANCE_DELAY);
        }
        // A floor even for a rehearsal. At zero, `schedule` and `execute` land in
        // the same block and the guardian could not cancel a hostile operation
        // even while watching — which removes the only property being rehearsed.
        if (config.governanceDelay < MIN_TEST_GOVERNANCE_DELAY) {
            revert InvalidGovernanceDelay(config.governanceDelay, MIN_TEST_GOVERNANCE_DELAY);
        }

        _requireAddress("CORPORATE_MULTISIG", config.corporateMultisig);
        _requireAddress("GUARDIAN", config.guardian);
        _requireAddress("TREASURY", config.treasury);
        _requireAddress("ATTESTER", config.attester);
        _requireContract("CORPORATE_MULTISIG", config.corporateMultisig);
        _requireMultisigInterface(config.corporateMultisig);
        _requireContract("WETH", config.weth);

        if (config.initialFeeBps > 10_000) {
            revert FeeBpsTooHigh(config.initialFeeBps);
        }
    }

    function _requireAddress(bytes32 field, address value) private pure {
        if (value == address(0)) revert InvalidConfiguration(field, value);
    }

    function _requireContract(bytes32 field, address value) private view {
        _requireAddress(field, value);
        if (value.code.length == 0) {
            revert ConfigurationMustBeContract(field, value);
        }
    }

    /// @dev Checks that the governance address ANSWERS the standard Safe
    ///      configuration interface, and that its threshold is coherent. It does
    ///      not authenticate Safe bytecode, owner identity, signer security, or
    ///      the absence of enabled modules/guards.
    ///
    ///      This used to demand exactly 3-of-5. The numbers were never the
    ///      control: the PROBE is. A wrongly pasted address — the single most
    ///      dangerous field in this deployment — almost never answers both
    ///      getThreshold() and getOwners(), so it reverts here as
    ///      UnsupportedCorporateMultisig either way. What the exact shape did
    ///      instead was force a 3-of-5 on a solo operator, whose only way to
    ///      satisfy it is five keys derived from one seed on one machine. That
    ///      passes this check and would let THREAT_MODEL.md record a "3-of-5
    ///      verified at deployment" that is literally true and materially false.
    ///      An honest 1-of-2 carries the same real risk and names it.
    function _requireMultisigInterface(address multisig) private view {
        uint256 threshold;
        address[] memory owners;

        try ICorporateMultisigConfig(multisig).getThreshold() returns (uint256 configuredThreshold) {
            threshold = configuredThreshold;
        } catch {
            revert UnsupportedCorporateMultisig(multisig);
        }

        try ICorporateMultisigConfig(multisig).getOwners() returns (address[] memory configuredOwners) {
            owners = configuredOwners;
        } catch {
            revert UnsupportedCorporateMultisig(multisig);
        }

        // Coherence, not a fixed shape: a threshold of zero would make the Safe
        // executable by anyone, and a threshold above the owner count would make
        // it executable by nobody — governance dead on arrival, discovered only
        // when the first action is needed.
        if (owners.length == 0 || threshold == 0 || threshold > owners.length) {
            revert InvalidCorporateMultisigShape(multisig, threshold, owners.length);
        }
    }

    function _logDeployment(Deployment memory deployment) internal view {
        console2.log("Nuvem deployment prepared on chain", block.chainid);
        if (deployment.timelock.getMinDelay() < GOVERNANCE_DELAY) {
            console2.log("");
            console2.log("*** DISPOSABLE TEST DEPLOYMENT ***");
            console2.log("Timelock delay (seconds)", deployment.timelock.getMinDelay());
            console2.log("The guardian's cancel window is this short. One proposer key can");
            console2.log("upgrade every vault in this cohort within that window. Do not point");
            console2.log("other people's money at these addresses.");
            console2.log("");
        }
        console2.log("Timelock", address(deployment.timelock));
        console2.log("Factory", address(deployment.factory));
        console2.log("Factory bootstrap", address(deployment.factoryBootstrap));
        console2.log("Vault implementation", address(deployment.vaultImplementation));
        console2.log("Cohort beacon", deployment.beacon);
        console2.log("Settlement executor", address(deployment.settlementExecutor));
        console2.log("Pause controller", address(deployment.pauseController));
        console2.log("Attester registry", address(deployment.attesterRegistry));
        console2.log("Adapter registry (vault immutable)", address(deployment.adapterRegistry));
        console2.log("Fee controller (deployed, not pinned)", address(deployment.feeController));
        console2.log("Fee collector (deployed, not pinned)", address(deployment.feeCollector));
        console2.log("Configured WETH", deployment.weth);

        (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt) =
            factoryOwnershipOperation(address(deployment.factory));
        console2.log("Schedule factory ownership target", target);
        console2.log("Schedule factory ownership value", value);
        console2.log("Schedule factory ownership delay", GOVERNANCE_DELAY);
        console2.log("Schedule factory ownership predecessor");
        console2.logBytes32(predecessor);
        console2.log("Schedule factory ownership salt");
        console2.logBytes32(salt);
        console2.log("Schedule factory ownership calldata");
        console2.logBytes(data);
    }
}

/// @notice Environment-driven deployment for testnet or a canary-approved chain.
/// @dev Running without `--broadcast` only simulates deployment. This repository
///      does not automatically schedule or execute multisig governance actions.
contract DeployNuvem is NuvemDeploymentBase {
    function run() external returns (Deployment memory deployment) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        uint256 rawFeeBps = vm.envUint("NUVEM_INITIAL_FEE_BPS");
        if (rawFeeBps > 10_000) revert FeeBpsTooHigh(rawFeeBps);

        DeploymentConfig memory config = DeploymentConfig({
            corporateMultisig: vm.envAddress("NUVEM_CORPORATE_MULTISIG"),
            guardian: vm.envAddress("NUVEM_GUARDIAN"),
            treasury: vm.envAddress("NUVEM_TREASURY"),
            attester: vm.envAddress("NUVEM_ATTESTER"),
            weth: vm.envAddress("NUVEM_WETH_ADDRESS"),
            initialFeeBps: uint16(rawFeeBps),
            canaryApproved: vm.envOr("NUVEM_CANARY_APPROVED", false),
            // Defaults to the full delay. An operator who sets neither variable
            // gets the production shape, which is the correct default for the
            // variable nobody remembered to set.
            governanceDelay: vm.envOr("NUVEM_GOVERNANCE_DELAY", GOVERNANCE_DELAY),
            disposableTestDeployment: vm.envOr("NUVEM_DISPOSABLE_TEST_DEPLOYMENT", false)
        });

        vm.startBroadcast(deployerPrivateKey);
        deployment = _deployCore(config);
        vm.stopBroadcast();

        _logDeployment(deployment);
    }
}
