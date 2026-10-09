// The page pins UTC so the server and the browser paint the same string. These
// hold it to also SAYING so, because the same timestamps are grouped into day
// headings and totalled into a "Today" tile: which day a settlement counts
// towards is a fact about somebody's money, not a formatting detail.

import { describe, expect, it } from "vitest";

import { clockLabel, compact, dayLabel, relativeDayLabel, timeAgo, weekLabel, whenLabel } from "@/lib/format";

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

/**
 * A MOMENT THAT MAY NOT BE TODAY (whenLabel). A stuck step said "Not done since
 * 23:58 UTC" the morning after, which reads as minutes, not hours: the day is
 * named the moment it is not the page's own, and the year when that differs.
 */
describe("a moment with its day", () => {
  const NOW = Date.parse("2026-10-09T09:15:00.000Z");

  it("is the bare clock on the page's own UTC day, from its first minute to its last", () => {
    expect(whenLabel(Date.parse("2026-10-09T08:32:00.000Z"), NOW)).toBe("08:32 UTC");
    expect(whenLabel(Date.parse("2026-10-09T00:00:00.000Z"), NOW)).toBe("00:00 UTC");
    expect(whenLabel(Date.parse("2026-10-09T23:59:00.000Z"), NOW)).toBe("23:59 UTC");
  });

  it("says yesterday, inside a sentence, for the UTC day before", () => {
    expect(whenLabel(Date.parse("2026-10-08T23:58:00.000Z"), NOW)).toBe("yesterday, 23:58 UTC");
    expect(whenLabel(Date.parse("2026-10-08T00:00:00.000Z"), NOW)).toBe("yesterday, 00:00 UTC");
  });

  it("names the date for an older day, and the year only when it is not this one", () => {
    expect(whenLabel(Date.parse("2026-10-07T14:32:00.000Z"), NOW)).toBe("Oct 7, 14:32 UTC");
    expect(whenLabel(Date.parse("2025-10-07T14:32:00.000Z"), NOW)).toBe("Oct 7, 2025, 14:32 UTC");
    // Yesterday across a year: still yesterday, and no year said.
    expect(whenLabel(Date.parse("2026-12-31T23:58:00.000Z"), Date.parse("2027-01-01T00:05:00.000Z"))).toBe("yesterday, 23:58 UTC");
  });

  it("judges the day in UTC, as every label on the page: a Lisbon 00:30 is the UTC day before", () => {
    // 00:30 in Lisbon on Oct 9 is 23:30 UTC on Oct 8.
    expect(whenLabel(Date.parse("2026-10-08T23:30:00.000Z"), Date.parse("2026-10-09T00:10:00.000Z"))).toBe("yesterday, 23:30 UTC");
  });
});

describe("a day heading", () => {
  it("is judged against the payload's own clock, never Date.now()", () => {
    expect(relativeDayLabel(AT, "2026-09-16T12:00:00.000Z")).toBe("Today");
    expect(relativeDayLabel(AT, "2026-09-17T12:00:00.000Z")).toBe("Yesterday");
    expect(relativeDayLabel(AT, "2026-09-30T12:00:00.000Z")).toBe("Sep 16");
  });
});

describe("a week on a chart", () => {
  it("names the UTC week from its Monday, inside a month and across one", () => {
    expect(weekLabel("2026-09-14")).toBe("Sep 14 – 20");
    expect(weekLabel("2026-09-28")).toBe("Sep 28 – Oct 4");
    expect(weekLabel("2026-12-28T00:00:00.000Z")).toBe("Dec 28 – Jan 3");
  });
});

describe("a compact axis figure", () => {
  it("shortens without a currency, and an unread one is a dash", () => {
    expect(compact(1234)).toBe("1.2K");
    expect(compact(3_400_000)).toBe("3.4M");
    expect(compact(12)).toBe("12");
    expect(compact(null)).toBe("—");
  });
});
