// The sliding windows every "per day" and "per minute" figure on /status is read
// over (src/rolling-counts.ts): what falls out of a window and when, how much
// time a window really covers, and that nothing a caller sends can grow one
// without bound.
//
// Every clock here is a number handed in: no timer, no Date.now().

import { describe, expect, it } from "vitest";
import {
  DAY_BUCKET_MS,
  DAY_MS,
  MAX_KEYS,
  MINUTE_BUCKET_MS,
  MINUTE_MS,
  OTHER_KEY,
  createRollingCounts,
  createRollingPeak,
  scaledToWindow,
} from "../src/rolling-counts.js";

/** A start on a bucket boundary, so the arithmetic below reads plainly. */
const T0 = 1_760_000_000_000 - (1_760_000_000_000 % DAY_BUCKET_MS);

describe("a day's counts", () => {
  it("keeps what happened in the last 24 hours and forgets what is older, a bucket at a time", () => {
    const counts = createRollingCounts({ windowMs: DAY_MS, bucketMs: DAY_BUCKET_MS, startedAt: T0 });
    counts.add("getSlot", 3, T0);
    counts.add("getTransaction", 1, T0 + 60_000);
    counts.add("getSlot", 2, T0 + 12 * 3_600_000);
    expect(counts.totals(T0 + 12 * 3_600_000)).toEqual({ getSlot: 5, getTransaction: 1 });
    expect(counts.total(T0 + 12 * 3_600_000)).toBe(6);

    // Still inside the window just before the first bucket's day is up…
    expect(counts.total(T0 + DAY_MS - 1)).toBe(6);
    // …and gone, both of T0's first-bucket events, the moment a day has passed.
    expect(counts.totals(T0 + DAY_MS)).toEqual({ getSlot: 2 });
    expect(counts.total(T0 + DAY_MS + 12 * 3_600_000)).toBe(0);
  });

  it("says how much time it covers: the uptime until a day has passed, then a day give or take one bucket", () => {
    const counts = createRollingCounts({ windowMs: DAY_MS, bucketMs: DAY_BUCKET_MS, startedAt: T0 });
    expect(counts.observedMs(T0)).toBe(0);
    expect(counts.observedMs(T0 + 3_600_000)).toBe(3_600_000);
    // A week later the window is a day long, never the week.
    const later = counts.observedMs(T0 + 7 * DAY_MS + 123_456);
    expect(later).toBeGreaterThan(DAY_MS - DAY_BUCKET_MS);
    expect(later).toBeLessThanOrEqual(DAY_MS);
  });

  it("files keys past the cap under one key, so a stream of new method names cannot grow it, and keeps the total whole", () => {
    const counts = createRollingCounts({ windowMs: DAY_MS, bucketMs: DAY_BUCKET_MS, startedAt: T0 });
    for (let i = 0; i < MAX_KEYS + 10; i++) counts.add(`method${i}`, 1, T0);
    const totals = counts.totals(T0);
    expect(Object.keys(totals)).toHaveLength(MAX_KEYS + 1);
    expect(totals[OTHER_KEY]).toBe(10);
    expect(counts.total(T0)).toBe(MAX_KEYS + 10);
  });

  it("counts nothing for a count that is not a positive number", () => {
    const counts = createRollingCounts({ windowMs: DAY_MS, bucketMs: DAY_BUCKET_MS, startedAt: T0 });
    for (const n of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) counts.add("x", n, T0);
    expect(counts.total(T0)).toBe(0);
  });

  it("keeps an event stamped a little in the past after the clock stepped back", () => {
    const counts = createRollingCounts({ windowMs: DAY_MS, bucketMs: DAY_BUCKET_MS, startedAt: T0 });
    counts.add("a", 1, T0 + 2 * DAY_BUCKET_MS);
    counts.add("a", 1, T0 + DAY_BUCKET_MS);
    expect(counts.total(T0 + 2 * DAY_BUCKET_MS)).toBe(2);
  });
});

describe("a minute's counts", () => {
  it("is the last sixty seconds, in one-second buckets", () => {
    const counts = createRollingCounts({ windowMs: MINUTE_MS, bucketMs: MINUTE_BUCKET_MS, startedAt: T0 });
    counts.add("calls", 6, T0);
    counts.add("calls", 6, T0 + 30_000);
    expect(counts.total(T0 + 59_999)).toBe(12);
    expect(counts.total(T0 + 60_000)).toBe(6);
    expect(counts.total(T0 + 90_000)).toBe(0);
  });
});

describe("scaling a partial window to a whole one", () => {
  it("multiplies by the share of the window not yet observed, and refuses to guess from nothing", () => {
    expect(scaledToWindow(100, 3_600_000, DAY_MS)).toBe(2_400);
    expect(scaledToWindow(100, DAY_MS, DAY_MS)).toBe(100);
    expect(scaledToWindow(100, 0, DAY_MS)).toBeNull();
  });
});

describe("a rolling peak", () => {
  it("is the highest value noted in the window, and forgets it once the window has passed", () => {
    const peak = createRollingPeak({ windowMs: DAY_MS, bucketMs: DAY_BUCKET_MS });
    peak.note(12, T0);
    peak.note(7, T0 + 3_600_000);
    expect(peak.peak(T0 + 3_600_000)).toBe(12);
    expect(peak.peak(T0 + DAY_MS + 1)).toBe(7);
    expect(peak.peak(T0 + 3 * DAY_MS)).toBe(0);
  });
});
