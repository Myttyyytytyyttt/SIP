// The mirrored PriceUpdateV2 decoder, held against the SAME committed fixture
// the core package's own test decodes.
//
// WHY THE IMPORTS BELOW LOOK ODD. src/pyth.ts is a hand-copy of
// packages/solana-core/src/client/pyth-price.ts, and a copy with no shared
// vector is a copy that has already drifted and nobody has noticed. So this
// test reaches ACROSS the package boundary for two things and two only: the two
// mainnet accounts as captured (test/fixtures/pyth-accounts.ts) and the
// original implementation, and asserts the two derive the same WAD to the unit.
//
// They are reached by a DYNAMIC import whose specifier is built at runtime, not
// a static one, because that is the only form that crosses this boundary
// without moving it. A static import would pull solana-core's sources into the
// keeper's own tsc program, where its extensionless relative imports — legal
// under the web's `Bundler` resolution, an error under the keeper's `NodeNext`
// — fail to resolve, and `pnpm --dir packages/solana-keeper typecheck` goes red
// on files this package does not own. Vitest resolves the specifier and runs
// the real module; tsc does not follow a specifier it cannot read, so the types
// are asserted here, at the seam, and named below. A shape that changes in core
// and not here shows up as a failure in THIS file, which is the point.
//
// NOTHING HERE IS A RUNTIME DEPENDENCY. packages/solana-keeper/package.json
// does not name @sip/solana-core and must not: what it declares is what ships
// to Railway. This is a test, and a test that reads a sibling's committed bytes
// costs the deployed keeper nothing.

import { describe, expect, it } from "vitest";
import {
  PYTH_PRICE_UPDATE_BYTES,
  PYTH_PRICE_UPDATE_DISCRIMINATOR,
  PYTH_RECEIVER_PROGRAM,
  PYTH_SOL_USD_FEED_ID_HEX,
  PYTH_USDC_USD_FEED_ID_HEX,
  PYTH_VERIFICATION_FULL,
  PYTH_VERIFICATION_PARTIAL,
  PythPriceError,
  decodePythPriceUpdate,
  olderPublishTime,
  pythPublishAgeSeconds,
  pythRateWad,
  solUsdcPythRateWad,
  solUsdcPythWad,
  type PythPriceUpdate,
} from "../src/pyth.js";

/** The shape this test asserts of the sibling package's fixture module, at the seam. */
interface CoreFixtures {
  readonly PYTH_SOL_USD_ACCOUNT: Uint8Array;
  readonly PYTH_USDC_USD_ACCOUNT: Uint8Array;
  readonly PYTH_FIXTURE_OWNER: string;
  readonly PYTH_FIXTURE_SPACE: number;
  readonly PYTH_FIXTURE_PUBLISH_TIME: bigint;
  readonly PYTH_FIXTURE_POSTED_SLOT: bigint;
}

/** And of its implementation: the one function both sides are compared on. */
interface CorePythPrice {
  readonly solUsdcPythWad: (
    solUsdData: Uint8Array,
    usdcUsdData: Uint8Array,
    nowUnixSeconds: bigint,
  ) => { readonly wad: bigint; readonly ageSeconds: bigint };
}

// Built at runtime so tsc leaves the sibling package alone; vitest resolves it.
const FIXTURES = "pyth-accounts";
const IMPLEMENTATION = "pyth-price";
const core = {
  fixtures: async (): Promise<CoreFixtures> =>
    (await import(`../../solana-core/test/fixtures/${FIXTURES}.ts`)) as CoreFixtures,
  pythPrice: async (): Promise<CorePythPrice> =>
    (await import(`../../solana-core/src/client/${IMPLEMENTATION}.ts`)) as CorePythPrice,
};

/** A clock the TEST owns. Nothing here reads the host's, so nothing here goes stale. */
const PUBLISH_TIME = 1_789_699_386n;
const NOW = PUBLISH_TIME + 15n;

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
  publishTime: PUBLISH_TIME,
  prevPublishTime: PUBLISH_TIME - 1n,
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
 * A PriceUpdateV2 account's bytes at whichever verification variant is asked
 * for, always PYTH_PRICE_UPDATE_BYTES long — Anchor allocates for the larger
 * variant, so no length check can tell Partial from Full, which is the whole
 * reason the variant byte is branched on.
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

/** A decoded update built from numbers rather than bytes, for the rate arithmetic. */
function quote(price: bigint, expo: number, publishTime = PUBLISH_TIME): PythPriceUpdate {
  return {
    writeAuthority: PYTH_RECEIVER_PROGRAM.toBase58(),
    verification: { variant: PYTH_VERIFICATION_FULL, numSignatures: null },
    feedIdHex: PYTH_SOL_USD_FEED_ID_HEX,
    price,
    conf: 0n,
    expo,
    publishTime,
    prevPublishTime: publishTime - 1n,
    emaPrice: price,
    emaConf: 0n,
    postedSlot: 0n,
  };
}

