// When the live dashboard reads Solana again — the whole policy as numbers.

import { describe, expect, it } from "vitest";

import { BACKOFF_MS, MANUAL_FLOOR_MS, POLL_BASE_MS, nextDelayMs, nextManualDelayMs, shouldRefreshOnShow } from "@/lib/live-schedule";

const NOW = 1_789_500_000_000;
const base = { failures: 0, retryAfterSeconds: null, visible: true, lastReadAt: NOW, now: NOW } as const;

describe("the steady state", () => {
  it("polls at the keeper's sweep, once a minute", () => {
    expect(nextDelayMs(base)).toBe(POLL_BASE_MS);
    expect(POLL_BASE_MS).toBe(60_000);
  });

  it("counts from the last read, so a slow answer does not add a minute on top", () => {
    expect(nextDelayMs({ ...base, now: NOW + 20_000 })).toBe(40_000);
    expect(nextDelayMs({ ...base, now: NOW + 59_999 })).toBe(1);
  });

  it("is due at once when the gap has already passed, or when nothing has been read yet", () => {
    expect(nextDelayMs({ ...base, now: NOW + POLL_BASE_MS })).toBe(0);
    expect(nextDelayMs({ ...base, now: NOW + 10 * POLL_BASE_MS })).toBe(0);
    expect(nextDelayMs({ ...base, lastReadAt: null })).toBe(0);
  });

  it("NEVER schedules a zero-delay retry while failing and the gap has not passed: that is a hot loop against a server that already said no", () => {
    for (const failures of [1, 2, 3, 9]) {
      // Just attempted, and — the case that bit — nothing recorded at all.
      expect(nextDelayMs({ ...base, failures, lastReadAt: NOW, now: NOW })).toBeGreaterThan(0);
      expect(nextDelayMs({ ...base, failures, lastReadAt: null, now: NOW })).toBeGreaterThan(0);
    }
  });

  it("but a retry whose gap HAS passed is due now: that is a retry, not a loop", () => {
    expect(nextDelayMs({ ...base, failures: 1, lastReadAt: NOW - 10 * POLL_BASE_MS, now: NOW })).toBe(0);
  });
});

describe("a hidden tab costs nothing", () => {
  it("runs no timer at all", () => {
    expect(nextDelayMs({ ...base, visible: false })).toBeNull();
    // Not even when it is overdue, or failing.
    expect(nextDelayMs({ ...base, visible: false, now: NOW + 10 * POLL_BASE_MS })).toBeNull();
    expect(nextDelayMs({ ...base, visible: false, failures: 3, retryAfterSeconds: 30 })).toBeNull();
  });

  it("reads once on becoming visible only when its numbers are a sweep old", () => {
    expect(shouldRefreshOnShow(NOW, NOW + POLL_BASE_MS)).toBe(true);
    expect(shouldRefreshOnShow(NOW, NOW + POLL_BASE_MS - 1)).toBe(false);
    expect(shouldRefreshOnShow(null, NOW)).toBe(true);
  });
});

describe("backoff", () => {
  it("is 2 minutes, then 4, then 5 at most, however long it keeps failing", () => {
    const after = (failures: number) => nextDelayMs({ ...base, failures, lastReadAt: null });
    expect([after(1), after(2), after(3)]).toEqual(BACKOFF_MS);
    expect([after(4), after(10), after(100)]).toEqual([300_000, 300_000, 300_000]);
    expect(Math.max(...BACKOFF_MS)).toBe(300_000);
  });

  it("returns to the base sweep as soon as a read succeeds", () => {
    // Failing three times then succeeding is the base sweep again, not 5 minutes.
    expect(nextDelayMs({ ...base, failures: 3 })).toBe(300_000);
    expect(nextDelayMs({ ...base, failures: 0 })).toBe(POLL_BASE_MS);
  });
});

describe("a refusal is obeyed, never retried through", () => {
  it("retry-after wins over the base sweep and over the backoff", () => {
    expect(nextDelayMs({ ...base, retryAfterSeconds: 90, lastReadAt: null })).toBe(90_000);
    expect(nextDelayMs({ ...base, failures: 1, retryAfterSeconds: 600, lastReadAt: null })).toBe(600_000);
  });

  it("but never shortens a wait the backoff already made longer", () => {
    expect(nextDelayMs({ ...base, failures: 3, retryAfterSeconds: 5, lastReadAt: null })).toBe(300_000);
  });

  it("a nonsense retry-after is ignored rather than trusted", () => {
    expect(nextDelayMs({ ...base, retryAfterSeconds: -30, lastReadAt: null })).toBe(0);
  });
});

describe("a refresh someone asked for", () => {
  it("still waits out the 10 s floor since the last read", () => {
    expect(MANUAL_FLOOR_MS).toBe(10_000);
    expect(nextManualDelayMs({ lastReadAt: NOW, now: NOW, retryAfterSeconds: null })).toBe(10_000);
    expect(nextManualDelayMs({ lastReadAt: NOW, now: NOW + 4_000, retryAfterSeconds: null })).toBe(6_000);
  });

  it("runs at once once the floor has passed, or when nothing was read yet", () => {
    expect(nextManualDelayMs({ lastReadAt: NOW, now: NOW + MANUAL_FLOOR_MS, retryAfterSeconds: null })).toBe(0);
    expect(nextManualDelayMs({ lastReadAt: null, now: NOW, retryAfterSeconds: null })).toBe(0);
  });

  it("a retry-after still wins: clicking Refresh does not get past a 429", () => {
    expect(nextManualDelayMs({ lastReadAt: NOW, now: NOW + MANUAL_FLOOR_MS, retryAfterSeconds: 45 })).toBe(45_000);
  });
});
