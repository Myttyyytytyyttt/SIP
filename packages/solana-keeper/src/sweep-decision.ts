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

/** Reads the carry book for /status, and remembers when each carry started waiting. */
export interface CarryWatch {
  /**
   * Stamps every carry the book holds, on the KEEPER'S OWN CLOCK, and forgets
   * the stamps of carries that have left it. CALLED ONCE PER SWEEP.
   *
   * WITHOUT IT THE STAMP IS THE READER'S, NOT THE LOSS'S. observe() was the only
   * caller, and it is the /status projection, so the stamp was born on the first
   * human page view: a loss carried at 09:00 by a keeper that ran all day was
   * reported as "since 17:00" to the operator who opened /status before a
   * redeploy — and that operator is exactly who this was built for. They read a
   * carry that had waited eight hours as one that had just appeared, deployed,
   * and the restart dropped it. The wrong stamp then stood for the life of the
   * carry, because it is memoised.
   */
  record(book: CarryBook, now: number): void;
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
 * AND IT IS TAKEN ON THE KEEPER'S CLOCK, NOT THE READER'S: the sweep calls
 * record() every pass, so a carry is stamped within one sweep of being recorded
 * whether or not anybody ever opens /status. See record() for what the lazy
 * stamp cost. observe() still stamps anything it finds unstamped — a carry
 * recorded by a sweep in flight, since a render can land mid-pass — so the page
 * can never show a carry with no wait at all.
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

  /**
   * Give every carry in the book a stamp if it has none, and drop the stamps of
   * carries that have left it. The ONE writer of `firstSeen`, so the sweep's
   * record() and the page's observe() cannot disagree about a wait.
   */
  const stamp = (book: CarryBook, now: number): void => {
    const live = new Set<string>();
    for (const [link, entries] of book) {
      for (const state of entries.keys()) {
        const key = id(link, state);
        live.add(key);
        if (!firstSeen.has(key)) firstSeen.set(key, now);
      }
    }
    for (const key of [...firstSeen.keys()]) if (!live.has(key)) firstSeen.delete(key);
  };

  return {
    record(book, now) {
      stamp(book, now);
    },

    observe(book, walletFor, now) {
      stamp(book, now);
      const found: { readonly carry: Omit<PendingCarry, "since">; readonly since: number }[] = [];
      for (const [link, entries] of book) {
        for (const [state, carry] of entries) {
          found.push({
            // Always present: stamp() has just run over this same book.
            since: firstSeen.get(id(link, state)) ?? now,
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
      return found
        .sort((a, b) => a.since - b.since || a.carry.link.localeCompare(b.carry.link) || a.carry.state.localeCompare(b.carry.state))
        .map(({ carry, since }) => ({ ...carry, since: new Date(since).toISOString() }));
    },
  };
}

/**
 * The leg-fee warnings that stand after a sweep, and the ones to clear.
 *
 * PER VAULT, BECAUSE A SWEEP NO LONGER TURNS EVERY VAULT. The keys are the
 * mint's and the rate's, never the vault's (invest-decision.ts, legFeeCeilingAlert),
 * and they used to be reconciled against ONE set raised by the whole sweep:
 * anything the sweep did not raise was cleared. That was right only while every
 * sweep turned every vault. Under the doorbell a vault that simply was not
 * turned this sweep raised nothing, so its standing warning would be cleared —
 * and raised again the next time the safety lane reached it: one message per
 * rotation, forever, which is exactly the alarm the deduplication exists to
 * prevent.
 *
 * So each vault keeps the set its own last LOOKING turn raised (`byVault`,
 * mutated here), a vault whose turns this sweep never read a mint keeps what it
 * had, a vault that is no longer discovered is dropped, and what stands is the
 * union. A key is cleared only when no vault still raises it.
 */
export function reconcileLegFees(input: {
  /** vault → the keys its last looking turn raised. Mutated: this sweep's lookers replace their entries. */
  readonly byVault: Map<string, ReadonlySet<string>>;
  /** vault → the keys this sweep's turns raised, only for vaults with a turn that READ the leg mints. */
  readonly looked: ReadonlyMap<string, ReadonlySet<string>>;
  readonly discoveredVaults: ReadonlySet<string>;
  readonly standing: ReadonlySet<string>;
}): { readonly standing: ReadonlySet<string>; readonly clear: readonly string[] } {
  for (const [vault, raised] of input.looked) input.byVault.set(vault, raised);
  for (const vault of [...input.byVault.keys()]) if (!input.discoveredVaults.has(vault)) input.byVault.delete(vault);
  const standing = new Set<string>();
  for (const raised of input.byVault.values()) for (const key of raised) standing.add(key);
  return { standing, clear: [...input.standing].filter((key) => !standing.has(key)) };
}

/**
 * The leg-fee book across sweeps: each vault's last looking turn, and the keys
 * that stand. reconcileLegFees is the rule; this OWNS its state, so a caller
 * cannot fold a sweep against the wrong `standing` — passing a fresh empty set
 * there silently cleared nothing, ever, with every test green (review,
 * 2026-09-23).
 */
export class LegFeeBook {
  readonly #byVault = new Map<string, ReadonlySet<string>>();
  #standing: ReadonlySet<string> = new Set<string>();

  /** Folds one sweep's lookers in; returns the keys no vault raises any longer, to be cleared. */
  fold(looked: ReadonlyMap<string, ReadonlySet<string>>, discoveredVaults: ReadonlySet<string>): readonly string[] {
    const result = reconcileLegFees({ byVault: this.#byVault, looked, discoveredVaults, standing: this.#standing });
    this.#standing = result.standing;
    return result.clear;
  }

  get standing(): ReadonlySet<string> {
    return this.#standing;
  }
}

/**
 * WHICH ROUTE CAN SIGN FOR EACH WALLET, across sweeps.
 *
 * IT WAS REBUILT EVERY SWEEP, from the wallets that sweep turned — which was
 * every wallet. Under the doorbell a sweep turns a selection, and /status
 * "signable of N" would have shrunk to "of the handful that moved". So it
 * persists: each turn overwrites its wallet's route, and a wallet that is no
 * longer discovered is dropped. There is no way to empty it wholesale: the one
 * edit that would bring the shrinking back.
 */
export class SigningRoutes {
  readonly #routes = new Map<string, string>();

  /** A new discovery: wallets no longer linked stop being counted. */
  prune(discoveredWallets: ReadonlySet<string>): void {
    for (const wallet of [...this.#routes.keys()]) if (!discoveredWallets.has(wallet)) this.#routes.delete(wallet);
  }

  set(wallet: string, route: string): void {
    this.#routes.set(wallet, route);
  }

  has(wallet: string): boolean {
    return this.#routes.has(wallet);
  }

  values(): string[] {
    return [...this.#routes.values()];
  }
}
