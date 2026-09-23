// The ceiling the bench is allowed to PUBLISH, and every term that pulls it down.
//
// NOTHING HERE RUNS IN PRODUCTION. src/bench/ exists for
// scripts/ceiling-bench.mts and its tests; no file the keeper boots imports it.
//
// WHY THIS FILE EXISTS: THE FIRST HEADLINE WAS TOO HIGH. c6e38d8 published
// "about 99 links at the public endpoint's shape, ~266 at 30:45, ~698 at 10:14"
// from ONE straight line through four sweeps. An adversarial review of that
// number found three ways it flattered production, and each one is a term here:
//
//   1. THE LINE WAS DRAWN THROUGH FLEETS WITH DIFFERENT HOT SHARES. At 2 % the
//      1- and 10-link rows have no hot user at all (Math.round), so the slope
//      mixed an idle price with a hot one in proportions nobody chose, and the
//      headline held only for a fleet where 98 % of traders did nothing that
//      minute. Here the two prices are read SEPARATELY off the keeper's own
//      lanes (/status lastSweepPhaseMs: triageMs is every turn that rested,
//      expensiveMs every turn that walked), and the ceiling is a function of the
//      hot share rather than a single number that hides it.
//
//   2. A HOT USER WAS PRICED ON ITS READS ONLY. The bench runs dry, so no turn
//      reaches Privy, the confirmation poll or the receipt read. A live settle
//      cannot spend less than settle-tick.ts forces it to: the submit, a first
//      status check that finds nothing, one CONFIRM_POLL_MS wait, a second
//      check, and the receipt read. That floor is charged to every hot user
//      here. It is a FLOOR, so the ceiling built on it is an upper bound and is
//      printed as one ("at most").
//
//   3. A RATE LIMIT IS A REFUSAL, NOT A SLOWDOWN. The stub never said 429; a
//      provider does, and src/rpc-pool.ts sets the endpoint aside and throws
//      ("every Solana endpoint refused") instead of backing off. So every
//      ceiling is printed with the request rate its sweep drives, and a sweep
//      that DRIVES more requests a second than the plan allows has no ceiling
//      at all as the keeper is written — only refusals, which the bench now
//      measures by answering 429 above --plan-rps (src/bench/rate-gate.ts).
//
// MEASURED, DERIVED AND ASSUMED ARE THREE DIFFERENT WORDS. The lane prices are
// measured (the keeper's own clock, in the real loop). The ceiling, the
// sensitivity table and the backlog line are derived from them by the
// arithmetic below. The write floor is derived from the keeper's own constants
// and a round trip that was measured. Privy's own round trip is ASSUMED, at
// whatever the caller passes, and is zero unless it is passed.

import { MAX_SIGNATURES } from "../measure-window.js";
import { CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS } from "../settle-tick.js";
import { JUPITER_CALLS_PER_ROUTE_BUILD, JUPITER_KEYLESS_CALLS_PER_MINUTE } from "../sweep-cost.js";

/** One measured sweep, with the keeper's own lane split and the fleet it ran over. */
export interface LaneRow {
  readonly links: number;
  /** How many of those links were hot (had transactions above their frontier). */
  readonly hot: number;
  readonly sweepMs: number;
  /** /status lastSweepPhaseMs.triageMs: every turn whose settle rested before the walk. */
  readonly triageMs: number;
  /** /status lastSweepPhaseMs.expensiveMs: every turn that walked, settled or threw. */
  readonly expensiveMs: number;
  /** Every RPC call the stub answered for this cell's keeper process, its boot read included. */
  readonly rpcCalls: number;
}

/** What a sweep costs, lane by lane. */
export interface LaneCosts {
  /** The part of a sweep that does not grow with users: chain read, discovery, vault batch, loop overhead. */
  readonly fixedMs: number;
  /** One idle user: the probe, then the invest turn's five reads. */
  readonly idleMs: number;
  /** One hot user at `hotTxCount` transactions, READS ONLY. Null when no measured row had a hot user. */
  readonly hotReadMs: number | null;
  /** The fixed calls, INCLUDING the keeper's boot read (the stub counts the whole process). */
  readonly fixedCalls: number | null;
  readonly idleCalls: number | null;
  readonly hotCalls: number | null;
  /**
   * One round trip as the sweep really paid it, CPU included: every per-user
   * millisecond over every per-user call. Needs only the fixed calls, so it is
   * known even when the rows cannot split the calls between the lanes.
   */
  readonly roundTripMs: number | null;
  /** The backlog each hot user carried when `hotReadMs` was measured. */
  readonly hotTxCount: number;
  readonly rows: number;
}

