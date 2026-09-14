// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AdapterRegistry} from "../src/registry/AdapterRegistry.sol";
import {console2} from "forge-std/console2.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";
import {NuvemTypes} from "../src/types/NuvemTypes.sol";

interface IBeaconLike {
    function implementation() external view returns (address);
    function upgradeTo(address) external;
    function owner() external view returns (address);
}

interface IFactoryLike {
    function createVault(bytes32 userSalt, uint32 cohortId, bytes calldata initData)
        external
        returns (bytes32, address);
    function protocolConfiguration() external view returns (address, address, address, address);
    function protocolConfigured() external view returns (bool);
    function owner() external view returns (address);
    function cohorts(uint32) external view returns (address, address, address, uint64);
}

interface IExecutorLike {
    function previewContribution(NuvemTypes.SettlementAttestation calldata a) external view returns (uint256);
    function factory() external view returns (address);
}

interface IVaultReads {
    function getTradingAccount(address) external view returns (NuvemTypes.TradingAccount memory);
    function settlementPaused() external view returns (bool);
    function settlementExecutor() external view returns (address);
    function adminEpoch() external view returns (uint64);
    function localPauseEpoch() external view returns (uint64);
    function policyHash(address) external view returns (bytes32);
    function accountRollingCapStatus(address) external view returns (NuvemTypes.RollingCapStatus memory);
    function aggregateRollingCapStatus() external view returns (NuvemTypes.RollingCapStatus memory);
    function vaultAdmin() external view returns (address);
    function vaultId() external view returns (bytes32);
    function vaultPolicyNonce() external view returns (uint64);
    function aggregateLifetimeContribution() external view returns (uint128);
}

