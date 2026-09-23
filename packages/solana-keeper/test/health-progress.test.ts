// /health restarts a WEDGED keeper, never a slow one.
//
// THE DEFECT. The clock behind /health was stamped once, at the top of each
// sweep, and never again while that sweep ran — so a sweep making steady
// progress was indistinguishable from one hung inside a call that never
// returns. The work per link is real and only loosely bounded: measure-window
// walks up to MAX_SIGNATURE_PAGES pages plus MAX_SIGNATURES getTransaction
// reads for one link, each request bounded only by the pool's 30 s timeout, so
// a single backlogged VOLUME wallet against a throttled endpoint spends the
// whole ten-minute bound inside one turn. /health then answered 503 mid-sweep,
// Railway restarted the container, and the fresh process re-ran the same walk
// against the same endpoint until restartPolicyMaxRetries was exhausted and the
// keeper was down — dropping every pending carry on each pass and never
// draining the backlog. The one thing a restart cannot fix is a slow endpoint.
//
// Two things are pinned here, because the clock lives in bin/keeper.mts and no
// unit test can call that file: the RULE, that the bound is measured from the
// last time the sweep MOVED; and the CALL SITES, read from the source the way
// test/read-model-rate.test.ts reads them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HEALTH_STALE_FLOOR_MS, decideHealth, type HealthInput } from "../src/status.js";

const PACKAGE = new URL("..", import.meta.url);
const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, PACKAGE)), "utf8");
const keeper = source("bin/keeper.mts");
const lines = keeper.split("\n");

const base: HealthInput = { now: 0, startedAt: 0, lastProgressAt: null, sweepMs: 60_000 };
const MINUTE = 60_000;

describe("a sweep that is slow but still moving", () => {
  it("stays healthy through a pass far longer than the bound, one turn at a time", () => {
    // Four linked wallets, each turn taking four minutes: sixteen minutes in one
    // sweep, well past the ten-minute floor. Stamped per turn, every probe in
    // between is inside the bound.
    let lastProgressAt = 0;
    for (let turn = 1; turn <= 4; turn += 1) {
      const startedTurn = turn * 4 * MINUTE;
      // Probed just before this turn begins: the previous turn is 4 minutes old.
      expect(decideHealth({ ...base, lastProgressAt, now: startedTurn - 1 }), `before turn ${turn}`).toEqual({ ok: true });
      lastProgressAt = startedTurn;
    }
    // The pass took 16 minutes and the keeper was never restarted.
    expect(decideHealth({ ...base, lastProgressAt, now: 16 * MINUTE + 1 })).toEqual({ ok: true });
    // THE DEFECT, in one line: measured from the sweep's START, that same pass
    // was declared dead nine minutes before it finished.
    expect(decideHealth({ ...base, lastProgressAt: 0, now: 16 * MINUTE }).ok).toBe(false);
  });

  it("stays healthy inside one very long turn, because an RPC answer is progress too", () => {
    // One VOLUME wallet with a 300-signature backlog: a single turn, hundreds of
    // getTransaction reads. No turn begins for 20 minutes, but answers keep
    // arriving, so nothing here is wedged.
    let lastProgressAt = 0;
    for (let read = 1; read <= 600; read += 1) {
      const at = read * 2_000;
      expect(decideHealth({ ...base, lastProgressAt, now: at }).ok, `read ${read}`).toBe(true);
      lastProgressAt = at;
    }
    expect(lastProgressAt).toBe(20 * MINUTE);
  });

  it("still fails a sweep that has stopped moving, whatever it was doing when it stopped", () => {
    // The clock stops: the call never returns, the turn never ends, the interval
    // never fires again. This is the case a restart does fix.
    const wedged = decideHealth({ ...base, lastProgressAt: 0, now: HEALTH_STALE_FLOOR_MS });
    expect(wedged).toEqual({
      ok: false,
      detail: "the sweep last moved 600s ago",
      quietForMs: HEALTH_STALE_FLOOR_MS,
      staleAfterMs: HEALTH_STALE_FLOOR_MS,
    });
  });

  it("never fails before anything has moved: a boot behind a slow endpoint is not a wedged keeper", () => {
    expect(decideHealth({ ...base, now: HEALTH_STALE_FLOOR_MS - 1 })).toEqual({ ok: true });
    expect(decideHealth({ ...base, now: HEALTH_STALE_FLOOR_MS }).detail).toBe("no sweep has started in the 600s since this process came up");
  });
});

describe("where the keeper's health clock is stamped", () => {
  it("advances at the top of every link's turn, before that turn awaits anything", () => {
    const loop = lines.findIndex((line) => line.includes("for (const { link: door, lane } of turns) {"));
    expect(loop, "the sweep's per-link loop").toBeGreaterThan(-1);
    const turn = lines.slice(loop + 1, loop + 12);
    const stamped = turn.findIndex((line) => line.includes("noteProgress()"));
    const awaited = turn.findIndex((line) => line.includes("await "));
    expect(stamped, "a turn that begins is progress").toBeGreaterThan(-1);
    expect(awaited === -1 || stamped < awaited, "stamped before the turn's first await").toBe(true);
  });

  it("advances on every answer from the chain, under the Connection's own transport", () => {
    // The whole measure walk and every send go through this one fetch, so a turn
    // grinding forward keeps the clock moving without a progress callback
    // threaded down the settle path.
    expect(keeper).toMatch(/const trackedFetch: typeof fetch = async \(input, init\) => \{[\s\S]{0,200}?noteProgress\(\);/);
    expect(keeper, "the Connection must use the tracked transport").toMatch(/fetch: trackedFetch,/);
    // Only a returned response counts: a throw must leave the clock alone.
    expect(keeper).toMatch(/const response = await rpcFetch\(input, init\);\s*\n\s*noteProgress\(\);\s*\n\s*return response;/);
  });

  it("is the clock /health reads, and the sweep's start is no longer a clock at all", () => {
    const probe = lines.filter((line) => line.includes("decideHealth("));
    expect(probe).toHaveLength(1);
    expect(probe[0]).toContain("lastProgressAt");
    expect(keeper, "the old stamp-once clock is gone").not.toContain("sweepStartedAt");
    // Three stamps, one per kind of progress: the sweep, the turn, the answer.
    expect(keeper.split("noteProgress()").length - 1).toBeGreaterThanOrEqual(3);
  });
});
