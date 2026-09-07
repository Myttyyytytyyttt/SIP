// What a Solana vault's holdings are worth, in dollars.
//
// FROM THE POOL'S OWN STATE, in one read per pool. A Raydium CLMM pool stores
// its current price as `sqrt_price_x64`, so the price is a field rather than
// something to infer from trades — no swap-walking, no external price API, no
// third party to trust or to be rate-limited by. Verified against reality
// rather than assumed: the WSOL/USDC pool decodes to $97.02 per SOL and the
// NVDAx pool to $212.98, against a real vault purchase two days earlier that
// filled at $215.39 — a 1.1% gap, which is drift, not a decode error.
//
// USDC IS TAKEN AS ONE DOLLAR. That is an assumption, it is stated here, and it
// is the only one in this file. Everything else is read.
//
// WHAT IT REFUSES TO DO is guess. A mint with no pool in the registry is
// reported as UNPRICED, never as zero and never omitted — a portfolio total
// that quietly drops a position it could not value is worse than one that says
// it is incomplete, because the first is a number the user will act on.

import { PublicKey } from "@solana/web3.js";

import type { SolanaRead, SolanaVaultHolding } from "./solana";
import { poolRpc } from "./rpc-pool";

/** Mainnet USDC, the quote asset every xStocks pool prices against. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export interface PoolPrice {
  readonly pool: string;
  readonly mint0: string;
  readonly mint1: string;
  /** Units of mint1 per unit of mint0, decimals applied. */
  readonly price: number;
  /**
   * The two mints' decimals, as the POOL records them.
   *
   * Carried because `price` is in whole tokens and the program's floors are in
   * RAW units per RAW unit — converting between the two needs these, and
   * reading them from anywhere else invites the pool and the floor to disagree
   * about the same mint.
   */
  readonly decimals0: number;
  readonly decimals1: number;
}

/**
 * Raydium CLMM `PoolState`, up to the field we need.
 *
 * OFFSETS ARE COUNTED, NOT COPIED, and the layout is stated so the arithmetic
 * can be checked: discriminator(8) bump(1) ammConfig(32) owner(32) mint0(32)
 * mint1(32) vault0(32) vault1(32) observation(32) decimals0(1) decimals1(1)
 * tickSpacing(2) liquidity(16) → sqrtPriceX64(16).
 */
function decodePoolPrice(pool: string, data: Uint8Array): PoolPrice | null {
  // A short account is not this layout; refusing beats reading noise as a price.
  if (data.length < 269) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let at = 8 + 1 + 32 + 32;
  const mint0 = new PublicKey(data.subarray(at, at + 32)).toBase58();
  at += 32;
  const mint1 = new PublicKey(data.subarray(at, at + 32)).toBase58();
  at += 32 + 32 + 32 + 32; // vault0, vault1, observation
  const decimals0 = data[at]!;
  at += 1;
  const decimals1 = data[at]!;
  at += 1 + 2 + 16; // mintDecimals1, tickSpacing, liquidity

  const low = view.getBigUint64(at, true);
  const high = view.getBigUint64(at + 8, true);
  const sqrtPriceX64 = low + (high << 64n);
  if (sqrtPriceX64 === 0n) return null;

  // price = (sqrt / 2^64)^2, then rescaled for the two mints' decimals.
  const root = Number(sqrtPriceX64) / 2 ** 64;
  const price = root * root * 10 ** (decimals0 - decimals1);
  if (!Number.isFinite(price) || price <= 0) return null;

  return { pool, mint0, mint1, price, decimals0, decimals1 };
}

/**
 * Out-raw per in-raw, WAD — the exact unit the vault program's floors speak.
 *
 * `price` above is whole tokens per whole token; a floor compared against
 * `min_out` is raw per raw. The gap between the two is 10^(decimalsOut −
 * decimalsIn), which for USDC(6) against an xStock(8) is a factor of 100 —
 * silently omitting it does not make a floor slightly wrong, it makes it wrong
 * by two orders of magnitude in whichever direction hurts.
 *
 * Returns null when the pool does not quote this pair, rather than inventing a
 * direction: the caller must refuse, not guess.
 */
