/**
 * THE UNITS /prices IS ALLOWED TO COMPARE, and the arithmetic that makes two
 * numbers comparable before either is shown beside the other.
 *
 * WHY THIS FILE EXISTS AT ALL. Every figure on that page arrives in a different
 * unit: a Raydium CLMM pool speaks RAW per RAW scaled by 1e18, a Pyth price
 * account speaks a signed integer with its own decimal exponent, and
 * prestocks.com's API speaks dollars per UI-SCALED token. A premium computed
 * across two of those without folding decimals, the feed's exponent and the
 * mint's scaledUiAmount multiplier is not a small error — on SPYx today the
 * multiplier alone is 57 bps, which is larger than most of the premiums anyone
 * would read the page to see. So the conversions live here, in bigint, with one
 * shared unit (MICRO_USD, the unit USDC's six decimals already count in), and
 * the page never divides two numbers it did not put into that unit first.
 *
 * PURE, AND CLIENT-SAFE: no fetch, no RpcPool, no server-only import. The
 * reading of accounts is prices-data.ts's job; this file only turns bytes and
 * bigints that are already in hand into figures, and says when it cannot.
 */

/** Dollars × 1e6 — the same unit a USDC raw amount is counted in, so a price and an amount never need a float between them. */
export const MICRO_USD = 1_000_000n;

/** The multiplier of a scaledUiAmount mint, carried as an integer: multiplier × 1e12. An f64 is not a unit this file will divide by. */
export const MULTIPLIER_SCALE = 10n ** 12n;

/** A multiplier of exactly one, in MULTIPLIER_SCALE: the only value at which a raw-per-raw price is already a per-token price. */
export const MULTIPLIER_ONE = MULTIPLIER_SCALE;

const BPS = 10_000n;
const WAD = 10n ** 18n;
/** A decimal exponent further from zero than this is not a price feed's. Pyth's own decoder uses the same bound. */
const MAX_EXPO = 18;

/** Anything this file refused to compute, with the reason a reader needs to see instead of the number. */
export class PriceUnitError extends Error {
  override readonly name = "PriceUnitError";
}

/**
 * One figure that either read or did not, with WHY when it did not.
 *
 * THE PAGE IS BUILT OUT OF THESE AND NOTHING ELSE. A source that fails must
 * cost the reader that one figure and no other, so every block holds readings
 * rather than values, and a `why` is copy, not a log line.
 */
export type Reading<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

export const reads = <T>(value: T): Reading<T> => ({ ok: true, value });
export const failed = (why: string): Reading<never> => ({ ok: false, why });

