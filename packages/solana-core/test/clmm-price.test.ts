// Raydium CLMM prices over synthetic PoolState buffers, against the goldens read on mainnet 2026-09-15.

import { describe, expect, it } from "vitest";

import { SPYX_MINT, USDC_MINT, WSOL_MINT } from "../src/client/addresses";
import { tryBase58Decode } from "../src/client/base58";
import {
  CLMM_POOL_STATE_BYTES,
  CLMM_POOL_STATE_DISCRIMINATOR,
  PoolPriceError,
  WAD,
  convertWadFromSqrtPrice,
  decodeClmmPoolPrice,
  floorWad,
  legUsdcWad,
  legWadFromSqrtPrice,
  solUsdcConvertWad,
  usdcRawPer1e8LegRaw,
  usdcRawPerSol,
} from "../src/client/clmm-price";
import { CONVERT_FLOOR_MARGIN_BPS, LEG_FLOOR_MARGIN_BPS } from "../src/client/product";
import { U128_MAX } from "../src/client/rules";

/** sqrt_price_x64 of 3ucNos4N (wSOL/USDC) and 6truu3rZ (SPYx/USDC) at slot 447313239. */
const SOL_SQRT = 5_834_501_654_111_004_443n;
const SPYX_SQRT = 50_911_325_114_989_095_030n;

function poolBytes(mint0: string, mint1: string, sqrtPriceX64: bigint, decimals: [number, number] = [9, 6]): Uint8Array {
  const bytes = new Uint8Array(CLMM_POOL_STATE_BYTES);
  bytes.set(CLMM_POOL_STATE_DISCRIMINATOR, 0);
  bytes.set(tryBase58Decode(mint0)!, 73);
  bytes.set(tryBase58Decode(mint1)!, 105);
  bytes[233] = decimals[0];
  bytes[234] = decimals[1];
  let value = sqrtPriceX64;
  for (let i = 0; i < 16; i++, value >>= 8n) bytes[253 + i] = Number(value & 0xffn);
  return bytes;
}

describe("the goldens", () => {
  it("convert: sqrtP 5834501654111004443 is 100038711555492562 USDC raw per lamport × 1e18 ($100.04), floored 10 % to 90034840399943305", () => {
    const wad = convertWadFromSqrtPrice(SOL_SQRT);
    expect(wad).toBe(100_038_711_555_492_562n);
    expect(floorWad(wad, CONVERT_FLOOR_MARGIN_BPS)).toBe(90_034_840_399_943_305n);
    expect(usdcRawPerSol(wad)).toBe(100_038_711n);
  });

  it("SPYx: sqrtP 50911325114989095030 is 131283650130637569 SPYx raw per USDC raw × 1e18, floored 5 % to 124719467624105690", () => {
    const wad = legWadFromSqrtPrice(SPYX_SQRT);
    expect(wad).toBe(131_283_650_130_637_569n);
    const floor = floorWad(wad, LEG_FLOOR_MARGIN_BPS);
    expect(floor).toBe(124_719_467_624_105_690n);
    // At most $801.80 per 1e8 raw at the floor, against $761.71 at the pool.
    expect(usdcRawPer1e8LegRaw(floor)).toBe(801_799_446n);
    expect(usdcRawPer1e8LegRaw(wad)).toBe(761_709_474n);
  });

  it("reads the same from pool bytes, with the mints in the order each pool holds them", () => {
    const sol = solUsdcConvertWad(poolBytes(WSOL_MINT, USDC_MINT, SOL_SQRT));
    expect(sol.wad).toBe(100_038_711_555_492_562n);
    expect([sol.price.mint0, sol.price.mint1, sol.price.decimals0, sol.price.decimals1]).toEqual([WSOL_MINT, USDC_MINT, 9, 6]);
    const spyx = legUsdcWad(poolBytes(SPYX_MINT, USDC_MINT, SPYX_SQRT, [8, 6]), SPYX_MINT);
    expect(spyx.wad).toBe(131_283_650_130_637_569n);
    expect(spyx.price.sqrtPriceX64).toBe(SPYX_SQRT);
  });
});

describe("refusals", () => {
  it("swapped mints, a short buffer, a wrong discriminator and a zero sqrt price all throw", () => {
    expect(() => solUsdcConvertWad(poolBytes(USDC_MINT, WSOL_MINT, SOL_SQRT))).toThrow(PoolPriceError);
    expect(() => legUsdcWad(poolBytes(USDC_MINT, SPYX_MINT, SPYX_SQRT), SPYX_MINT)).toThrow(/expected mint0/);
    expect(() => legUsdcWad(poolBytes(WSOL_MINT, USDC_MINT, SOL_SQRT), SPYX_MINT)).toThrow(PoolPriceError);
    expect(() => decodeClmmPoolPrice(poolBytes(WSOL_MINT, USDC_MINT, SOL_SQRT).subarray(0, 1_000))).toThrow(/1544 bytes/);
    const forged = poolBytes(WSOL_MINT, USDC_MINT, SOL_SQRT);
    forged[0] = 0;
    expect(() => decodeClmmPoolPrice(forged)).toThrow(/not a Raydium CLMM PoolState/);
    expect(() => decodeClmmPoolPrice(poolBytes(WSOL_MINT, USDC_MINT, 0n))).toThrow(/zero/);
    expect(() => convertWadFromSqrtPrice(0n)).toThrow(PoolPriceError);
    expect(() => legWadFromSqrtPrice(0n)).toThrow(PoolPriceError);
  });

  it("a rate that rounds to zero throws, and results stay within u128", () => {
    // A tiny sqrt price squares under 2^128 / 1e18: the convert rate floors to 0.
    expect(() => convertWadFromSqrtPrice(1n)).toThrow(/zero/);
    // The largest sqrt price: the leg rate floors to 0.
    expect(() => legWadFromSqrtPrice(U128_MAX)).toThrow(/zero/);
    // A sqrt price so large the convert rate exceeds u128, and one so small the leg rate does.
    expect(() => convertWadFromSqrtPrice(U128_MAX)).toThrow(/u128/);
    expect(() => legWadFromSqrtPrice(1n)).toThrow(/u128/);
    expect(legWadFromSqrtPrice(1n << 64n)).toBe(WAD);
    expect(convertWadFromSqrtPrice(1n << 64n)).toBe(WAD);
  });

  it("a margin is 0 to 9999 bps, and a floored rate is never zero", () => {
    expect(floorWad(10_000n, 0)).toBe(10_000n);
    expect(() => floorWad(10_000n, 10_000)).toThrow(PoolPriceError);
    expect(() => floorWad(10_000n, -1)).toThrow(PoolPriceError);
    expect(() => floorWad(10_000n, 1.5)).toThrow(PoolPriceError);
    expect(() => floorWad(1n, 9_999)).toThrow(/zero/);
  });
});
