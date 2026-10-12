// WHO THE SCHEDULER MAKES DUE THIS TICK: Doorbell.select (src/doorbell.ts),
// ported from one process's memory to the dispatcher's vault_work rows
// (dispatcher ADR §3.8 step 5; [QUEUE] §2.7 step 5; plan §3.3.1 Q2).
//
// THE SAME RULE, LANE FOR LANE. A full pass on the first tick after this
// scheduler took the lock, on a requested full pass (fleet.full_pass_reason: a
// lost delivery, a failed bell write, a 403 before the header was confirmed), on
// the protocol's unpause, and while the doorbell is not trusted; otherwise, in
// order, a bell that is held, a link not seen by the previous tick's discovery, a
// vault whose last job did not rest, a link the managed webhook does not watch
// yet, and the rotating safety slice — k = max(SAFETY_MIN_PER_SWEEP, ⌈N × tick /
// pass⌉) links a tick, every link within the pass. test/scheduler-select.test.ts
// runs this and the legacy Doorbell over the same random histories and compares
// what each turns, tick by tick.
//
// WHAT MOVED, AND WHERE IT NOW LIVES:
//   * THE BELL is vault_work.bell_at, written by whichever scheduler replica's
//     receiver heard the delivery (src/fleet-receiver.ts): a wallet's bell rings
//     its link's vault there, because the job unit is the vault. A bell is HELD
//     while it is unanswered or younger than HOLD_MS, as in the legacy doorbell,
//     and a job ANSWERS it when the job rested and was claimed at least
//     BELL_ANSWER_MARGIN_MS after it rang (claimed_at ≥ bell_at + margin: the
//     job's reads came after the trade was final). Once answered a bell stays
//     answered — the legacy rule — which is the one thing this keeps in memory:
//     a later job that did not rest must not make an answered bell ring again.
//   * REST is vault_work.rests, which the vault's job writes for the whole
//     vault: it rests only when every link's turn rested and the invest half
//     did. So a vault is "busy" exactly when some link of it would be busy in the
//     legacy doorbell, and the vault is turned either way.
//   * THE PREVIOUS DISCOVERY, THE SAFETY CURSOR and the time of the last select
//     stay in this process's memory, as they did in the legacy keeper's. A
//     scheduler that takes the lock starts them empty — and with a full pass —
//     exactly as a legacy keeper started them at boot or on a takeover.
//
// PER LINK, THEN PER VAULT. The lanes are decided per link, as before, so the
// safety slice rotates over the same ordered list of links with the same
// cursor, and each vault takes the most urgent lane among its links (bell, then
// busy, then new, then full, then safety: LANE_PRIORITY). A vault is selected
// exactly when one of its links would have been; for a vault with ONE link (two
// of today's three) its lane is the legacy link's lane exactly. For a vault with
// several links the lane can only be more urgent than the legacy one, never
// less: a bell held at the vault until the WHOLE vault rests is held at least as
// long as the legacy doorbell held the one address it rang.
//
// WHAT THE PASS LENGTH IS. SAFETY_PASS_MS (30 min) unless the credit governor
// stretched it (src/credit-governor.ts, 60 or 120 min): the governor's only
// lever, and it only shrinks the safety slice.
//
// PURE. No database, no clock, no RPC: the scheduler (src/scheduler.ts) reads the
// rows, hands them here with the database's own `now`, and writes what comes
// back.

import { BELL_ANSWER_MARGIN_MS, HOLD_MS, SAFETY_PASS_MS } from "./doorbell.js";
import { safetySliceSize } from "./credit-governor.js";
import { LANE_PRIORITY, type Lane } from "./dispatch-store.js";

/** A live link as discovery found it: three base58 addresses. */
export interface SelectLink {
  readonly link: string;
  readonly wallet: string;
  readonly vault: string;
}

/** What the selection reads of one vault's vault_work row. Times are ms on the DATABASE's clock. */
export interface VaultBellState {
  /** bell_at, or null when no delivery ever rang it. */
  readonly bellAt: number | null;
  /** rests: whether the vault's last job may rest; null when no job has completed it yet (busy). */
  readonly rests: boolean | null;
  /** claimed_at of its last job (COMPLETE leaves it in place), or null. */
  readonly claimedAt: number | null;
}