export function rawRateWad(inMint: string, outMint: string, price: PoolPrice): bigint | null {
  let whole: number;
  let decimalsIn: number;
  let decimalsOut: number;
  if (price.mint0 === inMint && price.mint1 === outMint) {
    whole = price.price;
    decimalsIn = price.decimals0;
    decimalsOut = price.decimals1;
  } else if (price.mint0 === outMint && price.mint1 === inMint) {
    whole = 1 / price.price;
    decimalsIn = price.decimals1;
    decimalsOut = price.decimals0;
  } else {
    return null;
  }
  if (!Number.isFinite(whole) || whole <= 0) return null;

  // NINE SIGNIFICANT DIGITS THROUGH THE FLOAT, then all-integer. A WAD rate is
  // routinely ~1e17, well past the 2^53 where a double stops counting by ones,
  // so the scaling is done in BigInt and the float only ever carries the ratio.
  const SCALE = 1_000_000_000n;
  const scaled = BigInt(Math.round(whole * Number(SCALE)));
  if (scaled <= 0n) return null;
  let wad = (scaled * 10n ** 18n) / SCALE;
  wad =
    decimalsOut >= decimalsIn
      ? wad * 10n ** BigInt(decimalsOut - decimalsIn)
      : wad / 10n ** BigInt(decimalsIn - decimalsOut);
  return wad > 0n ? wad : null;
}

/**
 * Parses a `mint=pool,mint=pool` registry.
 *
 * SHARED ON PURPOSE. The portfolio prices from this registry and the policy
 * builder now floors from it; two copies of this loop is how the number a user
 * is shown and the number they SIGN come to quote different venues — the exact
 * failure the registry's own doc comment warns about.
 */
export function parsePoolRegistry(raw: string): Map<string, string> {
  const poolFor = new Map<string, string>();
  for (const entry of raw.split(",").map((e) => e.trim()).filter(Boolean)) {
    const [mint, pool] = entry.split("=");
    const m = mint?.trim();
    const p = pool?.trim();
    // Base58 addresses are 32..44 chars; anything else is a typo, not a pool.
    const looksAddress = (v: string | undefined): v is string =>
      typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
    if (looksAddress(m) && looksAddress(p)) poolFor.set(m, p);
  }
  return poolFor;
}

/** One holding, priced or explicitly not. */
export interface ValuedHolding extends SolanaVaultHolding {
  /** Dollars this position is worth, or null when it could not be priced. */
  readonly usd: number | null;
  /** Why, when it could not. */
  readonly unpricedReason: string | null;
}

export interface VaultValuation {
  readonly holdings: readonly ValuedHolding[];
  /** Native SOL held by the vault, in dollars, or null when SOL is unpriced. */
  readonly solUsd: number | null;
  /**
   * WHY there is no SOL figure — and these are not the same fact.
   * "unreadable" means we never learned the balance; "unpriced" means we know
   * exactly how much SOL is there and could not put a price on it. Collapsing
   * them tells a user with 0.3 SOL that their balance could not be read, which
   * is false and alarming.
   */
  readonly solReason: "unreadable" | "unpriced" | null;
  /**
   * The sum of everything that COULD be priced.
   *
   * Always read alongside `unpriced`: a total with positions missing from it is
   * not the user's balance, and the caller must say so rather than print it
   * plainly.
   */
  readonly totalUsd: number;
  /** Positions absent from the total, by symbol or mint. Empty means complete. */
  readonly unpriced: readonly string[];
  /** True only when every position, and SOL, could be priced. */
  readonly complete: boolean;
}

async function rpc(urls: readonly string[], method: string, params: unknown[]): Promise<unknown> {
  // One line, because the failover, the cooldown and the key-redaction all live
  // in rpc-pool.ts now — four copies of this function is how they drifted.
  return poolRpc(urls, method, params);
}