contract ForkUpgradeCompat is Test {
    address constant FACTORY = 0x2a6a5d51677aA52674DF1380a5743fBf601ca9b0;
    address constant BEACON = 0xfDEa3541e8C586E530A2dF7fFFB291F046b42D1c;
    address constant OLD_IMPL = 0x16Ad7C7420A9B6485f5A4219E29DD6Ed1B502543;
    address constant TIMELOCK = 0x7E60F177599F6F59ca7DCb39064C4356A39624e8;
    address constant LIVE_VAULT = 0x0b5036063527bA4e32032e1b6B953c3677386BBD;
    address constant LIVE_EXECUTOR = 0x5D037fE7Fd65745BA51DDb433Aa5B17E965D46Ac;
    address constant TRADING_ACCOUNT = 0xA93095bB98e8B578e1560deD648D194FE4A335fA;

    address weth;
    address pauseController;
    address attesterRegistry;
    address settlementExecutor;

    /// @dev True only when FORK_RPC is set. Every test below is a no-op without
    ///      it, rather than a failure: this suite needs a live mainnet archive
    ///      node, and a plain `forge test` on a laptop or in CI has none. A test
    ///      that fails for want of an environment variable trains everyone to
    ///      ignore a red suite, which is a worse outcome than not running it.
    bool internal forked;

    modifier onlyForked() {
        if (!forked) return;
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
        (weth, pauseController, attesterRegistry, settlementExecutor) =
            IFactoryLike(FACTORY).protocolConfiguration();
    }

    function _oldInitData(uint128 cap) internal view returns (bytes memory) {
        // OLD VaultInitialization: 4 addresses + VaultPolicy{uint128}
        return abi.encode(weth, pauseController, attesterRegistry, settlementExecutor, uint256(cap));
    }

    /**
     * @dev Now IDENTICAL to `_oldInitData` — five words either way — because the
     *      adapter registry left `VaultInitialization` and became an immutable of
     *      the implementation. Kept as a separate function so the two call sites
     *      still read as "the shape this build encodes" versus "the shape the
     *      deployed factory expects", and so the day they diverge again is a diff
     *      on one line rather than a silent equality.
     */
    function _newInitData(address, uint128 cap) internal view returns (bytes memory) {
        return abi.encode(
            NuvemTypes.VaultInitialization({
                weth: weth,
                pauseController: pauseController,
                attesterRegistry: attesterRegistry,
                settlementExecutor: settlementExecutor,
                policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: cap})
            })
        );
    }

    /// CONTROL: with the CURRENTLY DEPLOYED implementation, createVault works.
    function test_A_control_createVault_works_today() public onlyForked {
        address user = address(uint160(uint256(keccak256("nuvem-control-user"))));
        vm.prank(user);
        (, address vault) = IFactoryLike(FACTORY).createVault(bytes32("s1"), 1, _oldInitData(1 ether));
        console2.log("control vault created:", vault);
        assertTrue(vault.code.length > 0);
    }

    /**
     * Q1: after upgrading the beacon, can new vaults still be created?
     *
     * THIS ASSERTION IS INVERTED FROM WHAT IT WAS, and the history is the reason
     * to keep the test. With `adapterRegistry` in `VaultInitialization`,
     * `initialize` called the FIVE-argument `isProtocolConfiguration`; the factory
     * deployed on mainnet has only the four-argument form, so all three initData
     * shapes reverted with `FailedCall()` and the product stopped taking new users
     * the moment the beacon moved. Measured on this fork, not reasoned about.
     *
     * The registry is now an implementation immutable and the gate call is back to
     * four arguments, so the same three calls must SUCCEED.
     */
    function test_B_createVault_after_upgrade() public onlyForked {
        PersonalVault newImpl = new PersonalVault(address(new AdapterRegistry(address(this), address(this))));
        assertEq(IBeaconLike(BEACON).owner(), TIMELOCK, "beacon owner");
        vm.prank(TIMELOCK);
        IBeaconLike(BEACON).upgradeTo(address(newImpl));
        assertEq(IBeaconLike(BEACON).implementation(), address(newImpl), "upgraded");

        address user = address(uint160(uint256(keccak256("nuvem-post-upgrade-user"))));

        vm.prank(user);
        (bool ok, bytes memory ret) = FACTORY.call(
            abi.encodeWithSelector(
                IFactoryLike.createVault.selector, bytes32("s2"), uint32(1), _newInitData(address(0), 1 ether)
            )
        );
        console2.log("createVault(this build's initData) ok:", ok);
        console2.logBytes(ret);
        assertTrue(ok, "a new vault must be creatable on the upgraded beacon");

        // The shape the deployed factory has always expected. Identical bytes to
        // the line above now, and asserted separately so a future divergence
        // shows up as a failing test rather than as a silent equality.
        address other = address(uint160(uint256(keccak256("nuvem-post-upgrade-user-2"))));
        vm.prank(other);
        (ok,) = FACTORY.call(
            abi.encodeWithSelector(
                IFactoryLike.createVault.selector, bytes32("s4"), uint32(1), _oldInitData(1 ether)
            )
        );
        console2.log("createVault(deployed-factory initData) ok:", ok);
        assertTrue(ok, "the deployed factory's own shape must still work");
    }

    /// Q1 supporting: the 5-arg selector simply does not exist on the live factory.
    function test_C_selector_absent_on_live_factory() public onlyForked {
        bytes4 five = bytes4(keccak256("isProtocolConfiguration(address,address,address,address,address)"));
        bytes4 four = bytes4(keccak256("isProtocolConfiguration(address,address,address,address)"));
        console2.logBytes4(five);
        console2.logBytes4(four);

        (bool ok5, bytes memory r5) = FACTORY.staticcall(
            abi.encodeWithSelector(five, weth, pauseController, attesterRegistry, settlementExecutor, weth)
        );
        (bool ok4, bytes memory r4) =
            FACTORY.staticcall(abi.encodeWithSelector(four, weth, pauseController, attesterRegistry, settlementExecutor));
        console2.log("5-arg ok:", ok5, "returndata len:", r5.length);
        console2.log("4-arg ok:", ok4, "returndata len:", r4.length);
        assertFalse(ok5, "5-arg should not exist");
        assertTrue(ok4, "4-arg should exist");
        assertTrue(abi.decode(r4, (bool)), "4-arg true");
    }

    /// Q2: configureProtocol is one-shot and already fired.
    function test_D_configureProtocol_is_burned() public onlyForked {
        assertTrue(IFactoryLike(FACTORY).protocolConfigured(), "already configured");
        address owner = IFactoryLike(FACTORY).owner();
        // try the 5-field configureProtocol (new ABI) and the 4-field one (deployed ABI)
        bytes4 sel5 = bytes4(keccak256("configureProtocol((address,address,address,address,address))"));
        bytes4 sel4 = bytes4(keccak256("configureProtocol((address,address,address,address))"));
        vm.prank(owner);
        (bool ok5,) = FACTORY.call(
            abi.encodeWithSelector(sel5, weth, pauseController, attesterRegistry, settlementExecutor, weth)
        );
        vm.prank(owner);
        (bool ok4,) =
            FACTORY.call(abi.encodeWithSelector(sel4, weth, pauseController, attesterRegistry, settlementExecutor));
        console2.log("owner configureProtocol 5-field ok:", ok5);
        console2.log("owner configureProtocol 4-field ok:", ok4);
        assertFalse(ok5);
        assertFalse(ok4);
    }

    /// Q3/Q5: after upgrade, does the live vault still answer everything the
    /// live SettlementExecutor calls on it?
    function test_E_live_vault_reads_after_upgrade() public onlyForked {
        _probeVault("BEFORE");
        PersonalVault newImpl = new PersonalVault(address(new AdapterRegistry(address(this), address(this))));
        vm.prank(TIMELOCK);
        IBeaconLike(BEACON).upgradeTo(address(newImpl));
        _probeVault("AFTER");
    }

    function _probeVault(string memory tag) internal view {
        string[9] memory names = [
            "getTradingAccount(address)",
            "settlementPaused()",
            "settlementExecutor()",
            "adminEpoch()",
            "localPauseEpoch()",
            "policyHash(address)",
            "accountRollingCapStatus(address)",
            "aggregateRollingCapStatus()",
            "vaultAdmin()"
        ];
        for (uint256 i = 0; i < names.length; i++) {
            bytes4 sel = bytes4(keccak256(bytes(names[i])));
            bytes memory cd;
            if (i == 0 || i == 5 || i == 6) {
                cd = abi.encodeWithSelector(sel, TRADING_ACCOUNT);
            } else {
                cd = abi.encodeWithSelector(sel);
            }
            (bool ok, bytes memory ret) = LIVE_VAULT.staticcall(cd);
            console2.log(tag, names[i], ok, ret.length);
        }
        // executor read path
        (bool okA,) = LIVE_EXECUTOR.staticcall(abi.encodeWithSignature("factory()"));
        console2.log(tag, "executor.factory()", okA);
    }

    /// Q4: the only thing the factory ever calls on a vault is initialize().
    function test_F_factory_only_calls_initialize() public onlyForked {
        // initialize selector must exist on the new implementation
        bytes4 sel = bytes4(keccak256("initialize(bytes32,address,address,uint32,bytes)"));
        console2.logBytes4(sel);
        assertEq(sel, PersonalVault.initialize.selector);
    }

    /// Q5: live executor previewContribution read path across the upgrade.
    function test_G_preview_contribution_path() public onlyForked {
        NuvemTypes.TradingAccount memory acct = IVaultReads(LIVE_VAULT).getTradingAccount(TRADING_ACCOUNT);
        console2.log("account status:", uint8(acct.status));
        console2.log("bindingEpoch:", acct.bindingEpoch);
        console2.log("policyNonce:", acct.policyNonce);
        console2.log("settlementNonce:", acct.settlementNonce);
        console2.log("savingsBps:", acct.policy.savingsBps);

        NuvemTypes.SettlementAttestation memory a;
        a.account = TRADING_ACCOUNT;
        a.vault = LIVE_VAULT;
        a.executor = LIVE_EXECUTOR;
        a.chainId = block.chainid;
        a.cashStart = 0;
        a.cashEnd = 1 ether;

        uint256 before_ = IExecutorLike(LIVE_EXECUTOR).previewContribution(a);
        console2.log("previewContribution BEFORE:", before_);

        PersonalVault newImpl = new PersonalVault(address(new AdapterRegistry(address(this), address(this))));
        vm.prank(TIMELOCK);
        IBeaconLike(BEACON).upgradeTo(address(newImpl));

        uint256 after_ = IExecutorLike(LIVE_EXECUTOR).previewContribution(a);
        console2.log("previewContribution AFTER:", after_);
    }
}
