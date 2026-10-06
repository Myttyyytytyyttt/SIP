// Which numbers the public dashboard shows: the owner's rule (10-06) — Mock is
// the sample, Live is the real figures, as everywhere else in the app.

import { describe, expect, it } from "vitest";

import { decideGlobalStatsMode } from "@/lib/global-stats-mode";

describe("the dashboard's mode", () => {
  it("shows the sample only for ?mode=mock", () => {
    expect(decideGlobalStatsMode("mock", undefined)).toEqual({ mode: "mock", showSample: true, returning: false, control: true });
    expect(decideGlobalStatsMode("live", undefined)).toEqual({ mode: "live", showSample: false, returning: false, control: true });
  });

  it("reads no mode as Live: a connected pension's own tabs carry none", () => {
    expect(decideGlobalStatsMode(undefined, undefined)).toEqual({ mode: null, showSample: false, returning: false, control: true });
  });

  it("takes anything it does not know as no mode at all", () => {
    for (const requested of ["MOCK", "demo", "", "mock ", ["mock", "live"]]) {
      expect(decideGlobalStatsMode(requested, undefined)).toMatchObject({ mode: null, showSample: false });
    }
  });

  it("offers no Live|Mock control to a browser that has connected before, and keeps its mode", () => {
    expect(decideGlobalStatsMode("mock", "1")).toEqual({ mode: "mock", showSample: true, returning: true, control: false });
    expect(decideGlobalStatsMode(undefined, "1")).toEqual({ mode: null, showSample: false, returning: true, control: false });
    // Only "1" is the hint.
    expect(decideGlobalStatsMode(undefined, "")).toMatchObject({ returning: false, control: true });
  });
});
