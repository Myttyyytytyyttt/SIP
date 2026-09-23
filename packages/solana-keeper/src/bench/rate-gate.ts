// A provider's rate limit, as the bench's stubbed endpoint enforces it.
//
// NOTHING HERE RUNS IN PRODUCTION. src/bench/ exists for
// scripts/ceiling-bench.mts and its tests; no file the keeper boots imports it.
//
// WHY THE STUB NEEDS ONE. Without it the only thing that could slow the bench's
// sweep was latency, and a provider's plan does not slow a caller down: it
// answers HTTP 429. src/rpc-pool.ts reads any non-OK answer as the endpoint
// failing, sets it aside and — with one URL, which is production today — throws
// "every Solana endpoint refused" on that call, with no backoff. So at a fast
// latency the bench used to report fleets as "fits" that a real plan would have
// refused within the first second of the sweep. With `--plan-rps` the bench's
// endpoint answers 429 above the plan, the REAL keeper meets it in the REAL
// loop, and the row reports the refusals and the users they left unserved.
//
// A TOKEN BUCKET, BECAUSE IT IS THE SHAPE PLANS ARE SOLD IN: so many requests a
// second, with a second's worth of burst. A provider's exact accounting is not
// known here and is not claimed; what matters is that above the sustained rate,
// calls are refused rather than queued.

export interface RateGate {
  /** Whether this request is inside the plan. A refused request spends nothing. */
  admit(): boolean;
  /** Requests refused since the gate was made. */
  readonly refused: number;
}

export function createRateGate(perSecond: number, now: () => number = Date.now): RateGate {
  if (!(perSecond > 0) || !Number.isFinite(perSecond)) throw new Error(`a plan's rate is a positive number of requests a second, not ${perSecond}`);
  const capacity = perSecond;
  let tokens = capacity;
  let at = now();
  let refused = 0;
  return {
    admit() {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - at) / 1_000) * perSecond);
      at = t;
      if (tokens >= 1) {
        tokens -= 1;
        return true;
      }
      refused += 1;
      return false;
    },
    get refused() {
      return refused;
    },
  };
}
