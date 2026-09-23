// What the bench's numbers MEAN: the grid it runs, and the ceiling it reads off
// the result.
//
// NOTHING HERE RUNS IN PRODUCTION. src/bench/ exists for
// scripts/ceiling-bench.mts and its tests.
//
// MEASURED AND EXTRAPOLATED ARE DIFFERENT WORDS, and this file is where the
// difference is kept. A sweep of 2000 idle users at production latency takes
// twenty minutes to observe; nobody is going to sit through the whole grid at
// that size, and a bench that quietly reported an arithmetic answer as a
// measurement would be worse than no bench at all. So: every row of the table
// is a sweep that really ran, the fit below is stated as a fit, and the ceiling
// it implies is labelled as the extrapolation it is.
//
// THE STRAIGHT LINE BELOW IS NO LONGER THE HEADLINE. It was c6e38d8's model:
// a fixed part plus one per-link part, drawn through sweep totals. Those totals
// came from fleets with different hot shares, and the slope priced a mixture
// nobody chose, so the published ceiling now comes from src/bench/ceiling.ts,
// which reads the idle and hot prices off the keeper's own lanes and charges
// the write floor and the plan. The line is still printed beside it, labelled,
// so the size of the correction is visible on every run.

import { SWEEP_SLOW_FRACTION } from "../sweep-cost.js";
import type { LatencyShape } from "./latency.js";

/** One row of the grid: a fleet size at a latency. */
export interface BenchCell {
  readonly links: number;
  readonly latency: LatencyShape;
}

/**
 * How a sweep stands against the interval it has to fit in.
 *
 * THE THREE NAMES ARE THE KEEPER'S OWN. "close" is SWEEP_SLOW_FRACTION, the
 * point at which src/sweep-cost.ts starts warning; "overruns" is the point at
 * which bin/keeper.mts skips the next sweep and somebody goes unsettled. A
 * fourth grade invented here would be a fourth thing to learn.
 */
export type SweepVerdict = "fits" | "close" | "overruns";

export function sweepVerdict(sweepMs: number, windowMs: number): SweepVerdict {
  if (!(windowMs > 0)) throw new Error(`a sweep window is a positive number of milliseconds, not ${windowMs}`);
  if (sweepMs >= windowMs) return "overruns";
  return sweepMs >= windowMs * SWEEP_SLOW_FRACTION ? "close" : "fits";
}

/**
 * A row's verdict, once refusals are counted: a sweep in which the provider said
 * 429, or a user was left THREW or FAILED, is "refused" however fast it was.
 *
 * THE ONE GRADE ADDED TO THE KEEPER'S THREE, AND WHY IT HAS TO BE. A refused
 * call is not retried — src/rpc-pool.ts throws on it — so a sweep whose calls
 * were refused ends EARLY, and graded by time alone it reads as the fastest row
 * in the table. The review of c6e38d8 found exactly that shape: a fleet the
 * plan would refuse, reported as "fits".
 */
export type RowVerdict = SweepVerdict | "refused";

export function rowVerdict(sweepMs: number, windowMs: number, refusals: number): RowVerdict {
  return refusals > 0 ? "refused" : sweepVerdict(sweepMs, windowMs);
}

export interface SweepPoint {
  readonly links: number;
  readonly sweepMs: number;
}

export interface SweepCostFit {
  /** The part of a sweep that does not grow with the fleet. */
  readonly fixedMs: number;
  /** What one more linked wallet adds to the sweep. */
  readonly perLinkMs: number;
  /** How many measured sweeps the line was drawn through. */
  readonly points: number;
}

/**
 * A least-squares line through measured sweeps, at ONE latency.
 *
 * NULL RATHER THAN A GUESS when fewer than two distinct fleet sizes were
 * measured: one point fixes no slope, and a slope invented from one point is
 * the number an operator would plan capacity on.
 */
export function fitSweepCost(points: readonly SweepPoint[]): SweepCostFit | null {
  const distinct = new Set(points.map((point) => point.links));
  if (points.length < 2 || distinct.size < 2) return null;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const { links, sweepMs } of points) {
    sumX += links;
    sumY += sweepMs;
    sumXX += links * links;
    sumXY += links * sweepMs;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  const perLinkMs = (n * sumXY - sumX * sumY) / denominator;
  return { fixedMs: (sumY - perLinkMs * sumX) / n, perLinkMs, points: n };
}

/**
 * The fleet size at which the fitted sweep first fails to fit the window: the
 * smallest whole N whose sweep is at or over `windowMs`.
 *
 * NULL FOR A FLAT OR FALLING LINE. A per-link cost at or below zero means the
 * measurement is noise, not a trend, and "infinite users" is not an answer this
 * should ever print.
 */
export function ceilingLinks(fit: SweepCostFit, windowMs: number): number | null {
  if (!(windowMs > 0)) throw new Error(`a sweep window is a positive number of milliseconds, not ${windowMs}`);
  if (!(fit.perLinkMs > 0)) return null;
  const at = (windowMs - fit.fixedMs) / fit.perLinkMs;
  if (!Number.isFinite(at)) return null;
  // The first N that does NOT fit. A fleet exactly at the crossing takes exactly
  // the window, which is already an overrun by sweepVerdict's rule.
  return Math.max(0, Math.ceil(at));
}

/** The largest fleet size in a measured set whose sweep still fit the window. */
export function largestFitting(points: readonly SweepPoint[], windowMs: number): number | null {
  const fitting = points.filter((point) => sweepVerdict(point.sweepMs, windowMs) !== "overruns").map((point) => point.links);
  return fitting.length === 0 ? null : Math.max(...fitting);
}

/**
 * A comma-separated list of whole numbers, as a grid axis.
 *
 * REFUSED RATHER THAN COERCED. "1,10,fifty" silently becoming [1, 10] is a grid
 * that ran two thirds of what was asked for and said nothing about the third.
 */
export function parseCountList(text: string, name: string): readonly number[] {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error(`${name} needs at least one value`);
  return parts.map((part) => {
    const value = Number(part);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} takes whole non-negative numbers; it holds "${part}"`);
    return value;
  });
}

/**
 * A latency axis: `p50:p90` pairs, comma-separated. A bare number is a flat
 * latency, whose p90 is its p50.
 */
export function parseLatencyList(text: string, name: string): readonly LatencyShape[] {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error(`${name} needs at least one value`);
  return parts.map((part) => {
    const [p50Raw, p90Raw] = part.split(":");
    const p50Ms = Number(p50Raw);
    const p90Ms = p90Raw === undefined ? p50Ms : Number(p90Raw);
    if (!Number.isFinite(p50Ms) || p50Ms < 0) throw new Error(`${name} takes p50:p90 milliseconds; it holds "${part}"`);
    if (!Number.isFinite(p90Ms) || p90Ms < p50Ms) throw new Error(`${name}'s p90 must be at or above its p50; it holds "${part}"`);
    return { p50Ms, p90Ms };
  });
}

/** The grid, latency by latency and fleet by fleet: the order the bench walks it in. */
export function buildGrid(links: readonly number[], latencies: readonly LatencyShape[]): readonly BenchCell[] {
  const cells: BenchCell[] = [];
  for (const latency of latencies) for (const count of links) cells.push({ links: count, latency });
  return cells;
}
