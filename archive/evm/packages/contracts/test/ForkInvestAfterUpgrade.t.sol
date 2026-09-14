// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PersonalVault} from "../src/vault/PersonalVault.sol";
import {NuvemTypes} from "../src/types/NuvemTypes.sol";
import {AdapterRegistry} from "../src/registry/AdapterRegistry.sol";
import {IInvestmentAdapter} from "../src/interfaces/IInvestmentAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * CAN AN ALREADY-INITIALISED VAULT INVEST AFTER A BEACON UPGRADE?
 *
 * The answer used to be NO, and this file recorded why. Measured against a
 * mainnet fork, with `adapterRegistry` stored per vault and written in
 * `initialize`:
 *
 *   - the slot read address(0) before AND after the upgrade, because the upgrade
 *     writes no storage and `initialize` had already run;
 *   - `setInvestmentPolicy` nevertheless SUCCEEDED — nonce 1, `enabled` set, event
 *     emitted — so the admin saw a configured, switched-on vault;
 *   - and every `invest()` reverted with empty returndata, calling address zero.
 *
 * That is the silent failure this codebase exists to refuse, and it was reachable
 * for every vault that existed. Separately, calling the FIVE-argument
 * `isProtocolConfiguration` made `createVault` revert with `FailedCall()` for
 * every new vault, because the deployed factory has only the four-argument form
 * and `configureProtocol` is one-shot.
 *
 * The registry is now an IMMUTABLE OF THE IMPLEMENTATION, so it arrives in the
 * bytecode with the upgrade for every proxy on the beacon at once, and the gate
 * call is back to four arguments. Every assertion below is the inverse of what it
 * was, which is the point: this file is the proof that the fix is real, and it
 * runs against the actual vault holding actual money.
 *
 * Run: FORK_RPC=<mainnet rpc> forge test --match-path test/ForkInvestAfterUpgrade.t.sol -vv
 */

contract StockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

contract HonestAdapter is IInvestmentAdapter {
    function executeInvestment(address tokenIn, address targetAsset, uint256 amountIn, uint256, uint48)
        external
        override
        returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        StockToken(targetAsset).mint(msg.sender, amountIn);
        return amountIn;
    }
}

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
}

interface IExecutorLike {
    function previewContribution(NuvemTypes.SettlementAttestation calldata a) external view returns (uint256);
}

