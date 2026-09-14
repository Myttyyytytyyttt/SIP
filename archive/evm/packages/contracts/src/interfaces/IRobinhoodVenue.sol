// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// The parts of Robinhood Chain's venues and tokens this protocol touches.
//
// WRITTEN OUT RATHER THAN IMPORTED, on purpose. Pulling in v4-core would drag a
// large dependency in for four function selectors, and the chain's own
// UniversalRouter is a FORK whose `ExactInputSingleParams` carries an extra
// `minHopPriceX36` field — so the upstream package would not describe this chain
// anyway. Everything here was read off verified source on
// robinhoodchain.blockscout.com and exercised with eth_call against mainnet.

/// @dev v4 packs both sides into one int256: amount0 in the high 128 bits,
///      amount1 in the low. Negative means the pool took it from you.
type BalanceDelta is int256;

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    /// @dev Negative for an exact-input swap.
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/**
 * @dev The Uniswap v4 singleton at 0x8366a39CC670B4001A1121B8F6A443A643e40951.
 *
 *      Flash accounting: inside `unlock` the caller runs whatever it likes and
 *      the manager asserts at the end that every currency it touched nets to
 *      zero. A mis-settled adapter therefore reverts the whole transaction on the
 *      venue's own arithmetic, not on ours — which is a check worth having for
 *      free.
 */
interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (BalanceDelta);
    /// @dev Records the manager's balance so a later `settle` can measure what arrived.
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/**
 * @dev A Rialto propAMM pair. Selectors verified live against the NVDA/USDG pair
 *      0x682fd352329026885366D6649D61CB4EE505E7A4.
 *
 *      THE ROUTER IS NOT USED. Its calldata carries a 65-byte ECDSA quote
 *      signature, so it requires an off-chain quote and cannot be driven from a
 *      contract. The PAIRS are permissionless: `getAmountOut` was called
 *      successfully from an arbitrary address, and a `swapExactIn` from an
 *      unfunded address reverted with the USDG token's own
 *      `InsufficientAllowance`, meaning execution reached `transferFrom` rather
 *      than an authorisation gate.
 *
 *      Measured, the quote is FLAT from $0.01 to $500 and steps up only past
 *      $5,000 — it is a tiered quoted book, not a constant-product curve.
 */
interface IRialtoPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function isActive() external view returns (bool);
    function getAmountOut(bool zeroForOne, uint256 amountIn) external view returns (uint256);
    function swapExactIn(bool zeroForOne, uint256 amountIn, uint256 amountOutMin, address to, uint256 deadline)
        external
        payable
        returns (uint256 amountOut);
}

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * @dev A Robinhood Stock Token. Every genuine one is a BeaconProxy on the
 *      registry at 0xe10B6f6b275de231345c20D14Ab812db62151b00, and they all share
 *      one runtime codehash.
 *
 *      BUT THAT IS NOT AN IDENTITY TEST. `Stock.initialize(uid, name, symbol)` is
 *      `external initializer` with NO role check, so anyone can deploy their own
 *      BeaconProxy at the real beacon and initialise it with symbol "NVDA". The
 *      clone has the same codehash, the same beacon and the same registry, and it
 *      passes every structural check. Robinhood's own docs say as much: "a token
 *      with a matching name/ticker but a different contract address is not a
 *      Robinhood Stock Token." Identity has to come from a pinned address list,
 *      and in this adapter it does.
 */
interface IStock {
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
    /// @dev True if the token itself is paused OR the registry is paused globally.
    function paused() external view returns (bool);
    /// @dev Advisory per Robinhood's docs, and not enforced on chain — the
    ///      staleness check stays the primary guard.
    function oraclePaused() external view returns (bool);
    function uiMultiplier() external view returns (uint256);
    /// @dev When a scheduled multiplier change takes effect. The one window in
    ///      which the feed's price and the token's multiplier can disagree.
    function effectiveAt() external view returns (uint256);
}

interface IAccessControlsRegistry {
    /// @dev The beacon's implementation. Rotating it is how a single role holder
    ///      could give every stock token transfer gating it does not have today.
    function implementation() external view returns (address);
    /// @dev A deny-list, default-allow. Applied to sender, from and to on every
    ///      transfer, so the vault, the pair and the adapter must all be clear.
    function isBlocked(address account) external view returns (bool);
}
