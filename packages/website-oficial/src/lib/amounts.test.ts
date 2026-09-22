import { describe, expect, it } from "vitest";

import { AmountError, formatSol, formatUnits, formatUsd, parseUnits, rawFrom, shareOfRaw, solToLamports, usdcRawForLamports, usdcToRaw, splitDecimal, formatSolAtMost } from "@/lib/amounts";

describe("token shares", () => {
  it("25 % and 50 % round down; All is the raw amount itself", () => {
    expect(shareOfRaw(12_345_678n, 25)).toBe(3_086_419n);
    expect(shareOfRaw(12_345_678n, 50)).toBe(6_172_839n);
    expect(shareOfRaw(12_345_678n, 100)).toBe(12_345_678n);
    expect(shareOfRaw(18_446_744_073_709_551_615n, 100)).toBe(18_446_744_073_709_551_615n);
    expect(shareOfRaw(3n, 25)).toBe(0n);
  });

  it.each([0, 101, 12.5, -25])("refuses %s percent", (percent) => {
    expect(() => shareOfRaw(100n, percent)).toThrow(AmountError);
  });
});

describe("text to raw units", () => {
  it("parses digit by digit, with no float in between", () => {
    expect(solToLamports("0.06")).toBe(60_000_000n);
    expect(solToLamports("0.05")).toBe(50_000_000n);
    expect(solToLamports(" 1 ")).toBe(1_000_000_000n);
    expect(solToLamports("0.000000001")).toBe(1n);
    expect(solToLamports("007.5")).toBe(7_500_000_000n);
    expect(usdcToRaw("10")).toBe(10_000_000n);
    expect(usdcToRaw("0.000001")).toBe(1n);
    expect(parseUnits("18446744073.709551615", 9)).toBe(18_446_744_073_709_551_615n);
  });

  it.each(["", "   ", "-1", "1e3", "0.0000000001", "1.", ".5", "0x10", "1,5", "Infinity", "NaN", "1 000"])("refuses %j", (text) => {
    expect(() => solToLamports(text)).toThrow(AmountError);
  });

  it("refuses more decimals than the token has, and more than a u64", () => {
    expect(() => usdcToRaw("0.0000001")).toThrow(/6 decimal places/);
    expect(() => solToLamports("0.0000000001")).toThrow(/9 decimal places/);
    expect(() => parseUnits("18446744073.709551616", 9)).toThrow(/too large/);
  });
});

describe("raw units to text", () => {
  it("never rounds and drops trailing zeros", () => {
    expect(formatUnits(60_000_000n, 9)).toBe("0.06");
    expect(formatSol(1_285_240n)).toBe("0.00128524");
    expect(formatSol(1_000_000_000n)).toBe("1");
    expect(formatSol(0n)).toBe("0");
    expect(formatSol(12_345_000_000_000n)).toBe("12,345");
    expect(formatUnits(-1n, 9)).toBe("-0.000000001");
  });

  it("writes dollars to the nearest cent, and converts lamports at a pool price", () => {
    expect(formatUsd(1_000_000_000n)).toBe("$1,000.00");
    expect(formatUsd(5_000_000n)).toBe("$5.00");
    expect(formatUsd(4_999n)).toBe("$0.00");
    expect(formatUsd(5_000n)).toBe("$0.01");
    // 0.06 SOL at $100.038711 a SOL.
    expect(usdcRawForLamports(60_000_000n, 100_038_711n)).toBe(6_002_322n);
    expect(formatUsd(usdcRawForLamports(60_000_000n, 100_038_711n))).toBe("$6.00");
  });

  /**
   * The hero sets the first four decimals large and the rest small. It may only
   * do that if the two halves are still the whole figure: a splitter that drops
   * a digit is a rounding nobody asked for.
   */
  it("splits a formatted decimal losslessly, measuring from the point and not the end", () => {
    expect(splitDecimal(formatSol(36_634_582n))).toEqual(["0.0366", "34582"]);
    // Grouped, so measuring from the end would cut in the wrong place.
    expect(splitDecimal("1,234.567890123")).toEqual(["1,234.5678", "90123"]);
    // Nothing to split: fewer decimals than `keep`, and no point at all.
    expect(splitDecimal("0.06")).toEqual(["0.06", ""]);
    expect(splitDecimal("1,234")).toEqual(["1,234", ""]);
    for (const lamports of [0n, 1n, 60_000_000n, 36_634_582n, 1_234_567_890_123n]) {
      const text = formatSol(lamports);
      const [head, tail] = splitDecimal(text);
      expect(head + tail).toBe(text);
    }
  });

  it("reads the server's decimal strings and nothing else", () => {
    expect(rawFrom("1285240")).toBe(1_285_240n);
    expect(rawFrom("12.5")).toBeNull();
    expect(rawFrom(1_285_240)).toBeNull();
    expect(rawFrom(undefined)).toBeNull();
  });
});

/**
 * THE ONE ROUNDING IN THIS MODULE, and it is for a face that has to be read at
 * a glance — a strip chip, nine characters wide. Everything else here never
 * rounds, and every caller of this keeps the whole figure within reach.
 */
describe("a SOL figure rounded for a glance", () => {
  it("rounds to the places asked, half up, on the lamports themselves", () => {
    expect(formatSolAtMost(36_634_582n, 3)).toBe("0.037");
    expect(formatSolAtMost(60_000_000n, 3)).toBe("0.06");
    expect(formatSolAtMost(1_723_287_901n, 3)).toBe("1.723");
    // Exactly half goes up.
    expect(formatSolAtMost(1_500_000n, 3)).toBe("0.002");
    expect(formatSolAtMost(1_400_000n, 3)).toBe("0.001");
  });

  /**
   * A SETTLEMENT THAT MOVED SOMETHING MUST NEVER READ AS ZERO. 0.0004 SOL
   * rounded to three places is "0.000", which says the opposite of what
   * happened.
   */
  it("says `<0.001` for an amount too small to show, and `0` only for nothing", () => {
    expect(formatSolAtMost(400_000n, 3)).toBe("<0.001");
    expect(formatSolAtMost(1n, 3)).toBe("<0.001");
    expect(formatSolAtMost(0n, 3)).toBe("0");
  });

  it("groups the whole part and keeps a sign", () => {
    expect(formatSolAtMost(1_234_000_000_000n, 3)).toBe("1,234");
    expect(formatSolAtMost(-36_634_582n, 3)).toBe("-0.037");
  });
});
