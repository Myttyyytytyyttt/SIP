// WHO A WORKER WAKES, AND FOR WHAT: the legacy sweep's per-wallet and per-vault
// ladder (bin/keeper.mts), applied to one job's end (src/worker-job.ts).
//
// THE SAME RULES, NOT NEW ONES. Every alert here is built by the function the
// legacy keeper already calls — settleAlert, settleThrewAlert, investFailedAlert,
// wrapShortAlert, legFeeAlert — so a wallet a worker serves pages exactly as it
// paged under the legacy keeper, with the same keys: a vault moved to the queue
// keeps its open alerts' keys, and the worker's first SETTLED clears what the
// legacy keeper raised.
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
import { INVEST_FAILED_CRITICAL_STREAK, investFailedAlert, wrapShortAlert } from "./invest-decision.js";
import { settleAlert, settleThrewAlert } from "./settle-decision.js";
import { legFeeAlert } from "./sweep-decision.js";
import { readStreaks, type JobEnd } from "./worker-job.js";

/** What one job's end raises and resolves: cleared first, then fired (the keeper's order). */
export interface JobAlertRules {
  readonly clear: readonly string[];
  readonly fire: readonly Alert[];
}

/** The per-vault invest-refused alert, in the legacy keeper's exact shape (bin/keeper.mts). */
export function investRefusedAlert(vault: string, detail: string): Alert {
  return { key: `invest-refused:${vault}`, severity: "warn", title: "A basket cannot be bought", detail, context: { vault } };
}

export function jobAlerts(end: JobEnd): JobAlertRules {
  if (end.kind !== "complete") return { clear: [], fire: [] };
  const { report } = end;
  const vault = report.vault;
  const streaks = readStreaks(end.completion.streaks);
  const clear: string[] = [];
  const fire: Alert[] = [];

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
    if (invest.outcome === "REFUSED") fire.push(investRefusedAlert(vault, invest.detail));
    else clear.push(`invest-refused:${vault}`);

    // A THROW IN THE INVEST HALF IS A FAILED TURN, as the legacy keeper folds it.
    const failed = invest.outcome === "FAILED" || invest.outcome === "THREW";
    if (failed) {
      // THE ALERTER DEDUPES BY KEY ALONE: the standing warning is cleared before
      // the critical that replaces it, or it would swallow the escalation.
      if (streaks.investFailed === INVEST_FAILED_CRITICAL_STREAK) clear.push(`invest-failed:${vault}`);
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

    // A LEG'S FEE WALKING TOWARD THE CEILING, on any turn that read the mints.
    for (const warning of report.investFacts?.feeWarnings ?? []) fire.push(legFeeAlert(warning));
  }
  return { clear, fire };
}
