// The two Pyth pull-oracle feeds the keeper prices its SOL hop against, read
// out of a PriceUpdateV2 account in bigint only.
//
// A MIRROR OF packages/solana-core/src/client/pyth-price.ts, DELIBERATELY.
// The keeper does not depend on @sip/solana-core and must not start to: its
// package.json is what ships to Railway, and the repo already draws this
// boundary — invest-tick.ts re-declares the wSOL/USDC pool rather than import
// the web's copy of it. So the decoder is copied, not imported.
//
// A CHANGE TO ONE IS A CHANGE TO BOTH. Nothing in either file stops the two
// drifting apart, so test/pyth.test.ts decodes the SAME committed fixture the
// core package's own test decodes (packages/solana-core/test/fixtures/
// pyth-accounts.ts) and asserts both implementations derive the same WAD to
// the unit. That shared vector is the only thing keeping this mirror honest;
// break it and the test says so on the next run.
//
// WHAT IS DELIBERATELY NOT THE SAME, and nothing else is:
//  * core's pythConfBps is left out. It has no caller here — the keeper's guard
//    is a relative deviation bound against a live route, not a confidence band
//    — and a mirrored function nobody calls is a line that rots unread.
//  * solUsdcPythRateWad is split out of solUsdcPythWad, because
//    invest-decision.ts is handed feeds ALREADY DECODED (the owner check
//    belongs at the read) while core's callers hand it bytes. Same arithmetic,
//    same unit, one extra entry point.
//
// THE OWNER IS NOT CHECKED HERE, for the reason it is not checked there: bytes
// cannot say who wrote them. A price account is bytes at an address and an
// address is whatever the caller was handed, so WHATEVER READS THE ACCOUNT must
// assert owner === PYTH_RECEIVER_PROGRAM. invest-tick.ts does, in the same
// getMultipleAccountsInfo that fetches them.
//
// THE EXPECTED FEED ID IS NOT OPTIONAL, again as there. A decoder that reports
// the feed id it found instead of refusing the one it was not looking for
// prices SOL from a feed somebody else chose, which is the whole spoof.
//
// THE FEED ID'S OFFSET MOVES. After the 8-byte discriminator and the 32-byte
// write authority sits VerificationLevel, a Borsh enum: Partial carries a u8
// count and is TWO bytes, Full is ONE. Every account sampled on mainnet is
// Full, so feed_id begins at 41 — but the same 134 bytes are allocated either
// way, so a length check cannot tell the variants apart and a hardcoded 41
// would read a Partial account one byte short in every field, silently.

import { PublicKey } from "@solana/web3.js";

/**
 * The program that OWNS every feed account: the Pyth Solana receiver. Not the
 * push program the addresses derive under — an ownership gate that named the
 * deriver would accept an account the receiver never wrote.
 */
export const PYTH_RECEIVER_PROGRAM = new PublicKey("rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");

/** SOL/USD, shard 0. */
export const PYTH_SOL_USD_FEED = new PublicKey("7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE");
/** USDC/USD, shard 0. */
export const PYTH_USDC_USD_FEED = new PublicKey("6HAuqASbHEh4w4REJEUUUCginTLfj1kwCh215ZLtMkrT");

/** The 32-byte feed id the SOL/USD account must carry, as 64 lowercase hex characters. */
export const PYTH_SOL_USD_FEED_ID_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
/** The 32-byte feed id the USDC/USD account must carry. */
export const PYTH_USDC_USD_FEED_ID_HEX = "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

/** What Anchor allocates for a PriceUpdateV2: the LARGER variant's size, so Full leaves a trailing byte. */
export const PYTH_PRICE_UPDATE_BYTES = 134;

/** sha256("account:PriceUpdateV2")[..8], Anchor's discriminator for the receiver's price account. */
export const PYTH_PRICE_UPDATE_DISCRIMINATOR: readonly number[] = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd];

