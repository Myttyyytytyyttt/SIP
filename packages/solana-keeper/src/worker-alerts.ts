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
// why). The legacy keeper's stays a warn. AND ONE CAUSE PAGES ONCE: a refusal
// because the basket's venues could not be measured at all — Jupiter or the
// RPC not answering, or Jupiter answering 5xx, 429 or a key it refuses — is the
// upstream's, and every vault buying at that moment meets it. Paged per vault,
// one Jupiter outage was one critical per funded vault two minutes in and again
// every 30 minutes; so such a refusal stays a warn on the vault's own key, and
// UpstreamRefusals pages it once for all of them (invest-refused-upstream). A
// refusal for the vault's own reason — a drained pool, a basket over the share,
// Jupiter refusing its pair with a 400 (invest-decision.ts,
// measurementFailedUpstream) — still pages per vault.
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
import { investFailedAlert, isUnmeasuredRefusal, wrapShortAlert } from "./invest-decision.js";
import { settleAlert, settleThrewAlert } from "./settle-decision.js";
import { legFeeAlert } from "./sweep-decision.js";
import type { AlertDecision } from "./usage-alerts.js";
import { REFUSED_DUE_MAX_SECONDS, readStreaks, type JobEnd } from "./worker-job.js";

/** What one job's end raises and resolves: cleared first, then fired (the keeper's order). */
export interface JobAlertRules {
  readonly clear: readonly string[];
  readonly fire: readonly Alert[];
  /** The leg-fee keys this turn raised, when it read the mints (undefined: it did not, and nothing is known). */
  readonly legFeeKeys?: ReadonlySet<string>;
  /** A settle waited on the shared loss-carry store: the store's page is the caller's (it knows since when). */
  readonly carryWaited: boolean;
  /**
   * This job's word on the upstream refusal (UpstreamRefusals): the vault's
   * refused streak and the detail when its basket was refused because the venues
   * could not be measured; null when the invest bought, failed, or was refused
   * for the vault's own reason; absent when it says nothing (no invest half, a
   * deferral, a rest, a throw — as for the per-vault key).
   */
  readonly upstreamRefusal?: { readonly streak: number; readonly detail: string } | null;
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
 * a venue drained under a leg, a basket over this worker's Jupiter share — was
 * a log line every REFUSED job, for as long as it lasted: money that should be
 * buying and is not, and nobody woken. One refusal is often the moment (a pool
 * thin for a minute); the third in a row is a vault that has stopped buying. A
 * basket whose venues could not be measured at all (Jupiter or the RPC not
 * answering) is the upstream's: jobAlerts keeps it a warn here and
 * UpstreamRefusals pages it once for every vault it stops.
 *
 * HOW SOON THE THIRD COMES IS THE SCHEDULER'S, NOT THIS FILE'S. A REFUSED job
 * asks to come back after REFUSED_DUE_SECONDS, doubling (five minutes, then
 * ten: about a quarter of an hour to the third). But a due time only ever moves
 * earlier (src/scheduler-pg.ts), and a full pass makes every queue vault that
 * did not rest due at once. While the scheduler holds no doorbell secret EVERY
 * tick is a full pass (production on 2026-10-27), so a refused vault is turned
 * every tick and the third refusal lands about two ticks — two minutes — after
 * the first. Only a trusted doorbell leaves a busy vault to its own backoff.
 *
 * THE ALERTER'S OWN RULES DO THE REST (alerts.ts): the first warn is logged, the
 * second is a repeat inside its window and stays quiet, and the critical
 * ESCALATES through the dedup on the third. It repeats no sooner than 30
 * minutes later, at the first refused job after that: every 30 minutes while a
 * full pass turns the vault every tick, hourly once a trusted doorbell lets the
 * backoff reach REFUSED_DUE_MAX_SECONDS. A turn that bought or failed clears it
 * (jobAlerts), and the next refusal starts at a warn again. The legacy keeper's
 * copy (bin/keeper.mts) is unchanged and stays a warn.
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
  let upstreamRefusal: { readonly streak: number; readonly detail: string } | null | undefined;

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
    // AN UNMEASURED BASKET IS THE UPSTREAM'S: a warn on the vault's key however long it lasts, and UpstreamRefusals' page.
    if (invest.outcome === "REFUSED") {
      const streak = Math.max(1, streaks.investRefused);
      if (isUnmeasuredRefusal(invest.detail)) {
        fire.push(investRefusedAlert(vault, invest.detail, Math.min(streak, INVEST_REFUSED_CRITICAL_STREAK - 1)));
        upstreamRefusal = { streak, detail: invest.detail };
      } else {
        fire.push(investRefusedAlert(vault, invest.detail, streak));
        upstreamRefusal = null;
      }
    } else if (invest.outcome === "INVESTED" || invest.outcome === "FAILED") {
      clear.push(`invest-refused:${vault}`);
      upstreamRefusal = null;
    }

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
      return {
        clear,
        fire,
        legFeeKeys: raised,
        carryWaited: report.settles.some((turn) => turn.waitingOn === "carry-store"),
        ...(upstreamRefusal === undefined ? {} : { upstreamRefusal }),
      };
    }
  }
  return { clear, fire, carryWaited: report.settles.some((turn) => turn.waitingOn === "carry-store"), ...(upstreamRefusal === undefined ? {} : { upstreamRefusal }) };
}

