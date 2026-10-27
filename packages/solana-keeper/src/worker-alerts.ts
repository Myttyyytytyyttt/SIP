// WHO A WORKER WAKES, AND FOR WHAT: the legacy sweep's per-wallet and per-vault
// ladder (bin/keeper.mts), applied to one job's end (src/worker-job.ts).
//
// THE SAME RULES, NOT NEW ONES. Every alert here is built by the function the
// legacy keeper already calls — settleAlert, settleThrewAlert, investFailedAlert,
// wrapShortAlert, legFeeAlert — so a wallet a worker serves pages as it paged
// under the legacy keeper, under the same key names. What an alerter remembers
// (its dedup window, what it has raised) is per process: nothing crosses the
// handover, so the worker's first alert for a wallet is sent, and its clears
// resolve only what the worker itself raised.
//
// ONE RULE IS THE WORKER'S OWN: invest-refused, the same key and the same warn,
// turns critical on the third REFUSED job in a row (investRefusedAlert says
// why). The legacy keeper's stays a warn.
//
// WHAT IS COUNTED WHERE. The legacy keeper keeps its streaks in process memory,
// sweep after sweep. A worker keeps them in vault_work.streaks (completionFor),
// because the next job on the vault may run in another process; this reads the
// streaks the job is about to write, so the third failure in a row pages
// critical whichever worker ran the first two.
//
// ONLY A COMPLETED JOB SPEAKS. A stopped job (its lease lost, a SIGTERM, a fence
// refused) did not finish its turn and wrote no streaks; the job that completes
// the vault next decides, as a skipped legacy sweep does.
//
// NOT HERE: the seat alerts (raised where a wallet's Privy signer is resolved,
// bin/worker.mts) and the authorization-key check (bin/worker.mts, at boot and on
// a cadence). Both are per process, not per job.

import type { Alert } from "./alerts.js";
import { investFailedAlert, wrapShortAlert } from "./invest-decision.js";
import { settleAlert, settleThrewAlert } from "./settle-decision.js";
import { legFeeAlert } from "./sweep-decision.js";
import { readStreaks, type JobEnd } from "./worker-job.js";

/** What one job's end raises and resolves: cleared first, then fired (the keeper's order). */
export interface JobAlertRules {
  readonly clear: readonly string[];
  readonly fire: readonly Alert[];
  /** The leg-fee keys this turn raised, when it read the mints (undefined: it did not, and nothing is known). */
  readonly legFeeKeys?: ReadonlySet<string>;
  /** A settle waited on the shared loss-carry store: the store's page is the caller's (it knows since when). */
  readonly carryWaited: boolean;
}

/** The settle-key check's own alert, the legacy keeper's key (bin/keeper.mts: settle-key-mismatch). */
export const SETTLE_KEY_ALERT_KEY = "settle-key-mismatch";

/**
 * The REFUSED job, in a row, at which a vault's invest-refused alert turns
 * critical: the third, as invest-failed's (INVEST_FAILED_CRITICAL_STREAK).
 */
export const INVEST_REFUSED_CRITICAL_STREAK = 3;

/**
 * The per-vault invest-refused alert: the legacy keeper's exact shape
 * (bin/keeper.mts) while the refusal is new, critical once it persists.
 *
 * A WARN THAT NEVER PAGES IS A REFUSAL NOBODY HEARS OF. The alert destination
 * takes critical and above unless SIP_SOLANA_ALERT_MIN_SEVERITY says warn
 * (critical is its default, src/config.ts), so a basket the worker cannot buy —
 * a venue drained under a leg, a basket over this worker's Jupiter share, a
 * Jupiter that keeps answering 4xx — was a log line every REFUSED job, for as
 * long as it lasted: money that should be buying and is not, and nobody woken.
 * One refusal is often the moment (a pool thin for a minute); the third in a
 * row, at the job's own backoff between them (REFUSED_DUE_SECONDS, doubling:
 * five minutes, then ten), is about a quarter of an hour of it, and a vault
 * that has stopped buying.
 *
 * THE ALERTER'S OWN RULES DO THE REST (alerts.ts): the first warn is logged, the
 * second is a repeat inside its window and stays quiet, and the critical
 * ESCALATES through the dedup on the third. It repeats no sooner than 30
 * minutes later, and only when a refused job comes round again — hourly once
 * the backoff is at REFUSED_DUE_MAX_SECONDS. A turn that bought or failed
 * clears it (jobAlerts), and the next refusal starts at a warn again. The
 * legacy keeper's copy (bin/keeper.mts) is unchanged and stays a warn.
 */