/** VerificationLevel::Partial { num_signatures: u8 } — the first Borsh variant, and two bytes wide. */
export const PYTH_VERIFICATION_PARTIAL = 0;
/** VerificationLevel::Full — the second Borsh variant, one byte wide. */
export const PYTH_VERIFICATION_FULL = 1;

const WRITE_AUTHORITY_AT = 8;
const VERIFICATION_AT = 40;

// Offsets inside the body, which begins right after the verification level.
const FEED_ID_AT = 0;
const PRICE_AT = 32;
const CONF_AT = 40;
const EXPO_AT = 48;
const PUBLISH_TIME_AT = 52;
const PREV_PUBLISH_TIME_AT = 60;
const EMA_PRICE_AT = 68;
const EMA_CONF_AT = 76;
const POSTED_SLOT_AT = 84;
const BODY_BYTES = 92;

/** A decimal exponent this far from zero is not a price feed's; it is also what keeps 10 ** scale a bigint and not a hang. */
const MAX_EXPO = 18;
/** No SPL mint has more. */
const MAX_DECIMALS = 18;

/** 1e18, the unit every rate in this product is quoted in. */
const WAD = 10n ** 18n;
const U128_MAX = (1n << 128n) - 1n;

const FEED_ID_HEX = /^[0-9a-f]{64}$/;

export class PythPriceError extends Error {
  override readonly name = "PythPriceError";
}

export interface PythVerification {
  /** The Borsh variant index: PYTH_VERIFICATION_PARTIAL or PYTH_VERIFICATION_FULL. */
  readonly variant: number;
  /** Partial's guardian-signature count. Full checked every one and carries no count, so it is null. */
  readonly numSignatures: number | null;
}

export interface PythPriceUpdate {
  readonly writeAuthority: string;
  readonly verification: PythVerification;
  readonly feedIdHex: string;
  /** i64, SIGNED: a feed may quote below zero, and a wrapped read would quote it enormous. */
  readonly price: bigint;
  /** u64, the symmetric confidence interval, in the same expo as the price. */
  readonly conf: bigint;
  /** i32, SIGNED: the decimal exponent, -8 on both feeds SaverFi reads. */
  readonly expo: number;
  /** i64 unix seconds. Compare it only with a clock the caller supplies. */
  readonly publishTime: bigint;
  readonly prevPublishTime: bigint;
  readonly emaPrice: bigint;
  readonly emaConf: bigint;
  readonly postedSlot: bigint;
}

function u64At(bytes: Uint8Array, at: number): bigint {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[at + i]!);
  return value;
}

/** Two's complement over 8 bytes, so a negative price reads negative instead of astronomical. */
function i64At(bytes: Uint8Array, at: number): bigint {
  const value = u64At(bytes, at);
  return value >= 1n << 63n ? value - (1n << 64n) : value;
}

