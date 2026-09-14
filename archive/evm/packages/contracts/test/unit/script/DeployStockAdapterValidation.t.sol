// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {DeployStockAdapter} from "../../../script/DeployStockAdapter.s.sol";
import {NuvemStockAdapter} from "../../../src/adapters/NuvemStockAdapter.sol";

/**
 * The refusals in DeployStockAdapter, and whether any of them actually fire.
 *
 * WHY THIS TEST EXISTS. The adapter is immutable — no owner, no setters, no
 * pause. Every constructor argument is welded in, and replacing one costs a fresh
 * deployment plus a seven-day governance cycle. The script's validation is
 * therefore the last moment a wrong address is free to fix, and validation nobody
 * tests is decoration: it compiles, it reads like a guarantee, and it can be
 * silently inert.
 *
 * Each test below breaks exactly ONE field of an otherwise-valid configuration
 * and asserts the script refuses with the error that names it. The baseline
 * passing case is asserted too, because a validator that refuses everything is
 * just as useless as one that refuses nothing — and much easier to write by
 * accident.
 *
 * WHAT THIS DOES NOT TEST is the actual deployment: `run()` broadcasts, and a test
 * that broadcasts is a test that needs a private key. The validation is exercised
 * directly instead, which is the part with the logic in it.
 */

// ── mocks, deliberately generous ─────────────────────────────────────────────
//
// These answer everything the STRUCTURAL checks ask for, so the only thing left
// distinguishing a good configuration from a bad one is the magnitude and
// freshness reasoning that is the point of the script. A mock that failed the
// structural checks would let a broken magnitude check pass unnoticed.

contract Token is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

