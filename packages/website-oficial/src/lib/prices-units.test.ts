// THE UNIT ARITHMETIC /prices IS NOT ALLOWED TO GET WRONG.
//
// A premium is a subtraction between two numbers that had better be the same
// quantity, and on this page they arrive in three different shapes: a pool's raw
// per raw × 1e18, a Pyth integer with its own exponent, and an issuer's dollars
// per UI-scaled token. These cases pin the conversions with figures read off
// mainnet on 2026-09-25, and they pin the two ways the arithmetic could be
// quietly wrong: forgetting the mint's scaledUiAmount multiplier, and reading
// the multiplier that has been REPLACED instead of the one in force.

import { describe, expect, it } from "vitest";

import {
  MULTIPLIER_ONE,
  PriceUnitError,
  decodeScaledUiAmountConfig,
  deviationBps,
  effectiveMultiplier,
  formatAge,
  formatBps,
  formatUsd,
  legMicroUsdPerUiToken,
  multiplierE12,
  pythMicroUsd,
  solMicroUsdFromConvertWad,
} from "@/lib/prices-units";

/**
 * A Token-2022 mint with exactly the extensions the argument needs: base 165
 * bytes, the mint AccountType byte, then TLV records.
 *
 * Built rather than pasted so a case can say what it is testing. The SPYx bytes
 * in the multiplier case below are the real ones, read from mainnet.
 */
function mintWith(records: readonly { readonly type: number; readonly body: Uint8Array }[]): Uint8Array {
  const total = 166 + records.reduce((sum, record) => sum + 4 + record.body.length, 0);
  const data = new Uint8Array(total);
  data[165] = 1;
  let at = 166;
  for (const record of records) {
    data[at] = record.type & 0xff;
    data[at + 1] = record.type >> 8;
    data[at + 2] = record.body.length & 0xff;
    data[at + 3] = record.body.length >> 8;
    data.set(record.body, at + 4);
    at += 4 + record.body.length;
  }
  return data;
}

function scaledUiBody(multiplier: number, effectiveAt: bigint, newMultiplier: number): Uint8Array {
  const body = new Uint8Array(56);
  const view = new DataView(body.buffer);
  view.setFloat64(32, multiplier, true);
  view.setBigInt64(40, effectiveAt, true);
  view.setFloat64(48, newMultiplier, true);
  return body;
}

describe("Pyth prices into micro-dollars", () => {
  it("takes SOL/USD at expo -8 as mainnet published it", () => {
    // 12,098,xxx,xxx at -8 is $120.98…
    expect(formatUsd(pythMicroUsd(12_098_000_000n, -8))).toBe("$120.98");
  });

  it("takes USDC/USD to four places, where the whole point is that it is not exactly one", () => {
    expect(formatUsd(pythMicroUsd(99_980_000n, -8), 4)).toBe("$0.9998");
  });

  it("refuses a non-positive price instead of quoting it", () => {
    expect(() => pythMicroUsd(0n, -8)).toThrow(PriceUnitError);
    expect(() => pythMicroUsd(-1n, -8)).toThrow(PriceUnitError);
  });

  it("refuses an exponent no price feed has", () => {
    expect(() => pythMicroUsd(1n, -40)).toThrow(PriceUnitError);
  });
});

describe("a Raydium mid into a price per token", () => {
  it("turns the SOL/USDC convert WAD into dollars a SOL", () => {
    // $121.18 a SOL is 121,180,000 USDC raw per SOL, so the WAD is that × 1e9.
    expect(formatUsd(solMicroUsdFromConvertWad(121_180_000n * 1_000_000_000n))).toBe("$121.18");
  });

  it("prices one UI token of a 9-decimal mint that carries no scaling", () => {
    // ANTHROPIC on 2026-09-25: about $1,050 a token, multiplier exactly 1.
    const legWad = (10n ** 27n) / 1_050_000_000n; // leg raw per USDC raw × 1e18 at $1,050 and 9 decimals
    expect(formatUsd(legMicroUsdPerUiToken(legWad, 9, MULTIPLIER_ONE), 0)).toBe("$1,050");
  });

  it("FOLDS THE MULTIPLIER IN, and the difference is not a rounding error", () => {
    // SPYx on 2026-09-25: 8 decimals, multiplier 1.005714560286254 in force.
    const legWad = 129_037_000_000_000n; // ~ $774.97 per RAW 1e8 units
    const raw = legMicroUsdPerUiToken(legWad, 8, MULTIPLIER_ONE);
    const scaled = legMicroUsdPerUiToken(legWad, 8, multiplierE12(1.005714560286254));
    expect(raw).toBeGreaterThan(scaled);
    // 57 bps apart — the multiplier itself, 0.5714 % — which is larger than most of the gaps this page exists to show.
    expect(deviationBps(raw, scaled)).toBe(57n);
  });

  it("refuses a zero rate, a silly decimals count and a zero multiplier", () => {
    expect(() => legMicroUsdPerUiToken(0n, 9, MULTIPLIER_ONE)).toThrow(PriceUnitError);
    expect(() => legMicroUsdPerUiToken(1n, 19, MULTIPLIER_ONE)).toThrow(PriceUnitError);
    expect(() => legMicroUsdPerUiToken(1n, 9, 0n)).toThrow(PriceUnitError);
  });
});

