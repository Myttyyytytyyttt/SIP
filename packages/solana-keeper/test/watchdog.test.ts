// The watchdog (src/watchdog.ts, token `watchdog-exit`): a sweep that has not
// MOVED for /health's own bound ends the process non-zero, so Railway's
// ON_FAILURE policy starts a fresh one — and a sweep that is slow but moving,
// a keeper that is idle, a keeper booting inside the bound, never does.
//
// The ADR's named test (§4.9 row 30): "watchdog: a sweep with no progress for
// the bound exits non-zero; a slow sweep that keeps progressing does not". The
// clock and the timers are driven by hand, and the verdict is decideHealth's
// own, exactly as bin/keeper.mts hands it over (healthNow).

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HEALTH_STALE_FLOOR_MS, decideHealth, healthStaleAfterMs, type HealthReport } from "../src/status.js";
import {
  WATCHDOG_ALERT_KEY,
  WATCHDOG_CHECK_EVERY_MS,
  WATCHDOG_EXIT_CODE,
  WATCHDOG_EXIT_GRACE_MS,
  startWatchdog,
  watchdogExitAlert,
  type WatchdogTimers,
} from "../src/watchdog.js";

const MINUTE = 60_000;

/** A keeper's progress clock and the watchdog's timers, both moved by hand. */
function harness(options: { readonly sweepMs?: number; readonly beforeExit?: (report: HealthReport) => void; readonly health?: () => HealthReport } = {}) {
  const sweepMs = options.sweepMs ?? 60_000;
  let now = 1_700_000_000_000;
  const startedAt = now;
  let lastProgressAt: number | null = null;
  interface Repeat {
    run: () => void;
    every: number;
    next: number;
    live: boolean;
  }
  interface Once {
    run: () => void;
    at: number;
    done: boolean;
  }
  const repeats: Repeat[] = [];
  const onces: Once[] = [];
  const timers: WatchdogTimers = {
    setInterval: (run, ms) => {
      const handle: Repeat = { run, every: ms, next: now + ms, live: true };
      repeats.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      (handle as Repeat).live = false;
    },
    setTimeout: (run, ms) => {
      const handle: Once = { run, at: now + ms, done: false };
      onces.push(handle);
      return handle;
    },
  };
  /** Moves the clock forward, firing every timer that falls due on the way, in order. */
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const repeat = repeats.filter((r) => r.live && r.next <= end).sort((a, b) => a.next - b.next)[0];
      const once = onces.filter((o) => !o.done && o.at <= end).sort((a, b) => a.at - b.at)[0];
      if (repeat === undefined && once === undefined) break;
      if (once !== undefined && (repeat === undefined || once.at <= repeat.next)) {
        now = once.at;
        once.done = true;
        once.run();
      } else if (repeat !== undefined) {
        now = repeat.next;
        repeat.next += repeat.every;
        repeat.run();
      }
    }
    now = end;
  };
  const exits: number[] = [];
  const reports: HealthReport[] = [];
  const dog = startWatchdog({
    health: options.health ?? (() => decideHealth({ now, startedAt, lastProgressAt, sweepMs })),
    beforeExit: (report) => {
      reports.push(report);
      options.beforeExit?.(report);
    },
    exit: (code) => void exits.push(code),
    timers,
  });
  return {
    dog,
    advance,
    progress: (): void => {
      lastProgressAt = now;
    },
    exits,
    reports,
    liveIntervals: (): number => repeats.filter((r) => r.live).length,
  };
}

describe("watchdog: the ADR's test", () => {
  it("a sweep with no progress for the bound exits non-zero", () => {
    const keeper = harness();
    keeper.progress();
    // Inside the bound: nothing, however many checks ran.
    keeper.advance(HEALTH_STALE_FLOOR_MS - 1_000);
    expect(keeper.dog.checks()).toBeGreaterThan(15);
    expect(keeper.reports).toEqual([]);
    // At the bound, at the check that falls on it (every 30 s from the start):
    // decided, and the exit follows only after the grace.
    keeper.advance(1_000);
    expect(keeper.reports).toHaveLength(1);
    expect(keeper.reports[0]!.ok).toBe(false);
    expect(keeper.exits).toEqual([]);
    keeper.advance(WATCHDOG_EXIT_GRACE_MS);
    expect(keeper.exits).toEqual([WATCHDOG_EXIT_CODE]);
    expect(WATCHDOG_EXIT_CODE).not.toBe(0);
  });

  it("a slow sweep that keeps progressing does not", () => {
    const keeper = harness();
    // One sweep grinding for an hour through a backlogged wallet: every turn
    // and every RPC answer moves the clock, a couple of minutes apart.
    for (let minute = 0; minute < 60; minute += 2) {
      keeper.progress();
      keeper.advance(2 * MINUTE);
    }
    expect(keeper.reports).toEqual([]);
    expect(keeper.exits).toEqual([]);
    expect(keeper.dog.fired()).toBe(false);
  });
});

