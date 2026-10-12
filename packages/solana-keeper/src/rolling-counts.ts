// Counts over a sliding window, in a bounded number of buckets: "how many in
// the last 24 hours" and "how many in the last minute", for a process that runs
// for weeks.
//
// WHY BUCKETS AND NOT A LIST OF EVENTS. The profit keeper's RPC pool is
// expected to carry about 27,360 requests a day (COMPUTED, [ROLLOUT] L1a), and a list of
// timestamps that long, scanned on every /status read, is a leak with a sort in
// it. A bucket per five minutes is 288 small maps for a day, whatever the
// traffic; the price is that the window's oldest edge moves in five-minute
// steps, so "the last 24 h" covers between 23 h 55 min and 24 h. That is a
// 0.35 % blur on a number whose gate is ±5 % (the ADR's L1a go criterion), and
// `observedMs` says exactly how much time the counts cover, so nothing has to
// guess it.
//
// IT DECIDES NOTHING. Every caller counts something that already happened and
// reads the totals back for a status page or an alert. A counter that can change
// what gets signed is a counter that can be wrong about money, so nothing on
// the money path ever reads one of these.
//
// IN MEMORY, AND A RESTART FORGETS. A deploy restarts the keeper, so a day's
// window is usually shorter than a day; `observedMs` is the honest denominator,
// and the per-day estimates built on it say they are extrapolated.

/** A day, in milliseconds: the window every "per day" figure on /status is read over. */
export const DAY_MS = 24 * 60 * 60 * 1_000;

/** The day's bucket: five minutes, 288 of them. */
export const DAY_BUCKET_MS = 5 * 60 * 1_000;

/** A minute, and its bucket of one second: the window Jupiter's per-minute limit is counted in. */
export const MINUTE_MS = 60_000;
export const MINUTE_BUCKET_MS = 1_000;

/**
 * The most distinct keys one counter keeps before it files the rest under
 * OTHER_KEY.
 *
 * BOUNDED BECAUSE THE KEYS COME FROM OUTSIDE. The RPC meter keys by the method
 * a request body names, and a body is whatever the library serialized; a
 * counter keyed on it without a cap is a map that grows with every new string
 * anything ever sends. The keeper calls about fifteen methods.
 */
export const MAX_KEYS = 64;

/** Where a key past MAX_KEYS is counted, so the total stays whole. */
export const OTHER_KEY = "other";

export interface RollingCounts {
  /** Counts `n` (default 1) under `key` at `now`. Never throws; a non-positive or non-finite `n` counts nothing. */
  add(key: string, n?: number, now?: number): void;
  /** Every key's count inside the window ending at `now`, keys sorted. */
  totals(now: number): Readonly<Record<string, number>>;
  /** The sum of every key inside the window ending at `now`. */
  total(now: number): number;
  /**
   * How much time the window ending at `now` actually covers: the window's
   * length, or less while the counter is younger than its window.
   */
  observedMs(now: number): number;
  /** The window's length, as configured. */
  readonly windowMs: number;
}

export interface RollingCountsOptions {
  readonly windowMs: number;
  readonly bucketMs: number;
  /** When counting began: the window covers nothing before it. */
  readonly startedAt: number;
  readonly maxKeys?: number;
}

