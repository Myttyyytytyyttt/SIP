// Telling a human when savings stop.
//
// A COPY OF packages/keeper-old/src/alerts.ts, and deliberately so. The lab lives
// OUTSIDE the pnpm workspace by design — its own toolchain, its own
// node_modules, nothing in the product importable from it — so this cannot be a
// shared import the way @nuvem/solana-core is for the two web apps. The file has
// no dependencies and no chain-specific logic; if it drifts, the two keepers
// disagree about what counts as worth waking someone for, which is a smaller
// hazard than coupling the experiment to the product's dependency graph.
//
// Every failure this system has actually had looked healthy from outside. A
// supervisor reported "1 keeper running" while every child crash-looped on a
// missing module. A keeper logged ordinary ticks while refusing to scan and
// falling further behind every block. A whole deployment deferred every
// settlement against a stale attester. In each case the chain was fine, the
// process was up, and the only symptom was an ABSENCE — money that did not
// arrive.
//
// So the alertable conditions here are mostly absences, and the design rule is
// that silence must never be the healthy state.
//
// DEDUPLICATED, BECAUSE AN ALERT THAT REPEATS IS AN ALERT THAT GETS MUTED. A
// condition fires once and then stays quiet until it clears or the repeat window
// passes. The counter is reported when it re-fires, so a long outage still reads
// as a long outage rather than as a single old message.

export type AlertSeverity = "warn" | "critical";

export interface Alert {
  /** Stable identity for deduplication. Same condition => same key. */
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly detail: string;
  readonly context?: Record<string, unknown>;
}

export interface Alerter {
  fire(alert: Alert): void;
  /** Marks a condition resolved, so its next occurrence alerts again. */
  clear(key: string): void;
}

export interface AlerterOptions {
  /** POST target. Slack, Discord and most incident tools accept this shape. */
  readonly webhookUrl?: string;
  /** How long a fired condition stays quiet before repeating. */
  readonly repeatAfterMs?: number;
  /** Injected for tests. */
  readonly now?: () => number;
  readonly post?: (url: string, body: string) => Promise<void>;
  /** Always called, webhook or not, so alerts are in the log even unconfigured. */
  readonly log?: (severity: AlertSeverity, line: string) => void;
}

interface FiredState {
  firedAt: number;
  count: number;
}

export function createAlerter(options: AlerterOptions = {}): Alerter {
  const repeatAfterMs = options.repeatAfterMs ?? 30 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const log =
    options.log ??
    ((severity, line) => {
      const stream = severity === "critical" ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    });
  const post =
    options.post ??
    (async (url: string, body: string) => {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    });

  const fired = new Map<string, FiredState>();

  return {
    fire(alert: Alert): void {
      const at = now();
      const previous = fired.get(alert.key);
      if (previous !== undefined && at - previous.firedAt < repeatAfterMs) {
        previous.count += 1;
        return;
      }
      const count = (previous?.count ?? 0) + 1;
      fired.set(alert.key, { firedAt: at, count });

      const repeated = count > 1 ? ` (x${count})` : "";
      const line = `[${alert.severity.toUpperCase()}] ${alert.title}${repeated} — ${alert.detail}`;
      log(alert.severity, line);

      if (options.webhookUrl === undefined) return;
      const body = JSON.stringify({
        // `text` is what Slack and Discord render; the rest is for anything that
        // parses. Both are sent so one payload works everywhere.
        text: line,
        severity: alert.severity,
        key: alert.key,
        title: alert.title,
        detail: alert.detail,
        occurrences: count,
        ...alert.context,
      });
      // Never awaited and never allowed to throw: an unreachable alerting
      // endpoint must not take down the thing it is monitoring.
      void post(options.webhookUrl, body).catch(() => {
        log("warn", "[WARN] alert webhook failed; the alert above was logged only");
      });
    },

    clear(key: string): void {
      fired.delete(key);
    },
  };
}

/**
 * A watchdog for the condition that has no event: nothing happening.
 *
 * Every other alert here is raised by something going wrong. This one fires when
 * NOTHING goes anything — a keeper that stopped ticking, a supervisor that
 * stopped sweeping. It is the only alert that can catch a process wedged rather
 * than crashed, which is the failure mode that hides longest.
 */
export function createHeartbeat(input: {
  readonly alerter: Alerter;
  readonly name: string;
  readonly silenceMs: number;
  readonly now?: () => number;
}): { beat: () => void; check: () => void } {
  const now = input.now ?? (() => Date.now());
  let last = now();

  return {
    beat(): void {
      last = now();
      input.alerter.clear(`silent:${input.name}`);
    },
    check(): void {
      const quietFor = now() - last;
      if (quietFor < input.silenceMs) return;
      input.alerter.fire({
        key: `silent:${input.name}`,
        severity: "critical",
        title: `${input.name} has gone quiet`,
        detail:
          `No progress for ${Math.round(quietFor / 1000)}s. The process may be up and wedged, ` +
          "which produces no error of its own — savings stop with nothing in the log.",
        context: { quietForMs: quietFor },
      });
    },
  };
}