contract ForkInvestAfterUpgrade is Test {
    address constant FACTORY = 0x2a6a5d51677aA52674DF1380a5743fBf601ca9b0;
    address constant BEACON = 0xfDEa3541e8C586E530A2dF7fFFB291F046b42D1c;
    address constant TIMELOCK = 0x7E60F177599F6F59ca7DCb39064C4356A39624e8;
    address constant LIVE_VAULT = 0x0b5036063527bA4e32032e1b6B953c3677386BBD;
    address constant VAULT_ADMIN = 0xB284f131eE5728272FA5fF1F6eae0896B4e2A3AA;
    address constant LIVE_EXECUTOR = 0x5D037fE7Fd65745BA51DDb433Aa5B17E965D46Ac;
    address constant TRADING_ACCOUNT = 0xA93095bB98e8B578e1560deD648D194FE4A335fA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    uint256 constant BASE = uint256(0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200);
    /// investmentPolicyNonce(64) | investmentEnabled(8) | investmentPaused(8).
    /// The address that used to open this word is gone; see the file header.
    bytes32 constant SLOT_INVESTMENT_PACKED = bytes32(BASE + 47);

    bool internal forked;
    AdapterRegistry internal registry;

    modifier onlyForked() {
        if (!forked) return;
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        forked = true;
    }

    /// @dev The upgrade exactly as governance would do it: deploy a registry,
    ///      deploy an implementation carrying it, point the beacon at it.
    function _upgrade() internal returns (address impl) {
        registry = new AdapterRegistry(address(this), address(this));
        impl = address(new PersonalVault(address(registry)));
        vm.prank(TIMELOCK);
        IBeaconLike(BEACON).upgradeTo(impl);
        assertEq(IBeaconLike(BEACON).implementation(), impl, "beacon upgraded");
    }

    function _initData(uint128 cap) internal view returns (bytes memory) {
        (address weth, address pause, address attester, address executor) =
            IFactoryLike(FACTORY).protocolConfiguration();
        return abi.encode(
            NuvemTypes.VaultInitialization({
                weth: weth,
                pauseController: pause,
                attesterRegistry: attester,
                settlementExecutor: executor,
                policy: NuvemTypes.VaultPolicy({maxAggregateRolling30dWei: cap})
            })
        );
    }

    // ── 1. the regression that made the previous attempt unshippable ─────────

    /**
     * `createVault` REVERTED for every new vault after the previous upgrade,
     * because `initialize` called a five-argument selector the deployed factory
     * does not have. Nothing about investing; the whole product stopped taking
     * new users. Measured then, asserted now in the other direction.
     */
    function test_1_createVault_still_works_after_upgrade() public onlyForked {
        _upgrade();
        address user = address(uint160(uint256(keccak256("nuvem-post-fix-user"))));

        // BUILT BEFORE THE PRANK, NOT INSIDE THE ARGUMENT LIST. `_initData` reads
        // `protocolConfiguration()` from the factory, and Solidity evaluates
        // arguments before the call — so writing it inline spends the prank on
        // that read and `createVault` arrives from the test contract instead of
        // from `user`. The vault is still created, which is why this surfaces as a
        // confusing `vaultAdmin` mismatch rather than as a revert. Same trap that
        // bit `vm.expectRevert` elsewhere in this suite.
        bytes memory initData = _initData(1 ether);

        vm.prank(user);
        (, address vault) = IFactoryLike(FACTORY).createVault(bytes32("fix1"), 1, initData);
        console2.log("new vault created on the upgraded beacon:", vault);
        assertTrue(vault.code.length > 0, "a new vault must still be creatable");
        assertEq(PersonalVault(payable(vault)).vaultAdmin(), user);
    }

    // ── 2. the registry now reaches a vault that already existed ─────────────

    function test_2_adapterRegistry_arrives_with_the_upgrade() public onlyForked {
        // Before: the live vault has no such function at all.
        (bool okBefore,) = LIVE_VAULT.staticcall(abi.encodeWithSignature("ADAPTER_REGISTRY()"));
        assertFalse(okBefore, "the deployed implementation has no ADAPTER_REGISTRY");

        address impl = _upgrade();

        // After: the SAME proxy, untouched by any transaction, answers with the
        // registry. No migration call, no per-vault write, no storage slot.
        assertEq(PersonalVault(payable(LIVE_VAULT)).ADAPTER_REGISTRY(), address(registry));
        assertEq(PersonalVault(payable(impl)).ADAPTER_REGISTRY(), address(registry));
        // And the storage word that used to hold it is still virgin — nothing was
        // written to this vault to make the line above true.
        assertEq(PersonalVault(payable(LIVE_VAULT)).extsload(SLOT_INVESTMENT_PACKED), bytes32(0));
    }

    // ── 3. the whole point, end to end, with nothing forced ──────────────────

    /**
     * NO `vm.store` ANYWHERE IN THIS TEST. The previous version of this file could
     * only make `invest()` succeed by planting the registry into storage with a
     * cheat code — something no transaction could do — which was the clearest
     * possible statement that the design did not work. This runs the real path:
     * configure a basket as the admin, call invest as the admin, and check the
     * vault actually holds the asset afterwards.
     */
    function test_3_configure_and_invest_end_to_end() public onlyForked {
        _upgrade();
        PersonalVault v = PersonalVault(payable(LIVE_VAULT));

        HonestAdapter adapter = new HonestAdapter();
        StockToken stock = new StockToken();
        bytes32 adapterId = keccak256("nuvem.adapter.stock.v1");
        registry.registerAdapter(adapterId, address(adapter));

        NuvemTypes.BasketLeg[] memory legs = new NuvemTypes.BasketLeg[](1);
        legs[0] = NuvemTypes.BasketLeg({targetAsset: address(stock), weightBps: 10_000, minOutRateWad: 1});

        uint256 wethBefore = IERC20(WETH).balanceOf(LIVE_VAULT);
        console2.log("vault WETH before:", wethBefore);
        assertGt(wethBefore, 0, "this test is only meaningful against a funded vault");

        vm.prank(VAULT_ADMIN);
        v.setInvestmentPolicy(legs, 1, 1 ether, 1 ether, adapterId, true);
        assertEq(v.investmentPolicyNonce(), 1, "policy stored");

        uint256 amountIn = 1e14;
        uint256[] memory minOut = new uint256[](1);
        vm.prank(VAULT_ADMIN);
        v.invest(legs, amountIn, minOut, uint48(block.timestamp + 1 hours), uint64(1), uint64(1));

        console2.log("stock bought by the vault:", stock.balanceOf(LIVE_VAULT));
        console2.log("vault WETH after :", IERC20(WETH).balanceOf(LIVE_VAULT));
        assertEq(stock.balanceOf(LIVE_VAULT), amountIn, "the vault received the asset");
        assertEq(IERC20(WETH).balanceOf(LIVE_VAULT), wethBefore - amountIn, "and paid for it out of its own savings");
    }

    // ── 4. and settlement is untouched by any of it ──────────────────────────

    function test_4_settlement_is_unaffected() public onlyForked {
        NuvemTypes.SettlementAttestation memory a;
        a.account = TRADING_ACCOUNT;
        a.vault = LIVE_VAULT;
        a.executor = LIVE_EXECUTOR;
        a.chainId = block.chainid;
        a.cashStart = 0;
        a.cashEnd = 1 ether;

        uint256 before_ = IExecutorLike(LIVE_EXECUTOR).previewContribution(a);
        _upgrade();
        uint256 after_ = IExecutorLike(LIVE_EXECUTOR).previewContribution(a);

        console2.log("previewContribution BEFORE:", before_);
        console2.log("previewContribution AFTER :", after_);
        assertEq(after_, before_, "the money path must not move");
        assertEq(
            PersonalVault(payable(LIVE_VAULT)).policyHash(TRADING_ACCOUNT),
            0xac799f5afe7a5ac166af9a65d8d7eb023ee0a7ef567bb30dfed822468c337ef0,
            "the existing binding's policyHash must survive, or every attestation in flight is void"
        );
    }

    // ── 5. the configuration that produced the silent failure is unbuildable ──

    /**
     * The old failure needed a zero registry. The constructor refuses one, so an
     * implementation that could reproduce it cannot be deployed — which is a
     * stronger guarantee than a runtime check, and is asserted here rather than
     * assumed because "the constructor validates it" is exactly the kind of claim
     * that quietly stops being true.
     */
    function test_5_an_implementation_without_a_registry_cannot_exist() public onlyForked {
        vm.expectRevert(PersonalVault.ZeroAddress.selector);
        new PersonalVault(address(0));

        address eoa = address(uint160(uint256(keccak256("not-a-contract"))));
        vm.expectRevert(abi.encodeWithSelector(PersonalVault.NotAContract.selector, eoa));
        new PersonalVault(eoa);
    }
}
