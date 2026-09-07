// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {NuvemStockAdapter} from "../src/adapters/NuvemStockAdapter.sol";
import {AdapterRegistry} from "../src/registry/AdapterRegistry.sol";
import {IAggregatorV3, IStock} from "../src/interfaces/IRobinhoodVenue.sol";

interface IAdapterRegistryAdmin {
    function registerAdapter(bytes32 adapterId, address adapter) external;
}

interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/**
 * @notice Deploys NuvemStockAdapter and prints the governance operation that puts
 *         it into service.
 *
 * WHY THIS SCRIPT VALIDATES SO MUCH MORE THAN THE CONSTRUCTOR DOES.
 *
 * The adapter is IMMUTABLE. It has no owner, no setters and no pause — that is
 * deliberate, and it means every one of these values is welded in at construction
 * and can only ever be replaced by deploying a new adapter and running another
 * seven-day governance cycle. The constructor checks what it can afford to check
 * on chain: non-zero, sort order, tick spacing, no duplicate stock. It cannot
 * afford to look at the POOLS or the outside world, and those are exactly
 * where a wrong value survives every structural test:
 *
 *   - A POOL that exists, holds liquidity, and charges 95%. Mainnet carries
 *     hookless USDG/stock pools at 85%, 90%, 95% and 99.9%; the constructor takes
 *     whatever `(fee, tickSpacing)` it is handed and never looks at the pool.
 *   - A pool that has never been initialised at all: every swap reverts, forever,
 *     on an adapter that cost a governance cycle to install.
 *   - A stock address that is a CLONE — same codehash, same beacon, same registry,
 *     symbol "NVDA" — passes every structural check the adapter makes. Robinhood's
 *     own docs say the ticker is not the identity; only the address is.
 *
 * So this script refuses to deploy on any of those, in the one place where
 * refusing is still free. A revert here costs nothing; a revert after governance
 * has installed the adapter costs another seven days.
 *
 * IT DOES NOT REGISTER THE ADAPTER, and cannot: `registerAdapter` is `onlyOwner`
 * on a registry owned by the timelock. It prints the calldata for the multisig to
 * schedule instead. Until that operation executes, no vault can invest through
 * this adapter — deploying it is necessary and not sufficient.
 *
 * Running without `--broadcast` only simulates.
 */
