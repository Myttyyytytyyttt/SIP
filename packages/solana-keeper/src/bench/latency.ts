// The latency the bench injects, as a DISTRIBUTION and not as a constant.
//
// NOTHING HERE RUNS IN PRODUCTION. This directory exists for
// scripts/ceiling-bench.mts and its tests; no file the keeper boots imports it.
//
// WHY A DISTRIBUTION AT ALL. The endpoint measurements this keeper was sized on
// were 86.3 ms median against 122.4 ms at p90 — a 1.4x spread — and the sweep is
// SEQUENTIAL, so what fills a sweep is not the median call, it is the sum of a
// few hundred draws from a right-skewed tail. A bench that injects a flat 86 ms
// per call reports a sweep that is exactly N x calls x 86, which is arithmetic
// anyone can do on paper; the only reason to run a bench is to see what the tail
// does to the real loop.
//
// LOGNORMAL, because the two numbers we have are a median and a p90 and that is
// exactly the pair a lognormal is pinned by: the median IS exp(mu), so mu is
// ln(p50), and sigma follows from p90 = p50 * exp(sigma * z90). Nothing deeper is
// claimed for it — an RPC's real latency has a floor (the speed of light to
// Frankfurt) and a fat tail (a throttle, a retry) that no two-parameter family
// reproduces. What it gets right is the thing that matters here: most calls near
// the median, a minority materially slower, and the SAME draws every run.
//
// SEEDED, because a bench whose answer moves between runs cannot say whether a
// change helped. Two runs of the same grid with the same seed inject the same
// milliseconds in the same order.

/** The z-score of the 90th percentile of the standard normal. */
const Z90 = 1.2815515655446004;

export interface LatencyShape {
  /** The median call, in milliseconds. */
  readonly p50Ms: number;
  /** The 90th-percentile call. Equal to p50Ms means a constant latency, which is what a flat bench injects. */
  readonly p90Ms: number;
}

export interface LatencySampler {
  readonly shape: LatencyShape;
  /** The next call's latency, in milliseconds. Never negative. */
  next(): number;
}

/**
 * A deterministic uniform stream. mulberry32: 32 bits of state, no dependency,
 * and the same sequence on every platform this ever runs on.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One standard normal draw from two uniforms (Box-Muller); only the first of the pair is used. */
function standardNormal(uniform: () => number): number {
  // u is drawn away from 0, where log() is -Infinity.
  const u = Math.max(uniform(), Number.EPSILON);
  const v = uniform();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * The injected latency for one bench run.
 *
 * A p90 BELOW THE p50 IS REFUSED rather than silently reordered: it is a typo in
 * a grid, and a bench that quietly swaps them reports a shape nobody asked for.
 */
export function createLatency(shape: LatencyShape, seed: number): LatencySampler {
  if (!(shape.p50Ms >= 0) || !Number.isFinite(shape.p50Ms)) throw new Error(`p50Ms must be a finite, non-negative number of milliseconds, not ${shape.p50Ms}`);
  if (!(shape.p90Ms >= shape.p50Ms) || !Number.isFinite(shape.p90Ms)) {
    throw new Error(`p90Ms must be a finite number of milliseconds at or above p50Ms (${shape.p50Ms}), not ${shape.p90Ms}`);
  }
  const uniform = mulberry32(seed);
  // A zero median, or a p90 equal to it, is a constant: sigma is 0 and every
  // draw is the median. Computed rather than special-cased, except for the
  // log of zero.
  const sigma = shape.p50Ms === 0 ? 0 : Math.log(shape.p90Ms / shape.p50Ms) / Z90;
  return {
    shape,
    next: () => (sigma === 0 ? shape.p50Ms : shape.p50Ms * Math.exp(sigma * standardNormal(uniform))),
  };
}
