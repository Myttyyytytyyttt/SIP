// THE LAST DAY THE POLICY BOUGHT, READ FROM THE CHAIN'S OWN DAY-BUCKETS — so the
// live rule card can say when the last buy was even when the loaded page of
// history no longer holds it.

import { describe, expect, it } from "vitest";

import { lastInvestedDay } from "@/lib/invest-limits";

/** 31 buckets as the program stores them: unwritten ones are day 0, amount 0. */
function buckets(written: readonly (readonly [number, string])[]): { days: number[]; amounts: string[] } {
  const days = Array.from({ length: 31 }, () => 0);
  const amounts = Array.from({ length: 31 }, () => "0");
  written.forEach(([day, amount], index) => {
    days[index] = day;
    amounts[index] = amount;
  });
  return { days, amounts };
}

describe("lastInvestedDay", () => {
  it("is the NEWEST day holding a buy, with that whole day's USDC, as a UTC date", () => {
    // The owner's vault on 09-25: 20715 is 2026-09-19, 20718 is 2026-09-22.
    const { days, amounts } = buckets([
      [20_715, "5284930"],
      [20_718, "16964637"],
    ]);
    expect(lastInvestedDay(days, amounts)).toEqual({ day: "2026-09-22", usdcRaw: 16_964_637n });
  });

  it("does not depend on where in the ring the newest bucket sits", () => {
    const { days, amounts } = buckets([
      [20_718, "16964637"],
      [20_700, "1000000"],
      [20_715, "5284930"],
    ]);
    expect(lastInvestedDay(days, amounts)).toEqual({ day: "2026-09-22", usdcRaw: 16_964_637n });
  });

  it("skips a newer bucket that holds nothing, and one whose amount cannot be read", () => {
    const { days, amounts } = buckets([
      [20_715, "5284930"],
      [20_720, "0"],
      [20_721, "not a number"],
    ]);
    expect(lastInvestedDay(days, amounts)).toEqual({ day: "2026-09-19", usdcRaw: 5_284_930n });
  });

  it("is null when no bucket holds a buy — a policy that never bought, or buckets never written", () => {
    expect(lastInvestedDay(buckets([]).days, buckets([]).amounts)).toBeNull();
    const { days, amounts } = buckets([[20_718, "0"]]);
    expect(lastInvestedDay(days, amounts)).toBeNull();
    expect(lastInvestedDay([], [])).toBeNull();
  });
});
