// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {VaultFactory} from "../src/factory/VaultFactory.sol";
import {FeeCollector} from "../src/fees/FeeCollector.sol";
import {FeeController} from "../src/fees/FeeController.sol";
import {ProtocolPauseController} from "../src/governance/ProtocolPauseController.sol";
import {AttesterRegistry} from "../src/registry/AttesterRegistry.sol";
import {AdapterRegistry} from "../src/registry/AdapterRegistry.sol";
import {SettlementExecutor} from "../src/settlement/SettlementExecutor.sol";
import {SipVolumeExecutor} from "../src/settlement/SipVolumeExecutor.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";

/// @dev Named `IAcceptOwnership` rather than `IOwnable2Step` so this file can be
///      imported alongside `DeployNuvem.s.sol` — which declares an interface of
///      that name — without a clash in whatever test or script pulls in both.
interface IAcceptOwnership {
    function acceptOwnership() external;
}

/// @notice Builds the timelock that governs SIP, and holds — for the length of
///         one deployment and no longer — the proposer and executor roles needed
///         to finish the factory handover in the same run.
///
/// @dev WHY A CONTRACT AND NOT THREE LINES IN THE SCRIPT. `Ownable2Step` means
///      the incoming owner has to call `acceptOwnership` itself, and the incoming
///      owner is the timelock, which acts only through schedule/execute. Only a
///      PROPOSER can schedule and only an EXECUTOR can execute. The owner Ledger
///      holds both, but a Ledger cannot sign inside a `forge script` run, so if
///      the script had no way to drive the timelock the deployment would END WITH
///      OWNERSHIP PENDING — the exact state that froze the deployment SIP was
///      forked from, where a factory is owned by a bootstrap incapable of acting
///      and no cohort can ever be registered again.
///
///      So this contract is a second, TEMPORARY proposer/executor. It schedules
///      and executes one batch and that batch's last three calls REVOKE ITS OWN
///      THREE ROLES, atomically, in the same transaction that accepts ownership.
///      There is no ordering in which it keeps power: either the whole batch
///      lands or none of it does.
///
///      msg.sender stability is the other reason it is a contract. Under
///      `vm.startBroadcast` an external call from a script carries the
///      broadcaster; in a plain in-process run it carries the script address. A
///      contract's own calls always carry the contract, in every context, so the
///      thing the tests rehearse is the thing mainnet runs.
contract SipGovernanceBootstrap {
    /// @notice The one governance contract in this deployment.
    TimelockController public immutable timelock;

    /// @notice Whoever created this bootstrap — the deployer EOA under broadcast,
    ///         the script/harness address in-process.
    /// @dev The handover is gated on it for one reason: `completeHandover` is the
    ///      only call that can spend this contract's temporary roles, and once
    ///      spent they are gone. An opportunist calling it first with a factory of
    ///      their own would revoke the roles on a batch of their choosing and
    ///      leave the real factory pending forever. Whoever deployed this contract
    ///      is, in every context, the same address that calls the next line of the
    ///      script, so pinning it costs nothing and closes that window.
    address public immutable deployer;

    error NotDeployer(address caller);

    constructor(address governor) {
        // The owner Ledger is proposer AND executor. OpenZeppelin's constructor
        // also grants CANCELLER_ROLE to every proposer, which on a one-key
        // governance means the same hand that queues can un-queue — worth nothing
        // today at delay 0, worth everything the day the delay is raised.
        address[] memory proposers = new address[](2);
        proposers[0] = governor;
        proposers[1] = address(this);

        // Execution is NOT open (`address(0)`) the way it is on a seven-day
        // timelock, where an operation has already survived a public delay and
        // anybody may push the button. At delay 0 an open executor role would let
        // a stranger execute a scheduled operation in the same block it was
        // scheduled — no worse in outcome, since only the Ledger can schedule, but
        // it hands the timing of every governance action to whoever is watching
        // the mempool. Keep it with the proposer.
        address[] memory executors = new address[](2);
        executors[0] = governor;
        executors[1] = address(this);

        // admin = address(0), and that is the "renounce" this deployment needs.
        //
        // TimelockController's constructor ALREADY grants DEFAULT_ADMIN_ROLE to
        // the timelock itself; the fourth argument is an EXTRA admin that exists
        // only to be renounced later. Granting it to the deployer and renouncing
        // it three lines down would be the same end state reached through a window
        // in which a hot deploy key could rewrite every role — plus a renounce
        // that a future edit could drop while still compiling. Never granting it
        // has no window and nothing to forget.
        timelock = new TimelockController(0, proposers, executors, address(0));
        deployer = msg.sender;
    }

    /// @notice The batch that finishes the deployment: the timelock accepts the
    ///         factory, then strips this bootstrap of every role it holds.
    /// @dev Public and `view` so a test — or an operator reading the log — can
    ///      see the exact operation, rather than trusting a private encoding.
    function handoverOperation(address factory)
        public
        view
        returns (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        )
    {
        targets = new address[](4);
        values = new uint256[](4);
        payloads = new bytes[](4);

        targets[0] = factory;
        payloads[0] = abi.encodeCall(IAcceptOwnership.acceptOwnership, ());

        // Self-administration is what makes these three possible: the timelock
        // holds its own DEFAULT_ADMIN_ROLE, so a call it makes to itself can
        // change its own role set. That is also the mechanism that lets the owner
        // hand governance to a Safe later without redeploying anything.
        targets[1] = address(timelock);
        payloads[1] = abi.encodeCall(IAccessControl.revokeRole, (timelock.PROPOSER_ROLE(), address(this)));
        targets[2] = address(timelock);
        payloads[2] = abi.encodeCall(IAccessControl.revokeRole, (timelock.EXECUTOR_ROLE(), address(this)));
        targets[3] = address(timelock);
        payloads[3] = abi.encodeCall(IAccessControl.revokeRole, (timelock.CANCELLER_ROLE(), address(this)));

        predecessor = bytes32(0);
        salt = keccak256(abi.encode("SIP_GOVERNANCE_HANDOVER_V1", factory, address(this)));
    }

    /// @notice Schedules and executes the handover in one transaction.
    /// @dev Two calls, not one, because a timelock has no third mode — even at
    ///      minDelay 0 an operation must be scheduled before it can be executed.
    ///      At delay 0 `_schedule` stamps `block.timestamp`, and `getOperationState`
    ///      calls an operation Ready when its timestamp is `<= block.timestamp`,
    ///      so the pair lands in the same block. Everything the owner does later
    ///      costs the same two steps — two Ledger approvals — and that is the
    ///      honest price of governance being a contract rather than a key.
    function completeHandover(address factory) external {
        if (msg.sender != deployer) revert NotDeployer(msg.sender);

        (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        ) = handoverOperation(factory);

        timelock.scheduleBatch(targets, values, payloads, predecessor, salt, 0);
        timelock.executeBatch(targets, values, payloads, predecessor, salt);
    }
}