export function investRefusedAlert(vault: string, detail: string, streak = 1): Alert {
  if (streak < INVEST_REFUSED_CRITICAL_STREAK) {
    return { key: `invest-refused:${vault}`, severity: "warn", title: "A basket cannot be bought", detail, context: { vault } };
  }
  return {
    key: `invest-refused:${vault}`,
    severity: "critical",
    title: "A vault's basket keeps being refused",
    detail: `${streak} refused turns in a row, nothing bought: ${detail}`,
    context: { vault },
  };
}

export function jobAlerts(end: JobEnd, previous: { readonly legFeeKeys?: ReadonlySet<string> } = {}): JobAlertRules {
  if (end.kind !== "complete") return { clear: [], fire: [], carryWaited: false };
  const { report } = end;
  const vault = report.vault;
  const streaks = readStreaks(end.completion.streaks);
  const clear: string[] = [];
  const fire: Alert[] = [];

  // THE SETTLE KEY THE CHAIN NAMES. A key the chain no longer names makes every
  // job end RETRY with nothing settled and no wallet turn to page (worker-job.ts):
  // the legacy keeper refuses to start on it and pages it mid-run; so does this.
  if (report.settleKey !== undefined) {
    if (report.settleKey.kind === "verified") clear.push(SETTLE_KEY_ALERT_KEY);
    else {
      fire.push({
        key: SETTLE_KEY_ALERT_KEY,
        severity: report.settleKey.kind === "mismatch" ? "critical" : "warn",
        title: report.settleKey.kind === "mismatch" ? "The worker's settle key is not the one the chain names" : "The worker cannot verify its settle key",
        detail: `${report.settleKey.detail ?? report.settleKey.kind}. Nothing is settled or bought for the queue's vaults until it is fixed.`,
        context: { vault },
      });
    }
  }

  // EACH WALLET'S SETTLE, as the legacy sweep raises it per wallet.
  for (const turn of report.settles) {
    const where = { wallet: turn.wallet, vault };
    const rule =
      turn.outcome === "THREW"
        ? settleThrewAlert(where, turn.detail)
        : settleAlert(turn.outcome, where, turn.detail, streaks.settleRetries[turn.wallet] ?? 0, turn.waitingOn);
    clear.push(...rule.clear);
    if (rule.fire !== null) fire.push(rule.fire);
  }

  // THE VAULT'S INVEST, once: what the legacy sweep folds per vault.
  const invest = report.invest;
  if (invest !== null) {
    // AS THE LEGACY SWEEP DOES: only a turn that bought or failed resolves a refusal; a throw, a deferral or a rest does not.
    // CRITICAL FROM THE THIRD REFUSED JOB IN A ROW (the streak the row is about to
    // hold, so whichever worker ran the first two), with no clear before it: the
    // escalation breaks the warn's dedup on its own, as invest-failed's below.
    if (invest.outcome === "REFUSED") fire.push(investRefusedAlert(vault, invest.detail, Math.max(1, streaks.investRefused)));
    else if (invest.outcome === "INVESTED" || invest.outcome === "FAILED") clear.push(`invest-refused:${vault}`);

    // A THROW IN THE INVEST HALF IS A FAILED TURN, as the legacy keeper folds it.
    const failed = invest.outcome === "FAILED" || invest.outcome === "THREW";
    if (failed) {
      // NO CLEAR BEFORE THE CRITICAL: the alerter lets an escalation through its
      // dedup (alerts.ts), and a clear here would page the critical twice when a
      // COMPLETE is discarded and the same streak is computed again.
      fire.push(investFailedAlert(vault, Math.max(1, streaks.investFailed), invest.detail));
    } else if (streaks.investFailed === 0) {
      clear.push(`invest-failed:${vault}`);
    }

    const wrap = report.investFacts?.wrap;
    if (streaks.wrapShort === 0) clear.push(`wrap-short:${vault}`);
    else if (wrap !== undefined) {
      const short = wrapShortAlert(vault, streaks.wrapShort, wrap);
      if (short !== null) fire.push(short);
    }

    // A LEG'S FEE WALKING TOWARD THE CEILING, on any turn that read the mints;
    // and, as the legacy sweep folds it, the warnings this vault raised before
    // and no longer does are cleared (only a turn that looked can say so).
    const warnings = report.investFacts?.feeWarnings;
    if (warnings !== undefined) {
      const raised = new Set<string>();
      for (const warning of warnings) {
        const alert = legFeeAlert(warning);
        raised.add(alert.key);
        fire.push(alert);
      }
      for (const key of previous.legFeeKeys ?? []) if (!raised.has(key)) clear.push(key);
      return { clear, fire, legFeeKeys: raised, carryWaited: report.settles.some((turn) => turn.waitingOn === "carry-store") };
    }
  }
  return { clear, fire, carryWaited: report.settles.some((turn) => turn.waitingOn === "carry-store") };
}