/**
 * Least squares over the columns of `x`, or null when they are not independent.
 * Gaussian elimination with partial pivoting on the normal equations: at most
 * three unknowns, so nothing cleverer earns its keep.
 */
function leastSquares(x: readonly (readonly number[])[], y: readonly number[]): number[] | null {
  const k = x[0]?.length ?? 0;
  if (k === 0 || x.length < k) return null;
  const a: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let r = 0; r < x.length; r++) {
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) a[i]![j]! += x[r]![i]! * x[r]![j]!;
      a[i]![k]! += x[r]![i]! * y[r]!;
    }
  }
  const scale = Math.max(1, ...a.map((row) => Math.max(...row.slice(0, k).map(Math.abs))));
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (Math.abs(a[pivot]![col]!) <= scale * 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const factor = a[r]![col]! / a[col]![col]!;
      for (let j = col; j <= k; j++) a[r]![j]! -= factor * a[col]![j]!;
    }
  }
  return a.map((row, i) => row[k]! / row[i]!);
}

/**
 * The idle price and the hot price, read off the keeper's OWN lanes.
 *
 * NOT A LINE THROUGH THE SWEEP TOTALS. triageMs is the sum of every turn that
 * rested and expensiveMs the sum of every turn that walked (bin/keeper.mts
 * charges each turn to exactly one of them), so idle and hot are divided by
 * their own counts and cannot leak into each other whatever share of the fleet
 * each row happened to be.
 *
 * THE CALL COUNTS ARE A FIT, because the stub counts a whole process and not a
 * lane: calls = fixed + idle·I + hot·H, solved over the rows. The counts are
 * deterministic, so on consistent rows the fit is exact. A fixed part that
 * includes the boot read is labelled as such; the per-user parts are clean.
 * Rows that all share ONE hot share cannot split the calls between the lanes
 * (hot is then a multiple of idle); the split is then left null — never
 * guessed — and only the fixed calls and the round trip are read.
 *
 * NULL FOR NO IDLE USER AT ALL: there is then no price to read.
 */
export function laneCosts(rows: readonly LaneRow[], hotTxCount: number): LaneCosts | null {
  let idle = 0;
  let hot = 0;
  let triage = 0;
  let expensive = 0;
  let fixed = 0;
  for (const row of rows) {
    idle += row.links - row.hot;
    hot += row.hot;
    triage += row.triageMs;
    expensive += row.expensiveMs;
    fixed += row.sweepMs - row.triageMs - row.expensiveMs;
  }
  if (rows.length === 0 || idle <= 0) return null;

  let fixedCalls: number | null = null;
  let idleCalls: number | null = null;
  let hotCalls: number | null = null;
  const calls = rows.map((row) => row.rpcCalls);
  const byLane = hot > 0 ? leastSquares(rows.map((row) => [1, row.links - row.hot, row.hot]), calls) : null;
  if (byLane !== null) [fixedCalls, idleCalls, hotCalls] = byLane as [number, number, number];
  else {
    const byLink = leastSquares(rows.map((row) => [1, row.links]), calls);
    if (byLink !== null) fixedCalls = byLink[0]!;
    const idleOnly = rows.filter((row) => row.hot === 0);
    const idleFit = leastSquares(idleOnly.map((row) => [1, row.links]), idleOnly.map((row) => row.rpcCalls));
    if (idleFit !== null) idleCalls = idleFit[1]!;
  }
  const userCalls = fixedCalls === null ? 0 : calls.reduce((sum, count) => sum + count, 0) - rows.length * fixedCalls;

  return {
    fixedMs: fixed / rows.length,
    idleMs: triage / idle,
    hotReadMs: hot > 0 ? expensive / hot : null,
    fixedCalls,
    idleCalls,
    hotCalls,
    roundTripMs: userCalls > 0 ? (triage + expensive) / userCalls : null,
    hotTxCount,
    rows: rows.length,
  };
}

/** One round trip as the sweep really paid it, CPU included; null when the rows could not fix the fixed calls. */
export function roundTripMs(costs: LaneCosts): number | null {
  return costs.roundTripMs;
}

/** What the write path adds to one hot user's turn, and what a settle that never confirms costs. */
export interface WriteFloor {
  /** The least a LIVE settle that lands can add to a turn. */
  readonly ms: number;
  /** The RPC calls in it (Privy's submit is not an RPC call and is not counted here). */
  readonly calls: number;
  /** A settle whose confirmation never arrives: the whole CONFIRM_TIMEOUT_MS, inside the sequential loop. */
  readonly stuckMs: number;
}

