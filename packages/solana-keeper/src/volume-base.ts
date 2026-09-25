// The volume keeper's VolumeBase: what a complete VOLUME span is charged on, and
// when it is worth a settlement (the owner's decisions of 2026-09-25,
// reports/VOLUME_KEEPER_PLAN_2026-09-25.md §2 and §3).
//
// THE BASE is the sum of what the walk's volume probe counted (measure-volume.ts),
// less every trade at or before the vault's last change of mode or volume rate
// (policy-boundary.ts): those were made under another rule and are forgiven.
//
// THE CADENCE. A settlement costs the trading wallet its fee (10 000 lamports for
// the owner's settle of 2026-09-19), so a span waits until what it owes reaches
// VOLUME_MIN_OWED_LAMPORTS, or until its oldest charged trade is
// VOLUME_MAX_WAIT_SECONDS old, whichever comes first. A span that is only the
// oldest prefix of a backlog never waits (baseDecision). A wait is a resting
// NO_PROFIT, and the trades stay above the frontier for the next sweep.
//
// THE CAP IS THE PROGRAM'S. settle_v2 pays at most max_contribution per settle and
// the rest is not saved; the web says so ("above it is not carried over"). This
// keeper does not split a span to get around it.

import type { WindowMeasurement } from "./measure-window.js";
import type { PolicyBoundary } from "./policy-boundary.js";
import type { VolumeBase } from "./settle-decision.js";

/** 0.001 SOL: a settlement is sent once the span owes at least this much. */
export const VOLUME_MIN_OWED_LAMPORTS = 1_000_000n;
/** One hour: a span that owes less settles anyway once its oldest charged trade is this old. */
export const VOLUME_MAX_WAIT_SECONDS = 3_600;

export interface VolumeBaseOptions {
  /** The vault's volume_bps, the rate settle_v2 applies in VOLUME mode. */
  readonly volumeBps: number;
  /** The policy boundary for this span; asked only for a span with something to charge. */
  readonly boundary: () => Promise<PolicyBoundary>;
  /** Unix seconds now. */
  readonly nowSeconds: () => number;
}

export function createVolumeBase(options: VolumeBaseOptions): VolumeBase {
  return async (measured: WindowMeasurement) => {
    const trades = measured.volumeTrades;
    // A CALLER BUG, NOT A QUIET SPAN. Without the probe the walk records no trades,
    // and reading that as "nothing traded" would move the frontier past real volume.
    if (trades === undefined) {
      throw new Error("the volume base needs the walk's volume trades: runSettleTick was not given the volume probe");
    }
    if (trades.length === 0) return 0n;
    const { slot: boundary } = await options.boundary();
    const charged = boundary === null ? trades : trades.filter((trade) => trade.slot > boundary);
    const lamports = charged.reduce((sum, trade) => sum + trade.lamports, 0n);
    if (lamports === 0n) return 0n;
    const owed = (lamports * BigInt(options.volumeBps)) / 10_000n;
    if (owed >= VOLUME_MIN_OWED_LAMPORTS) return lamports;
    // A TRADE WITH NO BLOCK TIME CANNOT BE AGED, so it cannot be made to wait.
    const times = charged.map((trade) => trade.blockTime);
    if (times.some((time) => time === null)) return lamports;
    const oldest = Math.min(...(times as number[]));
    if (options.nowSeconds() - oldest >= VOLUME_MAX_WAIT_SECONDS) return lamports;
    return {
      waitLamports: lamports,
      detail:
        `${charged.length} trade(s) of ${lamports} lamports owe ${owed} at ${options.volumeBps} bps, under the ` +
        `${VOLUME_MIN_OWED_LAMPORTS}-lamport minimum; they settle once the span owes that much or at ` +
        `${new Date((oldest + VOLUME_MAX_WAIT_SECONDS) * 1000).toISOString()}, an hour after the oldest`,
    };
  };
}
