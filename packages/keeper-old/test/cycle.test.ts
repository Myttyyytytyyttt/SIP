// Not running two cycles at once.
//
// THE TEST THAT MATTERS IS THE THROWING ONE. A skipped cycle costs one interval;
// a latch that is taken and never released costs everything after it — the
// supervisor stops sweeping, keeps holding every account it already had, and
// reports nothing wrong. That failure is silent by construction, so it is the one
// worth pinning.

import { describe, expect, it, vi } from "vitest";

import { skipWhileRunning } from "../src/cycle.js";

/** A promise plus the handles to settle it, so a body can be held mid-flight. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("keeping one cycle in flight at a time", () => {
  it("runs the body when nothing is running", async () => {
    const body = vi.fn(async () => {});
    const onSkip = vi.fn();
    await skipWhileRunning(body, onSkip)();
    expect(body).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("skips a call that arrives while the previous one is still running", async () => {
    const gate = deferred();
    const body = vi.fn(() => gate.promise);
    const onSkip = vi.fn();
    const run = skipWhileRunning(body, onSkip);

    const first = run();
    await run();
    await run();

    expect(body).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(2);

    gate.resolve();
    await first;
  });

  it("runs again once the previous call has finished", async () => {
    const gate = deferred();
    const body = vi.fn(() => gate.promise);
    const run = skipWhileRunning(body, vi.fn());

    const first = run();
    gate.resolve();
    await first;

    await run();
    expect(body).toHaveBeenCalledTimes(2);
  });

  /**
   * THE ONE THAT MATTERS. A body that rejects must still release the latch. The
   * supervisor wraps its own errors, but "the handler itself threw" is exactly
   * the case nobody plans for, and its symptom here is a keeper that goes quiet
   * forever rather than one that crashes and is restarted.
   */
  it("releases the latch when the body throws, so the next cycle still runs", async () => {
    let calls = 0;
    const body = vi.fn(async () => {
      calls += 1;
      throw new Error("boom");
    });
    const run = skipWhileRunning(body, vi.fn());

    await expect(run()).rejects.toThrow("boom");
    await expect(run()).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });

  /** A burst on one tick collapses to a single run, not to a queue of them. */
  it("collapses a burst instead of queueing it", async () => {
    const gate = deferred();
    const body = vi.fn(() => gate.promise);
    const onSkip = vi.fn();
    const run = skipWhileRunning(body, onSkip);

    const all = [run(), run(), run(), run(), run()];
    expect(body).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(4);

    gate.resolve();
    await Promise.all(all);

    // And the next firing is not one of the skipped four replayed.
    await run();
    expect(body).toHaveBeenCalledTimes(2);
  });
});
