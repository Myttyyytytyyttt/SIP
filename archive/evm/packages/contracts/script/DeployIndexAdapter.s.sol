// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {NuvemIndexAdapter} from "../src/adapters/NuvemIndexAdapter.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
}

/**
 * @notice Deploys NuvemIndexAdapter and prints the governance operation that
 *         puts it into service. IT DOES NOT REGISTER IT.
 *
 * WHY THIS VALIDATES BOTH POOLS BEFORE BROADCASTING. The adapter is immutable —
 * no owner, no setters, no pause — so a wrong pool parameter is not a bug to
 * fix, it is a redeploy and another governance cycle. And for INDEX the stakes
 * of a wrong key are unusually concrete: at review time 107 of the 108 hookless
 * INDEX/USDG pools were empty shells or fee traps charging 85–99.99%. Exactly
 * one carries real liquidity. Reading its state here costs two eth_calls;
 * discovering a shell after deployment costs the cycle.
 */
contract DeployIndexAdapter is Script {
    uint256 internal constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    /// @dev v4 keeps pools in a mapping at slot 6; liquidity sits 3 words in.
    uint256 internal constant POOL_MANAGER_POOLS_SLOT = 6;
    uint256 internal constant POOL_STATE_LIQUIDITY_OFFSET = 3;

    /// @dev Above this a fee is not a fee. This chain carries 85%+ traps, and
    ///      the INDEX pool population is where they live.
    uint24 internal constant MAX_PLAUSIBLE_POOL_FEE = 100_000;

    error UnsupportedChain(uint256 chainId);
    error PoolNotInitialized(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolEmpty(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolFeeImplausible(uint24 fee);

    struct Config {
        address weth;
        address usdg;
        address index;
        address poolManager;
        uint24 wethUsdgFee;
        int24 wethUsdgTickSpacing;
        uint24 usdgIndexFee;
        int24 usdgIndexTickSpacing;
    }

    function run() external returns (NuvemIndexAdapter adapter) {
        if (block.chainid != ROBINHOOD_MAINNET_CHAIN_ID && block.chainid != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(block.chainid);
        }

        Config memory config = _readConfig();
        validate(config);

        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        adapter = new NuvemIndexAdapter(
            config.weth,
            config.usdg,
            config.index,
            config.poolManager,
            config.wethUsdgFee,
            config.wethUsdgTickSpacing,
            config.usdgIndexFee,
            config.usdgIndexTickSpacing
        );
        vm.stopBroadcast();

        _log(config, address(adapter));
    }

    /// @dev Every value comes from the environment and none is defaulted — an
    ///      unset variable should stop a deployment, not silently pick a value
    ///      that gets welded into an immutable contract.
    function _readConfig() internal view returns (Config memory config) {
        config.weth = vm.envAddress("NUVEM_WETH");
        config.usdg = vm.envAddress("NUVEM_USDG");
        config.index = vm.envAddress("NUVEM_INDEX");
        config.poolManager = vm.envAddress("NUVEM_POOL_MANAGER");
        config.wethUsdgFee = uint24(vm.envUint("NUVEM_WETH_USDG_FEE"));
        config.wethUsdgTickSpacing = int24(int256(vm.envInt("NUVEM_WETH_USDG_TICK_SPACING")));
        config.usdgIndexFee = uint24(vm.envUint("NUVEM_USDG_INDEX_FEE"));
        config.usdgIndexTickSpacing = int24(int256(vm.envInt("NUVEM_USDG_INDEX_TICK_SPACING")));
    }

    function validate(Config memory config) public view {
        _requirePool(
            config.poolManager, config.weth, config.usdg, config.wethUsdgFee, config.wethUsdgTickSpacing
        );
        _requirePool(
            config.poolManager, config.usdg, config.index, config.usdgIndexFee, config.usdgIndexTickSpacing
        );
    }

    function _requirePool(address poolManager, address tokenA, address tokenB, uint24 fee, int24 tickSpacing)
        internal
        view
    {
        if (fee > MAX_PLAUSIBLE_POOL_FEE) revert PoolFeeImplausible(fee);

        (address currency0, address currency1) =
            uint160(tokenA) < uint160(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);
        bytes32 poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, address(0)));
        bytes32 base = keccak256(abi.encode(poolId, POOL_MANAGER_POOLS_SLOT));

        uint160 sqrtPriceX96 = uint160(uint256(IExtsload(poolManager).extsload(base)));
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(currency0, currency1, fee, tickSpacing);

        uint128 liquidity =
            uint128(uint256(IExtsload(poolManager).extsload(bytes32(uint256(base) + POOL_STATE_LIQUIDITY_OFFSET))));
        if (liquidity == 0) revert PoolEmpty(currency0, currency1, fee, tickSpacing);
    }

    /**
     * @dev DERIVED FROM THE ADDRESS, NOT CHOSEN — the rule all three adapter
     *      families follow. The label differs from the other two so no id can
     *      collide across families even if an address repeated.
     */
    function adapterIdFor(address adapter) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("NUVEM_INDEX_ADAPTER_V1", adapter));
    }

    function _log(Config memory config, address adapter) internal view {
        console2.log("");
        console2.log("NuvemIndexAdapter deployed");
        console2.log("  address          ", adapter);
        console2.log("  WETH             ", config.weth);
        console2.log("  USDG             ", config.usdg);
        console2.log("  INDEX            ", config.index);
        console2.log("    symbol         ", IERC20Meta(config.index).symbol());
        console2.log("    decimals       ", uint256(IERC20Meta(config.index).decimals()));
        console2.log("  PoolManager      ", config.poolManager);
        // Tick spacings are constructor-checked positive, so the uint casts are lossless.
        console2.log("  WETH/USDG pool    fee %s tickSpacing %s", uint256(config.wethUsdgFee), uint256(uint24(config.wethUsdgTickSpacing)));
        console2.log("  USDG/INDEX pool   fee %s tickSpacing %s", uint256(config.usdgIndexFee), uint256(uint24(config.usdgIndexTickSpacing)));
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
