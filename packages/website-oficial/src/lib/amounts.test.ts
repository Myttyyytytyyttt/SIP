import { describe, expect, it } from "vitest";

import { AmountError, formatSol, formatUnits, formatUsd, parseUnits, rawFrom, solToLamports, usdcRawForLamports, usdcToRaw } from "@/lib/amounts";

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

  it("reads the server's decimal strings and nothing else", () => {
    expect(rawFrom("1285240")).toBe(1_285_240n);
    expect(rawFrom("12.5")).toBeNull();
    expect(rawFrom(1_285_240)).toBeNull();
    expect(rawFrom(undefined)).toBeNull();
  });
});