/** The doorbell's trust, as the scheduler computes it from Postgres (src/scheduler.ts, doorbellTrust). */
export interface SelectTrust {
  /** False with no doorbell secret on the scheduler, or while the webhook is the legacy keeper's: every tick is then a full pass. */
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly reason: string | null;
}

/** The lanes this file decides. "retry" is a worker's lane (COMPLETE), never a selection's. */
export type SelectLane = Exclude<Lane, "retry">;

export interface VaultSelection {
  /** Why this tick turns every vault, or null when it turns a selection. */
  readonly fullReason: string | null;
  /** Each selected vault and its most urgent lane. A vault absent from the map is not turned this tick. */
  readonly vaults: ReadonlyMap<string, SelectLane>;
  /** Each turned link's own lane, in link-address order: the legacy doorbell's own answer, for /status and the tests. */
  readonly links: readonly { readonly link: SelectLink; readonly lane: SelectLane }[];
  /** Vaults by the lane they were selected in. */
  readonly lanes: Readonly<Record<SelectLane, number>>;
  /** How many links the safety slice took this tick: k. */
  readonly safetySlice: number;
}

export interface SelectInput {
  /** The live links this tick turns over: discovery's, restricted to the vaults the queue owns. */
  readonly links: readonly SelectLink[];
  /** vault_work's view of each vault the links name. A vault without a row is treated as never turned and never rung. */
  readonly vaults: ReadonlyMap<string, VaultBellState>;
  /** The database's clock, ms. */
  readonly now: number;
  /** The scheduler's tick (SIP_SOLANA_SWEEP_MS): the floor of the interval the safety slice is sized from. */
  readonly tickMs: number;
  /** The safety pass the governor allows now (SAFETY_PASS_MS unless stretched). */
  readonly passMs?: number;
  readonly protocolPaused: boolean;
  readonly trust: SelectTrust;
  /**
   * The addresses the managed webhook is confirmed to watch, or null when
   * nobody manages it (a webhook made by hand is taken at its word). An EMPTY
   * set is "managed, nothing confirmed yet": every link is then new.
   */
  readonly watched: ReadonlySet<string> | null;
}

const NO_LANES = (): Record<SelectLane, number> => ({ bell: 0, busy: 0, new: 0, full: 0, safety: 0 });

/** The most urgent of two lanes, by LANE_PRIORITY. */
export function moreUrgent(a: SelectLane, b: SelectLane): SelectLane {
  return LANE_PRIORITY[b] < LANE_PRIORITY[a] ? b : a;
}

/**
 * One scheduler's selection memory: what Doorbell kept between sweeps, minus
 * what now lives in vault_work. One instance per process; takeover() empties it
 * whenever the process (re)gains the lock.
 */
export class DueSelector {
  #previousLinks: ReadonlySet<string> | null = null;
  #safetyCursor: string | null = null;
  #lastSelectAt: number | null = null;
  #lastPaused: boolean | null = null;
  #fullPassPending: string | null = "the first tick after this scheduler took the lock";
  /** vault → the bell_at a resting job answered. A new bell_at is a new bell, unanswered. */
  readonly #answered = new Map<string, number>();

  /**
   * This process just took the lock: it knows nothing a previous holder knew,
   * and what it heard as a standby is not everything that happened. The next
   * select is a full pass, as a legacy keeper's first sweep and its takeover
   * were (Doorbell's "the first sweep after boot", "just became the acting
   * keeper").
   */
  takeover(reason = "this scheduler just took the lock"): void {
    this.#previousLinks = null;
    this.#safetyCursor = null;
    this.#lastSelectAt = null;
    this.#lastPaused = null;
    this.#answered.clear();
    this.#fullPassPending = reason;
  }

  /** The next select turns everything (fleet.full_pass_reason, a tick that failed mid-way). The first reason is kept. */
  requestFullPass(reason: string): void {
    this.#fullPassPending ??= reason;
  }

  /** Whether a full pass is owed and why: for /status. */
  get fullPassPending(): string | null {
    return this.#fullPassPending;
  }

  /** Whether the vault's current bell is held: unanswered, or answered inside the hold. */
  held(vault: string, state: VaultBellState | undefined, now: number): boolean {
    if (state === undefined || state.bellAt === null) return false;
    const answered = this.#answered.get(vault) === state.bellAt;
    return !answered || now - state.bellAt <= HOLD_MS;
  }