/** `run`'s value, or the reason it threw as a reading. The only place this file turns a throw into copy. */
export function attempt<T>(what: string, run: () => T): Reading<T> {
  try {
    return reads(run());
  } catch (error) {
    return failed(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Pyth ─────────────────────────────────────────────────────────────────────

/**
 * A Pyth price (a signed integer and its exponent) in MICRO_USD, truncated.
 *
 * The exponent is -8 on every feed this page reads, so the division is by 100
 * and the truncation is a hundredth of a cent. It is written in full anyway
 * because a feed's exponent is the feed's to change.
 */
export function pythMicroUsd(price: bigint, expo: number): bigint {
  if (typeof price !== "bigint") throw new PriceUnitError("a Pyth price is a bigint");
  if (price <= 0n) throw new PriceUnitError(`the feed quotes ${price}, which is not a price`);
  if (!Number.isInteger(expo) || expo < -MAX_EXPO || expo > MAX_EXPO) throw new PriceUnitError(`the feed's exponent is ${expo}, outside ±${MAX_EXPO}`);
  const scale = 6 + expo;
  return scale >= 0 ? price * 10n ** BigInt(scale) : price / 10n ** BigInt(-scale);
}

// ── Raydium CLMM mids ────────────────────────────────────────────────────────

/**
 * USDC raw per SOL — MICRO_USD per SOL, the same number — from a convert WAD
 * (USDC raw per lamport × 1e18). The keeper's own display helper divides by
 * exactly this; it is repeated rather than imported because this file may not
 * reach the keeper.
 */
export function solMicroUsdFromConvertWad(convertWad: bigint): bigint {
  if (typeof convertWad !== "bigint" || convertWad <= 0n) throw new PriceUnitError("the pool's SOL rate is zero");
  return convertWad / 1_000_000_000n;
}

/**
 * MICRO_USD per ONE UI TOKEN of a leg, from its pool's leg WAD (leg raw per
 * USDC raw × 1e18), the mint's decimals and the mint's EFFECTIVE scaledUiAmount
 * multiplier.
 *
 *   usdc_raw per leg_raw   = 1e18 / legWad
 *   leg_raw per UI token   = 10^decimals / multiplier
 *   MICRO_USD per UI token = 10^(decimals+18) / (multiplier × legWad)
 *
 * WHY THE MULTIPLIER IS NOT OPTIONAL. A pool trades RAW units and knows nothing
 * about the extension; a price list quotes the UI token the extension defines.
 * At SPYx's multiplier the two differ by more than half a percent, and a
 * "premium" of that size against an equity feed is the kind of number a reader
 * would act on. Passing MULTIPLIER_ONE is a claim that the mint carries no
 * scaling, and prices-data.ts only passes it after reading the mint.
 */
export function legMicroUsdPerUiToken(legWad: bigint, decimals: number, multiplierE12: bigint): bigint {
  if (typeof legWad !== "bigint" || legWad <= 0n) throw new PriceUnitError("the pool's leg rate is zero");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new PriceUnitError(`mint decimals are an integer 0 to 18, not ${decimals}`);
  if (typeof multiplierE12 !== "bigint" || multiplierE12 <= 0n) throw new PriceUnitError("a scaledUiAmount multiplier of zero or less is not a scale");
  return (10n ** BigInt(decimals + 18) * MULTIPLIER_SCALE) / (multiplierE12 * legWad);
}

// ── the comparison itself ────────────────────────────────────────────────────

/**
 * `observed` against `reference`, in bps of the REFERENCE, signed: positive
 * when the observed figure is the higher one. Both must already be in the same
 * unit — this function cannot tell, which is why nothing in this file returns a
 * bare number that has not been through one of the conversions above.
 *
 * Truncated toward zero, so a reported deviation is never larger than the real one.
 */
export function deviationBps(observed: bigint, reference: bigint): bigint {
  if (typeof observed !== "bigint" || typeof reference !== "bigint") throw new PriceUnitError("a deviation is taken between two bigints");
  if (reference <= 0n) throw new PriceUnitError("a deviation is taken as bps of a positive reference");
  return ((observed - reference) * BPS) / reference;
}

/** The WAD unit the keeper's own oracle gate compares in, for the SOL hop: pool against oracle, bps of the oracle. */
export const wadDeviationBps = (poolWad: bigint, oracleWad: bigint): bigint => deviationBps(poolWad, oracleWad);

// ── the mint's scaledUiAmount extension ──────────────────────────────────────

const MINT_BASE_BYTES = 82;
const BASE_ACCOUNT_BYTES = 165;
const ACCOUNT_TYPE_MINT = 1;
const EXT_UNINITIALIZED = 0;
const EXT_SCALED_UI_AMOUNT = 25;
/** authority(32) multiplier(f64) new_multiplier_effective_timestamp(i64) new_multiplier(f64). */
const SCALED_UI_AMOUNT_BYTES = 56;

const u16At = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);

/** A mint's ScaledUiAmountConfig as Token-2022 stores it: the multiplier in force, and the one written to replace it. */
export interface ScaledUiAmountConfig {
  readonly multiplier: number;
  readonly newMultiplierEffectiveTimestamp: bigint;
  readonly newMultiplier: number;
}

/**
 * The mint's ScaledUiAmountConfig, or null when it carries none. Throws
 * PriceUnitError on a layout it does not recognise — a mint whose scaling
 * cannot be read is a mint whose price cannot be compared, and the page says so
 * rather than assuming a multiplier of one.
 *
 * The TLV walk is decodeMintTransferFee's (client/transfer-fee.ts), extension 25
 * instead of extension 1.
 */
export function decodeScaledUiAmountConfig(data: Uint8Array): ScaledUiAmountConfig | null {
  if (!(data instanceof Uint8Array) || data.length < MINT_BASE_BYTES) {
    throw new PriceUnitError(`a mint account is at least ${MINT_BASE_BYTES} bytes; this one is ${data instanceof Uint8Array ? data.length : "not bytes"}`);
  }
  if (data.length <= BASE_ACCOUNT_BYTES) return null;
  const accountType = data[BASE_ACCOUNT_BYTES]!;
  if (accountType !== ACCOUNT_TYPE_MINT) throw new PriceUnitError(`byte ${BASE_ACCOUNT_BYTES} of this mint is ${accountType}, not the ${ACCOUNT_TYPE_MINT} Token-2022 writes for a mint`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = BASE_ACCOUNT_BYTES + 1;
  while (at + 4 <= data.length) {
    const type = u16At(data, at);
    if (type === EXT_UNINITIALIZED) break;
    const length = u16At(data, at + 2);
    const start = at + 4;
    if (start + length > data.length) throw new PriceUnitError(`extension ${type} claims ${length} bytes at ${start}, past the end of a ${data.length}-byte mint`);
    if (type === EXT_SCALED_UI_AMOUNT) {
      if (length !== SCALED_UI_AMOUNT_BYTES) throw new PriceUnitError(`ScaledUiAmountConfig is ${SCALED_UI_AMOUNT_BYTES} bytes; this mint carries ${length}`);
      return {
        multiplier: view.getFloat64(start + 32, true),
        newMultiplierEffectiveTimestamp: view.getBigInt64(start + 40, true),
        newMultiplier: view.getFloat64(start + 48, true),
      };
    }
    at = start + length;
  }
  return null;
}

/**
 * The multiplier IN FORCE at `unixSeconds`, as MULTIPLIER_SCALE, and whether a
 * different one is written for later.
 *
 * TOKEN-2022'S OWN RULE, NOT A GUESS: the new multiplier applies from its
 * effective timestamp ON, so a config whose timestamp has passed is read at its
 * NEW value and the older field is history. SPYx is exactly that case today —
 * reading `multiplier` there would price every xStock 18 bps off.
 */
export interface EffectiveMultiplier {
  readonly e12: bigint;
  /** The f64 as the mint carries it, for showing beside the figure it scaled. */
  readonly value: number;
  /** True when `value` came from new_multiplier because its timestamp has arrived. */
  readonly fromNewRecord: boolean;
  /** A multiplier written for a later timestamp, if any: the scale this page's figures will move to. */
  readonly pending: { readonly value: number; readonly effectiveAt: bigint } | null;
}

/** An f64 multiplier as MULTIPLIER_SCALE, refusing anything that is not a positive, finite scale. */
export function multiplierE12(value: number): bigint {
  if (!Number.isFinite(value) || value <= 0) throw new PriceUnitError(`a scaledUiAmount multiplier of ${value} is not a scale`);
  const scaled = BigInt(Math.round(value * Number(MULTIPLIER_SCALE)));
  if (scaled <= 0n) throw new PriceUnitError(`a scaledUiAmount multiplier of ${value} rounds to zero at 1e-12`);
  return scaled;
}

export function effectiveMultiplier(config: ScaledUiAmountConfig | null, unixSeconds: bigint): EffectiveMultiplier {
  if (config === null) return { e12: MULTIPLIER_ONE, value: 1, fromNewRecord: false, pending: null };
  const arrived = unixSeconds >= config.newMultiplierEffectiveTimestamp;
  const value = arrived ? config.newMultiplier : config.multiplier;
  return {
    e12: multiplierE12(value),
    value,
    fromNewRecord: arrived,
    pending: arrived ? null : { value: config.newMultiplier, effectiveAt: config.newMultiplierEffectiveTimestamp },
  };
}

// ── formatting: every figure on the page goes through one of these ───────────

/** MICRO_USD as dollars, with `decimals` places, grouped. Truncated, never rounded up. */
export function formatUsd(microUsd: bigint, decimals = 2): string {
  if (typeof microUsd !== "bigint") throw new PriceUnitError("a price is formatted from a bigint of MICRO_USD");
  const negative = microUsd < 0n;
  const absolute = negative ? -microUsd : microUsd;
  const units = absolute / MICRO_USD;
  const fraction = (absolute % MICRO_USD).toString().padStart(6, "0").slice(0, decimals);
  const grouped = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}${decimals > 0 ? `.${fraction}` : ""}`;
}

/** A signed bps figure with its sign always shown, because the direction is the whole content: "+41 bps", "-8 bps", "0 bps". */
export function formatBps(bps: bigint): string {
  if (typeof bps !== "bigint") throw new PriceUnitError("a bps figure is formatted from a bigint");
  return `${bps > 0n ? "+" : bps < 0n ? "-" : ""}${(bps < 0n ? -bps : bps).toString()} bps`;
}

/** A percentage from bps, one decimal, for a fee: "3.0 %". */
export const formatBpsPercent = (bps: number): string => `${(bps / 100).toFixed(2)} %`;

/**
 * An age in seconds, as a reader should judge it: "9 s", "4 min 12 s",
 * "2 h 05 min". A NEGATIVE age says the publish is ahead of the clock it was
 * measured against, which is a fact about the two clocks and never rendered as
 * freshness.
 */
export function formatAge(seconds: bigint): string {
  if (typeof seconds !== "bigint") throw new PriceUnitError("an age is formatted from a bigint of seconds");
  if (seconds < 0n) return `${(-seconds).toString()} s AHEAD of the chain's clock`;
  if (seconds < 60n) return `${seconds.toString()} s`;
  if (seconds < 3_600n) return `${(seconds / 60n).toString()} min ${(seconds % 60n).toString().padStart(2, "0")} s`;
  return `${(seconds / 3_600n).toString()} h ${((seconds % 3_600n) / 60n).toString().padStart(2, "0")} min`;
}

/** A unix second as an ISO instant, for a timestamp the page states rather than ages (a pending multiplier's date). */
export const isoFromUnix = (unixSeconds: bigint): string => `${new Date(Number(unixSeconds) * 1000).toISOString().slice(0, 19)}Z`;

/** A raw USDC amount as dollars: the unit every depth figure on the page is counted in. */
export const formatUsdcRaw = (raw: bigint, decimals = 0): string => formatUsd(raw, decimals);

/** The WAD a pool rate is quoted in, for a reader who wants to re-derive a figure from the bytes. */
export const WAD_UNIT = WAD;
