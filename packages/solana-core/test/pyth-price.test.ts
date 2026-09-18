// The PriceUpdateV2 decoder: the two mainnet accounts as captured, and the
// synthetic Partial vector the hardcoded-offset bug would sail through.

import { describe, expect, it } from "vitest";

import {
  PYTH_RECEIVER_PROGRAM,
  PYTH_SOL_USD_FEED_ID_HEX,
  PYTH_USDC_USD_FEED_ID_HEX,
} from "../src/client/addresses";
import { usdcRawPerSol } from "../src/client/clmm-price";
import { toHex } from "../src/client/idl";
import {
  PYTH_PRICE_UPDATE_BYTES,
  PYTH_PRICE_UPDATE_DISCRIMINATOR,
  PYTH_VERIFICATION_FULL,
  PYTH_VERIFICATION_PARTIAL,
  PythPriceError,
  decodePythPriceUpdate,
  pythConfBps,
  pythPublishAgeSeconds,
  pythRateWad,
  solUsdcPythWad,
  type PythPriceUpdate,
} from "../src/client/pyth-price";
import {
  PYTH_FIXTURE_POSTED_SLOT,
  PYTH_FIXTURE_PUBLISH_TIME,
  PYTH_FIXTURE_SPACE,
  PYTH_SOL_USD_ACCOUNT,
  PYTH_USDC_USD_ACCOUNT,
} from "./fixtures/pyth-accounts";

/** A clock the TEST owns. Nothing here reads the host's, so nothing here goes stale. */
const NOW = PYTH_FIXTURE_PUBLISH_TIME + 15n;

interface UpdateFields {
  readonly variant: number;
  readonly numSignatures: number;
  readonly writeAuthority: Uint8Array;
  readonly feedIdHex: string;
  readonly price: bigint;
  readonly conf: bigint;
  readonly expo: number;
  readonly publishTime: bigint;
  readonly prevPublishTime: bigint;
  readonly emaPrice: bigint;
  readonly emaConf: bigint;
  readonly postedSlot: bigint;
}

const FIELDS: UpdateFields = {
  variant: PYTH_VERIFICATION_FULL,
  numSignatures: 0,
  writeAuthority: Uint8Array.from({ length: 32 }, (_, i) => (i * 3 + 7) & 0xff),
  feedIdHex: PYTH_SOL_USD_FEED_ID_HEX,
  price: 10_259_321_149n,
  conf: 1_384_501n,
  expo: -8,
  publishTime: 1_789_699_386n,
  prevPublishTime: 1_789_699_385n,
  emaPrice: 10_212_384_680n,
  emaConf: 1_661_189n,
  postedSlot: 447_956_893n,
};

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function put64(bytes: Uint8Array, at: number, value: bigint): void {
  let v = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++, v >>= 8n) bytes[at + i] = Number(v & 0xffn);
}

function put32(bytes: Uint8Array, at: number, value: number): void {
  let v = Number(BigInt.asUintN(32, BigInt(value)));
  for (let i = 0; i < 4; i++, v = Math.floor(v / 256)) bytes[at + i] = v & 0xff;
}

/**
 * A PriceUpdateV2 account's bytes, at whichever verification variant is asked
 * for. Always PYTH_PRICE_UPDATE_BYTES long — Anchor allocates for the larger
 * variant — so the two variants are indistinguishable by length, which is the
 * point of the vector below.
 */
function updateBytes(fields: Partial<UpdateFields> = {}): Uint8Array {
  const f = { ...FIELDS, ...fields };
  const bytes = new Uint8Array(PYTH_PRICE_UPDATE_BYTES);
  bytes.set(PYTH_PRICE_UPDATE_DISCRIMINATOR, 0);
  bytes.set(f.writeAuthority, 8);
  bytes[40] = f.variant;
  let at = 41;
  if (f.variant === PYTH_VERIFICATION_PARTIAL) bytes[at++] = f.numSignatures;
  bytes.set(hexBytes(f.feedIdHex), at);
  put64(bytes, at + 32, f.price);
  put64(bytes, at + 40, f.conf);
  put32(bytes, at + 48, f.expo);
  put64(bytes, at + 52, f.publishTime);
  put64(bytes, at + 60, f.prevPublishTime);
  put64(bytes, at + 68, f.emaPrice);
  put64(bytes, at + 76, f.emaConf);
  put64(bytes, at + 84, f.postedSlot);
  return bytes;
}

/** A decoded update built from numbers rather than from bytes, for the rate arithmetic. */
function quote(price: bigint, expo: number, conf = 0n): PythPriceUpdate {
  return {
    writeAuthority: PYTH_RECEIVER_PROGRAM,
    verification: { variant: PYTH_VERIFICATION_FULL, numSignatures: null },
    feedIdHex: PYTH_SOL_USD_FEED_ID_HEX,
    price,
    conf,
    expo,
    publishTime: 0n,
    prevPublishTime: 0n,
    emaPrice: price,
    emaConf: conf,
    postedSlot: 0n,
  };
}

