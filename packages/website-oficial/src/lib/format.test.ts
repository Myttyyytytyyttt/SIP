// The page pins UTC so the server and the browser paint the same string. These
// hold it to also SAYING so, because the same timestamps are grouped into day
// headings and totalled into a "Today" tile: which day a settlement counts
// towards is a fact about somebody's money, not a formatting detail.

import { describe, expect, it } from "vitest";

import { clockLabel, dayLabel, relativeDayLabel, timeAgo } from "@/lib/format";

const AT = "2026-09-16T01:34:00.000Z";

describe("a clock on the page", () => {
  it("names its zone, so 01:34 is not read as the viewer's own 01:34", () => {
    expect(clockLabel(AT)).toBe("01:34 UTC");
  });

  it("is the same UTC clock it always was: a Lisbon midnight belongs to the day before", () => {
    // 2026-09-16 00:30 in Lisbon (UTC+1 in September) is 2026-09-15 23:30 UTC,
    // and the feed files it under Sep 15.
    expect(clockLabel("2026-09-15T23:30:00.000Z")).toBe("23:30 UTC");
    expect(dayLabel("2026-09-15T23:30:00.000Z")).toBe("Sep 15");
  });

  it("leaves a relative time alone, which has no zone to name", () => {
    expect(timeAgo(AT, "2026-09-16T01:38:00.000Z")).toBe("4m ago");
  });
});

describe("a day heading", () => {
  it("is judged against the payload's own clock, never Date.now()", () => {
    expect(relativeDayLabel(AT, "2026-09-16T12:00:00.000Z")).toBe("Today");
    expect(relativeDayLabel(AT, "2026-09-17T12:00:00.000Z")).toBe("Yesterday");
    expect(relativeDayLabel(AT, "2026-09-30T12:00:00.000Z")).toBe("Sep 16");
  });
});
