// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {NuvemUsdgSavingsAdapter} from "../src/adapters/NuvemUsdgSavingsAdapter.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IVaultMeta {
    function asset() external view returns (address);
    function decimals() external view returns (uint8);
    function name() external view returns (string memory);
    function previewDeposit(uint256 assets) external view returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}

/**
 * @notice Deploys NuvemUsdgSavingsAdapter and prints the governance operation
 *         that puts it into service. IT DOES NOT REGISTER IT.
 *
 * WHY THIS VALIDATES MORE THAN THE CONSTRUCTOR CAN. The adapter is immutable —
 * no owner, no setters, no pause — so every value here is welded in and can only
 * be replaced by deploying again. The constructor checks what it can afford to
 * check: non-zero addresses, WETH sorting below USDG, a positive tick spacing,
 * and that the yield vault's asset() really is USDG. It cannot afford to look at
 * the POOL, and that is where a wrong value survives every structural test —
 * a pool that was never initialised means every purchase reverts forever on a
 * contract that cost a governance cycle to install.
 *
 * THE CHECK THAT EXISTS BECAUSE OF A MISTAKE MADE ON 2026-08-29. An earlier
 * draft of the adapter gated deposits on `maxDeposit` and refused when it came
 * back short. Morpho Vault V2 returns ZERO from every max* by design, so that
 * would have bricked the yield route permanently; reports/YIELD_2026-08-24.md
 * says exactly this and says never to use max* as a gate. The honest question is
 * `previewDeposit`, and it is asked here — before deployment, where the answer
 * is still free — rather than in the money path where a wrong reading is fatal.
 */