// --- invest-refused-upstream ---------------------------------------------------

export const INVEST_REFUSED_UPSTREAM_ALERT_KEY = "invest-refused-upstream";

/**
 * A vault not heard of for this long leaves the page: unlinked, handed back, or
 * served by another process since. Twice the longest a REFUSED vault waits for
 * its next turn (REFUSED_DUE_MAX_SECONDS), so a vault still refused is heard of
 * well inside it.
 */
export const UPSTREAM_REFUSAL_FORGET_MS = 2 * REFUSED_DUE_MAX_SECONDS * 1_000;

/** How many of the persistent vaults the page names before it says "and N more". */
const UPSTREAM_REFUSAL_NAMED_MAX = 5;

/**
 * THE UPSTREAM REFUSAL, PAGED ONCE (the header): which vaults' last word was a
 * basket refused because its venues could not be measured, and the critical,
 * one key, once any of them has been refused INVEST_REFUSED_CRITICAL_STREAK
 * turns in a row — with how many vaults it stops and the latest detail.
 *
 * PER PROCESS, which at WORKERS_MAX=1 is the fleet: two workers would each page
 * it once. A vault leaves the set on a turn that bought, failed, or was refused
 * for its own reason (jobAlerts' null), or after UPSTREAM_REFUSAL_FORGET_MS
 * unheard of; the page clears once no vault in the set has reached the streak.
 */
export class UpstreamRefusals {
  readonly #vaults = new Map<string, { readonly streak: number; readonly detail: string; readonly at: number }>();
  readonly #now: () => number;
  #firing = false;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** One job's end, as jobAlerts' upstreamRefusal says it. Returns what to raise or clear. */
  observe(vault: string, refusal: { readonly streak: number; readonly detail: string } | null | undefined): AlertDecision {
    const now = this.#now();
    if (refusal === null) this.#vaults.delete(vault);
    else if (refusal !== undefined) this.#vaults.set(vault, { streak: refusal.streak, detail: refusal.detail, at: now });
    for (const [key, entry] of this.#vaults) if (now - entry.at > UPSTREAM_REFUSAL_FORGET_MS) this.#vaults.delete(key);
    const entries = [...this.#vaults.values()];
    const persistent = entries.filter((entry) => entry.streak >= INVEST_REFUSED_CRITICAL_STREAK).length;
    if (persistent === 0) {
      if (!this.#firing) return { fire: null, clear: false };
      this.#firing = false;
      return { fire: null, clear: true };
    }
    this.#firing = true;
    const latest = entries.reduce((newest, entry) => (entry.at >= newest.at ? entry : newest));
    const n = entries.length;
    // WHICH VAULTS, not only how many: the page is the only one they get.
    const named = [...this.#vaults].filter(([, entry]) => entry.streak >= INVEST_REFUSED_CRITICAL_STREAK).map(([vault]) => vault);
    const shown = named.length <= UPSTREAM_REFUSAL_NAMED_MAX ? named.join(", ") : `${named.slice(0, UPSTREAM_REFUSAL_NAMED_MAX).join(", ")} and ${named.length - UPSTREAM_REFUSAL_NAMED_MAX} more`;
    return {
      fire: {
        key: INVEST_REFUSED_UPSTREAM_ALERT_KEY,
        severity: "critical",
        title: "Baskets keep being refused: their venues cannot be measured",
        detail:
          `${n} vault${n === 1 ? "'s basket is" : "s' baskets are"} refused because the venues could not be measured, ` +
          `${persistent === n ? (n === 1 ? "for" : "each for") : `${persistent} of them for`} ${INVEST_REFUSED_CRITICAL_STREAK} turns or more in a row; nothing is bought ` +
          `(${shown}). One cause upstream (Jupiter or the RPC not answering), paged once here; each vault's invest-refused stays a warn. ` +
          `Latest: ${latest.detail}`,
        context: { vaults: n, persistent, ...(named.length === 1 ? { vault: named[0] } : {}) },
      },
      clear: false,
    };
  }
}
