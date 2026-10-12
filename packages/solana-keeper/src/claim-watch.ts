// THE CLAIM'S HISTORY IN THIS PROCESS: takeovers, losses, and the one that
// matters — a REGAIN. Token `claim-flap` (src/cuts.ts); off, KeeperClaim is
// exactly as it was and nothing here is built.
//
// WHAT A REGAIN IS (ADR §4.10 amendment 3, RT-18). Every new container takes the
// claim once: Railway overlaps the old and the new on each deploy, and the
// newcomer takes over when the old one lets go (src/singleton.ts). That first
// takeover is a deploy, not a fault, and an alert on it would page on every push
// and on every intentional rollback. A SECOND takeover by the SAME process is
// different: it means this process held the claim, lost it — its database
// session dropped, or the settle key stopped matching the chain — and took it
// back. Between the loss and the regain another instance may have acted, and
// whatever dropped the session once can drop it again.
//
// SO IT COUNTS ONLY REGAINS, BY THIS PROCESS. The rollout's first draft paged
// at two takeovers in 30 minutes across the fleet ([ROLLOUT] §6 row 6), which
// pages on a quick redeploy and a rollback; comparing deployment ids would need
// a Railway variable nobody has verified. A regain is a fact this process knows
// about itself, and the fleet-wide count waits for Postgres-backed leases (L4).
//
// IT DECIDES NOTHING: it is told after KeeperClaim has already decided, from the
// callbacks bin/keeper.mts already passes it.

import type { Alert } from "./alerts.js";

export const CLAIM_FLAP_ALERT_KEY = "claim-flap";

/** Why this process stopped holding the claim, in fixed words. */
export type ClaimLoss = "session-dropped" | "settle-key-mismatch";

/** The `ops.claim` block of /status ([ROLLOUT] §6 row 6, ADR §6.3 "claim"). */
export interface ClaimWatchStatus {
  readonly takeovers: number;
  /** Takeovers after this process's first: each one paged as claim-flap. */
  readonly regains: number;
  readonly losses: number;
  /** Since when the current hold began; null while this process does not hold it. */
  readonly heldSince: string | null;
  readonly lastTakeoverAt: string | null;
  readonly lastLossAt: string | null;
  readonly lastLoss: ClaimLoss | null;
}

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

export class ClaimWatch {
  #takeovers = 0;
  #losses = 0;
  #heldSince: number | null = null;
  #lastTakeoverAt: number | null = null;
  #lastLossAt: number | null = null;
  #lastLoss: ClaimLoss | null = null;

  /**
   * This process took the claim. Returns the claim-flap page when it is a
   * regain — any takeover after this process's first — and null otherwise.
   */
  takeover(at: number): Alert | null {
    this.#takeovers += 1;
    this.#heldSince = at;
    this.#lastTakeoverAt = at;
    if (this.#takeovers === 1) return null;
    const regains = this.#takeovers - 1;
    const loss =
      this.#lastLoss === null
        ? "without a loss this process recorded"
        : `after ${this.#lastLoss === "session-dropped" ? "its database session dropped" : "the settle key stopped matching the chain"}` +
          `${this.#lastLossAt === null ? "" : ` (${Math.max(0, Math.round((at - this.#lastLossAt) / 1000))} s earlier)`}`;
    return {
      key: CLAIM_FLAP_ALERT_KEY,
      severity: "critical",
      title: "The keeper took its claim back after losing it",
      detail:
        `This process has now taken the claim ${this.#takeovers} times and lost it ${this.#losses} (regain ${regains}), ${loss}. ` +
        "A container's first takeover is a deploy; a second one by the same process means the claim lapsed while it was " +
        "running, and in between another instance may have acted. Whatever dropped the session can drop it again: check " +
        "DATABASE_URL's pooler, and /status ops.claim.",
      context: { takeovers: this.#takeovers, regains, losses: this.#losses },
    };
  }

  /** This process stopped holding the claim, for `why`. A SIGTERM release is not recorded: the process is leaving. */
  lost(at: number, why: ClaimLoss): void {
    this.#losses += 1;
    this.#heldSince = null;
    this.#lastLossAt = at;
    this.#lastLoss = why;
  }

  status(): ClaimWatchStatus {
    return {
      takeovers: this.#takeovers,
      regains: Math.max(0, this.#takeovers - 1),
      losses: this.#losses,
      heldSince: iso(this.#heldSince),
      lastTakeoverAt: iso(this.#lastTakeoverAt),
      lastLossAt: iso(this.#lastLossAt),
      lastLoss: this.#lastLoss,
    };
  }
}
