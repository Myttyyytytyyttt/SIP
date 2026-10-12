// THE WATCHDOG: a keeper that has stopped moving ends itself, so Railway starts
// a fresh one. Token `watchdog-exit` (src/cuts.ts); off, nothing here runs.
//
// WHY IT EXISTS (ADR §3.11 "Health (amended, RT-11)", §4.9 row 30). Railway
// calls /health ONLY AT DEPLOY TIME (DOC, verified for the ADR). The comments in
// src/status.ts and the runbook that say a 503 makes Railway restart the
// container describe a probe that does not run: a process that is up and
// wedged answers 503 to nobody, keeps its claim and its lock, and settles nobody
// for as long as nobody looks. Absence is this keeper's characteristic failure,
// and this is the one absence no alert can report from inside a process whose
// sweep has stopped — the sweep is what fires them.
//
// THE SAME BOUND AND THE SAME PROGRESS AS /health, by construction: the check is
// decideHealth itself, handed the same clock (bin/keeper.mts). So everything
// src/status.ts says /health must never catch, this never exits for — a sweep
// that is slow but still moving (the clock advances at every link's turn and at
// every RPC answer), a keeper that is merely idle, a keeper still booting — and
// an RPC outage is still not a reason: a sweep that fails stamped the clock when
// it began, and the next one stamps it again. What it exits for is a sweep that
// has not moved for max(3 × sweepMs, 10 min): an await that will never resolve,
// an interval that stopped firing, a `cycleRunning` stuck on — the wedge that
// once ran for hours (bin/keeper.mts, the per-wallet catch).
//
// WHAT IT CANNOT CATCH, said so nobody counts on it: a SYNCHRONOUS loop that
// never yields. This check runs on a timer, on the same event loop; a loop that
// never returns to it starves the check too. None of the wedges recorded in
// bin/keeper.mts was one: they were a flag left set and an await that stalled.
//
// HOW IT EXITS, in order (bin/keeper.mts's beforeExit): one error line, one
// critical alert that says the process is restarting itself and why — the
// restart is otherwise visible only in Railway's deploy log — and the claim
// released, exactly as SIGTERM releases it, so the session holding the advisory
// lock is gone before the process is and the hung sweep's next turn, if it ever
// wakes, is handed no key (keysForTurn asks isLive() at every turn). Then, after
// a short grace for the alert's POST, the exit itself.
//
// EXIT CODE 3. Not 0, or ON_FAILURE would not restart it; not 1, which the
// uncaught-exception trap uses; not 2, which this keeper reserves for "change a
// variable, a restart fixes nothing" (bin/keeper.mts, configuration refused).
// A distinct code is what the container's exit will say about it.
// Railway retries ON_FAILURE up to restartPolicyMaxRetries (10, railway.json):
// a keeper that wedges on every boot stops being restarted after ten, and the
// runbook says so.

import type { Alert } from "./alerts.js";
import type { HealthReport } from "./status.js";

/** How often the bound is asked: every 30 s, so an exit lands at most 30 s past it. */
export const WATCHDOG_CHECK_EVERY_MS = 30_000;

/** The code a watchdog exit leaves with (see the file's header for why 3). */
export const WATCHDOG_EXIT_CODE = 3;

/**
 * Between the alert and the exit: 3 s. The alert's POST is detached (alerts.ts
 * never awaits a send), so an exit on the same tick would kill it in flight —
 * and that message is the only one that says why the process went away.
 */
export const WATCHDOG_EXIT_GRACE_MS = 3_000;

/** The alerter's key for the one message a watchdog exit sends. */
export const WATCHDOG_ALERT_KEY = "watchdog-exit";

/** The /status block under the token: the bound, the clock it reads, and how often it has asked. */
export interface WatchdogStatus {
  /** The bound, in ms: max(3 × sweepMs, 10 min), /health's own. */
  readonly exitAfterMs: number;
  /** When the sweep last moved, as /health reads it; null until it has moved at all. */
  readonly lastProgressAt: string | null;
  readonly checks: number;
  readonly exitCode: number;
}

/**
 * The message a watchdog exit sends, from /health's own report. Numbers and
 * fixed words only, like /health's answer: nothing upstream reaches it.
 */
export function watchdogExitAlert(report: HealthReport): Alert {
  const quietSeconds = report.quietForMs === undefined ? null : Math.round(report.quietForMs / 1000);
  const boundSeconds = report.staleAfterMs === undefined ? null : Math.round(report.staleAfterMs / 1000);
  return {
    key: WATCHDOG_ALERT_KEY,
    severity: "critical",
    title: "The keeper is restarting itself: its sweep stopped moving",
    detail:
      `${report.detail ?? "the sweep has not moved"} (bound ${boundSeconds ?? "unknown"} s). The process releases its claim and ` +
      `exits with code ${WATCHDOG_EXIT_CODE} so Railway starts a fresh one; nothing was settled or bought while it was stuck. ` +
      "If this repeats, the sweep is wedging on something every boot meets: read the log lines before this one.",
    context: { quietForSeconds: quietSeconds, boundSeconds, exitCode: WATCHDOG_EXIT_CODE },
  };
}

/** The timers the watchdog runs on, injectable so a test can drive the clock. */
export interface WatchdogTimers {
  readonly setInterval: (run: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
}

const realTimers: WatchdogTimers = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (run, ms) => setTimeout(run, ms),
};

export interface WatchdogOptions {
  /** /health's own verdict, asked fresh at every check (decideHealth over the keeper's progress clock). */
  readonly health: () => HealthReport;
  /**
   * What happens before the exit: the log line, the alert, the claim released.
   * A throw from it is swallowed — the exit is the point, and a watchdog that a
   * broken logger could stop from firing is not one.
   */
  readonly beforeExit: (report: HealthReport) => void;
  readonly exit: (code: number) => void;
  readonly everyMs?: number;
  readonly graceMs?: number;
  readonly timers?: WatchdogTimers;
}

export interface Watchdog {
  /** One check, as the timer runs it. Exposed so a test can ask without a clock. */
  check(): void;
  /** Whether it has decided to exit (it decides at most once). */
  fired(): boolean;
  checks(): number;
  stop(): void;
}

/**
 * Starts the check on its interval. It decides AT MOST ONCE: the first failing
 * check stops the interval, runs beforeExit, and schedules the exit after the
 * grace; nothing after that can call beforeExit or exit again.
 */
export function startWatchdog(options: WatchdogOptions): Watchdog {
  const timers = options.timers ?? realTimers;
  let fired = false;
  let checks = 0;
  let handle: unknown = null;

  const stop = (): void => {
    if (handle !== null) timers.clearInterval(handle);
    handle = null;
  };

  const check = (): void => {
    if (fired) return;
    checks += 1;
    let report: HealthReport;
    try {
      report = options.health();
    } catch {
      // A verdict that cannot be computed is not a verdict to exit on.
      return;
    }
    if (report.ok) return;
    fired = true;
    stop();
    try {
      options.beforeExit(report);
    } catch {
      // The exit below is the point; see WatchdogOptions.beforeExit.
    }
    timers.setTimeout(() => options.exit(WATCHDOG_EXIT_CODE), options.graceMs ?? WATCHDOG_EXIT_GRACE_MS);
  };

  handle = timers.setInterval(check, options.everyMs ?? WATCHDOG_CHECK_EVERY_MS);
  return { check, fired: () => fired, checks: () => checks, stop };
}