describe("the mainnet accounts, as captured at slot 447956907", () => {
  it("both are 134 bytes of PriceUpdateV2 at VerificationLevel::Full, carrying the feed ids addresses.ts names", () => {
    expect([PYTH_SOL_USD_ACCOUNT.length, PYTH_USDC_USD_ACCOUNT.length]).toEqual([PYTH_FIXTURE_SPACE, PYTH_FIXTURE_SPACE]);
    expect(PYTH_PRICE_UPDATE_BYTES).toBe(PYTH_FIXTURE_SPACE);
    const sol = decodePythPriceUpdate(PYTH_SOL_USD_ACCOUNT, PYTH_SOL_USD_FEED_ID_HEX);
    const usdc = decodePythPriceUpdate(PYTH_USDC_USD_ACCOUNT, PYTH_USDC_USD_FEED_ID_HEX);
    expect(sol.verification).toEqual({ variant: PYTH_VERIFICATION_FULL, numSignatures: null });
    expect(usdc.verification).toEqual({ variant: PYTH_VERIFICATION_FULL, numSignatures: null });
    expect(sol.feedIdHex).toBe(PYTH_SOL_USD_FEED_ID_HEX);
    expect(usdc.feedIdHex).toBe(PYTH_USDC_USD_FEED_ID_HEX);
    // Full's 133 bytes of struct inside a 134-byte allocation: the last byte is padding.
    expect(PYTH_SOL_USD_ACCOUNT[133]).toBe(0);
  });

  it("SOL/USD is 10259321149 at expo -8 ($102.59321149) and USDC/USD 99987040 ($0.99987040), both posted in slot 447956893", () => {
    const sol = decodePythPriceUpdate(PYTH_SOL_USD_ACCOUNT, PYTH_SOL_USD_FEED_ID_HEX);
    expect([sol.price, sol.conf, sol.expo]).toEqual([10_259_321_149n, 1_384_501n, -8]);
    expect([sol.publishTime, sol.prevPublishTime]).toEqual([PYTH_FIXTURE_PUBLISH_TIME, PYTH_FIXTURE_PUBLISH_TIME - 1n]);
    expect([sol.emaPrice, sol.emaConf, sol.postedSlot]).toEqual([10_212_384_680n, 1_661_189n, PYTH_FIXTURE_POSTED_SLOT]);
    const usdc = decodePythPriceUpdate(PYTH_USDC_USD_ACCOUNT, PYTH_USDC_USD_FEED_ID_HEX);
    expect([usdc.price, usdc.conf, usdc.expo]).toEqual([99_987_040n, 87_960n, -8]);
    expect([usdc.publishTime, usdc.postedSlot]).toEqual([PYTH_FIXTURE_PUBLISH_TIME, PYTH_FIXTURE_POSTED_SLOT]);
    // Each feed's write authority is its own, and neither is the program that owns the account.
    expect(sol.writeAuthority).not.toBe(usdc.writeAuthority);
    expect(sol.writeAuthority).not.toBe(PYTH_RECEIVER_PROGRAM);
  });

  it("the pair is 102606509293604451 USDC raw per lamport × 1e18, which usdcRawPerSol reads as $102.606509", () => {
    const rate = solUsdcPythWad(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, NOW);
    expect(rate.wad).toBe(102_606_509_293_604_451n);
    expect(usdcRawPerSol(rate.wad)).toBe(102_606_509n);
    // SOL/USD alone is $102.59321149; dividing by a USDC under a dollar lifts it.
    expect(rate.wad).toBeGreaterThan(102_593_211_490_000_000n);
    expect(rate.sol.feedIdHex).toBe(PYTH_SOL_USD_FEED_ID_HEX);
    expect(rate.usdc.feedIdHex).toBe(PYTH_USDC_USD_FEED_ID_HEX);
  });

  it("confidence is read relative to the price, never as a USD band: 1 bps on SOL, 8 on USDC", () => {
    expect(pythConfBps(decodePythPriceUpdate(PYTH_SOL_USD_ACCOUNT, PYTH_SOL_USD_FEED_ID_HEX))).toBe(1n);
    expect(pythConfBps(decodePythPriceUpdate(PYTH_USDC_USD_ACCOUNT, PYTH_USDC_USD_FEED_ID_HEX))).toBe(8n);
  });
});