/**
 * The settle's write path, at the least settle-tick.ts lets it cost.
 *
 * FROM THE CODE, NOT FROM A GUESS. After the submit, landing() asks for the
 * status at once — a transaction Privy has only just broadcast is not
 * `confirmed` yet — then sleeps CONFIRM_POLL_MS and asks again; then the
 * receipt is read. Two status checks, one wait and one receipt is the fastest
 * path through that code for a settle that lands, so charging it is a floor:
 * a second poll, the 1 s receipt re-read, the invest leg's Jupiter calls and
 * its own sends are all on top of it and none is charged.
 *
 * PRIVY'S ROUND TRIP IS WHATEVER IS PASSED, zero by default, because it was
 * never measured and a guess would be the same kind of number this file exists
 * to take out of the headline.
 */
export function settleWriteFloor(rpcRoundTripMs: number, privyMs = 0): WriteFloor {
  if (!(rpcRoundTripMs >= 0) || !Number.isFinite(rpcRoundTripMs)) throw new Error(`a round trip is a non-negative number of milliseconds, not ${rpcRoundTripMs}`);
  if (!(privyMs >= 0) || !Number.isFinite(privyMs)) throw new Error(`Privy's round trip is a non-negative number of milliseconds, not ${privyMs}`);
  return {
    ms: privyMs + CONFIRM_POLL_MS + 3 * rpcRoundTripMs,
    calls: 3,
    stuckMs: privyMs + CONFIRM_TIMEOUT_MS + rpcRoundTripMs,
  };
}

export interface CeilingQuestion {
  readonly costs: LaneCosts;
  readonly windowMs: number;
  /** The fraction of the fleet that is hot in a given sweep, 0..1. */
  readonly hotShare: number;
  /** Added to every hot user: settleWriteFloor(...).ms, or 0 to ask the reads-only question. */
  readonly writeMs: number;
  readonly writeCalls: number;
  /** The provider plan's sustained requests a second, or null when it is not known. */
  readonly planRps: number | null;
}

export interface CeilingAnswer {
  /** What one user costs at this hot share, write floor included. */
  readonly perLinkMs: number;
  readonly perLinkCalls: number | null;
  /** The first fleet size whose sweep does not fit the window. */
  readonly byWindow: number | null;
  /**
   * The first fleet size whose sweep needs more requests than the plan grants in
   * one window — as if the keeper spread them evenly. It does not; see `overPlan`.
   */
  readonly byPlan: number | null;
  /** Requests a second the sweep drives while it runs. Sequential and unpaced, so it barely moves with N. */
  readonly driveRps: number | null;
  /** The sweep drives more requests a second than the plan allows: calls are REFUSED, not slowed. */
  readonly overPlan: boolean;
  /**
   * The ceiling this keeper, AS WRITTEN, can reach — or null when it cannot be
   * stated: an unmeasured hot price, or a sweep over the plan, which has no
   * ceiling but a refusal.
   */
  readonly links: number | null;
  readonly binding: "window" | "refused" | "unmeasured";
}

/**
 * How many linked wallets fit, at one hot share, with every term that pulls the
 * number down.
 *
 * THE KEEPER DOES NOT PACE ITSELF, and that is why the plan is a refusal and
 * not a third ceiling. A sequential loop drives about calls-per-user over
 * ms-per-user requests a second, from its first call to its last, whatever N
 * is. At or under the plan, the window is the only limit (and the plan's
 * budget over the window is then never the lower of the two, up to the fixed
 * part). Over the plan, the provider answers 429 once its burst is spent,
 * rpc-pool.ts throws, and the turns behind it are not served — so there is no
 * ceiling to print, only the size at which refusals start, which the bench
 * MEASURES with --plan-rps. `byPlan` is what a keeper that spread its requests
 * could reach, and is reported as that.
 */