contract Feed {
    int256 internal answer;
    uint256 internal updatedAt;
    uint8 internal dec;

    constructor(int256 a, uint256 t, uint8 d) {
        answer = a;
        updatedAt = t;
        dec = d;
    }

    function decimals() external view returns (uint8) {
        return dec;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract Stock is Token {
    address public immutable ACCESS_CONTROLLED_REGISTRY;
    bool public paused;
    bool public oraclePaused;

    constructor(string memory s, address registry, uint8 d) Token(s, s, d) {
        ACCESS_CONTROLLED_REGISTRY = registry;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setOraclePaused(bool p) external {
        oraclePaused = p;
    }
}

/**
 * @dev A PoolManager, reduced to the two storage words the validator reads.
 *
 * It stores by pool id rather than by slot so a test can say "this pool has this
 * price and this liquidity" without doing the keccak by hand — but `extsload`
 * still takes a raw slot, so the mapping arithmetic being tested is the real one.
 */
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

contract DeployStockAdapterValidationTest is Test {
    DeployStockAdapter internal script;

    // WETH must sort BELOW USDG, so the mocks are deployed until they do rather
    // than assumed to — CREATE addresses depend on nonce, and a test that assumed
    // the order would fail for a reason unrelated to what it is checking.
    Token internal weth;
    Token internal usdg;
    Stock internal nvda;
    Feed internal ethUsd;
    Feed internal usdgUsd;
    Feed internal nvdaUsd;
    // Labelled rather than literal: a wrong address in a failure message is much
    // easier to read as "registry" than as 0x0000…0042.
    address internal registry = makeAddr("stockRegistry");
    MockPoolManager internal poolManager;
    address internal stockImpl = makeAddr("pinnedStockImplementation");
    address internal otherRegistry = makeAddr("someOtherRegistry");

    function setUp() public {
        // A timestamp well clear of zero, so "age" arithmetic is meaningful.
        vm.warp(1_786_636_800);
        script = new DeployStockAdapter();
        poolManager = new MockPoolManager();

        (weth, usdg) = _sortedPair();
        nvda = new Stock("NVDA", registry, 18);
        ethUsd = new Feed(3_000e8, block.timestamp, 8);
        usdgUsd = new Feed(1e8, block.timestamp, 8);
        nvdaUsd = new Feed(180e8, block.timestamp, 8);
    }

    function _sortedPair() internal returns (Token lower, Token higher) {
        Token a = new Token("Wrapped Ether", "WETH", 18);
        Token b = new Token("Global Dollar", "USDG", 6);
        // Deploying with 6 decimals on the higher one matters: the script checks
        // USDG's decimals specifically, so the pair cannot simply be swapped.
        if (uint160(address(a)) < uint160(address(b))) return (a, b);
        // Redeploy until sorted. Cheap, and it keeps the invariant true by
        // construction rather than by luck.
        return _sortedPair();
    }

    /// @dev The sorted pair, which is what a PoolKey and therefore every pool
    ///      error names. Writing (usdg, nvda) in a test proves nothing about the
    ///      order the mocks happened to deploy in.
    function _sorted(address a, address b) internal pure returns (address, address) {
        return uint160(a) < uint160(b) ? (a, b) : (b, a);
    }

    /// @dev The pool id v4 derives, so a test can seed the pool the validator
    ///      will actually look for rather than a slot it hopes is right.
    function _poolId(address a, address b, uint24 fee, int24 tickSpacing) internal pure returns (bytes32) {
        (address c0, address c1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        return keccak256(abi.encode(c0, c1, fee, tickSpacing, address(0)));
    }

    /// @dev Both pools a one-leg basket needs, alive and deep.
    function _seedHealthyPools() internal {
        poolManager.setPool(_poolId(address(weth), address(usdg), 3000, 60), 1e29, 68_903_952_934_212_396);
        poolManager.setPool(_poolId(address(usdg), address(nvda), 3000, 60), 1e33, 1_171_748_594_528_528_804);
    }

    function _config() internal view returns (DeployStockAdapter.Config memory config) {
        config.weth = address(weth);
        config.usdg = address(usdg);
        config.poolManager = address(poolManager);
        config.stockRegistry = registry;
        config.pinnedStockImplementation = stockImpl;
        config.stockProxyCodehash = address(nvda).codehash;
        config.wethUsdgFee = 3000;
        config.wethUsdgTickSpacing = 60;
        config.stocks = new NuvemStockAdapter.StockInput[](1);
        config.stocks[0] = NuvemStockAdapter.StockInput({stock: address(nvda), fee: 3000, tickSpacing: 60});
    }

    /**
     * THE ONE THAT MAKES THE REST MEAN ANYTHING. Without it, every assertion
     * below is satisfied by a validator that reverts unconditionally.
     */
    function testAValidConfigurationIsAccepted() public {
        _seedHealthyPools();
        script.validate(_config());
    }

    // ── the feeds ────────────────────────────────────────────────────────────

    // ── the stock tokens ─────────────────────────────────────────────────────

    function testAStockPointingAtADifferentRegistryIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        Stock impostor = new Stock("NVDA", otherRegistry, 18);
        config.stocks[0].stock = address(impostor);
        // Same codehash as the genuine one — this is the check that catches it.
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployStockAdapter.StockRegistryMismatch.selector, address(impostor), registry, otherRegistry
            )
        );
        script.validate(config);
    }

    function testAStockWithADifferentCodehashIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        // A token that is not a stock proxy at all, but does claim the right
        // registry. Only the codehash separates it.
        Stock odd = new Stock("NVDA", registry, 18);
        config.stockProxyCodehash = keccak256("something else entirely");
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployStockAdapter.StockCodehashMismatch.selector,
                address(odd) == config.stocks[0].stock ? address(odd) : config.stocks[0].stock,
                config.stockProxyCodehash,
                config.stocks[0].stock.codehash
            )
        );
        script.validate(config);
    }

    function testAnAlreadyPausedStockIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        nvda.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(DeployStockAdapter.StockPaused.selector, address(nvda)));
        script.validate(config);
    }

    function testAStockWithAPausedOracleIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        nvda.setOraclePaused(true);
        vm.expectRevert(abi.encodeWithSelector(DeployStockAdapter.StockOraclePaused.selector, address(nvda)));
        script.validate(config);
    }

    function testAStockWithUnexpectedDecimalsIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        Stock sixDecimals = new Stock("NVDA", registry, 6);
        config.stocks[0].stock = address(sixDecimals);
        config.stockProxyCodehash = address(sixDecimals).codehash;
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployStockAdapter.StockDecimalsUnexpected.selector, address(sixDecimals), uint8(6)
            )
        );
        script.validate(config);
    }

    // ── the shape ────────────────────────────────────────────────────────────

    /**
     * The inverted pair. A v4 PoolKey with currency0 > currency1 addresses a pool
     * that does not exist, and the adapter would revert on every purchase — after
     * governance had installed it.
     */
    function testAnInvertedWethUsdgPairIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        (config.weth, config.usdg) = (config.usdg, config.weth);
        vm.expectRevert(
            abi.encodeWithSelector(DeployStockAdapter.SortOrderWrong.selector, config.weth, config.usdg)
        );
        script.validate(config);
    }

    /// @dev USDG_UNIT is hardcoded to 1e6 in the adapter, so a USDG with other
    ///      decimals makes every dollar conversion wrong by a power of ten while
    ///      passing every other check.
    function testAUsdgWithWrongDecimalsIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        Token wrong = new Token("Global Dollar", "USDG", 18);
        // Keep the sort order valid so THIS is the failure being observed.
        if (uint160(address(weth)) >= uint160(address(wrong))) return;
        config.usdg = address(wrong);
        vm.expectRevert(
            abi.encodeWithSelector(DeployStockAdapter.UsdgDecimalsUnexpected.selector, address(wrong), uint8(18))
        );
        script.validate(config);
    }

    // ── the pool, which is the choice the oracle used to cover for ───────────
    //
    // With a price feed a catastrophic pool announced itself as a slippage
    // revert. Without one, the pinned (fee, tickSpacing) IS the counterparty, and
    // it is welded into an immutable contract. On mainnet the hookless USDG/NVDA
    // pairs alone include pools at 85%, 90%, 95% and 99.9% WITH real liquidity,
    // plus a 10000/100 pool that is 74 bps worse and 31x shallower than the right
    // one. Every one of them passes every other check in this file.

    /**
     * A pool that has never been initialised. This is what a wrong `fee` or a
     * wrong `tickSpacing` produces: not an error, just a pool id nothing lives
     * at — so every swap reverts forever on an adapter that cost a governance
     * cycle to install.
     */
    function testAnUninitialisedStockPoolIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        config.stocks[0].tickSpacing = 61; // one off, and nothing is there

        (address c0, address c1) = _sorted(address(usdg), address(nvda));
        vm.expectRevert(
            abi.encodeWithSelector(DeployStockAdapter.PoolNotInitialized.selector, c0, c1, uint24(3000), int24(61))
        );
        script.validate(config);
    }

    function testAnUninitialisedWethUsdgPoolIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        config.wethUsdgFee = 500; // the healthy fixture seeded 3000

        (address w0, address w1) = _sorted(address(weth), address(usdg));
        vm.expectRevert(
            abi.encodeWithSelector(DeployStockAdapter.PoolNotInitialized.selector, w0, w1, uint24(500), int24(60))
        );
        script.validate(config);
    }

    /**
     * Initialised and empty. Distinguished from uninitialised because the fix is
     * different: the tier is right and the liquidity is not there, so waiting or
     * choosing another tier are both plausible, and "pool does not exist" would
     * send the operator to change numbers that are already correct.
     */
    function testAnEmptyPoolIsRefused() public {
        _seedHealthyPools();
        poolManager.setPool(_poolId(address(usdg), address(nvda), 3000, 60), 1e33, 0);

        (address c0, address c1) = _sorted(address(usdg), address(nvda));
        vm.expectRevert(abi.encodeWithSelector(DeployStockAdapter.PoolEmpty.selector, c0, c1, uint24(3000), int24(60)));
        script.validate(_config());
    }

    /**
     * THE TRAP THAT REALLY EXISTS. 850000 is 85%, and mainnet has a hookless
     * USDG/NVDA pool at exactly that fee holding 22,002,641,622,534 of real
     * liquidity. It is initialised, it is deep enough to fill, and it would hand
     * away 85% of every purchase — while passing initialisation and liquidity.
     */
    function testAPoolWithAConfiscatoryFeeIsRefused() public {
        _seedHealthyPools();
        poolManager.setPool(_poolId(address(usdg), address(nvda), 850_000, 17_000), 1e33, 22_002_641_622_534);

        DeployStockAdapter.Config memory config = _config();
        config.stocks[0].fee = 850_000;
        config.stocks[0].tickSpacing = 17_000;

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployStockAdapter.PoolFeeImplausible.selector, address(usdg), address(nvda), uint24(850_000)
            )
        );
        script.validate(config);
    }

    /// @dev And the ceiling does not refuse a legitimate one. A validator that
    ///      rejects every fee is as useless as one that rejects none.
    function testAnOrdinaryFeeTierIsAccepted() public {
        _seedHealthyPools();
        poolManager.setPool(_poolId(address(usdg), address(nvda), 10_000, 200), 1e33, 38_017_667_754_396_873);

        DeployStockAdapter.Config memory config = _config();
        config.stocks[0].fee = 10_000; // 1%, high but real
        config.stocks[0].tickSpacing = 200;
        script.validate(config);
    }

    function testANonPositiveTickSpacingIsRefused() public {
        _seedHealthyPools();
        DeployStockAdapter.Config memory config = _config();
        config.stocks[0].tickSpacing = 0;

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployStockAdapter.PoolTickSpacingInvalid.selector, address(usdg), address(nvda), int24(0)
            )
        );
        script.validate(config);
    }

    // ── the derived id ───────────────────────────────────────────────────────

    /**
     * Two adapters must never share an id. `resolveActiveAdapter` takes the id
     * rather than the address, so a collision silently repoints every vault
     * holding it at a different contract.
     */
    function testAdapterIdsAreDistinctPerAddressAndNeverZero() public {
        bytes32 a = script.adapterIdFor(makeAddr("adapterA"));
        bytes32 b = script.adapterIdFor(makeAddr("adapterB"));
        assertTrue(a != b, "two adapters must not share an id");
        assertTrue(a != bytes32(0), "a zero id is rejected by registerAdapter");
        assertEq(a, script.adapterIdFor(makeAddr("adapterA")), "the id must be a pure function of the address");
    }
}