describe("the age comes from the caller's clock", () => {
  it("is the seconds between the publish and whatever clock is passed, and never asks the host", () => {
    const rate = solUsdcPythWad(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, NOW);
    expect(rate.ageSeconds).toBe(15n);
    // The same bytes, a clock a year on: the decoder reports the number and judges nothing.
    expect(solUsdcPythWad(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, NOW + 31_536_000n).ageSeconds).toBe(31_536_015n);
    // A clock behind the publish reads negative rather than throwing or clamping.
    expect(solUsdcPythWad(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, PYTH_FIXTURE_PUBLISH_TIME - 3n).ageSeconds).toBe(-3n);
    expect(pythPublishAgeSeconds(PYTH_FIXTURE_PUBLISH_TIME, NOW)).toBe(15n);
  });

  it("a pair is only as fresh as its stalest leg", () => {
    const sol = updateBytes({ publishTime: 1_000n, feedIdHex: PYTH_SOL_USD_FEED_ID_HEX });
    const usdc = updateBytes({ publishTime: 940n, price: 99_987_040n, feedIdHex: PYTH_USDC_USD_FEED_ID_HEX });
    expect(solUsdcPythWad(sol, usdc, 1_000n).ageSeconds).toBe(60n);
    // The younger leg's own age is smaller; the pair still reports the older.
    expect(pythPublishAgeSeconds(1_000n, 1_000n)).toBe(0n);
  });
});

describe("the Partial vector", () => {
  const partial = updateBytes({ variant: PYTH_VERIFICATION_PARTIAL, numSignatures: 5 });
  const full = updateBytes();

  it("is the same 134 bytes as Full, so no length check can tell them apart", () => {
    expect(partial.length).toBe(full.length);
    expect(partial.length).toBe(PYTH_PRICE_UPDATE_BYTES);
    expect(partial[40]).toBe(PYTH_VERIFICATION_PARTIAL);
    expect(full[40]).toBe(PYTH_VERIFICATION_FULL);
  });

  it("decodes every field one byte later, to exactly what Full decodes", () => {
    const decodedPartial = decodePythPriceUpdate(partial, PYTH_SOL_USD_FEED_ID_HEX);
    const decodedFull = decodePythPriceUpdate(full, PYTH_SOL_USD_FEED_ID_HEX);
    expect(decodedPartial.verification).toEqual({ variant: PYTH_VERIFICATION_PARTIAL, numSignatures: 5 });
    expect(decodedFull.verification).toEqual({ variant: PYTH_VERIFICATION_FULL, numSignatures: null });
    const { verification: _p, ...partialFields } = decodedPartial;
    const { verification: _f, ...fullFields } = decodedFull;
    expect(partialFields).toEqual(fullFields);
    expect(partialFields).toMatchObject({
      feedIdHex: PYTH_SOL_USD_FEED_ID_HEX,
      price: FIELDS.price,
      conf: FIELDS.conf,
      expo: FIELDS.expo,
      publishTime: FIELDS.publishTime,
      prevPublishTime: FIELDS.prevPublishTime,
      emaPrice: FIELDS.emaPrice,
      emaConf: FIELDS.emaConf,
      postedSlot: FIELDS.postedSlot,
    });
  });

  it("is what a feed id hardcoded at 41 would read wrong", () => {
    // What the buggy decoder would take for the feed id, and what it would take for the price.
    expect(toHex(partial.subarray(41, 73))).not.toBe(PYTH_SOL_USD_FEED_ID_HEX);
    expect(toHex(partial.subarray(42, 74))).toBe(PYTH_SOL_USD_FEED_ID_HEX);
    // Its first byte is the signature count; the feed id's own last byte spills one past 73.
    expect(partial[41]).toBe(5);
    expect(partial[73]).toBe(hexBytes(PYTH_SOL_USD_FEED_ID_HEX)[31]);
    // And the whole account still carries the feed id it claims, so only the branch saves it.
    expect(decodePythPriceUpdate(partial, PYTH_SOL_USD_FEED_ID_HEX).feedIdHex).toBe(PYTH_SOL_USD_FEED_ID_HEX);
  });

  it("refuses a variant that is neither", () => {
    for (const variant of [2, 7, 0xff]) {
      const forged = updateBytes();
      forged[40] = variant;
      expect(() => decodePythPriceUpdate(forged, PYTH_SOL_USD_FEED_ID_HEX)).toThrow(/verification level is variant/);
      expect(() => decodePythPriceUpdate(forged, PYTH_SOL_USD_FEED_ID_HEX)).toThrow(PythPriceError);
    }
  });
});