  select(input: SelectInput): VaultSelection {
    const { now } = input;
    const links = [...input.links].sort((a, b) => (a.link < b.link ? -1 : a.link > b.link ? 1 : 0));
    const passMs = input.passMs ?? SAFETY_PASS_MS;

    // ANSWERS FIRST: a resting job claimed at least the margin after the bell
    // rang has answered it (Doorbell.recordTurn), and stays answered.
    for (const [vault, state] of input.vaults) {
      if (state.bellAt === null) continue;
      if (state.rests === true && state.claimedAt !== null && state.claimedAt >= state.bellAt + BELL_ANSWER_MARGIN_MS) {
        this.#answered.set(vault, state.bellAt);
      }
    }
    // And forgets the answers of vaults no link names any more.
    const vaultsNamed = new Set(links.map((link) => link.vault));
    for (const vault of this.#answered.keys()) if (!vaultsNamed.has(vault)) this.#answered.delete(vault);

    let fullReason: string | null = null;
    if (!input.trust.enabled) fullReason = input.trust.reason ?? "the doorbell is off";
    else if (this.#fullPassPending !== null) fullReason = this.#fullPassPending;
    // THE PROTOCOL'S UNPAUSE rings no wallet's bell (Doorbell.select).
    else if (this.#lastPaused === true && !input.protocolPaused) fullReason = "the protocol was unpaused";
    else if (!input.trust.trusted) fullReason = input.trust.reason ?? "the doorbell is not trusted";
    this.#lastPaused = input.protocolPaused;

    const previous = this.#previousLinks;
    this.#previousLinks = new Set(links.map((link) => link.link));

    const vaults = new Map<string, SelectLane>();
    const lanes = NO_LANES();
    const turned: { link: SelectLink; lane: SelectLane }[] = [];
    const take = (link: SelectLink, lane: SelectLane): void => {
      turned.push({ link, lane });
      const had = vaults.get(link.vault);
      vaults.set(link.vault, had === undefined ? lane : moreUrgent(had, lane));
    };

    if (fullReason !== null) {
      this.#fullPassPending = null;
      this.#lastSelectAt = now;
      for (const link of links) take(link, "full");
      for (const lane of vaults.values()) lanes[lane] += 1;
      return { fullReason, vaults, links: turned, lanes, safetySlice: 0 };
    }

    // THE REAL INTERVAL, NOT THE CONFIGURED ONE (Doorbell.select): a tick that
    // overran had its successors skipped, and the slice keeps the pass in wall time.
    const previousSelectAt = this.#lastSelectAt;
    this.#lastSelectAt = now;
    const intervalMs = Math.max(input.tickMs, previousSelectAt === null ? 0 : now - previousSelectAt);
    const safety = this.#safetySlice(links, intervalMs, passMs);
    const watched = input.watched;
    for (const link of links) {
      const state = input.vaults.get(link.vault);
      const lane: SelectLane | null = this.held(link.vault, state, now)
        ? "bell"
        : previous === null || !previous.has(link.link)
          ? "new"
          : state?.rests !== true
            ? "busy"
            : // NOT WATCHED YET IS STILL NEW: a link the managed webhook cannot
              // ring may not rest on a bell until it can.
              watched !== null && (!watched.has(link.wallet) || !watched.has(link.vault))
              ? "new"
              : safety.has(link.link)
                ? "safety"
                : null;
      if (lane !== null) take(link, lane);
    }
    for (const lane of vaults.values()) lanes[lane] += 1;
    return { fullReason: null, vaults, links: turned, lanes, safetySlice: safety.size };
  }

  /** Doorbell's #safetySlice, with the governor's pass. */
  #safetySlice(links: readonly SelectLink[], intervalMs: number, passMs: number): Set<string> {
    const n = links.length;
    const slice = new Set<string>();
    if (n === 0) return slice;
    const k = safetySliceSize(n, Math.max(1, intervalMs), passMs);
    const cursor = this.#safetyCursor;
    let start = cursor === null ? 0 : links.findIndex((link) => link.link > cursor);
    if (start < 0) start = 0;
    let last = cursor;
    for (let i = 0; i < k; i += 1) {
      const link = links[(start + i) % n]!;
      slice.add(link.link);
      last = link.link;
    }
    this.#safetyCursor = last;
    return slice;
  }
}