/// @notice One-shot bootstrap that configures the protocol and registers cohort 1
///         without ever leaving a human hot key as factory owner.
/// @dev Identical in shape to Nuvem's, and identical for the same reason:
///      `configureProtocol` and `registerCohort` are `onlyOwner`, and the owner
///      has to be an address whose msg.sender is the same in a broadcast and in a
///      test. After construction this contract exposes NO function that can touch
///      the factory — the only thing left to happen is the timelock accepting.
///
///      `registerCohort` is also the constraint that decided this entire
///      deployment's shape: it reverts `NotAContract(upgradeAuthority)` when the
///      beacon's upgrade authority has no code, so a Ledger EOA cannot be it.
///      Something with code must hold that role, and the timelock is that
///      something — audited code rather than a bespoke forwarder.
contract SipFactoryBootstrap {
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

        // THE ONE-SHOT LINE. `configureProtocol` can never be called again on this
        // factory, so these four addresses are the life of the deployment: every
        // vault ever created here initializes against exactly them, and a vault
        // whose `initData` names anything else is refused at `initialize`.
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

/// @notice SIP's permanent deployment: one Ledger, zero delay, guardian direct.
///
/// @dev WHAT THIS IS, stated rather than implied.
///
///      Governance is ONE PERSON holding ONE HARDWARE WALLET. Every owner in the
///      system is a TimelockController whose only proposer and only executor is
///      that Ledger, and whose minimum delay is ZERO. That concentrates power and
///      the owner knows it. What it buys is a deployment that never has to be
///      thrown away: three separate hardening moves are available later, and none
///      of them redeploys anything.
///
///        1. RAISE THE DELAY. `TimelockController.updateDelay` is callable only by
///           the timelock itself, so the owner schedules and executes a call to
///           it and the delay goes from 0 to days. Nothing else moves.
///        2. HAND GOVERNANCE TO A SAFE. PROPOSER/EXECUTOR/CANCELLER are ordinary
///           AccessControl roles on a self-administering timelock. Grant them to a
///           Safe, revoke them from the Ledger, through the timelock.
///        3. SPLIT THE OWNERSHIPS. Factory, pause controller, attester registry
///           and adapter registry are separate `Ownable2Step` surfaces that all
///           happen to point at the same timelock today. Any one of them can be
///           handed to different governance later, and `renounceOwnership` is
///           disabled everywhere, so none can be dropped by accident.
///
///      THE COST OF ZERO, also stated. A governance action is still two
///      transactions — two Ledger approvals — because a timelock has no immediate
///      mode. And there is NO WINDOW in which a user could see a hostile or
///      coerced upgrade coming and exit before it lands. Raising the delay is
///      precisely what closes that gap, and it is move (1) above.
abstract contract SipDeploymentBase is Script {
    /// @dev Zero, and deliberately a named constant so that the day it changes,
    ///      it changes in one place and shows up in a diff as a decision.
    uint256 public constant INITIAL_GOVERNANCE_DELAY = 0;

    /// @dev ZERO BASIS POINTS, and the reason is a product decision nobody has
    ///      made rather than an oversight. SIP already takes its slice from the
    ///      user's own trading VOLUME — that is the entire product. A protocol fee
    ///      on top would be a second cut, taken out of the savings the user is
    ///      here to accumulate. The controller and collector are deployed anyway
    ///      so the plumbing exists (and is owner-rotatable) if that decision is
    ///      ever taken; they are NOT pinned into the factory, so today no vault
    ///      can even reach them.
    uint16 public constant INITIAL_FEE_BPS = 0;

    /// @dev Cohort 1 is what `registerCohort` returns on a fresh factory, and it
    ///      is the value the website's NUVEM_COHORT_ID must carry.
    uint32 public constant INITIAL_COHORT_ID = 1;

    struct DeploymentConfig {
        /// @dev The Ledger. Proposer, executor, canceller, guardian everywhere,
        ///      fee owner and treasury. One address, named once.
        address owner;
        /// @dev The hot key running this script. It holds NOTHING afterwards; it
        ///      is checked only so a deployment cannot silently make the hot key
        ///      the permanent governor.
        address deployer;
        address attester;
        address weth;
        /// @dev The chain the operator BELIEVES they are deploying to. Compared
        ///      against `block.chainid` and never defaulted: a right script
        ///      against a wrong RPC is the cheapest way to burn a permanent
        ///      deployment.
        uint256 expectedChainId;
    }

    struct Deployment {
        TimelockController timelock;
        SipGovernanceBootstrap governanceBootstrap;
        ProtocolPauseController pauseController;
        AttesterRegistry attesterRegistry;
        AdapterRegistry adapterRegistry;
        FeeCollector feeCollector;
        FeeController feeController;
        SettlementExecutor settlementExecutor;
        SipVolumeExecutor volumeExecutor;
        VaultFactory factory;
        SipFactoryBootstrap factoryBootstrap;
        PersonalVault vaultImplementation;
        uint32 cohortId;
        address beacon;
        address weth;
        uint256 deployBlock;
    }

    error ChainIdMismatch(uint256 expected, uint256 actual);
    error InvalidConfiguration(bytes32 field, address value);
    error ConfigurationMustBeContract(bytes32 field, address value);
    error GovernorMustNotBeTheDeployer(address account);
    error UnexpectedWethMetadata();
    error HandoverIncomplete(address owner, address pendingOwner);
    error BootstrapRetainedRole(bytes32 role);

    event SipDeploymentPrepared(
        address indexed factory,
        address indexed timelock,
        address indexed settlementExecutor,
        address volumeExecutor,
        address beacon,
        uint32 cohortId,
        address weth
    );

    function _deployCore(DeploymentConfig memory config) internal returns (Deployment memory deployment) {
        _validateConfig(config);

        deployment.governanceBootstrap = new SipGovernanceBootstrap(config.owner);
        deployment.timelock = deployment.governanceBootstrap.timelock();
        address timelock = address(deployment.timelock);

        // THE GUARDIAN IS THE LEDGER, AND IT ACTS DIRECTLY — not through the
        // timelock. Every guardian power in this system is restrictive: pause the
        // protocol, disable the attester, deactivate an adapter. Each one is the
        // response to something already going wrong, and each REVERSAL (unpause,
        // rotate, reactivate) is owner-gated, so the guardian can never make its
        // own emergency permanent. Routing those calls through schedule/execute
        // would add a second Ledger approval and a mempool-visible announcement to
        // the one action whose value is entirely in how fast it lands. So the
        // guardian is deliberately NOT the timelock.
        deployment.pauseController = new ProtocolPauseController(timelock, config.owner);
        deployment.attesterRegistry = new AttesterRegistry(timelock, config.owner, config.attester);

        // ORDER IS FORCED BY THE DESIGN. The adapter registry is an IMMUTABLE of
        // the PersonalVault implementation, so it must exist before the
        // implementation is constructed. It is deliberately not in the factory's
        // ProtocolConfiguration: a value pinned there is read at `initialize`, and
        // `initialize` runs once, so it could never reach a vault that already
        // exists. On the implementation it arrives with a beacon upgrade, to every
        // proxy in the cohort at once.
        //
        // It starts EMPTY, and `registerAdapter` is `onlyOwner` on a
        // timelock-owned registry: no vault can invest until governance lands the
        // first adapter.
        deployment.adapterRegistry = new AdapterRegistry(timelock, config.owner);
        deployment.vaultImplementation = new PersonalVault(address(deployment.adapterRegistry));

        // Fees are owned by the Ledger DIRECTLY, not by the timelock, and that is
        // a deliberate separation rather than a shortcut. Code governance — what
        // every vault in the cohort runs — is the thing that deserves a delay and
        // a role set. A treasury address and a basis-point number are ordinary
        // business settings whose worst case is bounded by the collector, which
        // can only ever pay out to its own treasury.
        deployment.feeCollector = new FeeCollector(config.owner, config.owner);
        deployment.feeController = new FeeController(config.owner, address(deployment.feeCollector), INITIAL_FEE_BPS);

        deployment.factoryBootstrap = new SipFactoryBootstrap(
            address(deployment.vaultImplementation),
            timelock,
            config.weth,
            address(deployment.pauseController),
            address(deployment.attesterRegistry)
        );
        deployment.factory = deployment.factoryBootstrap.factory();
        deployment.settlementExecutor = deployment.factoryBootstrap.settlementExecutor();
        deployment.cohortId = deployment.factoryBootstrap.cohortId();
        deployment.beacon = deployment.factoryBootstrap.beacon();
        deployment.weth = config.weth;

        // PHASE 1, DEPLOYED NOW SO IT NEVER NEEDS A SECOND DEPLOYMENT. The factory
        // pins the Phase 0 `SettlementExecutor` because that is what the worker
        // signs against today, and `configureProtocol` cannot be redone. The
        // volume executor is ownerless, immutable and reachable per vault through
        // `PersonalVault.setSettlementExecutor`, which is a VAULT ADMIN action —
        // so the migration is opt-in, per user, and needs no governance action and
        // no new deployment. Its address is what SIP_SETTLEMENT_EXECUTOR becomes
        // the day the worker moves to Phase 1.
        deployment.volumeExecutor = new SipVolumeExecutor(
            address(deployment.factory), address(deployment.attesterRegistry), address(deployment.pauseController)
        );

        // THE STEP THAT FROZE THE PREVIOUS DEPLOYMENT, done here rather than left
        // to a runbook. minDelay 0 is what makes it possible inside one run.
        deployment.governanceBootstrap.completeHandover(address(deployment.factory));
        _requireHandoverComplete(deployment);

        deployment.deployBlock = block.number;

        emit SipDeploymentPrepared(
            address(deployment.factory),
            timelock,
            address(deployment.settlementExecutor),
            address(deployment.volumeExecutor),
            deployment.beacon,
            deployment.cohortId,
            deployment.weth
        );
    }

    /// @dev Reverts rather than warns. Under `forge script` the whole run is
    ///      simulated before a single transaction is broadcast, so a revert here
    ///      means NOTHING is deployed — strictly better than a mainnet factory
    ///      left owned by a contract that cannot act.
    function _requireHandoverComplete(Deployment memory deployment) private view {
        address timelock = address(deployment.timelock);
        if (deployment.factory.owner() != timelock || deployment.factory.pendingOwner() != address(0)) {
            revert HandoverIncomplete(deployment.factory.owner(), deployment.factory.pendingOwner());
        }

        address bootstrap = address(deployment.governanceBootstrap);
        TimelockController lock = deployment.timelock;
        if (lock.hasRole(lock.PROPOSER_ROLE(), bootstrap)) revert BootstrapRetainedRole(lock.PROPOSER_ROLE());
        if (lock.hasRole(lock.EXECUTOR_ROLE(), bootstrap)) revert BootstrapRetainedRole(lock.EXECUTOR_ROLE());
        if (lock.hasRole(lock.CANCELLER_ROLE(), bootstrap)) revert BootstrapRetainedRole(lock.CANCELLER_ROLE());
        if (lock.hasRole(lock.DEFAULT_ADMIN_ROLE(), bootstrap)) {
            revert BootstrapRetainedRole(lock.DEFAULT_ADMIN_ROLE());
        }
    }

    function _validateConfig(DeploymentConfig memory config) internal view {
        // The chain, first, because everything after it is permanent.
        if (config.expectedChainId == 0 || block.chainid != config.expectedChainId) {
            revert ChainIdMismatch(config.expectedChainId, block.chainid);
        }

        _requireAddress("SIP_OWNER", config.owner);
        _requireAddress("SIP_ATTESTER", config.attester);
        _requireAddress("SIP_WETH", config.weth);

        // A deployment whose governor is the hot key that deployed it looks
        // exactly like this one on chain and shares none of its properties: the
        // Ledger's whole contribution is that the key which signs governance is
        // not the key sitting in an environment variable.
        if (config.owner == config.deployer) revert GovernorMustNotBeTheDeployer(config.owner);

        _requireWeth(config.weth);
    }

    /// @dev WETH is verified, not merely checked for code, because
    ///      `configureProtocol` pins it forever and every vault denominates a
    ///      user's savings in it. A wrong-but-real token here would not fail
    ///      loudly; it would quietly accumulate the wrong asset. Name, symbol and
    ///      decimals are read from the chain — three cheap questions that a
    ///      mistyped address essentially never answers correctly.
    function _requireWeth(address weth) private view {
        if (weth.code.length == 0) revert ConfigurationMustBeContract("SIP_WETH", weth);

        try IERC20Metadata(weth).name() returns (string memory name_) {
            if (keccak256(bytes(name_)) != keccak256("WETH")) revert UnexpectedWethMetadata();
        } catch {
            revert UnexpectedWethMetadata();
        }
        try IERC20Metadata(weth).symbol() returns (string memory symbol_) {
            if (keccak256(bytes(symbol_)) != keccak256("WETH")) revert UnexpectedWethMetadata();
        } catch {
            revert UnexpectedWethMetadata();
        }
        try IERC20Metadata(weth).decimals() returns (uint8 decimals_) {
            if (decimals_ != 18) revert UnexpectedWethMetadata();
        } catch {
            revert UnexpectedWethMetadata();
        }
    }

    function _requireAddress(bytes32 field, address value) private pure {
        if (value == address(0)) revert InvalidConfiguration(field, value);
    }

    /// @notice The calldata that raises the delay, printed so the hardening move
    ///         is a paste rather than a research project.
    /// @dev Target is the timelock itself — `updateDelay` reverts for every caller
    ///      except `address(this)`, which is exactly why the delay can be raised
    ///      later without redeploying anything.
    function raiseDelayOperation(uint256 newDelay)
        public
        pure
        returns (uint256 value, bytes memory data, bytes32 predecessor, bytes32 salt)
    {
        value = 0;
        data = abi.encodeCall(TimelockController.updateDelay, (newDelay));
        predecessor = bytes32(0);
        salt = keccak256(abi.encode("SIP_RAISE_GOVERNANCE_DELAY_V1", newDelay));
    }

    function _logDeployment(Deployment memory deployment) internal view {
        console2.log("");
        console2.log("=== SIP deployed on chain", block.chainid, "===");
        console2.log("");
        console2.log("Timelock (governs code)     ", address(deployment.timelock));
        console2.log("Governance bootstrap (spent)", address(deployment.governanceBootstrap));
        console2.log("VaultFactory                ", address(deployment.factory));
        console2.log("Factory bootstrap (spent)   ", address(deployment.factoryBootstrap));
        console2.log("Vault implementation        ", address(deployment.vaultImplementation));
        console2.log("Cohort beacon               ", deployment.beacon);
        console2.log("SettlementExecutor (Phase 0)", address(deployment.settlementExecutor));
        console2.log("SipVolumeExecutor  (Phase 1)", address(deployment.volumeExecutor));
        console2.log("ProtocolPauseController     ", address(deployment.pauseController));
        console2.log("AttesterRegistry            ", address(deployment.attesterRegistry));
        console2.log("AdapterRegistry (vault immutable)", address(deployment.adapterRegistry));
        console2.log("FeeController (0 bps, not pinned)", address(deployment.feeController));
        console2.log("FeeCollector  (not pinned)  ", address(deployment.feeCollector));
        console2.log("WETH (pinned, verified)     ", deployment.weth);
        console2.log("Cohort id                   ", deployment.cohortId);
        console2.log("Deploy block                ", deployment.deployBlock);

        _logWorkerEnv(deployment);
        _logWebsiteEnv(deployment);
        _logWhatThisIs(deployment);
    }

    /// @dev Pasteable into packages/worker/.env, which refuses to start with any
    ///      of these blank — on purpose, because the forked project's addresses
    ///      carry a savings rate that meant a percentage of PROFIT and would skim
    ///      roughly a hundred times what a SIP user agreed to.
    function _logWorkerEnv(Deployment memory deployment) private view {
        console2.log("");
        console2.log("--- packages/worker/.env ---");
        console2.log(string.concat("SIP_VAULT_FACTORY=", vm.toString(address(deployment.factory))));
        console2.log(string.concat("SIP_SETTLEMENT_EXECUTOR=", vm.toString(address(deployment.settlementExecutor))));
        console2.log(string.concat("SIP_LOGS_FROM_BLOCK=", vm.toString(deployment.deployBlock)));
        console2.log(string.concat("SIP_CHAIN_ID=", vm.toString(block.chainid)));
        console2.log("# Phase 1, when the worker moves to it. The Privy policy that");
        console2.log("# bounds the worker's seat pins the executor address, so update");
        console2.log("# that policy BEFORE switching or every signature is denied.");
        console2.log(string.concat("# SIP_SETTLEMENT_EXECUTOR=", vm.toString(address(deployment.volumeExecutor))));
    }

    /// @dev Pasteable into packages/website-oficial/.env.local. The variable names
    ///      still carry the NUVEM_ prefix because that is what the site reads; the
    ///      ADDRESSES are SIP's own and share nothing with the forked deployment.
    function _logWebsiteEnv(Deployment memory deployment) private view {
        console2.log("");
        console2.log("--- packages/website-oficial/.env.local ---");
        console2.log(string.concat("NUVEM_VAULT_FACTORY=", vm.toString(address(deployment.factory))));
        console2.log(string.concat("NUVEM_SETTLEMENT_EXECUTOR=", vm.toString(address(deployment.settlementExecutor))));
        console2.log(string.concat("NUVEM_WETH=", vm.toString(deployment.weth)));
        console2.log(string.concat("NUVEM_PAUSE_CONTROLLER=", vm.toString(address(deployment.pauseController))));
        console2.log(string.concat("NUVEM_ATTESTER_REGISTRY=", vm.toString(address(deployment.attesterRegistry))));
        console2.log(string.concat("NUVEM_COHORT_ID=", vm.toString(uint256(deployment.cohortId))));
        console2.log(string.concat("NUVEM_CHAIN_ID=", vm.toString(block.chainid)));
        console2.log(string.concat("NUVEM_LOGS_FROM_BLOCK=", vm.toString(deployment.deployBlock)));
    }

    function _logWhatThisIs(Deployment memory deployment) private view {
        address governor = deployment.pauseController.guardian();

        console2.log("");
        console2.log("--- WHAT THIS DEPLOYMENT IS ---");
        console2.log("ONE LEDGER, ZERO DELAY, GUARDIAN DIRECT.");
        console2.log("Governor (proposer/executor/canceller/guardian/fee owner)", governor);
        console2.log("Timelock minimum delay (seconds)", deployment.timelock.getMinDelay());
        console2.log("Factory owner is the timelock, ownership ACCEPTED (not pending).");
        console2.log("The schedule+execute pair that accepts it RAN INSIDE THIS DEPLOYMENT.");
        console2.log("THERE IS NO LEFTOVER CEREMONY: nothing for the Ledger to schedule, and");
        console2.log("no runbook step to remember. If it had not landed, the run would have");
        console2.log("reverted and NOTHING would have been broadcast.");
        console2.log("Every governance action from here is TWO transactions: schedule, then execute.");
        console2.log("At delay 0 there is NO window in which a user can exit ahead of an");
        console2.log("upgrade. That is the cost, and (1) below is what closes it.");
        console2.log("");
        console2.log("--- PERMANENT: configureProtocol IS SPENT ---");
        console2.log("WETH, pause controller, attester registry and settlement executor are");
        console2.log("pinned on this factory forever. Ownership can move; these cannot.");
        console2.log("");
        console2.log("--- HARDENING, WITH NO REDEPLOY ---");
        console2.log("(1) RAISE THE DELAY. updateDelay is callable only by the timelock, so");
        console2.log("    the owner schedules this on the timelock and executes it.");
        console2.log("    target =", address(deployment.timelock));

        (, bytes memory data,, bytes32 salt) = raiseDelayOperation(2 days);
        console2.log("    example (2 days) calldata");
        console2.logBytes(data);
        console2.log("    example (2 days) salt");
        console2.logBytes32(salt);
        console2.log("    predecessor = 0x0, value = 0, delay = current minDelay");
        console2.log("");
        console2.log("(2) HAND GOVERNANCE TO A SAFE. Grant PROPOSER_ROLE, EXECUTOR_ROLE and");
        console2.log("    CANCELLER_ROLE to the Safe and revoke all three from the Ledger,");
        console2.log("    as one batch on the timelock itself. Do it in that order: a batch");
        console2.log("    that revokes first and grants second leaves governance dead.");
        console2.log("");
        console2.log("(3) SPLIT THE OWNERSHIPS. Factory, pause controller, attester registry");
        console2.log("    and adapter registry are separate Ownable2Step surfaces pointing");
        console2.log("    at one timelock today. renounceOwnership is disabled on all of");
        console2.log("    them, so none can be dropped by accident.");
    }
}

/// @notice Environment-driven, permanent SIP deployment.
/// @dev NOTHING here has a default, because every field is either permanent or
///      the difference between this deployment and a disposable one. `vm.envAddress`
///      reverts on a missing variable, which is the behaviour we want: a blank
///      SIP_OWNER must stop the run, never fall back to the deployer.
///
///      Running without `--broadcast` simulates the whole thing, including the
///      handover, which is the cheapest possible rehearsal of a permanent event.
contract DeploySip is SipDeploymentBase {
    function run() external returns (Deployment memory deployment) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        DeploymentConfig memory config = DeploymentConfig({
            owner: vm.envAddress("SIP_OWNER"),
            deployer: vm.addr(deployerPrivateKey),
            attester: vm.envAddress("SIP_ATTESTER"),
            weth: vm.envAddress("SIP_WETH"),
            expectedChainId: vm.envUint("SIP_CHAIN_ID")
        });

        vm.startBroadcast(deployerPrivateKey);
        deployment = _deployCore(config);
        vm.stopBroadcast();

        _logDeployment(deployment);
    }
}