/** Reads several pools in ONE request. */
export async function readPoolPrices(
  rpcUrl: readonly string[],
  pools: readonly string[],
): Promise<SolanaRead<ReadonlyMap<string, PoolPrice>>> {
  if (pools.length === 0) return { ok: true, value: new Map() };
  try {
    const result = (await rpc(rpcUrl, "getMultipleAccounts", [
      pools,
      { encoding: "base64", commitment: "confirmed" },
    ])) as { value: readonly ({ data: [string, string] } | null)[] };

    const prices = new Map<string, PoolPrice>();
    for (const [index, account] of result.value.entries()) {
      const address = pools[index];
      if (account === null || address === undefined) continue;
      const decoded = decodePoolPrice(address, Uint8Array.from(Buffer.from(account.data[0], "base64")));
      if (decoded !== null) prices.set(address, decoded);
    }
    return { ok: true, value: prices };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Dollars per unit of `mint`, from a pool that quotes it against USDC.
 *
 * Handles either ordering — a pool may hold the stock as mint0 or mint1 — and
 * returns null rather than a guess when neither side is USDC.
 */
function usdPerUnit(mint: string, price: PoolPrice): number | null {
  if (price.mint0 === mint && price.mint1 === USDC_MINT) return price.price;
  if (price.mint1 === mint && price.mint0 === USDC_MINT) return 1 / price.price;
  return null;
}

/**
 * Values a vault's holdings.
 *
 * RAW AMOUNTS, NOT DISPLAYED ONES, and the difference is real money. xStocks
 * mints carry Token-2022's scaledUiAmount extension, so what the RPC shows a
 * holder (`uiAmount`) is the raw balance times an issuer multiplier — while the
 * POOL trades raw units. Valuing the displayed figure would overstate the
 * position by exactly that multiplier. What this reports is what the holding
 * would fetch if sold, which is the only number a portfolio should show.
 */
export function valueHoldings(
  holdings: readonly SolanaVaultHolding[],
  lamports: bigint | null,
  poolFor: ReadonlyMap<string, string>,
  prices: ReadonlyMap<string, PoolPrice>,
  wsolPool: string | null,
): VaultValuation {
  const unpriced: string[] = [];
  // UNSET IS NOT EMPTY, and the difference is the difference between a true
  // sentence and a false one. The pool registry lives in the KEEPER's
  // environment; a surface that cannot see it has no grounds to announce that
  // a stock it buys every day has no pool. Same rule the diagnostics page
  // already follows.
  const registryKnown = poolFor.size > 0;

  const valued: ValuedHolding[] = holdings.map((holding) => {
    const label = holding.symbol ?? `${holding.mint.slice(0, 8)}…`;
    const units = Number(holding.amountRaw) / 10 ** holding.decimals;

    if (holding.mint === USDC_MINT) {
      // The only assumption in this file, and it is stated where it is made.
      return { ...holding, usd: units, unpricedReason: null };
    }

    const poolAddress = poolFor.get(holding.mint);
    if (poolAddress === undefined) {
      unpriced.push(label);
      return {
        ...holding,
        usd: null,
        unpricedReason: registryKnown
          ? "no pool is configured for this mint"
          : "this site has no price source configured for it",
      };
    }
    const price = prices.get(poolAddress);
    if (price === undefined) {
      unpriced.push(label);
      return { ...holding, usd: null, unpricedReason: "that pool could not be read" };
    }
    const perUnit = usdPerUnit(holding.mint, price);
    if (perUnit === null) {
      unpriced.push(label);
      return { ...holding, usd: null, unpricedReason: "that pool does not quote against USDC" };
    }
    const usd = units * perUnit;
    // Every other price path in this file guards; this one was the exception.
    // A NaN would sail through `unpriced` untouched and surface as "$NaN" on a
    // total still claiming to be complete.
    if (!Number.isFinite(usd)) {
      unpriced.push(label);
      return { ...holding, usd: null, unpricedReason: "the value did not come out to a number" };
    }
    return { ...holding, usd, unpricedReason: null };
  });

  // Native SOL, priced through the same WSOL/USDC pool the keeper converts on.
  let solUsd: number | null = null;
  let solReason: "unreadable" | "unpriced" | null = null;
  if (lamports === null) {
    // An unreadable balance is not a zero one.
    unpriced.push("SOL");
    solReason = "unreadable";
  } else if (lamports > 0n) {
    const price = wsolPool === null ? undefined : prices.get(wsolPool);
    const perSol = price === undefined ? null : usdPerUnit(WSOL_MINT, price);
    const value = perSol === null ? Number.NaN : (Number(lamports) / 1e9) * perSol;
    if (!Number.isFinite(value)) {
      unpriced.push("SOL");
      solReason = "unpriced";
    } else {
      solUsd = value;
    }
  } else {
    solUsd = 0;
  }

  const totalUsd =
    (solUsd ?? 0) + valued.reduce((sum, holding) => sum + (holding.usd ?? 0), 0);

  return { holdings: valued, solUsd, solReason, totalUsd, unpriced, complete: unpriced.length === 0 };
}
