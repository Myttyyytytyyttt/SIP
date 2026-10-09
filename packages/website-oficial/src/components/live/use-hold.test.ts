// Many ids held for a while on one timer (use-hold.ts): a row that just arrived
// keeps its edge for 30 s, a finished step its "done" for 4 s. The pure core,
// which is all the hook does besides setting the one timer.

import { describe, expect, it } from "vitest";

import { holdUntil, nextRelease, releaseDue, type Holds } from "@/components/live/use-hold";

const NONE: Holds = new Map();

describe("holdUntil", () => {
  it("holds every id it is given until the time given", () => {
    const holds = holdUntil(NONE, ["a", "b"], 1_000);
    expect([...holds]).toEqual([
      ["a", 1_000],
      ["b", 1_000],
    ]);
  });

  it("restarts the clock of an id held again", () => {
    expect(holdUntil(holdUntil(NONE, ["a"], 1_000), ["a"], 5_000).get("a")).toBe(5_000);
  });

  it("never shortens a hold, and hands back the same Map when nothing changed", () => {
    const holds = holdUntil(NONE, ["a"], 5_000);
    expect(holdUntil(holds, ["a"], 1_000)).toBe(holds);
    expect(holdUntil(holds, [], 9_000)).toBe(holds);
  });
});

describe("releaseDue", () => {
  it("lets go of what is due, at its time exactly, and keeps the rest", () => {
    const holds = holdUntil(holdUntil(NONE, ["a"], 1_000), ["b"], 2_000);
    expect([...releaseDue(holds, 1_000).keys()]).toEqual(["b"]);
    expect(releaseDue(holds, 2_000).size).toBe(0);
  });

  it("hands back the same Map when nothing was due, so nothing re-renders", () => {
    const holds = holdUntil(NONE, ["a"], 1_000);
    expect(releaseDue(holds, 999)).toBe(holds);
  });
});

describe("nextRelease", () => {
  it("is the earliest hold's time — the one timer's — or null when nothing is held", () => {
    expect(nextRelease(NONE)).toBeNull();
    expect(nextRelease(holdUntil(holdUntil(NONE, ["a"], 3_000), ["b"], 2_000))).toBe(2_000);
  });
});
