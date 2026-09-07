// Decoding the vault's investment configuration out of raw storage.
//
// WHY SLOTS AND NOT GETTERS. `PersonalVault` traded twelve getters for one
// `extsload` to fit the investment path under EIP-170, so `enabled`, `paused`,
// the basket hash, the adapter id and all three limits are readable only as
// packed words. That makes the slot map load-bearing off-chain code, and a
// wrong offset here does not throw — it returns a plausible number from the
// wrong field. `investmentEnabled` read from the wrong bit is a vault that
// reports itself switched off forever, or worse, on.
//
// THE MAP IS MEASURED, NOT DERIVED. It was taken from `VaultLens.sol`, which is
// pinned in Solidity by test/unit/VaultLens.t.sol writing a distinct value into
// every field and reading it back. Deriving it on paper got it wrong once
// already: `settlementExecutor` is an address with twelve spare bytes and the
// compiler fills them with `cohortId` and `adminEpoch`, shifting everything below
// by a slot.
//
// NOTE THE ABSENCE OF adapterRegistry. It used to live at S+47 and is now an
// immutable of the implementation, read with a normal `ADAPTER_REGISTRY()` call.
// The slot it vacated is why the nonce and both flags sit at offset 0 here rather
// than above an address.

import type { Address, Hex } from "viem";

/** ERC-7201 namespace base for `PersonalVault`'s storage struct. */
export const VAULT_STORAGE_BASE = 0xe42e09f071b7e8aed0aad6a42ba1b4e3f8a0bc10a2919eea366981f9c3cd1200n;

export const INVESTMENT_SLOT = {
  /** investmentPolicyNonce(64) | investmentEnabled(8) | investmentPaused(8) */
  packed: VAULT_STORAGE_BASE + 47n,
  adapterId: VAULT_STORAGE_BASE + 48n,
  basketHash: VAULT_STORAGE_BASE + 49n,
  /** minInvestmentWei(128) | maxInvestmentPerCallWei(128) */
  limits: VAULT_STORAGE_BASE + 50n,
  rollingCap: VAULT_STORAGE_BASE + 51n,
  /** aggregateLifetimeContributions(128) | aggregateLifetimeInvested(128) */
  lifetimeTotals: VAULT_STORAGE_BASE + 46n,
} as const;

export function slotHex(slot: bigint): Hex {
  return `0x${slot.toString(16).padStart(64, "0")}`;
}

export interface InvestmentConfiguration {
  readonly policyNonce: bigint;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly adapterId: Hex;
  readonly basketHash: Hex;
  readonly minInvestmentWei: bigint;
  readonly maxPerCallWei: bigint;
  readonly maxRolling30dWei: bigint;
}

const MASK_64 = (1n << 64n) - 1n;
const MASK_128 = (1n << 128n) - 1n;

const toHex32 = (word: bigint): Hex => `0x${word.toString(16).padStart(64, "0")}`;

/**
 * Decodes the four investment words.
 *
 * THE BIT OFFSETS ARE THE WHOLE POINT. Solidity packs a struct's members from
 * the LOW end of the word in declaration order, so with `adapterRegistry` gone
 * the layout of S+47 is nonce at bit 0, `enabled` at bit 64 and `paused` at bit
 * 72 — each `bool` occupying a full byte, not a bit. Reading `enabled` as bit 64
 * rather than byte 64 happens to work for `true` and silently misreads nothing
 * else, which is exactly the kind of near-miss that survives a smoke test.
 */
export function decodeInvestmentConfiguration(words: {
  readonly packed: bigint;
  readonly adapterId: bigint;
  readonly basketHash: bigint;
  readonly limits: bigint;
  readonly rollingCap: bigint;
}): InvestmentConfiguration {
  return {
    policyNonce: words.packed & MASK_64,
    enabled: ((words.packed >> 64n) & 0xffn) === 1n,
    paused: ((words.packed >> 72n) & 0xffn) === 1n,
    adapterId: toHex32(words.adapterId),
    basketHash: toHex32(words.basketHash),
    minInvestmentWei: words.limits & MASK_128,
    maxPerCallWei: (words.limits >> 128n) & MASK_128,
    maxRolling30dWei: words.rollingCap & MASK_128,
  };
}

