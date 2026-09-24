// THE FIRST PAINT WAITS FOR THE HISTORY (owner, 09-24). The snapshot answers
// before the history, and committing it alone drew half a second of "No
// activity yet", "0 events · 0 settlements" and a chart saying the savings were
// "not in the history loaded here" on every live load. So the first snapshot
// of a pension is held until its head page answers or fails, and until the
// settlement round answers too — for at most FIRST_PAINT_WAIT_MS.
//
// This package has no DOM to render a hook in (node environment, no jsdom), so
// the wiring is read from the hook's source, the way live-backfill.test.ts
// reads it. The behaviour itself was checked in a browser against fixture
// answers with controlled delays (see the commit that added this file).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FIRST_PAINT_WAIT_MS } from "@/hooks/use-live-dashboard";

const HOOK = fileURLToPath(new URL("./use-live-dashboard.ts", import.meta.url));

/** The file's CODE, with its prose removed: a comment about the snapshot is not a call. */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

const source = code(readFileSync(HOOK, "utf8"));
const read = source.slice(source.indexOf("const read = useCallback"), source.indexOf("const loadOlder"));

describe("the first paint of a pension waits for its history", () => {
  it("sets the snapshot in ONE place: the gate's commit (its timing is lib/first-paint.test.ts's)", () => {
    expect(read.match(/setSnapshot\(/g)).toHaveLength(1);
    expect(read).toMatch(/const gate = firstPaintGate\(\{ hold: holdFirstPaint, commit: \(\) => setSnapshot\(answered\.body\), stale, waitMs: FIRST_PAINT_WAIT_MS \}\);/);
  });

  it("holds only the FIRST snapshot, and only when there is a history to wait for", () => {
    expect(read).toMatch(/const holdFirstPaint = snapshotRef\.current === null && wantsActivity && answered\.body\.vault\.status === "exists";/);
  });

  it("ends a previous failure as soon as a held snapshot has answered, so the error card does not outlive the answer", () => {
    expect(read).toMatch(/if \(holdFirstPaint\) \{\s*setFailures\(0\);\s*setFailure\(null\);\s*\}/);
    expect(read.search(/if \(holdFirstPaint\) \{\s*setFailures\(0\)/)).toBeLessThan(read.indexOf("api.activity("));
  });

  it("asks for the history after the gate is armed, and releases it in a finally, whatever the history did", () => {
    const armed = read.indexOf("const gate = firstPaintGate(");
    const asked = read.indexOf("api.activity(");
    const released = read.search(/\} finally \{\s*gate\.release\(\);\s*\}/);
    expect(armed).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(armed);
    expect(released).toBeGreaterThan(asked);
  });

  it("still drops every answer a newer read has overtaken — the snapshot, the history and the settlement round", () => {
    // After each await: the snapshot, the head page, the round.
    expect(read.match(/if \(stale\(\)\) return true;/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // The source's comments are stripped first, so the check sits straight after the round.
    expect(read).toMatch(/await backfillLinkSettlements\([\s\S]*?\}\);\s*if \(stale\(\)\) return true;/);
  });

  it("says the history is still being read — never 'No activity yet' — when the bound drew the page first", () => {
    expect(source).toMatch(/const activityPending = wantsActivity && snapshot !== null && snapshot\.vault\.status === "exists" && activityMeta === null && activityTrouble === null;/);
    expect(FIRST_PAINT_WAIT_MS).toBeGreaterThan(0);
    expect(FIRST_PAINT_WAIT_MS).toBeLessThanOrEqual(2_000);
  });
});

describe("Load older is offered only when there is an older page", () => {
  it("is worked out from the cursor a head page named, never stored beside it", () => {
    expect(source).toMatch(/available: cursor !== null/);
    expect(source).toMatch(/const cursor = activityMeta\?\.nextBefore \?\? null;/);
  });
});