contract DeployUsdgSavingsAdapter is Script {
    uint256 internal constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    /// @dev v4 keeps pools in a mapping at slot 6; liquidity sits 3 words in.
    uint256 internal constant POOL_MANAGER_POOLS_SLOT = 6;
    uint256 internal constant POOL_STATE_LIQUIDITY_OFFSET = 3;

    /// @dev Above this a fee is not a fee. This chain carries 85%+ traps.
    uint24 internal constant MAX_PLAUSIBLE_POOL_FEE = 100_000;

    error UnsupportedChain(uint256 chainId);
    error PoolNotInitialized(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolEmpty(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolFeeImplausible(uint24 fee);
    error YieldVaultWrongAsset(address expected, address actual);
    error YieldVaultRefusesDeposits(address vault);
    error YieldVaultIsACurrency(address vault);

    struct Config {
        address weth;
        address usdg;
        address poolManager;
        uint24 wethUsdgFee;
        int24 wethUsdgTickSpacing;
        /// @dev address(0) deploys a plain-dollars adapter with no yield route.
        address yieldVault;
    }

    function run() external returns (NuvemUsdgSavingsAdapter adapter) {
        if (block.chainid != ROBINHOOD_MAINNET_CHAIN_ID && block.chainid != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(block.chainid);
        }

        Config memory config = _readConfig();
        validate(config);

        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        adapter = new NuvemUsdgSavingsAdapter(
            config.weth, config.usdg, config.poolManager, config.wethUsdgFee, config.wethUsdgTickSpacing, config.yieldVault
        );
        vm.stopBroadcast();

        _log(config, address(adapter));
    }

    /**
     * @dev Every value comes from the environment and none is defaulted. A
     *      default here would be this script choosing, on the operator's behalf,
     *      an address that gets welded into an immutable contract.
     *      `vm.envAddress` reverts on a missing variable, which is correct: an
     *      unset variable should stop a deployment, not silently pick something.
     */
    function _readConfig() internal view returns (Config memory config) {
        config.weth = vm.envAddress("NUVEM_WETH");
        config.usdg = vm.envAddress("NUVEM_USDG");
        config.poolManager = vm.envAddress("NUVEM_POOL_MANAGER");
        config.wethUsdgFee = uint24(vm.envUint("NUVEM_WETH_USDG_FEE"));
        config.wethUsdgTickSpacing = int24(int256(vm.envInt("NUVEM_WETH_USDG_TICK_SPACING")));
        // The only optional one: unset means plain dollars and nothing else.
        config.yieldVault = vm.envOr("NUVEM_INVEST_YIELD_VAULT", address(0));
    }

    function validate(Config memory config) public view {
        _requireWethUsdgPool(config);

        if (config.yieldVault == address(0)) return;
        if (config.yieldVault == config.usdg || config.yieldVault == config.weth) {
            revert YieldVaultIsACurrency(config.yieldVault);
        }

        address underlying = IVaultMeta(config.yieldVault).asset();
        if (underlying != config.usdg) revert YieldVaultWrongAsset(config.usdg, underlying);

        // THE DEPOSIT IS PRICED, NOT MERELY PERMITTED. previewDeposit is the
        // question EIP-4626 answers honestly — it may not promise more than a
        // deposit delivers — where max* is a Vault V2 constant zero and means
        // nothing. A vault that prices one dollar at zero shares would take the
        // money and mint nothing.
        uint256 oneDollar = 10 ** IERC20Meta(config.usdg).decimals();
        if (IVaultMeta(config.yieldVault).previewDeposit(oneDollar) == 0) {
            revert YieldVaultRefusesDeposits(config.yieldVault);
        }
    }

    function _requireWethUsdgPool(Config memory config) internal view {
        if (config.wethUsdgFee > MAX_PLAUSIBLE_POOL_FEE) revert PoolFeeImplausible(config.wethUsdgFee);

        // The adapter hardcodes WETH as currency0, which its constructor enforces
        // by refusing an inverted pair; the key built here must match it exactly
        // or this validates a pool the adapter will never touch.
        (address currency0, address currency1) = uint160(config.weth) < uint160(config.usdg)
            ? (config.weth, config.usdg)
            : (config.usdg, config.weth);
        bytes32 poolId =
            keccak256(abi.encode(currency0, currency1, config.wethUsdgFee, config.wethUsdgTickSpacing, address(0)));
        bytes32 base = keccak256(abi.encode(poolId, POOL_MANAGER_POOLS_SLOT));

        uint160 sqrtPriceX96 = uint160(uint256(IExtsload(config.poolManager).extsload(base)));
        if (sqrtPriceX96 == 0) {
            revert PoolNotInitialized(currency0, currency1, config.wethUsdgFee, config.wethUsdgTickSpacing);
        }

        uint128 liquidity = uint128(
            uint256(IExtsload(config.poolManager).extsload(bytes32(uint256(base) + POOL_STATE_LIQUIDITY_OFFSET)))
        );
        if (liquidity == 0) revert PoolEmpty(currency0, currency1, config.wethUsdgFee, config.wethUsdgTickSpacing);
    }

    /**
     * @dev DERIVED FROM THE ADDRESS, NOT CHOSEN — the same rule the stock
     *      adapter's script states, for the same reason: a hand-picked id is a
     *      value that has to be kept in sync across the registry, every vault's
     *      adapterId, and whatever the operator wrote down. Deriving it means one
     *      adapter has exactly one id and two can never collide, which matters
     *      because resolveActiveAdapter takes the ID, so a reused one silently
     *      repoints every vault holding it.
     *
     *      The label differs from the stock adapter's so the two families cannot
     *      collide even if an address somehow repeated across chains.
     */
    function adapterIdFor(address adapter) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("NUVEM_USDG_SAVINGS_ADAPTER_V1", adapter));
    }

    function _log(Config memory config, address adapter) internal view {
        console2.log("");
        console2.log("NuvemUsdgSavingsAdapter deployed");
        console2.log("  address        ", adapter);
        console2.log("  WETH           ", config.weth);
        console2.log("  USDG           ", config.usdg);
        console2.log("  PoolManager    ", config.poolManager);
        console2.log("  WETH/USDG fee  ", uint256(config.wethUsdgFee));
        console2.log("  tickSpacing    ", int256(config.wethUsdgTickSpacing));

        if (config.yieldVault == address(0)) {
            console2.log("  yield vault     none - this deployment offers plain dollars only");
        } else {
            console2.log("  yield vault    ", config.yieldVault);
            console2.log("    name         ", IVaultMeta(config.yieldVault).name());
            // SHARE DECIMALS ARE THE VAULT'S OWN and differ between candidates:
            // spUSDG mints 6, steakUSDG 18, over the same 6-decimal dollar.
            // Printed because every downstream floor depends on which it is.
            console2.log("    share decimals", uint256(IVaultMeta(config.yieldVault).decimals()));
            uint256 oneDollar = 10 ** IERC20Meta(config.usdg).decimals();
            console2.log("    1 USDG buys   ", IVaultMeta(config.yieldVault).previewDeposit(oneDollar), "shares");
        }

        console2.log("");
        console2.log("NOT REGISTERED. Registering is a governance operation and this script");
        console2.log("does not perform it. The id is derived from the address:");
        console2.logBytes32(adapterIdFor(adapter));
        console2.log("  AdapterRegistry.registerAdapter(<the id above>, %s)", adapter);
        console2.log("");
        console2.log("Until that lands and a vault admin points at the new id, nothing");
        console2.log("reaches this contract and no user is affected either way.");
    }
}