/** `aggregateLifetimeInvested` shares its slot with lifetime contributions. */
export function decodeLifetimeInvested(lifetimeTotals: bigint): bigint {
  return (lifetimeTotals >> 128n) & MASK_128;
}

// ---------------------------------------------------------------------------
// Uniswap v4 pool state
// ---------------------------------------------------------------------------

/**
 * `PoolManager` keeps pools in a mapping at slot 6; each `Pool.State` begins with
 * `slot0` and carries `liquidity` as its fourth word.
 *
 * Verified against mainnet: reading these two offsets for the WETH/USDG pool at
 * fee 500 / tickSpacing 10 returns liquidity 68,903,952,934,212,396, which
 * matches what the pool's own swaps imply. The empty pools in the same sweep
 * returned zero rather than garbage, which is the check that the base offset is
 * right rather than merely plausible.
 */
export const POOL_MANAGER_POOLS_SLOT = 6n;
export const POOL_STATE_SLOT0_OFFSET = 0n;
export const POOL_STATE_LIQUIDITY_OFFSET = 3n;

/** `slot0` packs sqrtPriceX96 into its low 160 bits. */
export function decodeSqrtPriceX96(slot0: bigint): bigint {
  return slot0 & ((1n << 160n) - 1n);
}

/**
 * The fee a swap ACTUALLY pays, which is not the fee in the PoolKey.
 *
 * THIS WAS MISSED AND IT COST 6.23 bps ON EVERY QUOTE. A v4 pool charges the
 * lpFee plus a PROTOCOL fee set by a controller the pool does not own, and only
 * the lpFee appears in the PoolKey. Measured on the two pinned pools:
 *
 *     WETH/USDG   PoolKey 500    lpFee 500    protocolFee 125   -> 625
 *     USDG/NVDA   PoolKey 3000   lpFee 3000   protocolFee 500   -> 3499
 *
 * Quoting from the PoolKey alone produced a floor 6.23 bps above what the pool
 * pays — which is exactly the 6.27 bps gap measured when a fork purchase was
 * compared against its own quote, and which had been written off as tick-crossing
 * approximation. At a tolerance of zero it would revert every honest fill.
 *
 * `protocolFeeController` is live and non-zero on this chain, so this is not a
 * constant to hardcode: it was zero at an earlier block and can change again.
 *
 * slot0 layout: sqrtPriceX96 0-159, tick 160-183, protocolFee 184-207,
 * lpFee 208-231. `protocolFee` is two 12-bit halves, one per direction.
 */
export function decodeSwapFeePips(slot0: bigint, zeroForOne: boolean): number {
  const protocolFee = (slot0 >> 184n) & ((1n << 24n) - 1n);
  const lpFee = (slot0 >> 208n) & ((1n << 24n) - 1n);
  // Low 12 bits are the zeroForOne direction, high 12 the oneForZero.
  const directional = zeroForOne ? protocolFee & 0xfffn : (protocolFee >> 12n) & 0xfffn;
  // v4 composes them rather than adding: the protocol fee is taken first, and
  // the lp fee applies to what is left. Adding overstates by pf*lp/1e6.
  return Number(directional + lpFee - (directional * lpFee) / 1_000_000n);
}

/**
 * The `PoolKey` a v4 pool id hashes from, in the order v4 encodes it.
 *
 * `hooks` is fixed at the zero address because the adapter's key is: it only
 * ever addresses hookless pools, and a hooked pool is a DIFFERENT id the adapter
 * cannot reach. Making it a parameter here would let the keeper quote a pool the
 * adapter will never trade in — and the quote would look perfectly healthy.
 */
export interface PoolKeyParts {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
}

/**
 * Orders a pair the way a `PoolKey` requires, so a caller cannot build an
 * inverted key by accident.
 *
 * An inverted key is not an error anywhere — it hashes to a pool id that simply
 * does not exist, and every read against it returns zero, which this module
 * would then report as "the pinned pool is empty". The cause and the symptom are
 * a long way apart, so it is worth making the mistake unrepresentable.
 */
export function orderPair(a: Address, b: Address): { currency0: Address; currency1: Address; zeroForOneIs: Address } {
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0, currency1, zeroForOneIs: currency0 };
}
