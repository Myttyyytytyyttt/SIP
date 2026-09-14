// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {NuvemPerpDesk} from "../src/periphery/NuvemPerpDesk.sol";
import {NuvemPerpDeskAdapter} from "../src/adapters/NuvemPerpDeskAdapter.sol";

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface INavMeta {
    function symbol() external view returns (string memory);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}

/**
 * @notice Deploys the desk AND its adapter, and arms the desk with the adapter,
 *         in one broadcast. IT DOES NOT REGISTER THE ADAPTER — that stays a
 *         governance operation.
 *
 * WHY ONE SCRIPT FOR THE PAIR. The desk's buyer is settable exactly once and
 * the adapter's desk is immutable — they only make sense wired to each other,
 * and deploying them separately invites the one mistake this removes: an armed
 * desk pointing at yesterday's adapter, or an adapter pointing at somebody
 * else's desk.
 *
 * WHAT THIS VALIDATES: the WETH/USDG pool (initialized, non-empty, plausible
 * fee — the same storage reads every sibling script does) and that the pToken
 * answers convertToAssets with a non-zero NAV, because that is the ONLY thing
 * the desk's pricing needs. Deliberately NOT previewDeposit: the entire reason
 * the desk exists is that Arcus keeps that gated, and the desk works anyway.
 */
contract DeployPerpDesk is Script {
    uint256 internal constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    uint256 internal constant POOL_MANAGER_POOLS_SLOT = 6;
    uint256 internal constant POOL_STATE_LIQUIDITY_OFFSET = 3;
    uint24 internal constant MAX_PLAUSIBLE_POOL_FEE = 100_000;

    error UnsupportedChain(uint256 chainId);
    error PoolNotInitialized(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolEmpty(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolFeeImplausible(uint24 fee);
    error NavUnreadable(address perpToken);

    struct Config {
        address weth;
        address usdg;
        address perpToken;
        address poolManager;
        uint24 wethUsdgFee;
        int24 wethUsdgTickSpacing;
        uint16 spreadBps;
    }

    function run() external returns (NuvemPerpDesk desk, NuvemPerpDeskAdapter adapter) {
        if (block.chainid != ROBINHOOD_MAINNET_CHAIN_ID && block.chainid != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(block.chainid);
        }

        Config memory config = _readConfig();
        validate(config);

        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        desk = new NuvemPerpDesk(config.usdg, config.perpToken, config.spreadBps);
        adapter = new NuvemPerpDeskAdapter(
            config.weth, config.usdg, address(desk), config.poolManager, config.wethUsdgFee, config.wethUsdgTickSpacing
        );
        desk.arm(address(adapter));
        vm.stopBroadcast();

        _log(config, address(desk), address(adapter));
    }

    function _readConfig() internal view returns (Config memory config) {
        config.weth = vm.envAddress("NUVEM_WETH");
        config.usdg = vm.envAddress("NUVEM_USDG");
        config.perpToken = vm.envAddress("NUVEM_PERP_TOKEN");
        config.poolManager = vm.envAddress("NUVEM_POOL_MANAGER");
        config.wethUsdgFee = uint24(vm.envUint("NUVEM_WETH_USDG_FEE"));
        config.wethUsdgTickSpacing = int24(int256(vm.envInt("NUVEM_WETH_USDG_TICK_SPACING")));
        config.spreadBps = uint16(vm.envUint("NUVEM_DESK_SPREAD_BPS"));
    }

    function validate(Config memory config) public view {
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

        // The desk's whole pricing input. try/catch so an Arcus-side revert is
        // named rather than raw.
        try INavMeta(config.perpToken).convertToAssets(1e18) returns (uint256 nav) {
            if (nav == 0) revert NavUnreadable(config.perpToken);
        } catch {
            revert NavUnreadable(config.perpToken);
        }
    }

    /// @dev Derived from the adapter address, the family rule; distinct label.
    function adapterIdFor(address adapter) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("NUVEM_PERP_DESK_ADAPTER_V1", adapter));
    }

    function _log(Config memory config, address desk, address adapter) internal view {
        console2.log("");
        console2.log("NuvemPerpDesk + adapter deployed and armed");
        console2.log("  desk          ", desk);
        console2.log("  adapter       ", adapter);
        console2.log("  pToken        ", config.perpToken);
        console2.log("    symbol      ", INavMeta(config.perpToken).symbol());
        console2.log("    NAV (USDG/1e18 shares)", INavMeta(config.perpToken).convertToAssets(1e18));
        console2.log("  spread (bps)  ", uint256(config.spreadBps));
        console2.log("");
        console2.log("FUND THE DESK by transferring pTokens to it - inventory is balanceOf,");
        console2.log("no function needed. NOT REGISTERED; the id derives from the adapter:");
        console2.logBytes32(adapterIdFor(adapter));
        console2.log("  AdapterRegistry.registerAdapter(<the id above>, %s)", adapter);
    }
}