describe("the mirror against the core package's committed fixture", () => {
  it("decodes the two mainnet accounts to the numbers the fixture documents", async () => {
    const { PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, PYTH_FIXTURE_SPACE, PYTH_FIXTURE_PUBLISH_TIME, PYTH_FIXTURE_POSTED_SLOT } =
      await core.fixtures();
    expect(PYTH_PRICE_UPDATE_BYTES).toBe(PYTH_FIXTURE_SPACE);

    const sol = decodePythPriceUpdate(PYTH_SOL_USD_ACCOUNT, PYTH_SOL_USD_FEED_ID_HEX);
    expect(sol.verification).toEqual({ variant: PYTH_VERIFICATION_FULL, numSignatures: null });
    expect([sol.price, sol.conf, sol.expo]).toEqual([10_259_321_149n, 1_384_501n, -8]);
    expect([sol.publishTime, sol.postedSlot]).toEqual([PYTH_FIXTURE_PUBLISH_TIME, PYTH_FIXTURE_POSTED_SLOT]);

    const usdc = decodePythPriceUpdate(PYTH_USDC_USD_ACCOUNT, PYTH_USDC_USD_FEED_ID_HEX);
    expect([usdc.price, usdc.conf, usdc.expo]).toEqual([99_987_040n, 87_960n, -8]);
    expect([usdc.publishTime, usdc.postedSlot]).toEqual([PYTH_FIXTURE_PUBLISH_TIME, PYTH_FIXTURE_POSTED_SLOT]);

    // The account's own write authority is neither feed's owner: the OWNER is
    // the reader's to check, and pyth.ts deliberately does not.
    expect(sol.writeAuthority).not.toBe(PYTH_RECEIVER_PROGRAM.toBase58());
    expect(sol.writeAuthority).not.toBe(usdc.writeAuthority);
  });

  it("DERIVES THE SAME WAD AS packages/solana-core/src/client/pyth-price.ts, TO THE UNIT", async () => {
    // The one assertion this whole file exists for. Two hand-rolled decoders,
    // one committed vector, one number: if the mirror ever drifts — an offset,
    // a sign, a rounding direction, the decimals folded the wrong way — this is
    // where it is caught, and a change to one file is a change to both.
    const { PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT } = await core.fixtures();
    const { solUsdcPythWad: coreSolUsdcPythWad } = await core.pythPrice();

    const mine = solUsdcPythWad(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, NOW);
    const theirs = coreSolUsdcPythWad(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, NOW);

    expect(mine.wad).toBe(theirs.wad);
    expect(mine.ageSeconds).toBe(theirs.ageSeconds);
    // And the number itself, so a matched pair of identical MISTAKES still fails:
    // $102.59321149 over a USDC at $0.99987040 is 0.102606509293604451 USDC per
    // lamport, and the pair reads 15 s old against the clock this test owns.
    expect(mine.wad).toBe(102_606_509_293_604_451n);
    expect(mine.ageSeconds).toBe(15n);
    // The decoded-pair entry point invest-decision.ts uses is the same arithmetic.
    expect(solUsdcPythRateWad(mine.sol, mine.usdc)).toBe(theirs.wad);
  });

  it("agrees with core on a Partial account too, where a hardcoded offset would not", async () => {
    const { solUsdcPythWad: coreSolUsdcPythWad } = await core.pythPrice();
    const sol = updateBytes({ variant: PYTH_VERIFICATION_PARTIAL, numSignatures: 5 });
    const usdc = updateBytes({
      variant: PYTH_VERIFICATION_PARTIAL,
      numSignatures: 3,
      feedIdHex: PYTH_USDC_USD_FEED_ID_HEX,
      price: 99_987_040n,
      conf: 87_960n,
    });
    expect([sol.length, usdc.length]).toEqual([PYTH_PRICE_UPDATE_BYTES, PYTH_PRICE_UPDATE_BYTES]);
    expect(solUsdcPythWad(sol, usdc, NOW).wad).toBe(coreSolUsdcPythWad(sol, usdc, NOW).wad);
    expect(decodePythPriceUpdate(sol, PYTH_SOL_USD_FEED_ID_HEX).verification).toEqual({
      variant: PYTH_VERIFICATION_PARTIAL,
      numSignatures: 5,
    });
    // Every field lands one byte later and decodes to exactly what Full does.
    const asFull = decodePythPriceUpdate(updateBytes(), PYTH_SOL_USD_FEED_ID_HEX);
    const asPartial = decodePythPriceUpdate(sol, PYTH_SOL_USD_FEED_ID_HEX);
    expect({ ...asPartial, verification: asFull.verification }).toEqual(asFull);
  });
});