export function fleetCeiling(question: CeilingQuestion): CeilingAnswer {
  const { costs, windowMs, hotShare, writeMs, writeCalls, planRps } = question;
  if (!(windowMs > 0)) throw new Error(`a sweep window is a positive number of milliseconds, not ${windowMs}`);
  if (!(hotShare >= 0 && hotShare <= 1)) throw new Error(`a hot share is a fraction in 0..1, not ${hotShare}`);
  if (planRps !== null && !(planRps > 0)) throw new Error(`a plan's rate is a positive number of requests a second, not ${planRps}`);

  const hotKnown = hotShare === 0 || costs.hotReadMs !== null;
  const perLinkMs = (1 - hotShare) * costs.idleMs + (hotShare > 0 ? hotShare * ((costs.hotReadMs ?? 0) + writeMs) : 0);
  const perLinkCalls =
    costs.idleCalls === null || (hotShare > 0 && costs.hotCalls === null)
      ? null
      : (1 - hotShare) * costs.idleCalls + (hotShare > 0 ? hotShare * ((costs.hotCalls ?? 0) + writeCalls) : 0);

  const firstNotFitting = (budget: number, fixed: number, perLink: number): number | null => {
    if (!(perLink > 0)) return null;
    const at = (budget - fixed) / perLink;
    return Number.isFinite(at) ? Math.max(0, Math.ceil(at)) : null;
  };
  const byWindow = hotKnown ? firstNotFitting(windowMs, costs.fixedMs, perLinkMs) : null;
  const driveRps = hotKnown && perLinkCalls !== null && perLinkMs > 0 ? (perLinkCalls / perLinkMs) * 1_000 : null;
  const byPlan =
    planRps === null || perLinkCalls === null || costs.fixedCalls === null || !hotKnown
      ? null
      : firstNotFitting((planRps * windowMs) / 1_000, costs.fixedCalls, perLinkCalls);
  const overPlan = planRps !== null && driveRps !== null && driveRps > planRps;

  if (!hotKnown || byWindow === null) return { perLinkMs, perLinkCalls, byWindow, byPlan, driveRps, overPlan, links: null, binding: "unmeasured" };
  if (overPlan) return { perLinkMs, perLinkCalls, byWindow, byPlan, driveRps, overPlan, links: null, binding: "refused" };
  return { perLinkMs, perLinkCalls, byWindow, byPlan, driveRps, overPlan, links: byWindow, binding: "window" };
}

/** The hot shares the sensitivity table always prints, the measured one added to them. */
export const SENSITIVITY_HOT_SHARES: readonly number[] = [0, 0.02, 0.05, 0.1, 0.2, 0.5];

/** What a backlogged user costs, and how many of them fill a window on their own. */
export interface BacklogFill {
  /** One user whose walk hits MAX_SIGNATURES, reads plus the write floor. */
  readonly perUserMs: number;
  /** The first count of such users whose sweep does not fit the window. */
  readonly users: number;
}

/**
 * AFTER AN OUTAGE THE FLEET IS NOT THE PROBLEM, THE BACKLOG IS. Every trader
 * who kept trading while the keeper was down comes back hot with up to
 * MAX_SIGNATURES transactions to walk, one getTransaction at a time. That walk
 * is priced as the measured hot turn plus one round trip for every transaction
 * it did not already include — derived, and labelled so by the report.
 *
 * NULL WHEN THE HOT PRICE WAS NOT MEASURED or no round trip could be read.
 */
export function backlogFill(costs: LaneCosts, windowMs: number, writeMs: number): BacklogFill | null {
  const trip = roundTripMs(costs);
  if (costs.hotReadMs === null || trip === null) return null;
  const extraTx = Math.max(0, MAX_SIGNATURES - costs.hotTxCount);
  const perUserMs = costs.hotReadMs + extraTx * trip + writeMs;
  if (!(perUserMs > 0)) return null;
  return { perUserMs, users: Math.max(1, Math.ceil((windowMs - costs.fixedMs) / perUserMs)) };
}

/** Jupiter requests one buying turn spends: a route build per leg-and-convert hop, about a dozen. */
export const JUPITER_CALLS_PER_BUYING_TURN = JUPITER_CALLS_PER_ROUTE_BUILD * 6;

/**
 * The fleet at which buying turns alone exceed Jupiter's keyless budget in one
 * window, IF EVERY HOT USER ALSO BOUGHT — the external ceiling on ACTIVE users,
 * which no change to this process moves. Null at a hot share of zero, where
 * nobody buys.
 */
export function jupiterBuyerCeiling(hotShare: number, windowMs: number): number | null {
  if (!(hotShare > 0)) return null;
  const turnsPerWindow = ((JUPITER_KEYLESS_CALLS_PER_MINUTE * windowMs) / 60_000) / JUPITER_CALLS_PER_BUYING_TURN;
  return Math.floor(turnsPerWindow / hotShare) + 1;
}
