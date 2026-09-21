// When the live dashboard reads Solana again — the whole policy as numbers.

import { describe, expect, it } from "vitest";

import { BACKOFF_MS, MANUAL_FLOOR_MS, POLL_BASE_MS, nextDelayMs, nextManualDelayMs, shouldRefreshOnShow, ACTIVITY_RETRIES, nextActivityRetryMs } from "@/lib/live-schedule";

const NOW = 1_789_500_000_000;
const base = { failures: 0, retryAfterSeconds: null, visible: true, lastReadAt: NOW, now: NOW, reading: false } as const;

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

describe("a read that is already in flight", () => {
  it("schedules NOTHING — the loop this prevents is the first read's own", () => {
    // The exact shape of it: nothing read yet, nothing failed, and the first
    // read already started before the poll was first asked. Answering 0 here
    // arms a timer that fires at once, finds the in-flight guard closed, does
    // nothing, and re-arms at 0 — for the whole duration of the first read.
    expect(nextDelayMs({ ...base, reading: true, lastReadAt: null, failures: 0 })).toBeNull();

    // And on the other road into it: a tab taking focus after a long sleep,
    // whose read has begun and whose gap has long since passed.
    expect(nextDelayMs({ ...base, reading: true, lastReadAt: NOW - 10 * POLL_BASE_MS })).toBeNull();

    // A request that never answers holds it there rather than spinning.
    expect(nextDelayMs({ ...base, reading: true, failures: 3, retryAfterSeconds: 30 })).toBeNull();
  });

  it("…and the ordinary schedule is back the moment that read finishes", () => {
    expect(nextDelayMs({ ...base, reading: false, lastReadAt: null })).toBe(0);
    expect(nextDelayMs({ ...base, reading: false })).toBe(POLL_BASE_MS);
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

/**
 * A READ REFUSED ONLY ITS HISTORY. The snapshot answered, so every figure on
 * the screen is current and NOTHING may be backed off — but the route said
 * when this browser may ask for the page again, and waiting out the whole
 * sweep for a bucket that refills at a token a second is how "Activity could
 * not be read just now" came to sit over a problem that had already cleared.
 */
describe("when a refused history is worth asking for again early", () => {
  const now = 1_000_000;

  it("comes back at the moment the server named", () => {
    expect(nextActivityRetryMs({ retryAt: now + 2_000, attempts: 0, now })).toBe(2_000);
  });

  it("does nothing when the server named no time: there is nothing to obey", () => {
    expect(nextActivityRetryMs({ retryAt: null, attempts: 0, now })).toBeNull();
  });

  it("does nothing past the sweep: the ordinary poll gets there first, and two timers is one too many", () => {
    expect(nextActivityRetryMs({ retryAt: now + POLL_BASE_MS, attempts: 0, now })).toBeNull();
    expect(nextActivityRetryMs({ retryAt: now + POLL_BASE_MS - 1, attempts: 0, now })).toBe(POLL_BASE_MS - 1);
  });

  it("buys ONE early read and no more: a refusal that repeats needs the whole minute, not a faster question", () => {
    expect(ACTIVITY_RETRIES).toBe(1);
    expect(nextActivityRetryMs({ retryAt: now + 2_000, attempts: ACTIVITY_RETRIES, now })).toBeNull();
  });

  it("never asks for a time already past", () => {
    expect(nextActivityRetryMs({ retryAt: now - 5_000, attempts: 0, now })).toBe(0);
  });
});
