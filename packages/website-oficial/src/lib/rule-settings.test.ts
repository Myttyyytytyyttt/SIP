// The vault settings' shared shapes (owner, 09-25): the rate ranges, the $10
// base threshold whatever the basket, and picking assets.

import { describe, expect, it } from "vitest";

import { BASE_THRESHOLD_RAW, evened, minimumFor, pickToggled, RATE_RANGES, shareTotal, thresholdUsdOf, withShare } from "@/lib/rule-settings";
import { PROFIT_BPS_MAX, PROFIT_BPS_MIN, VOLUME_BPS_MAX, VOLUME_BPS_MIN } from "@sip/solana-core/client";

describe("the rate ranges are the program's", () => {
  it("profit and volume, with their presets inside them", () => {
    expect(RATE_RANGES.profit.min).toBe(PROFIT_BPS_MIN);
    expect(RATE_RANGES.profit.max).toBe(PROFIT_BPS_MAX);
    expect(RATE_RANGES.volume.min).toBe(VOLUME_BPS_MIN);
    expect(RATE_RANGES.volume.max).toBe(VOLUME_BPS_MAX);
    for (const mode of ["profit", "volume"] as const) {
      for (const preset of RATE_RANGES[mode].presets) {
        expect(preset).toBeGreaterThanOrEqual(RATE_RANGES[mode].min);
        expect(preset).toBeLessThanOrEqual(RATE_RANGES[mode].max);
      }
    }
  });
});

describe("the $10 base is the whole basket's, whatever its size", () => {
  it("signs the per-leg minimum that makes the basket buy at $10", () => {
    expect(minimumFor(BASE_THRESHOLD_RAW, [10_000])).toBe(10_000_000n);
    expect(minimumFor(BASE_THRESHOLD_RAW, [5_000, 5_000])).toBe(5_000_000n);
    expect(minimumFor(BASE_THRESHOLD_RAW, [3_400, 3_300, 3_300])).toBe(3_300_000n);
    expect(minimumFor(BASE_THRESHOLD_RAW, [2_000, 2_000, 2_000, 2_000, 2_000])).toBe(2_000_000n);
    expect(minimumFor(BASE_THRESHOLD_RAW, [])).toBe(0n);
  });
});

describe("picking assets", () => {
  it("splits evenly again whenever WHICH assets are picked changes", () => {
    const one = pickToggled([], "SPYx", true, 5);
    expect(one).toEqual([{ id: "SPYx", percent: "100" }]);
    const two = pickToggled(one, "ANTHROPIC", true, 5);
    expect(two).toEqual([
      { id: "SPYx", percent: "50" },
      { id: "ANTHROPIC", percent: "50" },
    ]);
    const three = pickToggled(two, "GLDx", true, 5);
    expect(shareTotal(three)).toBe(100);
    expect(pickToggled(three, "SPYx", false, 5).map((row) => row.id)).toEqual(["ANTHROPIC", "GLDx"]);
  });

  it("never adds past the most a basket may hold, and ignores a tick that changes nothing", () => {
    const full = evened(["a", "b"].map((id) => ({ id, percent: "" })));
    expect(pickToggled(full, "c", true, 2)).toBe(full);
    expect(pickToggled(full, "a", true, 2)).toBe(full);
    expect(pickToggled(full, "z", false, 2)).toBe(full);
  });

  it("keeps typed shares as typed, and counts a box that is not a whole number as 0", () => {
    const rows = withShare(evened([{ id: "a", percent: "" }, { id: "b", percent: "" }]), "a", "70");
    expect(rows).toEqual([
      { id: "a", percent: "70" },
      { id: "b", percent: "50" },
    ]);
    expect(shareTotal(rows)).toBe(120);
    expect(shareTotal(withShare(rows, "b", "3.5"))).toBe(70);
  });
});

describe("the threshold as typed", () => {
  it("reads plain dollars up to cents, and nothing else", () => {
    expect(thresholdUsdOf("10")).toBe(10);
    expect(thresholdUsdOf(" 12.50 ")).toBe(12.5);
    for (const bad of ["", "0", "-5", "1e3", "10.123", "$10", "ten"]) expect(thresholdUsdOf(bad), bad).toBeNull();
  });
});