describe("watchdog: the bound is /health's", () => {
  it("covers a boot that never moves the clock, from the process's own start", () => {
    const keeper = harness();
    keeper.advance(HEALTH_STALE_FLOOR_MS - 1_000);
    expect(keeper.reports).toEqual([]);
    keeper.advance(WATCHDOG_CHECK_EVERY_MS + WATCHDOG_EXIT_GRACE_MS);
    expect(keeper.reports[0]!.detail).toMatch(/no sweep has started/);
    expect(keeper.exits).toEqual([WATCHDOG_EXIT_CODE]);
  });

  it("stretches with a slow cadence: three sweeps of 300 s are fifteen minutes, not ten", () => {
    const keeper = harness({ sweepMs: 300_000 });
    expect(healthStaleAfterMs(300_000)).toBe(15 * MINUTE);
    keeper.progress();
    keeper.advance(14 * MINUTE);
    expect(keeper.reports).toEqual([]);
    keeper.advance(MINUTE + WATCHDOG_CHECK_EVERY_MS + WATCHDOG_EXIT_GRACE_MS);
    expect(keeper.exits).toEqual([WATCHDOG_EXIT_CODE]);
  });

  it("a keeper that is merely idle stamps the clock at every sweep's start and never exits", () => {
    const keeper = harness();
    for (let sweep = 0; sweep < 180; sweep += 1) {
      keeper.progress();
      keeper.advance(MINUTE);
    }
    expect(keeper.exits).toEqual([]);
  });
});

describe("watchdog: it decides once, and nothing stops the exit", () => {
  it("stops its interval and never runs beforeExit or exit twice", () => {
    const keeper = harness();
    keeper.advance(HEALTH_STALE_FLOOR_MS + WATCHDOG_CHECK_EVERY_MS + WATCHDOG_EXIT_GRACE_MS);
    expect(keeper.liveIntervals()).toBe(0);
    keeper.advance(HEALTH_STALE_FLOOR_MS);
    keeper.dog.check();
    expect(keeper.reports).toHaveLength(1);
    expect(keeper.exits).toEqual([WATCHDOG_EXIT_CODE]);
  });

  it("exits even when beforeExit throws — a broken logger cannot keep a wedged keeper up", () => {
    const keeper = harness({
      beforeExit: () => {
        throw new Error("the log sink is gone");
      },
    });
    keeper.advance(HEALTH_STALE_FLOOR_MS + WATCHDOG_CHECK_EVERY_MS + WATCHDOG_EXIT_GRACE_MS);
    expect(keeper.exits).toEqual([WATCHDOG_EXIT_CODE]);
  });

  it("does not exit on a verdict it could not compute", () => {
    const keeper = harness({
      health: () => {
        throw new Error("clock unreadable");
      },
    });
    keeper.advance(3 * HEALTH_STALE_FLOOR_MS);
    expect(keeper.exits).toEqual([]);
  });
});

describe("watchdogExitAlert", () => {
  it("is one critical under its own key, built from /health's numbers and fixed words only", () => {
    const report = decideHealth({ now: 1_000_000 + 11 * MINUTE, startedAt: 0, lastProgressAt: 1_000_000, sweepMs: 60_000 });
    const alert = watchdogExitAlert(report);
    expect(alert.key).toBe(WATCHDOG_ALERT_KEY);
    expect(alert.severity).toBe("critical");
    expect(alert.detail).toContain("the sweep last moved 660s ago");
    expect(alert.detail).toContain(`code ${WATCHDOG_EXIT_CODE}`);
    expect(alert.context).toEqual({ quietForSeconds: 660, boundSeconds: 600, exitCode: WATCHDOG_EXIT_CODE });
  });
});

describe("watchdog: in a real process", () => {
  it("leaves with a non-zero code Railway's ON_FAILURE policy restarts", () => {
    // NOT A MOCK OF process.exit: the module loaded the way the image loads it
    // (tsx, Node ESM), its real timers, and the exit code the OS reports.
    const keeper = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const watchdog = resolve(keeper, "src/watchdog.ts");
    const script =
      `import { startWatchdog } from ${JSON.stringify(watchdog)};` +
      "startWatchdog({ health: () => ({ ok: false, detail: 'wedged' }), beforeExit: () => {}, exit: (code) => process.exit(code), everyMs: 20, graceMs: 20 });" +
      "setInterval(() => {}, 1_000);";
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: keeper, timeout: 30_000 });
    expect(child.status, child.stderr.toString()).toBe(WATCHDOG_EXIT_CODE);
  });
});