function i32At(bytes: Uint8Array, at: number): number {
  let value = 0;
  for (let i = 3; i >= 0; i--) value = value * 256 + bytes[at + i]!;
  return value >= 0x8000_0000 ? value - 0x1_0000_0000 : value;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function bytesEqual(a: Uint8Array, b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (const [index, byte] of b.entries()) if (a[index] !== byte) return false;
  return true;
}

/** A 32-byte feed id as this package writes it: 64 lowercase hex characters. Throws on anything else. */
function requireFeedIdHex(feedIdHex: unknown, what: string): string {
  if (typeof feedIdHex !== "string" || !FEED_ID_HEX.test(feedIdHex)) {
    throw new PythPriceError(`${what} is 64 lowercase hex characters, not ${typeof feedIdHex === "string" ? JSON.stringify(feedIdHex) : typeof feedIdHex}`);
  }
  return feedIdHex;
}

/** Where the body starts, from the variant byte. Both widths are real; an unknown variant is not read past. */
function readVerification(data: Uint8Array): { readonly verification: PythVerification; readonly bodyAt: number } {
  const variant = data[VERIFICATION_AT]!;
  if (variant === PYTH_VERIFICATION_FULL) {
    return { verification: { variant, numSignatures: null }, bodyAt: VERIFICATION_AT + 1 };
  }
  if (variant === PYTH_VERIFICATION_PARTIAL) {
    return { verification: { variant, numSignatures: data[VERIFICATION_AT + 1]! }, bodyAt: VERIFICATION_AT + 2 };
  }
  throw new PythPriceError(`the price update's verification level is variant ${variant}, which is neither Partial (${PYTH_VERIFICATION_PARTIAL}) nor Full (${PYTH_VERIFICATION_FULL})`);
}

/**
 * The fields of a PriceUpdateV2 account's data, for the feed the caller expects.
 * Throws PythPriceError on a wrong size, a wrong discriminator, an unknown
 * verification variant, or a feed id that is not `expectedFeedIdHex`.
 */
export function decodePythPriceUpdate(data: Uint8Array, expectedFeedIdHex: string): PythPriceUpdate {
  const expected = requireFeedIdHex(expectedFeedIdHex, "the expected feed id");
  if (!(data instanceof Uint8Array) || data.length !== PYTH_PRICE_UPDATE_BYTES) {
    throw new PythPriceError(`a Pyth price update is ${PYTH_PRICE_UPDATE_BYTES} bytes, this account is ${data instanceof Uint8Array ? data.length : "not bytes"}`);
  }
  if (!bytesEqual(data.subarray(0, 8), PYTH_PRICE_UPDATE_DISCRIMINATOR)) throw new PythPriceError("the account is not a Pyth PriceUpdateV2");
  const { verification, bodyAt } = readVerification(data);
  // Full leaves a trailing byte inside the allocation; Partial fills it exactly. Neither may run past it.
  if (bodyAt + BODY_BYTES > data.length) throw new PythPriceError(`the price update's ${verification.variant === PYTH_VERIFICATION_PARTIAL ? "Partial" : "Full"} body needs ${bodyAt + BODY_BYTES} bytes, the account has ${data.length}`);
  const feedIdHex = toHex(data.subarray(bodyAt + FEED_ID_AT, bodyAt + FEED_ID_AT + 32));
  if (feedIdHex !== expected) throw new PythPriceError(`the price update carries feed id ${feedIdHex}, the caller expected ${expected}`);
  return {
    writeAuthority: new PublicKey(data.subarray(WRITE_AUTHORITY_AT, WRITE_AUTHORITY_AT + 32)).toBase58(),
    verification,
    feedIdHex,
    price: i64At(data, bodyAt + PRICE_AT),
    conf: u64At(data, bodyAt + CONF_AT),
    expo: i32At(data, bodyAt + EXPO_AT),
    publishTime: i64At(data, bodyAt + PUBLISH_TIME_AT),
    prevPublishTime: i64At(data, bodyAt + PREV_PUBLISH_TIME_AT),
    emaPrice: i64At(data, bodyAt + EMA_PRICE_AT),
    emaConf: u64At(data, bodyAt + EMA_CONF_AT),
    postedSlot: u64At(data, bodyAt + POSTED_SLOT_AT),
  };
}

/**
 * Seconds between a publish and the clock the CALLER passes: positive when the
 * publish is behind that clock, negative when the clock is. It is reported, not
 * judged — whether an age is too old is invest-decision.ts's call, and a
 * committed fixture is stale by definition.
 */
export function pythPublishAgeSeconds(publishTime: bigint, nowUnixSeconds: bigint): bigint {
  if (typeof publishTime !== "bigint" || typeof nowUnixSeconds !== "bigint") throw new PythPriceError("a publish time and a clock are both bigints of unix seconds");
  return nowUnixSeconds - publishTime;
}

function inU128(value: bigint, what: string): bigint {
  if (value <= 0n) throw new PythPriceError(`${what} came to zero`);
  if (value > U128_MAX) throw new PythPriceError(`${what} does not fit a u128`);
  return value;
}

function positivePrice(update: PythPriceUpdate, what: string): bigint {
  if (update.price <= 0n) throw new PythPriceError(`the ${what} feed quotes ${update.price}, which is not a price`);
  if (update.expo < -MAX_EXPO || update.expo > MAX_EXPO) throw new PythPriceError(`the ${what} feed's exponent is ${update.expo}, outside ±${MAX_EXPO}`);
  return update.price;
}

function mintDecimals(decimals: number, what: string): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) throw new PythPriceError(`${what} decimals are an integer 0 to ${MAX_DECIMALS}, not ${decimals}`);
  return decimals;
}

