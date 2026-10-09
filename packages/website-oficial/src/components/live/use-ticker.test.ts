// A clock for the one leaf that counts (use-ticker.ts): it ticks while the tab
// is visible, never while it is hidden, and once the moment it is shown again —
// so a countdown is right on the first frame anyone sees.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTicker, type PageVisibility } from "@/components/live/use-ticker";

/** A page whose visibility the test sets. */
function page(initial: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  const fake = {
    visibilityState: initial,
    addEventListener: (_: "visibilitychange", listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: "visibilitychange", listener: () => void) => void listeners.delete(listener),
    show(state: DocumentVisibilityState) {
      fake.visibilityState = state;
      for (const listener of listeners) listener();
    },
    listeners,
  };
  return fake satisfies PageVisibility;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("runTicker", () => {
  it("ticks every step while the tab is visible", () => {
    const onTick = vi.fn();
    runTicker(page("visible"), 1_000, onTick);
    vi.advanceTimersByTime(3_000);
    expect(onTick).toHaveBeenCalledTimes(3);
  });

  it("never ticks while the tab is hidden, and ticks once the moment it is shown", () => {
    const onTick = vi.fn();
    const tab = page("hidden");
    runTicker(tab, 1_000, onTick);
    vi.advanceTimersByTime(10_000);
    expect(onTick).not.toHaveBeenCalled();

    tab.show("visible");
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("stops when the tab is hidden again", () => {
    const onTick = vi.fn();
    const tab = page("visible");
    runTicker(tab, 1_000, onTick);
    tab.show("hidden");
    vi.advanceTimersByTime(5_000);
    expect(onTick).not.toHaveBeenCalled();
  });

  it("leaves nothing behind once stopped: no timer, no listener", () => {
    const onTick = vi.fn();
    const tab = page("visible");
    const stop = runTicker(tab, 1_000, onTick);
    stop();
    vi.advanceTimersByTime(5_000);
    tab.show("visible");
    expect(onTick).not.toHaveBeenCalled();
    expect(tab.listeners.size).toBe(0);
  });
});