describe("the mint's scaledUiAmount extension", () => {
  it("finds the config past other extensions and reads its three fields", () => {
    const data = mintWith([
      { type: 12, body: new Uint8Array(32) },
      { type: 1, body: new Uint8Array(108) },
      { type: 25, body: scaledUiBody(1.003909240011759, 1_781_755_200n, 1.005714560286254) },
    ]);
    const config = decodeScaledUiAmountConfig(data);
    expect(config?.multiplier).toBe(1.003909240011759);
    expect(config?.newMultiplierEffectiveTimestamp).toBe(1_781_755_200n);
    expect(config?.newMultiplier).toBe(1.005714560286254);
  });

  it("is null for a mint that carries no such extension", () => {
    expect(decodeScaledUiAmountConfig(mintWith([{ type: 1, body: new Uint8Array(108) }]))).toBeNull();
  });

  it("refuses a TLV record of the wrong width rather than reading a field at the wrong offset", () => {
    expect(() => decodeScaledUiAmountConfig(mintWith([{ type: 25, body: new Uint8Array(40) }]))).toThrow(PriceUnitError);
  });

  it("USES THE NEW MULTIPLIER ONCE ITS TIMESTAMP HAS ARRIVED — Token-2022's own rule", () => {
    const config = { multiplier: 1.003909240011759, newMultiplierEffectiveTimestamp: 1_781_755_200n, newMultiplier: 1.005714560286254 };
    const before = effectiveMultiplier(config, 1_781_755_199n);
    const after = effectiveMultiplier(config, 1_781_755_200n);
    expect(before.value).toBe(1.003909240011759);
    expect(before.fromNewRecord).toBe(false);
    expect(before.pending).toEqual({ value: 1.005714560286254, effectiveAt: 1_781_755_200n });
    expect(after.value).toBe(1.005714560286254);
    expect(after.fromNewRecord).toBe(true);
    expect(after.pending).toBeNull();
  });

  it("is a multiplier of one, with no pending record, when there is no extension at all", () => {
    expect(effectiveMultiplier(null, 0n)).toEqual({ e12: MULTIPLIER_ONE, value: 1, fromNewRecord: false, pending: null });
  });
});

describe("the gap, and how it is printed", () => {
  it("is signed, and taken as bps of the reference", () => {
    expect(deviationBps(1_050_330_000n, 1_042_600_000n)).toBe(74n);
    expect(deviationBps(1_042_600_000n, 1_050_330_000n)).toBe(-73n);
    expect(deviationBps(100n, 100n)).toBe(0n);
  });

  it("refuses a reference of zero instead of dividing by it", () => {
    expect(() => deviationBps(1n, 0n)).toThrow(PriceUnitError);
  });

  it("always shows the direction", () => {
    expect(formatBps(74n)).toBe("+74 bps");
    expect(formatBps(-59n)).toBe("-59 bps");
    expect(formatBps(0n)).toBe("0 bps");
  });

  it("groups dollars and truncates rather than rounding a price up", () => {
    expect(formatUsd(1_050_339_999n)).toBe("$1,050.33");
    expect(formatUsd(4_952_180_000n, 0)).toBe("$4,952");
  });
});

describe("ages, which every figure on the page carries", () => {
  it("reads seconds, minutes and hours the way a reader judges them", () => {
    expect(formatAge(9n)).toBe("9 s");
    expect(formatAge(583n)).toBe("9 min 43 s");
    expect(formatAge(7_500n)).toBe("2 h 05 min");
  });

  it("NEVER dresses a publish ahead of the chain's clock as freshness", () => {
    expect(formatAge(-4n)).toBe("4 s AHEAD of the chain's clock");
  });
});