/**
 * `base` over `quote` as raw-per-raw × 1e18 — the WAD unit set_invest_policy
 * stores and the convert floor is in — with each feed's own exponent and each
 * token's own decimals folded in, so the two USD quotes cancel:
 *
 *   quote raw per base raw = (base.price / quote.price)
 *                          × 10^(base.expo − quote.expo)
 *                          × 10^(quoteDecimals − baseDecimals)
 *
 * Truncated, like every other floor in this product. Throws rather than guess on
 * a non-positive price, an absurd exponent, or a result that is zero or over a u128.
 */
export function pythRateWad(
  base: PythPriceUpdate,
  quote: PythPriceUpdate,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  const basePrice = positivePrice(base, "base");
  const quotePrice = positivePrice(quote, "quote");
  const scale = base.expo - quote.expo + mintDecimals(quoteDecimals, "the quote's") - mintDecimals(baseDecimals, "the base's");
  const numerator = basePrice * WAD * (scale > 0 ? 10n ** BigInt(scale) : 1n);
  const denominator = quotePrice * (scale < 0 ? 10n ** BigInt(-scale) : 1n);
  return inU128(numerator / denominator, "the oracle rate");
}

/** SOL is nine decimals of lamports. */
const LAMPORT_DECIMALS = 9;
/** USDC is six. The pair the convert floor is quoted in. */
const USDC_DECIMALS = 6;

/**
 * USDC raw per lamport × 1e18 from two ALREADY-DECODED feeds: the same unit the
 * pool's own rate is read in, so oracle and pool compare directly with no
 * display price entering either. Throws whatever pythRateWad throws.
 */
export function solUsdcPythRateWad(sol: PythPriceUpdate, usdc: PythPriceUpdate): bigint {
  return pythRateWad(sol, usdc, LAMPORT_DECIMALS, USDC_DECIMALS);
}

export interface SolUsdcPythRate {
  /** USDC raw per lamport × 1e18. */
  readonly wad: bigint;
  readonly sol: PythPriceUpdate;
  readonly usdc: PythPriceUpdate;
  /** The OLDER of the two publishes' age against the caller's clock: the pair is only as fresh as its stalest leg. */
  readonly ageSeconds: bigint;
}

/**
 * The SOL/USDC rate from the two feeds' account data, each refused unless it
 * carries the feed id this file names for it, with the pair's age against
 * `nowUnixSeconds`. The caller checks both accounts' owner is
 * PYTH_RECEIVER_PROGRAM and decides what age it will accept; neither is here.
 */
export function solUsdcPythWad(solUsdData: Uint8Array, usdcUsdData: Uint8Array, nowUnixSeconds: bigint): SolUsdcPythRate {
  const sol = decodePythPriceUpdate(solUsdData, PYTH_SOL_USD_FEED_ID_HEX);
  const usdc = decodePythPriceUpdate(usdcUsdData, PYTH_USDC_USD_FEED_ID_HEX);
  return {
    wad: solUsdcPythRateWad(sol, usdc),
    sol,
    usdc,
    ageSeconds: pythPublishAgeSeconds(olderPublishTime(sol, usdc), nowUnixSeconds),
  };
}

/** The stalest of a pair's two publishes: a pair is only as fresh as its older leg. */
export function olderPublishTime(sol: PythPriceUpdate, usdc: PythPriceUpdate): bigint {
  return sol.publishTime < usdc.publishTime ? sol.publishTime : usdc.publishTime;
}
