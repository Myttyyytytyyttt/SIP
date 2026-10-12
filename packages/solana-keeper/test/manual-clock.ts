// A clock and a timer queue a test owns, for the dispatcher's budget pieces
// (src/rpc-budget.ts and its users): they take `now` and `setTimer` instead of
// reading Date.now and calling setTimeout, so seconds of pacing run in
// microseconds and every grant happens at an exact instant.
//
// NOT A TEST FILE: vitest collects test/**/*.test.ts only, and this is imported
// by the files that need it.

/** A clock and a timer queue the test advances by hand; due timers fire in order, with the microtasks they release. */
export function manualClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers: { at: number; seq: number; fn: () => void }[] = [];
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number): (() => void) => {
      const timer = { at: now + ms, seq: seq++, fn };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
    async advance(ms: number): Promise<void> {
      const until = now + ms;
      await settle();
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const due = timers[0];
        if (due === undefined || due.at > until) break;
        timers.shift();
        now = due.at;
        due.fn();
        await settle();
      }
      now = until;
      await settle();
    },
    settle,
    pending: () => timers.length,
  };
}