export function createRollingCounts(options: RollingCountsOptions): RollingCounts {
  const { windowMs, bucketMs, startedAt } = options;
  const maxKeys = options.maxKeys ?? MAX_KEYS;
  /** How many buckets the window spans, the current, partial one included. */
  const span = Math.max(1, Math.ceil(windowMs / bucketMs));
  const buckets = new Map<number, Map<string, number>>();
  const known = new Set<string>();

  const indexOf = (at: number): number => Math.floor(at / bucketMs);
  /** The oldest bucket the window ending at `now` still holds. */
  const oldest = (now: number): number => indexOf(now) - (span - 1);
  const prune = (now: number): void => {
    const floor = oldest(now);
    // A BUCKET AHEAD OF `now` IS KEPT: Date.now() can step backwards over an
    // NTP correction, and the events counted in it really happened.
    for (const index of buckets.keys()) if (index < floor) buckets.delete(index);
  };

  return {
    windowMs,
    add(key, n = 1, now = Date.now()) {
      if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(now)) return;
      let name = key;
      if (!known.has(name)) {
        if (known.size >= maxKeys) name = OTHER_KEY;
        else known.add(name);
      }
      const index = indexOf(now);
      let bucket = buckets.get(index);
      if (bucket === undefined) {
        bucket = new Map();
        buckets.set(index, bucket);
        prune(now);
      }
      bucket.set(name, (bucket.get(name) ?? 0) + n);
    },
    totals(now) {
      prune(now);
      const sum = new Map<string, number>();
      for (const bucket of buckets.values()) for (const [key, n] of bucket) sum.set(key, (sum.get(key) ?? 0) + n);
      return Object.fromEntries([...sum].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    },
    total(now) {
      prune(now);
      let sum = 0;
      for (const bucket of buckets.values()) for (const n of bucket.values()) sum += n;
      return sum;
    },
    observedMs(now) {
      const windowStart = Math.max(startedAt, oldest(now) * bucketMs);
      return Math.max(0, now - windowStart);
    },
  };
}

/**
 * How much a window must have watched before a count is scaled up to the whole
 * of it on /status: ten minutes, ten sweeps at the default cadence.
 *
 * MEASURED, NOT ARGUED: a keeper booted against the bench's chain stub served,
 * 132 ms after boot, an estimate of 48 million credits a day — its first sweep
 * (65 calls) multiplied by a day over 132 ms. A number like that on a status
 * page is read, and it is wrong by five orders of magnitude. Below this the
 * estimate is null and the raw count is served instead; past it the boot's
 * full pass is one sweep in ten and falling. The alert waits longer still
 * (CREDIT_BURN_MIN_OBSERVED_MS, src/rpc-usage.ts).
 */
export const MIN_OBSERVED_FOR_ESTIMATE_MS = 10 * 60 * 1_000;

/**
 * A count over its window, scaled to the whole window: what `observed` would
 * have been had the counter been watching for all of it. Null when it has
 * watched for no time at all.
 *
 * AN EXTRAPOLATION, AND IT SAYS SO: a keeper an hour past a deploy has an hour
 * of evidence, and this multiplies it by 24. The callers serve `observedMs`
 * beside it, serve nothing scaled before MIN_OBSERVED_FOR_ESTIMATE_MS, and the
 * one alert built on it waits for an hour of evidence.
 */
export function scaledToWindow(observed: number, observedMs: number, windowMs: number): number | null {
  if (!(observedMs > 0) || !Number.isFinite(observed)) return null;
  return (observed * windowMs) / observedMs;
}

/**
 * The highest value noted inside a sliding window, in buckets like the counts
 * above: Jupiter's busiest minute of the last day.
 *
 * WHY A PEAK AND NOT ONLY THE CURRENT MINUTE. A per-minute limit is broken by a
 * burst, and a burst is over long before anyone reads /status: the last minute
 * would read 0 every time an operator looked. The peak is the number to hold
 * against the limit.
 */
export interface RollingPeak {
  note(value: number, now?: number): void;
  /** The highest value noted inside the window ending at `now`, or 0. */
  peak(now: number): number;
}

export function createRollingPeak(options: { readonly windowMs: number; readonly bucketMs: number }): RollingPeak {
  const { windowMs, bucketMs } = options;
  const span = Math.max(1, Math.ceil(windowMs / bucketMs));
  const buckets = new Map<number, number>();
  const prune = (now: number): void => {
    const floor = Math.floor(now / bucketMs) - (span - 1);
    for (const index of buckets.keys()) if (index < floor) buckets.delete(index);
  };
  return {
    note(value, now = Date.now()) {
      if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(now)) return;
      const index = Math.floor(now / bucketMs);
      buckets.set(index, Math.max(buckets.get(index) ?? 0, value));
      prune(now);
    },
    peak(now) {
      prune(now);
      let highest = 0;
      for (const value of buckets.values()) highest = Math.max(highest, value);
      return highest;
    },
  };
}