describe("what the mirror refuses", () => {
  it("refuses a feed id the caller did not name, which is the whole spoof", () => {
    // The right bytes at the wrong address: a real, live, well-formed Pyth
    // account for some other asset, handed over as SOL/USD.
    expect(() => decodePythPriceUpdate(updateBytes(), PYTH_USDC_USD_FEED_ID_HEX)).toThrow(PythPriceError);
    expect(() => decodePythPriceUpdate(updateBytes(), PYTH_USDC_USD_FEED_ID_HEX)).toThrow(/carries feed id .* the caller expected/);
    // And an expected id that is not one: no silent pass on a typo'd constant.
    expect(() => decodePythPriceUpdate(updateBytes(), "not hex")).toThrow(/64 lowercase hex characters/);
  });

  it("refuses a wrong size, a wrong discriminator and an unknown verification variant", () => {
    expect(() => decodePythPriceUpdate(new Uint8Array(133), PYTH_SOL_USD_FEED_ID_HEX)).toThrow(/is 134 bytes/);
    const notPyth = updateBytes();
    notPyth[0] = 0x21;
    expect(() => decodePythPriceUpdate(notPyth, PYTH_SOL_USD_FEED_ID_HEX)).toThrow(/not a Pyth PriceUpdateV2/);
    const unknownVariant = updateBytes();
    unknownVariant[40] = 2;
    expect(() => decodePythPriceUpdate(unknownVariant, PYTH_SOL_USD_FEED_ID_HEX)).toThrow(/variant 2/);
  });

  it("refuses a price that is not one, rather than quoting it", () => {
    expect(() => solUsdcPythRateWad(quote(0n, -8), quote(99_987_040n, -8))).toThrow(PythPriceError);
    expect(() => solUsdcPythRateWad(quote(-1n, -8), quote(99_987_040n, -8))).toThrow(/which is not a price/);
    expect(() => solUsdcPythRateWad(quote(10_259_321_149n, -8), quote(0n, -8))).toThrow(PythPriceError);
    // An exponent far enough out to hang 10 ** scale is refused before it is used.
    expect(() => solUsdcPythRateWad(quote(10_259_321_149n, -40), quote(99_987_040n, -8))).toThrow(/outside/);
  });
});

describe("the age, and the pair's stalest leg", () => {
  it("is measured against whatever clock the caller passes, and never the host's", async () => {
    const { PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, PYTH_FIXTURE_PUBLISH_TIME } = await core.fixtures();
    expect(solUsdcPythWad(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, NOW).ageSeconds).toBe(15n);
    // A year on, the same bytes: the decoder reports the number and judges nothing.
    expect(solUsdcPythWad(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, NOW + 31_536_000n).ageSeconds).toBe(31_536_015n);
    // A clock BEHIND the publish reads negative rather than clamping: the chain's
    // clock drifts, and invest-decision.ts is the thing that decides what to do.
    expect(solUsdcPythWad(PYTH_SOL_USD_ACCOUNT, PYTH_USDC_USD_ACCOUNT, PYTH_FIXTURE_PUBLISH_TIME - 3n).ageSeconds).toBe(-3n);
    expect(pythPublishAgeSeconds(PYTH_FIXTURE_PUBLISH_TIME, NOW)).toBe(15n);
  });

  it("takes the OLDER of the two publishes: a pair is only as fresh as its stalest leg", () => {
    const fresh = quote(10_259_321_149n, -8, 1_000n);
    const stale = quote(99_987_040n, -8, 940n);
    expect(olderPublishTime(fresh, stale)).toBe(940n);
    expect(olderPublishTime(stale, fresh)).toBe(940n);
    const sol = updateBytes({ publishTime: 1_000n });
    const usdc = updateBytes({ publishTime: 940n, feedIdHex: PYTH_USDC_USD_FEED_ID_HEX, price: 99_987_040n });
    expect(solUsdcPythWad(sol, usdc, 1_000n).ageSeconds).toBe(60n);
  });
});

describe("the WAD unit", () => {
  it("cancels the two USD quotes and folds in both exponents and both decimals", () => {
    // A round $100 SOL against a USDC at exactly $1: 100 USDC per SOL is
    // 100_000_000 USDC raw per 1e9 lamports, so 0.1 raw per lamport x 1e18.
    expect(solUsdcPythRateWad(quote(10_000_000_000n, -8), quote(100_000_000n, -8))).toBe(100_000_000_000_000_000n);
    // The same pair quoted at different exponents is the same rate.
    expect(solUsdcPythRateWad(quote(100_000n, -3), quote(1_000n, -3))).toBe(100_000_000_000_000_000n);
    expect(solUsdcPythRateWad(quote(10_000_000_000n, -8), quote(1_000n, -3))).toBe(100_000_000_000_000_000n);
    // And nine-decimal lamports against six-decimal USDC is the 1e-3 between them.
    expect(pythRateWad(quote(10_000_000_000n, -8), quote(100_000_000n, -8), 9, 9)).toBe(100_000_000_000_000_000_000n);
  });
});
