// The first paint's gate (owner, 09-24): the first snapshot of a pension waits
// for its history, but never longer than a bound, never twice, and never for a
// read a newer one has overtaken.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { firstPaintGate } from "@/lib/first-paint";

const WAIT = 1_500;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (hold: boolean) => {
  const state = { commits: 0, stale: false };
  const gate = firstPaintGate({ hold, waitMs: WAIT, commit: () => (state.commits += 1), stale: () => state.stale });
  return { state, gate };
};

describe("a later read, over rows already on screen", () => {
  it("is drawn at once, and a release adds nothing", () => {
    const { state, gate } = setup(false);
    expect(state.commits).toBe(1);
    gate.release();
    vi.advanceTimersByTime(WAIT * 2);
    expect(state.commits).toBe(1);
  });
});

describe("the first read of a pension", () => {
  it("is not drawn while its history is still on the way", () => {
    const { state } = setup(true);
    vi.advanceTimersByTime(WAIT - 1);
    expect(state.commits).toBe(0);
  });

  it("is drawn the moment the history settles — answered or failed — and once", () => {
    const { state, gate } = setup(true);
    vi.advanceTimersByTime(400);
    gate.release();
    expect(state.commits).toBe(1);
    vi.advanceTimersByTime(WAIT * 2);
    gate.release();
    expect(state.commits).toBe(1);
  });

  it("is drawn after the bound when the history is slow, and not again when it lands", () => {
    const { state, gate } = setup(true);
    vi.advanceTimersByTime(WAIT);
    expect(state.commits).toBe(1);
    gate.release();
    expect(state.commits).toBe(1);
  });

  it("is never drawn once a newer read has overtaken it — neither at the bound nor on release", () => {
    const atBound = setup(true);
    atBound.state.stale = true;
    vi.advanceTimersByTime(WAIT);
    expect(atBound.state.commits).toBe(0);

    const onRelease = setup(true);
    onRelease.state.stale = true;
    onRelease.gate.release();
    vi.advanceTimersByTime(WAIT * 2);
    expect(onRelease.state.commits).toBe(0);
  });
});
