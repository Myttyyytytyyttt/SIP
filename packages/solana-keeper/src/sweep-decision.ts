// What the SWEEP decides about itself, as pure functions.
//
// The per-wallet decisions live in settle-decision.ts and the per-vault ones in
// invest-decision.ts. What was left in bin/keeper.mts were the decisions about
// the sweep as a whole — whether a failed read is weather or a defect — and they
// were inline between RPC calls, where no test could reach them.

import type { Alert } from "./alerts.js";
import type { WrapReport } from "./invest-decision.js";
import type { InvestOutcome } from "./invest-tick.js";
import type { CarryBook } from "./settle-decision.js";
import type { PendingCarry } from "./status.js";

/**
 * The alerter's key for the sweep's batched vault read.
 *
 * ONE KEY, NOT ONE PER VAULT: the batch is one request for every link, so its
 * failure is one condition. Every other key the sweep raises names a vault or a
 * wallet (`invest-failed:<vault>`, `settle-failed:<wallet>`); this one names
 * nothing, because it is the sweep's own.
 */
export const VAULT_READ_ALERT_KEY = "vault-read";

/**
 * Consecutive sweeps whose batched vault read failed before it pages critical: 3,
 * the streak the invest and settle failures already use.
 */
export const VAULT_READ_CRITICAL_STREAK = 3;

/**
 * The alert for a batched vault read that failed: a warning at first, critical
 * from the third sweep in a row.
 *
 * NOT CRITICAL ON THE FIRST. A refused getMultipleAccounts used to fail the whole
 * sweep and page at once, so one throttled request from a public endpoint woke
 * somebody while nothing was actually wrong with the money. A sweep that degrades
 * to a read per link still settles every link whose vault it can read, so one
 * failure is weather. Three sweeps in a row is an endpoint that cannot serve this
 * program's accounts, and by then nothing has settled for three sweeps.
 */
export function vaultReadAlert(streak: number, detail: string): Alert {
  const critical = streak >= VAULT_READ_CRITICAL_STREAK;
  return {
    key: VAULT_READ_ALERT_KEY,
    severity: critical ? "critical" : "warn",
    title: critical ? "The sweep cannot read the vaults it settles against" : "The batched vault read failed; this sweep reads one vault per link",
    detail: `${streak} sweep${streak === 1 ? "" : "s"} in a row: ${detail}`,
    context: { sweeps: streak },
  };
}

/** What one vault's invest turns added up to over a single sweep. */
export interface VaultInvestSweep {
  /** The outcome the vault's streaks are judged on this sweep. */
  readonly outcome: InvestOutcome;
  /** The detail of the turn that decided `outcome`. */
  readonly detail: string;
  /** The report the wrap-short streak is judged on: a short turn's if there was one. */
  readonly wrap: WrapReport | undefined;
}

/**
 * One vault's invest turns, folded into the single outcome its streaks are
 * counted on.
 *
 * WHY THIS EXISTS. `wrapShort` and `investFailed` are keyed by VAULT, but the
 * sweep's loop runs per LINK, and the invest turn runs inside it. A vault with
 * three linked wallets therefore advanced its streak three times in one sweep and
 * paged critical after a single sweep — the escalation that is supposed to mean
 * "three sweeps in a row". The turn still runs for every link, because it moves
 * money and running it once per vault would change what an armed keeper does;
 * only the counting moved.
 *
 * FAILED WINS, AND KEEPS THE FIRST FAILURE'S WORDS. One failed turn is a vault
 * that did not buy what it should have, whatever its other links did.
 *
 * A RESTING TURN BEATS A REFUSED ONE, which looks backwards and is not:
 * investFailedStreak holds the count on REFUSED — it has its own alert — and ends
 * it on every resting outcome. A fold that let REFUSED win would freeze a streak
 * that a resting turn in the same sweep should have ended.
 *
 * THE WRAP REPORT IS A SHORT TURN'S ONCE ANY TURN IS SHORT. The crank's shortfall
 * is a fact about the vault's free SOL, and the first turn of a sweep is the one
 * that sees all of it; a later turn finding only the remainder must not erase it.
 * With no short turn it is the latest report there was, so a turn that read no
 * wrap at all does not blank out one that did.
 */
export function foldInvestTurn(
  previous: VaultInvestSweep | undefined,
  turn: { readonly outcome: InvestOutcome; readonly detail: string; readonly wrap?: WrapReport },
): VaultInvestSweep {
  const wrap = previous?.wrap?.short === true ? previous.wrap : (turn.wrap ?? previous?.wrap);
  const decided = ((): { readonly outcome: InvestOutcome; readonly detail: string } => {
    if (previous === undefined) return turn;
    if (previous.outcome === "FAILED") return previous;
    if (turn.outcome === "FAILED") return turn;
    if (previous.outcome === "REFUSED" && turn.outcome !== "REFUSED") return turn;
    return previous;
  })();
  return { outcome: decided.outcome, detail: decided.detail, wrap };
}

/** Reads the carry book for /status, and remembers when each carry first appeared. */
export interface CarryWatch {
  observe(book: CarryBook, walletFor: (link: string) => string | null, now: number): readonly PendingCarry[];
}

/**
 * What the carry book holds right now, for /status, with a "since" of its own.
 *
 * IT ONLY READS. carryFor PRUNES as it reads — it deletes every entry no later
 * state can match — so calling it from a /status projection would let an
 * operator's poll forget a loss, which is money. This walks the Map and touches
 * nothing in it; recordCarry and carryFor stay the only writers.
 *
 * THE TIMESTAMP IS KEPT HERE, NOT ON LossCarry. A settle that does not land is
 * re-recorded under the same key every sweep with a fresh object, so a stamp
 * inside the carry would reset each sweep and "since" would always read as now.
 * Keyed by link and state, the stamp survives that and means what it says: when
 * this loss started waiting. Keeping it out of LossCarry also leaves the money
 * path — recordCarry's positive-loss guard and the settle tests that compare
 * carries whole — untouched.
 *
 * IT CANNOT DRIFT. Every stamp whose carry is no longer in the book is dropped
 * on each pass, so entries the book prunes cannot accumulate here, and a carry
 * that comes back is a new wait with a new stamp.
 *
 * Oldest first: the longest-waiting loss is the one a restart costs most.
 */
export function createCarryWatch(): CarryWatch {
  const firstSeen = new Map<string, number>();
  // "|" separates them unambiguously: base58 has no punctuation, and the state
  // key is digits and colons.
  const id = (link: string, state: string): string => `${link}|${state}`;

  return {
    observe(book, walletFor, now) {
      const live = new Set<string>();
      const found: { readonly carry: Omit<PendingCarry, "since">; readonly since: number }[] = [];
      for (const [link, entries] of book) {
        for (const [state, carry] of entries) {
          const key = id(link, state);
          live.add(key);
          const since = firstSeen.get(key) ?? now;
          firstSeen.set(key, since);
          found.push({
            since,
            carry: {
              wallet: walletFor(link),
              link,
              state,
              lossLamports: carry.lossLamports,
              walletSignedTxCount: carry.walletSignedTxCount,
            },
          });
        }
      }
      for (const key of [...firstSeen.keys()]) if (!live.has(key)) firstSeen.delete(key);
      return found
        .sort((a, b) => a.since - b.since || a.carry.link.localeCompare(b.carry.link) || a.carry.state.localeCompare(b.carry.state))
        .map(({ carry, since }) => ({ ...carry, since: new Date(since).toISOString() }));
    },
  };
}
