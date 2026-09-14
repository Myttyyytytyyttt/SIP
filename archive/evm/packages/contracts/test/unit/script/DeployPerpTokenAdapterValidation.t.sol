// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {DeployPerpTokenAdapter} from "../../../script/DeployPerpTokenAdapter.s.sol";

/**
 * The arming gate in DeployPerpTokenAdapter, and whether it actually fires.
 *
 * WHY THIS TEST EXISTS — the sibling suites' rule: validation nobody tests is
 * decoration. This script's whole purpose is to REFUSE deployment while Arcus
 * keeps pToken deposits gated (previewDeposit reverting), and to refuse a
 * destination that would price a dollar at zero shares. Each test breaks one
 * thing; the baseline passing case is asserted too, because a validator that
 * refuses everything is as useless as one that refuses nothing.
 */

contract Token is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory n, uint8 d) ERC20(n, n) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

/// Today's Arcus: previewDeposit reverts. The gate must read this as "wait".
contract GatedPToken {
    error DepositsClosed();

    function previewDeposit(uint256) external pure returns (uint256) {
        revert DepositsClosed();
    }
}

/// The arming day: previewDeposit answers.
contract OpenPToken {
    uint256 internal immutable RATE;

    constructor(uint256 rate) {
        RATE = rate;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        return (assets * 1e18) / RATE;
    }
}

/// A vault that would take the money and mint nothing.
contract ZeroPToken {
    function previewDeposit(uint256) external pure returns (uint256) {
        return 0;
    }
}

/// The two storage words the pool validator reads, keyed by pool id.
contract MockPoolManager {
    mapping(bytes32 => bytes32) internal _slots;

    function setPool(bytes32 poolId, uint160 sqrtPriceX96, uint128 liquidity) external {
        bytes32 base = keccak256(abi.encode(poolId, uint256(6)));
        _slots[base] = bytes32(uint256(sqrtPriceX96));
        _slots[bytes32(uint256(base) + 3)] = bytes32(uint256(liquidity));
    }

    function extsload(bytes32 slot) external view returns (bytes32) {
        return _slots[slot];
    }
}

contract DeployPerpTokenAdapterValidationTest is Test {
    DeployPerpTokenAdapter internal script;
    Token internal weth;
    Token internal usdg;
    MockPoolManager internal poolManager;

    uint24 internal constant FEE = 200;
    int24 internal constant TICK = 4;

    function setUp() public {
        script = new DeployPerpTokenAdapter();
        poolManager = new MockPoolManager();
        weth = new Token("WETH", 18);
        usdg = new Token("USDG", 6);
        while (uint160(address(weth)) >= uint160(address(usdg))) {
            usdg = new Token("USDG", 6);
        }
        poolManager.setPool(_poolId(), 1 << 96, 1e18);
    }

    function _poolId() internal view returns (bytes32) {
        return keccak256(abi.encode(address(weth), address(usdg), FEE, TICK, address(0)));
    }

    function _config(address perpToken) internal view returns (DeployPerpTokenAdapter.Config memory) {
        return DeployPerpTokenAdapter.Config({
            weth: address(weth),
            usdg: address(usdg),
            perpToken: perpToken,
            poolManager: address(poolManager),
            wethUsdgFee: FEE,
            wethUsdgTickSpacing: TICK
        });
    }

    function testBaselinePassesWithAHealthyPoolAndOpenDeposits() public {
        script.validate(_config(address(new OpenPToken(175e6))));
    }

    function testTodaysArcusIsReadAsStillGated() public {
        address gated = address(new GatedPToken());
        vm.expectRevert(abi.encodeWithSelector(DeployPerpTokenAdapter.DepositsStillGated.selector, gated));
        script.validate(_config(gated));
    }

    function testAZeroPricingVaultIsRefused() public {
        address zero = address(new ZeroPToken());
        vm.expectRevert(abi.encodeWithSelector(DeployPerpTokenAdapter.PerpVaultRefusesDeposits.selector, zero));
        script.validate(_config(zero));
    }

    function testAnUninitializedPoolIsRefusedBeforeTheGateEvenRuns() public {
        MockPoolManager empty = new MockPoolManager();
        DeployPerpTokenAdapter.Config memory config = _config(address(new OpenPToken(175e6)));
        config.poolManager = address(empty);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployPerpTokenAdapter.PoolNotInitialized.selector, address(weth), address(usdg), FEE, TICK
            )
        );
        script.validate(config);
    }

    function testAnEmptyPoolIsRefused() public {
        poolManager.setPool(_poolId(), 1 << 96, 0);
        // Built BEFORE expectRevert: the config helper deploys a mock, and the
        // cheatcode binds to the very next call — a CREATE included.
        DeployPerpTokenAdapter.Config memory config = _config(address(new OpenPToken(175e6)));
        vm.expectRevert(
            abi.encodeWithSelector(DeployPerpTokenAdapter.PoolEmpty.selector, address(weth), address(usdg), FEE, TICK)
        );
        script.validate(config);
    }

    function testATrapFeeIsRefused() public {
        DeployPerpTokenAdapter.Config memory config = _config(address(new OpenPToken(175e6)));
        config.wethUsdgFee = 970_790;
        vm.expectRevert(abi.encodeWithSelector(DeployPerpTokenAdapter.PoolFeeImplausible.selector, uint24(970_790)));
        script.validate(config);
    }
}