describe("refusals", () => {
  it("a feed id the caller did not expect is refused, whichever way round the pair is handed over", () => {
    expect(() => decodePythPriceUpdate(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_FEED_ID_HEX)).toThrow(/carries feed id/);
    expect(() => decodePythPriceUpdate(PYTH_USDC_USD_ACCOUNT, PYTH_SOL_USD_FEED_ID_HEX)).toThrow(PythPriceError);
    // The spoof this exists for: the two real accounts, swapped.
    expect(() => solUsdcPythWad(PYTH_USDC_USD_ACCOUNT, PYTH_SOL_USD_ACCOUNT, NOW)).toThrow(/carries feed id/);
    // An account of the right shape carrying somebody else's feed.
    const stranger = updateBytes({ feedIdHex: "00".repeat(32) });
    expect(() => decodePythPriceUpdate(stranger, PYTH_SOL_USD_FEED_ID_HEX)).toThrow(/the caller expected ef0d8b6f/);
  });

  it("an expected feed id that is not 32 bytes of lowercase hex is refused before the account is read", () => {
    for (const bad of ["", "EF0D8B6FDA2CEBA41DA15D4095D1DA392A0D2F8ED0C6C7BC0F4CFAC8C280B56D", PYTH_SOL_USD_FEED_ID_HEX.slice(0, 62), `${PYTH_SOL_USD_FEED_ID_HEX}00`]) {
      expect(() => decodePythPriceUpdate(PYTH_SOL_USD_ACCOUNT, bad)).toThrow(/64 lowercase hex characters/);
    }
  });

  it("a wrong length and a wrong discriminator both throw", () => {
    expect(() => decodePythPriceUpdate(PYTH_SOL_USD_ACCOUNT.subarray(0, 133), PYTH_SOL_USD_FEED_ID_HEX)).toThrow(/134 bytes, this account is 133/);
    expect(() => decodePythPriceUpdate(new Uint8Array(200), PYTH_SOL_USD_FEED_ID_HEX)).toThrow(/this account is 200/);
    const forged = updateBytes();
    forged[0] = 0;
    expect(() => decodePythPriceUpdate(forged, PYTH_SOL_USD_FEED_ID_HEX)).toThrow(/not a Pyth PriceUpdateV2/);
  });

  it("price and expo are signed, so a negative quote reads negative and is then refused as a rate", () => {
    const negative = decodePythPriceUpdate(updateBytes({ price: -42n, emaPrice: -42n }), PYTH_SOL_USD_FEED_ID_HEX);
    expect(negative.price).toBe(-42n);
    expect(negative.emaPrice).toBe(-42n);
    expect(negative.expo).toBe(-8);
    expect(() => pythRateWad(negative, quote(99_987_040n, -8), 9, 6)).toThrow(/quotes -42/);
    expect(() => pythConfBps(negative)).toThrow(/has no confidence/);
    expect(() => pythRateWad(quote(1n, -8), quote(0n, -8), 9, 6)).toThrow(/quotes 0/);
  });

  it("an absurd exponent, absurd decimals, a rate that rounds to zero and one over a u128 all throw", () => {
    expect(() => pythRateWad(quote(1n, 19), quote(1n, -8), 9, 6)).toThrow(/outside ±18/);
    expect(() => pythRateWad(quote(1n, -8), quote(1n, -19), 9, 6)).toThrow(/outside ±18/);
    expect(() => pythRateWad(quote(1n, -8), quote(1n, -8), 19, 6)).toThrow(/integer 0 to 18/);
    expect(() => pythRateWad(quote(1n, -8), quote(1n, -8), 9, 1.5)).toThrow(/integer 0 to 18/);
    expect(() => pythRateWad(quote(1n, -18), quote(10n ** 18n, 18), 9, 0)).toThrow(/came to zero/);
    expect(() => pythRateWad(quote(9_000_000_000_000_000_000n, 18), quote(1n, -18), 0, 18)).toThrow(/does not fit a u128/);
  });

  it("the exponents and the decimals both move the rate, and a pair at parity is one WAD of raw per raw", () => {
    // Same price, same expo, same decimals: one raw buys one raw.
    expect(pythRateWad(quote(1n, -8), quote(1n, -8), 6, 6)).toBe(10n ** 18n);
    // Three more decimals on the quote side is a thousand times the raw rate.
    expect(pythRateWad(quote(1n, -8), quote(1n, -8), 6, 9)).toBe(10n ** 21n);
    // A base quoted at expo -6 against a quote at -8 is a hundred times the price.
    expect(pythRateWad(quote(1n, -6), quote(1n, -8), 6, 6)).toBe(10n ** 20n);
  });

  it("a clock that is not a bigint is refused rather than coerced", () => {
    expect(() => pythPublishAgeSeconds(1n, 2 as unknown as bigint)).toThrow(/unix seconds/);
    expect(() => pythPublishAgeSeconds("1" as unknown as bigint, 2n)).toThrow(PythPriceError);
  });
});
