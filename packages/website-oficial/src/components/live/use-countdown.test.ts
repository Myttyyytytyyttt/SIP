// A countdown that moves and lands on its moment (use-countdown.ts): whole
// seconds rounded up while it counts, and the deadline met to the millisecond
// rather than on whichever second's tick happens to come after it.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { armDeadline, secondsUntil, useReached } from "@/components/live/use-countdown";

describe("secondsUntil", () => {
  it("rounds up, so the last second still reads 1 s and never 0 s", () => {
    expect(secondsUntil(10_000, 0)).toBe(10);
    expect(secondsUntil(10_000, 1)).toBe(10);
    expect(secondsUntil(10_000, 9_001)).toBe(1);
    expect(secondsUntil(10_000, 9_999)).toBe(1);
  });

  it("is null at the moment and after it, and when there is nothing to wait for", () => {
    expect(secondsUntil(10_000, 10_000)).toBeNull();
    expect(secondsUntil(10_000, 12_000)).toBeNull();
    expect(secondsUntil(null, 0)).toBeNull();
  });
});

describe("armDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires exactly at the moment: not a millisecond before", () => {
    const onReach = vi.fn();
    armDeadline(12_500, 0, onReach);
    vi.advanceTimersByTime(12_499);
    expect(onReach).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReach).toHaveBeenCalledTimes(1);
  });

  it("fires at once for a moment already past", () => {
    const onReach = vi.fn();
    armDeadline(1_000, 5_000, onReach);
    expect(onReach).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer behind once stopped", () => {
    const onReach = vi.fn();
    const stop = armDeadline(12_500, 0, onReach);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(onReach).not.toHaveBeenCalled();
  });
});

describe("useReached", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** The hook's answer on a first paint at browser time `now`. */
  const reachedAt = (at: number, now: number): string => {
    vi.setSystemTime(now);
    const Probe = () => createElement("i", null, String(useReached(at)));
    return renderToStaticMarkup(createElement(Probe));
  };

  it("is false before the moment and true from it, on the very first paint", () => {
    expect(reachedAt(20_000, 19_999)).toBe("<i>false</i>");
    expect(reachedAt(20_000, 20_000)).toBe("<i>true</i>");
    expect(reachedAt(20_000, 90_000)).toBe("<i>true</i>");
  });
});
