// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {NuvemPerpTokenAdapter} from "../src/adapters/NuvemPerpTokenAdapter.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

interface IVaultMeta {
    function asset() external view returns (address);
    function name() external view returns (string memory);
    function previewDeposit(uint256 assets) external view returns (uint256 shares);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}

/**
 * @notice Deploys NuvemPerpTokenAdapter for ONE Arcus pToken and prints the
 *         governance operation. IT DOES NOT REGISTER IT.
 *
 * THE ARMING GATE, WHICH IS THE POINT OF THIS SCRIPT. Measured 2026-08-30,
 * Arcus pToken deposits are GATED: previewDeposit reverts and real deposits
 * are settled asynchronously by their operator's bot. An adapter deployed
 * against that behaviour would be installable but permanently useless — every
 * purchase reverting inside deposit() — and worse, it would normalise pointing
 * governance at a venue that has not yet met the listing preconditions. So
 * validate() asks the pToken previewDeposit(one dollar) and REFUSES TO DEPLOY
 * while it reverts or answers zero. The day Arcus opens synchronous deposits,
 * this script starts passing — that is the arming signal, on chain, nobody's
 * word required.
 *
 * THE GATE IS NECESSARY, NOT SUFFICIENT. previewDeposit answering is the
 * TECHNICAL precondition. The GOVERNANCE preconditions — verified source, the
 * pToken beacon behind Arcus's timelocked multisig rather than an EOA — are
 * not machine-checkable here and remain listing requirements the operator
 * confirms by hand. The wrapper script prints them as a checklist.
 */
contract DeployPerpTokenAdapter is Script {
    uint256 internal constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    uint256 internal constant POOL_MANAGER_POOLS_SLOT = 6;
    uint256 internal constant POOL_STATE_LIQUIDITY_OFFSET = 3;
    uint24 internal constant MAX_PLAUSIBLE_POOL_FEE = 100_000;

    error UnsupportedChain(uint256 chainId);
    error PoolNotInitialized(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolEmpty(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolFeeImplausible(uint24 fee);
    error DepositsStillGated(address perpToken);
    error PerpVaultRefusesDeposits(address perpToken);

    struct Config {
        address weth;
        address usdg;
        address perpToken;
        address poolManager;
        uint24 wethUsdgFee;
        int24 wethUsdgTickSpacing;
    }

    function run() external returns (NuvemPerpTokenAdapter adapter) {
        if (block.chainid != ROBINHOOD_MAINNET_CHAIN_ID && block.chainid != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(block.chainid);
        }

        Config memory config = _readConfig();
        validate(config);

        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        adapter = new NuvemPerpTokenAdapter(
            config.weth, config.usdg, config.perpToken, config.poolManager, config.wethUsdgFee, config.wethUsdgTickSpacing
        );
        vm.stopBroadcast();

        _log(config, address(adapter));
    }

    function _readConfig() internal view returns (Config memory config) {
        config.weth = vm.envAddress("NUVEM_WETH");
        config.usdg = vm.envAddress("NUVEM_USDG");
        config.perpToken = vm.envAddress("NUVEM_PERP_TOKEN");
        config.poolManager = vm.envAddress("NUVEM_POOL_MANAGER");
        config.wethUsdgFee = uint24(vm.envUint("NUVEM_WETH_USDG_FEE"));
        config.wethUsdgTickSpacing = int24(int256(vm.envInt("NUVEM_WETH_USDG_TICK_SPACING")));
    }

    function validate(Config memory config) public view {
        _requireWethUsdgPool(config);

        // ── THE ARMING GATE ──────────────────────────────────────────────────
        // A revert here is TODAY'S EXPECTED OUTCOME, not a bug: Arcus deposits
        // are gated and this deployment must wait for them. try/catch turns the
        // pToken's own custom error into a named refusal the operator can read.
        uint256 oneDollar = 10 ** IERC20Meta(config.usdg).decimals();
        try IVaultMeta(config.perpToken).previewDeposit(oneDollar) returns (uint256 shares) {
            if (shares == 0) revert PerpVaultRefusesDeposits(config.perpToken);
        } catch {
            revert DepositsStillGated(config.perpToken);
        }
    }

    function _requireWethUsdgPool(Config memory config) internal view {
        if (config.wethUsdgFee > MAX_PLAUSIBLE_POOL_FEE) revert PoolFeeImplausible(config.wethUsdgFee);

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

    /// @dev Derived from the address, the rule every adapter family follows;
    ///      a distinct label so no id can collide across families.
    function adapterIdFor(address adapter) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("NUVEM_PERP_TOKEN_ADAPTER_V1", adapter));
    }

    function _log(Config memory config, address adapter) internal view {
        console2.log("");
        console2.log("NuvemPerpTokenAdapter deployed");
        console2.log("  address     ", adapter);
        console2.log("  WETH        ", config.weth);
        console2.log("  USDG        ", config.usdg);
        console2.log("  pToken      ", config.perpToken);
        console2.log("    symbol    ", IERC20Meta(config.perpToken).symbol());
        console2.log("    name      ", IVaultMeta(config.perpToken).name());
        console2.log("    1e18 shares are worth (USDG, 6 dec):", IVaultMeta(config.perpToken).convertToAssets(1e18));
        console2.log("  PoolManager ", config.poolManager);
        console2.log("");
        console2.log("NOT REGISTERED. The id is derived from the address:");
        console2.logBytes32(adapterIdFor(adapter));
        console2.log("  AdapterRegistry.registerAdapter(<the id above>, %s)", adapter);
        console2.log("");
        console2.log("Until that lands and a vault admin points at the new id, nothing");
        console2.log("reaches this contract and no user is affected either way.");
    }
}
