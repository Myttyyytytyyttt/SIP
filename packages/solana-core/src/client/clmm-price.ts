// Prices from a Raydium CLMM PoolState, in bigint only. Browser-safe.
//
// WHAT IS READ. Four fields of the 1544-byte account, at the offsets the keeper
// reads (packages/solana-keeper scripts/live-route.ts): mint0 at 73, mint1 at
// 105, their decimals at 233 and 234, and sqrt_price_x64 (u128 LE) at 253. The
// account's owner is the reader's to check (readers.ts): bytes alone cannot say
// who wrote them.
//
// WHAT IS COMPUTED. Floors are RAW-per-RAW rates times 1e18 (a WAD), the unit
// set_invest_policy stores, so no decimals and no display price enter them:
//  * convert (pool mint0 wSOL, mint1 USDC): USDC raw out per lamport in,
//    sqrtP² × 1e18 >> 128;
//  * a leg (pool mint0 the leg, mint1 USDC): leg raw out per USDC raw in,
//    2^128 × 1e18 / sqrtP².
// Never from uiAmount: SPYx's scaledUiAmount multiplier moves the display price
// without moving the raw one. A zero, a wrong length, a wrong discriminator or
// the mints in the other order throw rather than yield a floor.

import { tryBase58Decode, base58Encode } from "./base58";
import { USDC_MINT, WSOL_MINT } from "./addresses";
import { bytesEqual } from "./idl";
import { U128_MAX } from "./rules";

export const CLMM_POOL_STATE_BYTES = 1544;
/** sha256("account:PoolState")[..8], Anchor's discriminator for Raydium CLMM's pool account. */
export const CLMM_POOL_STATE_DISCRIMINATOR: readonly number[] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];

const MINT0_AT = 73;
const MINT1_AT = 105;
const DECIMALS0_AT = 233;
const DECIMALS1_AT = 234;
const SQRT_PRICE_AT = 253;

export const WAD = 10n ** 18n;
const Q128 = 1n << 128n;
const BPS = 10_000n;

export class PoolPriceError extends Error {
  override readonly name = "PoolPriceError";
}

export interface ClmmPoolPrice {
  readonly mint0: string;
  readonly mint1: string;
  readonly decimals0: number;
  readonly decimals1: number;
  readonly sqrtPriceX64: bigint;
}

function u128At(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i--) value = (value << 8n) | BigInt(bytes[at + i]!);
  return value;
}

/** The price fields of a PoolState account's data. Throws PoolPriceError on anything that is not one. */
export function decodeClmmPoolPrice(data: Uint8Array): ClmmPoolPrice {
  if (!(data instanceof Uint8Array) || data.length !== CLMM_POOL_STATE_BYTES) {
    throw new PoolPriceError(`a Raydium CLMM pool is ${CLMM_POOL_STATE_BYTES} bytes, this account is ${data instanceof Uint8Array ? data.length : "not bytes"}`);
  }
  if (!bytesEqual(data.subarray(0, 8), CLMM_POOL_STATE_DISCRIMINATOR)) throw new PoolPriceError("the account is not a Raydium CLMM PoolState");
  const sqrtPriceX64 = u128At(data, SQRT_PRICE_AT);
  if (sqrtPriceX64 === 0n) throw new PoolPriceError("the pool's sqrt price is zero");
  return {
    mint0: base58Encode(data.subarray(MINT0_AT, MINT0_AT + 32)),
    mint1: base58Encode(data.subarray(MINT1_AT, MINT1_AT + 32)),
    decimals0: data[DECIMALS0_AT]!,
    decimals1: data[DECIMALS1_AT]!,
    sqrtPriceX64,
  };
}

function inU128(value: bigint, what: string): bigint {
  if (value <= 0n) throw new PoolPriceError(`${what} came to zero`);
  if (value > U128_MAX) throw new PoolPriceError(`${what} does not fit a u128`);
  return value;
}

/** USDC raw per lamport × 1e18, from a pool whose mint0 is wSOL and mint1 USDC. */
export function convertWadFromSqrtPrice(sqrtPriceX64: bigint): bigint {
  if (sqrtPriceX64 <= 0n) throw new PoolPriceError("the pool's sqrt price is zero");
  return inU128((sqrtPriceX64 * sqrtPriceX64 * WAD) >> 128n, "the SOL/USDC rate");
}

/** Leg raw per USDC raw × 1e18, from a pool whose mint0 is the leg and mint1 USDC. */
export function legWadFromSqrtPrice(sqrtPriceX64: bigint): bigint {
  if (sqrtPriceX64 <= 0n) throw new PoolPriceError("the pool's sqrt price is zero");
  return inU128((Q128 * WAD) / (sqrtPriceX64 * sqrtPriceX64), "the leg rate");
}

/** `wad` less `marginBps` (0..9999), rounded down. */
export function floorWad(wad: bigint, marginBps: number): bigint {
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps >= 10_000) throw new PoolPriceError("a margin is 0 to 9999 bps");
  return inU128((wad * (BPS - BigInt(marginBps))) / BPS, "the floor");
}

function requireMints(price: ClmmPoolPrice, mint0: string, mint1: string, what: string): void {
  if (price.mint0 !== mint0 || price.mint1 !== mint1) {
    throw new PoolPriceError(`${what}: expected mint0 ${mint0} and mint1 ${mint1}, the pool holds ${price.mint0} and ${price.mint1}`);
  }
}

/** The convert rate from the wSOL/USDC pool's data, mint order checked. */
export function solUsdcConvertWad(data: Uint8Array): { readonly wad: bigint; readonly price: ClmmPoolPrice } {
  const price = decodeClmmPoolPrice(data);
  requireMints(price, WSOL_MINT, USDC_MINT, "the SOL/USDC pool");
  return { wad: convertWadFromSqrtPrice(price.sqrtPriceX64), price };
}

/** A leg's rate from its leg/USDC pool's data, mint order checked. */
export function legUsdcWad(data: Uint8Array, legMint: string): { readonly wad: bigint; readonly price: ClmmPoolPrice } {
  if (tryBase58Decode(legMint)?.length !== 32) throw new PoolPriceError("the leg mint is not a 32-byte key");
  const price = decodeClmmPoolPrice(data);
  requireMints(price, legMint, USDC_MINT, "the leg's pool");
  return { wad: legWadFromSqrtPrice(price.sqrtPriceX64), price };
}

/** USDC raw units one SOL (1e9 lamports) buys at `convertWad`: $100.04 is 100,038,711. For display. */
export const usdcRawPerSol = (convertWad: bigint): bigint => convertWad / 1_000_000_000n;

/** USDC raw units 1e8 leg raw units cost at `legWad`, rounded up: what a floor lets be paid, for display. */
export function usdcRawPer1e8LegRaw(legWad: bigint): bigint {
  if (legWad <= 0n) throw new PoolPriceError("the leg rate is zero");
  return (100_000_000n * WAD + legWad - 1n) / legWad;
}