contract DeployStockAdapter is Script {
    uint256 public constant ROBINHOOD_MAINNET_CHAIN_ID = 4663;
    uint256 public constant ROBINHOOD_TESTNET_CHAIN_ID = 46_630;
    uint256 public constant LOCAL_CHAIN_ID = 31_337;

    /// @dev v4 keeps pools in a mapping at slot 6; `Pool.State.liquidity` is the
    ///      fourth word of each entry. Verified against mainnet: reading these two
    ///      offsets for the pinned WETH/USDG pool returns liquidity
    ///      68,903,952,934,212,396, and the empty fee tiers in the same sweep
    ///      returned zero rather than garbage — which is what shows the base
    ///      offset is right rather than merely plausible.
    uint256 internal constant POOL_MANAGER_POOLS_SLOT = 6;
    uint256 internal constant POOL_STATE_LIQUIDITY_OFFSET = 3;

    /**
     * @dev One percent, lowered from ten.
     *
     * Ten percent was chosen to sit "far below the 85%-99.9% traps", and it does
     * — but it let through a whole tier nobody would knowingly deploy: the first
     * discovery sweep returned pools at 5% and 10% as "acceptable", and the only
     * thing that stopped them was a human reading the output. A ceiling that
     * needs a human to be useful is not a ceiling.
     *
     * One percent still admits every pool worth using: measured across the whole
     * curated token list, the pinned tiers run 500 to 8000, and the best pool for
     * every stock with real depth is at or under 4762 except TTWO at 8000.
     */
    uint24 internal constant MAX_PLAUSIBLE_POOL_FEE = 10_000;

    error UnsupportedChain(uint256 chainId);
    error StockRegistryMismatch(address stock, address expected, address actual);
    error StockCodehashMismatch(address stock, bytes32 expected, bytes32 actual);
    error StockPaused(address stock);
    error StockOraclePaused(address stock);
    error StockDecimalsUnexpected(address stock, uint8 decimals);
    error UsdgDecimalsUnexpected(address usdg, uint8 decimals);
    error SortOrderWrong(address weth, address usdg);
    error PoolNotInitialized(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolEmpty(address currency0, address currency1, uint24 fee, int24 tickSpacing);
    error PoolFeeImplausible(address a, address b, uint24 fee);
    error PoolTickSpacingInvalid(address a, address b, int24 tickSpacing);
    error NoStocks();
    error ArityMismatch(uint256 stocks, uint256 fees, uint256 tickSpacings);

    struct Config {
        address weth;
        address usdg;
        address poolManager;
        address stockRegistry;
        address pinnedStockImplementation;
        bytes32 stockProxyCodehash;
        uint24 wethUsdgFee;
        int24 wethUsdgTickSpacing;
        NuvemStockAdapter.StockInput[] stocks;
    }

    function run() external returns (NuvemStockAdapter adapter) {
        if (
            block.chainid != ROBINHOOD_MAINNET_CHAIN_ID && block.chainid != ROBINHOOD_TESTNET_CHAIN_ID
                && block.chainid != LOCAL_CHAIN_ID
        ) revert UnsupportedChain(block.chainid);

        Config memory config = _readConfig();
        validate(config);

        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);
        adapter = new NuvemStockAdapter(
            config.weth,
            config.usdg,
            config.poolManager,
            config.stockRegistry,
            config.pinnedStockImplementation,
            config.stockProxyCodehash,
            config.wethUsdgFee,
            config.wethUsdgTickSpacing,
            config.stocks
        );
        vm.stopBroadcast();

        _log(config, address(adapter));
    }

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    /**
     * @dev Every value comes from the environment, none is defaulted.
     *
     * A default here would be this script choosing, on the operator's behalf, an
     * address that gets welded into an immutable contract. `vm.envAddress` reverts
     * on a missing variable, which is the correct behaviour: an unset variable
     * should stop the deployment, not silently select something.
     *
     * The per-stock arrays are parallel rather than a single encoded struct array
     * because forge's env parsing has no struct form. Their lengths are checked
     * against each other below — a missed entry would otherwise shift every feed
     * onto the wrong stock, which is the single worst configuration error
     * available here and the constructor cannot see it.
     */
    function _readConfig() internal view returns (Config memory config) {
        config.weth = vm.envAddress("NUVEM_WETH_ADDRESS");
        config.usdg = vm.envAddress("NUVEM_USDG");
        config.poolManager = vm.envAddress("NUVEM_POOL_MANAGER");
        config.stockRegistry = vm.envAddress("NUVEM_STOCK_REGISTRY");
        config.pinnedStockImplementation = vm.envAddress("NUVEM_STOCK_IMPLEMENTATION");
        config.stockProxyCodehash = vm.envBytes32("NUVEM_STOCK_PROXY_CODEHASH");
        config.wethUsdgFee = uint24(vm.envUint("NUVEM_WETH_USDG_FEE"));
        config.wethUsdgTickSpacing = int24(vm.envInt("NUVEM_WETH_USDG_TICK_SPACING"));

        address[] memory stocks = vm.envAddress("NUVEM_STOCKS", ",");
        uint256[] memory fees = vm.envUint("NUVEM_STOCK_FEES", ",");
        int256[] memory tickSpacings = vm.envInt("NUVEM_STOCK_TICK_SPACINGS", ",");

        if (stocks.length == 0) revert NoStocks();
        if (fees.length != stocks.length || tickSpacings.length != stocks.length) {
            revert ArityMismatch(stocks.length, fees.length, tickSpacings.length);
        }

        config.stocks = new NuvemStockAdapter.StockInput[](stocks.length);
        for (uint256 i = 0; i < stocks.length; ++i) {
            config.stocks[i] = NuvemStockAdapter.StockInput({
                stock: stocks[i],
                fee: uint24(fees[i]),
                tickSpacing: int24(tickSpacings[i])
            });
        }
    }

    // -----------------------------------------------------------------------
    // The checks the constructor cannot make
    // -----------------------------------------------------------------------

    /**
     * @dev PUBLIC so it can be tested without broadcasting.
     *
     * `run()` deploys, and a test that calls `run()` needs a private key and
     * sends transactions. The logic worth testing is entirely here, so this is
     * the seam — see test/unit/script/DeployStockAdapterValidation.t.sol, which
     * breaks one field at a time and asserts the named refusal.
     */
    function validate(Config memory config) public view {
        // Repeated from the constructor on purpose: reverting HERE names the
        // problem, while the constructor's single `InvalidConfiguration()` says
        // only that one of nineteen conditions failed.
        if (uint160(config.weth) >= uint160(config.usdg)) revert SortOrderWrong(config.weth, config.usdg);

        // USDG_UNIT is hardcoded to 1e6 in the adapter. A USDG with different
        // decimals would make every dollar conversion wrong by a power of ten
        // while every other check passed.
        uint8 usdgDecimals = IERC20Meta(config.usdg).decimals();
        if (usdgDecimals != 6) revert UsdgDecimalsUnexpected(config.usdg, usdgDecimals);

        // NO FEED CHECKS. There are no feeds: the adapter prices nothing and the
        // only floor is `minAmountOut`, supplied by the vault admin's hash-bound
        // rate and the keeper's per-call quote. What is left to validate is
        // identity — that each pinned address is the stock it claims to be — and
        // the POOL, which is the decision the removed oracle used to cover for.
        _requirePool(config, config.weth, config.usdg, config.wethUsdgFee, config.wethUsdgTickSpacing);

        for (uint256 i = 0; i < config.stocks.length; ++i) {
            _requireGenuineStock(config, config.stocks[i]);
            _requirePool(config, config.usdg, config.stocks[i].stock, config.stocks[i].fee, config.stocks[i].tickSpacing);
        }
    }

    /**
     * @dev The pool a leg will actually trade in: does it exist, does it hold
     *      anything, and is its fee sane.
     *
     * THIS IS THE CHECK THE ORACLE USED TO STAND IN FOR. With a price feed, a
     * catastrophic pool announced itself as a slippage revert. Without one, the
     * pinned `(fee, tickSpacing)` IS the choice of counterparty, and it is welded
     * into an immutable contract. Measured on mainnet, the hookless USDG/NVDA
     * pairs alone include pools at fee 850000, 900000, 950000 and 999016 — 85% to
     * 99.9% — WITH real liquidity, plus a 10000/100 pool that is 74 bps worse and
     * 31x shallower than the right one. Pinning any of them compiles, deploys,
     * passes every structural check, and quietly hands most of a purchase away.
     *
     * Three failures are distinguished because their fixes are different:
     *   - uninitialised: the pool has never existed. Wrong fee or tick spacing.
     *   - empty: it exists and holds nothing. Every swap reverts or fills awfully.
     *   - absurd fee: it exists and is a trap.
     *
     * WHAT THIS DOES NOT DO is prove the pool is the DEEPEST for that pair, which
     * cannot be done from inside a script without enumerating every fee tier.
     * That comparison belongs in the review that produces these numbers; this is
     * the floor under it.
     */
    function _requirePool(Config memory config, address a, address b, uint24 fee, int24 tickSpacing) internal view {
        if (tickSpacing <= 0) revert PoolTickSpacingInvalid(a, b, tickSpacing);
        // A fee above this is not a fee, it is a confiscation. The pinned pools
        // are 500 and 3000; ten percent is far above anything legitimate and far
        // below the 850000+ traps that actually exist on this chain.
        if (fee > MAX_PLAUSIBLE_POOL_FEE) revert PoolFeeImplausible(a, b, fee);

        (address currency0, address currency1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        bytes32 poolId = keccak256(
            abi.encode(currency0, currency1, fee, tickSpacing, address(0))
        );
        bytes32 base = keccak256(abi.encode(poolId, POOL_MANAGER_POOLS_SLOT));

        uint256 slot0 = uint256(IExtsload(config.poolManager).extsload(base));
        uint160 sqrtPriceX96 = uint160(slot0);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized(currency0, currency1, fee, tickSpacing);

        uint128 liquidity =
            uint128(uint256(IExtsload(config.poolManager).extsload(bytes32(uint256(base) + POOL_STATE_LIQUIDITY_OFFSET))));
        if (liquidity == 0) revert PoolEmpty(currency0, currency1, fee, tickSpacing);
    }

    /**
     * @dev The structural checks, run here so a wrong address fails before
     *      deployment rather than at the first purchase.
     *
     * NONE OF THIS ESTABLISHES IDENTITY, and the script must not pretend
     * otherwise. `Stock.initialize(uid, name, symbol)` has no role check, so
     * anyone can deploy a BeaconProxy at the real beacon and call it "NVDA": the
     * clone shares this codehash, this registry and this implementation, and
     * passes every line below. What these catch is a MISTYPED or STALE address,
     * which is the realistic failure. Identity comes from the operator having
     * taken each address from Robinhood's own published list — there is no
     * on-chain substitute for that, and this comment exists so nobody later reads
     * these checks as one.
     */
    function _requireGenuineStock(Config memory config, NuvemStockAdapter.StockInput memory input) internal view {
        address registry = IStock(input.stock).ACCESS_CONTROLLED_REGISTRY();
        if (registry != config.stockRegistry) {
            revert StockRegistryMismatch(input.stock, config.stockRegistry, registry);
        }
        bytes32 codehash = input.stock.codehash;
        if (codehash != config.stockProxyCodehash) {
            revert StockCodehashMismatch(input.stock, config.stockProxyCodehash, codehash);
        }
        // A token paused AT DEPLOYMENT would produce an adapter that reverts on
        // that leg from its first block. The adapter re-checks at purchase time;
        // this catches welding in a token that is already dead.
        if (IStock(input.stock).paused()) revert StockPaused(input.stock);
        if (IStock(input.stock).oraclePaused()) revert StockOraclePaused(input.stock);

        // 18 decimals is what the adapter's WAD arithmetic assumes for the output
        // side, and every genuine stock token on this chain has it.
        uint8 decimals = IERC20Meta(input.stock).decimals();
        if (decimals != 18) revert StockDecimalsUnexpected(input.stock, decimals);

    }

    // -----------------------------------------------------------------------
    // Output
    // -----------------------------------------------------------------------

    /**
     * @dev The adapter id is derived from the adapter ADDRESS rather than chosen.
     *
     * A hand-picked id is a value that has to be kept in sync across the registry,
     * every vault's `adapterId`, and whatever the operator wrote down. Deriving it
     * means a given adapter always has exactly one id, and two different adapters
     * can never collide on one — which matters because `resolveActiveAdapter`
     * takes the id, not the address, so a reused id silently repoints every vault
     * that holds it.
     */
    function adapterIdFor(address adapter) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("NUVEM_STOCK_ADAPTER_V1", adapter));
    }

    function _log(Config memory config, address adapter) internal view {
        console2.log("NuvemStockAdapter deployed on chain", block.chainid);
        console2.log("  adapter", adapter);
        console2.log("  weth", config.weth);
        console2.log("  usdg", config.usdg);
        console2.log("  poolManager", config.poolManager);
        console2.log("  stockRegistry", config.stockRegistry);
        console2.log("  pinnedStockImplementation", config.pinnedStockImplementation);
        console2.log("  stocks", config.stocks.length);
        for (uint256 i = 0; i < config.stocks.length; ++i) {
            console2.log("    stock", config.stocks[i].stock);
            console2.log("      pool fee", config.stocks[i].fee);
        }

        bytes32 adapterId = adapterIdFor(adapter);
        console2.log("");
        console2.log("NOT YET IN SERVICE. The registry is owned by the timelock, so the");
        console2.log("multisig must schedule this and it takes the full governance delay:");
        console2.log("  adapterId");
        console2.logBytes32(adapterId);
        console2.log("  registerAdapter calldata");
        console2.logBytes(abi.encodeCall(IAdapterRegistryAdmin.registerAdapter, (adapterId, adapter)));
        console2.log("");
        console2.log("Then each vault admin sets adapterId on their own vault via");
        console2.log("setInvestmentPolicy. Nothing is invested until they do.");
    }
}
