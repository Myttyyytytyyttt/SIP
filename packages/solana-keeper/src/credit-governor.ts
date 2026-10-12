// THE FLEET'S MONTH OF HELIUS CREDITS: what every process asked for, kept in
// ten-minute rows, and the governor that stretches the safety rotation when the
// month is running short (ADR §3.8 step 5, §3.9 "Credit governor"; [QUEUE] §2.3
// rpc_usage, §2.8).
//
// WHY A GOVERNOR AND NOT ONLY AN ALERT. credit-burn (src/rpc-usage.ts) tells the
// owner one keeper is over its day and changes nothing itself: every lever it
// names is the owner's to pull (ADR §2.4). Under the dispatcher one lever can be
// pulled by the scheduler, because it moves credits without moving money: the
// safety rotation, the slice of quiet vaults turned every tick so that each is
// looked at within 30 minutes even when no bell rang. Stretching it to 60 and
// then 120 minutes cuts the rest lane's reads while every bell, every busy
// vault and every retry is turned exactly as before.
//
// IT NEVER THROTTLES A SEND, A BELL OR A BUSY VAULT. Its one output is the
// safety pass length (GovernorVerdict.safetyPassMs), which only the safety
// slice reads (safetySliceSize). It holds no reference to any process's bucket
// and hands out no quota: the rate a send is admitted at is the quota and the
// provider's 429s, never the bill (test/credit-governor.test.ts, "sends never
// deferred by the governor"). A month that runs out anyway pages the owner; it
// does not stop the keeper from paying out what users are owed.
//
// THE PRICE OF AN ARCHIVAL CALL IS A PARAMETER, because 1 vs 10 is unsettled
// (rpc-usage.ts, ArchivalCredits). While it is unsettled the governor decides on
// the DEARER reading, as credit-burn does: stretching a rotation early costs a
// quiet vault up to an hour more between looks; stretching it late can cost the
// month.
//
// THE STORE IS NOT HERE. `rpc_usage` and the code that writes and reads it land
// in their own track (Q1). This file names what it needs — RpcUsageFeed — and
// ships the in-memory implementation the tests and the local shadow use.
//
// NOTHING HERE RUNS TODAY: no legacy keeper builds a collector or a governor.

import type { Alert } from "./alerts.js";
import { SAFETY_MIN_PER_SWEEP, SAFETY_PASS_MS } from "./doorbell.js";
import type { RpcLane, RpcUsageSink } from "./rpc-budget.js";
import { creditsFor, type ArchivalCredits, type CreditClass } from "./rpc-usage.js";

/** rpc_usage's bucket: ten minutes ([QUEUE] §2.3). */
export const USAGE_BUCKET_MS = 10 * 60_000;

/** Who was asked. Only the two Helius providers are on the credit bill. */
export type UsageProvider = "helius-rpc" | "helius-rest" | "jupiter" | "privy" | "other";

/**
 * The `class` column. THE CODE'S BILL LINES, NOT THE DRAFT'S. [QUEUE] §2.3
 * sketched `std | gpa | archival | send | webhook | jupiter | privy`; the
 * keeper already prices its traffic by CreditClass (rpc-usage.ts), and a second
 * vocabulary would need a translation table that could only drift. A send is
 * told apart by its LANE, which is what the sketch's `send` class was for.
 */
export type UsageClass = CreditClass | "jupiter" | "privy";

/** One rpc_usage row: one process's calls of one class, in one lane, to one provider, in one ten-minute bucket. */
export interface RpcUsageRow {
  /** The bucket's start, ms since the epoch: a multiple of USAGE_BUCKET_MS. */
  readonly bucket: number;
  readonly workerId: string;
  readonly provider: UsageProvider;
  readonly lane: RpcLane;
  readonly usageClass: UsageClass;
  readonly calls: number;
  readonly errors429: number;
  readonly errorsOther: number;
}

/**
 * The rows' store. Implemented by the store track over Postgres; by
 * InMemoryRpcUsageFeed here.
 *
 * `add` ADDS: each row's counts go onto the stored row with the same key
 * (bucket, worker, provider, lane, class), creating it when absent — the SQL is
 * `INSERT … ON CONFLICT (…) DO UPDATE SET calls = rpc_usage.calls +
 * EXCLUDED.calls, …`. A process flushes the same bucket several times while it
 * is current, and each flush carries only what is new.
 */
export interface RpcUsageFeed {
  add(rows: readonly RpcUsageRow[]): Promise<void>;
  /** Every row whose bucket starts in [fromMs, toMs). */
  read(fromMs: number, toMs: number): Promise<readonly RpcUsageRow[]>;
}

export const bucketStart = (at: number): number => Math.floor(at / USAGE_BUCKET_MS) * USAGE_BUCKET_MS;

const rowKey = (row: Pick<RpcUsageRow, "bucket" | "workerId" | "provider" | "lane" | "usageClass">): string =>
  `${row.bucket}\u0000${row.workerId}\u0000${row.provider}\u0000${row.lane}\u0000${row.usageClass}`;

const plus = (a: RpcUsageRow, b: RpcUsageRow): RpcUsageRow => ({
  ...a,
  calls: a.calls + b.calls,
  errors429: a.errors429 + b.errors429,
  errorsOther: a.errorsOther + b.errorsOther,
});

/** rpc_usage in memory: the tests', and the local shadow's before the store track lands. */
export class InMemoryRpcUsageFeed implements RpcUsageFeed {
  readonly #rows = new Map<string, RpcUsageRow>();

  async add(rows: readonly RpcUsageRow[]): Promise<void> {
    for (const row of rows) {
      const key = rowKey(row);
      const had = this.#rows.get(key);
      this.#rows.set(key, had === undefined ? { ...row } : plus(had, row));
    }
  }

  async read(fromMs: number, toMs: number): Promise<readonly RpcUsageRow[]> {
    return [...this.#rows.values()].filter((row) => row.bucket >= fromMs && row.bucket < toMs);
  }

  /** The 35-day prune the scheduler's reap runs ([QUEUE] §2.3). */
  prune(beforeMs: number): number {
    let pruned = 0;
    for (const [key, row] of this.#rows) {
      if (row.bucket < beforeMs) {
        this.#rows.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }

  get size(): number {
    return this.#rows.size;
  }
}

/**
 * The most distinct rows a collector holds before it drops the oldest: about a
 * week of buckets at every lane and class (1,008 buckets × 4 lanes × 5 classes
 * in use). A feed down that long is a page of its own; memory must not be one.
 */
export const COLLECTOR_MAX_ROWS = 20_000;

/**
 * One process's rpc_usage, accumulated in memory and handed to the feed by its
 * heartbeat (flush).
 *
 * TOLD BY THE BUDGET (it is the budget's RpcUsageSink: asked when a request is
 * admitted the first time, ended when each attempt ends), and by anything else
 * the process calls that is not JSON-RPC (count: Helius REST, Jupiter, Privy).
 * WHAT WAS ASKED IS COUNTED ONCE, as rpc-usage.ts counts it; a 429 or another
 * failure is counted per attempt, on the row of the request's first call.
 *
 * NEVER AWAITED ON A REQUEST'S PATH. Counting is a map update; only flush talks
 * to the feed, and only the heartbeat calls it.
 */
export class RpcUsageCollector implements RpcUsageSink {
  readonly workerId: string;
  readonly provider: UsageProvider;
  readonly #maxRows: number;
  #rows = new Map<string, RpcUsageRow>();
  #dropped = 0;
  #flushFailures = 0;

  constructor(options: { readonly workerId: string; readonly provider?: UsageProvider; readonly maxRows?: number }) {
    this.workerId = options.workerId;
    this.provider = options.provider ?? "helius-rpc";
    this.#maxRows = options.maxRows ?? COLLECTOR_MAX_ROWS;
  }

  #bump(at: number, provider: UsageProvider, lane: RpcLane, usageClass: UsageClass, calls: number, errors429: number, errorsOther: number): void {
    const row: RpcUsageRow = { bucket: bucketStart(at), workerId: this.workerId, provider, lane, usageClass, calls, errors429, errorsOther };
    const key = rowKey(row);
    const had = this.#rows.get(key);
    if (had !== undefined) {
      this.#rows.set(key, plus(had, row));
      return;
    }
    this.#rows.set(key, row);
    while (this.#rows.size > this.#maxRows) {
      // OLDEST FIRST: the Map keeps insertion order, and buckets are inserted in time order.
      const oldest = this.#rows.keys().next().value as string;
      this.#rows.delete(oldest);
      this.#dropped += 1;
    }
  }

  asked(lane: RpcLane, line: CreditClass, calls: number, at: number): void {
    this.#bump(at, this.provider, lane, line, calls, 0, 0);
  }

  ended(lane: RpcLane, line: CreditClass, result: number | "unreachable", at: number): void {
    if (result === 429) this.#bump(at, this.provider, lane, line, 0, 1, 0);
    else if (result === "unreachable" || result < 200 || result >= 300) this.#bump(at, this.provider, lane, line, 0, 0, 1);
  }

  /** Calls that do not pass the pool: Helius REST (the webhook client), Jupiter, Privy. */
  count(provider: UsageProvider, lane: RpcLane, usageClass: UsageClass, calls: number, at: number): void {
    this.#bump(at, provider, lane, usageClass, calls, 0, 0);
  }

  /** Everything not yet flushed, and forgets it. */
  drain(): RpcUsageRow[] {
    const rows = [...this.#rows.values()];
    this.#rows = new Map();
    return rows;
  }

  /** Rows a failed flush could not write, added back in front of whatever was counted since. */
  putBack(rows: readonly RpcUsageRow[]): void {
    const since = this.#rows;
    this.#rows = new Map();
    for (const row of rows) this.#bump(row.bucket, row.provider, row.lane, row.usageClass, row.calls, row.errors429, row.errorsOther);
    for (const row of since.values()) this.#bump(row.bucket, row.provider, row.lane, row.usageClass, row.calls, row.errors429, row.errorsOther);
  }

  /**
   * Writes what is new to the feed. A write that throws or outlasts `timeoutMs`
   * keeps its rows for the next beat — so a write that timed out but did land
   * is counted twice. That errs toward a higher bill, the side a budget governor
   * can afford to be wrong on.
   */
  async flush(feed: RpcUsageFeed, timeoutMs = 5_000): Promise<{ readonly written: number } | { readonly failed: true; readonly kept: number }> {
    const rows = this.drain();
    if (rows.length === 0) return { written: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        feed.add(rows),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(new Error("the rpc_usage write timed out")), timeoutMs);
        }),
      ]);
      return { written: rows.length };
    } catch {
      this.#flushFailures += 1;
      this.putBack(rows);
      return { failed: true, kept: rows.length };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  status(): { readonly pendingRows: number; readonly dropped: number; readonly flushFailures: number } {
    return { pendingRows: this.#rows.size, dropped: this.#dropped, flushFailures: this.#flushFailures };
  }
}

/** The safety pass lengths the governor steps through: 30, then 60, then 120 minutes (ADR §3.9). */
export const SAFETY_PASS_STEPS_MS: readonly number[] = [SAFETY_PASS_MS, 2 * SAFETY_PASS_MS, 4 * SAFETY_PASS_MS];

/** Above this projected share of the month's plan the rotation stretches one step and the governor warns (ADR §3.9). */
export const GOVERNOR_STRETCH_PCT = 90;

/** Above this the governor pages (ADR §3.9). */
export const GOVERNOR_PAGE_PCT = 100;

/**
 * A step is undone only when the month projected AT THE SHORTER PASS stays
 * under this: 85 %, five points under the stretch. ASSUMED. Without the gap a
 * month near 90 % would stretch, relax and stretch again every hour.
 */
export const GOVERNOR_RELAX_PCT = 85;

/**
 * The least time between two steps, and the window the current burn is read
 * over: an hour each. ASSUMED. The window must be no longer than the dwell, or a
 * step's own effect is not yet in the reading that decides the next one.
 */
export const GOVERNOR_DWELL_MS = 60 * 60_000;
export const GOVERNOR_RECENT_MS = 60 * 60_000;

/** Less recent burn than this observed, and the governor does not decide: a projection from minutes is noise. */
export const GOVERNOR_MIN_OBSERVED_MS = 30 * 60_000;

/** Helius Developer's month: 10M credits (ADR §1.2). */
export const HELIUS_DEVELOPER_CREDITS_MONTH = 10_000_000;

/** The alerter's key for the fleet's month. */
export const CREDIT_GOVERNOR_ALERT_KEY = "credit-governor";

/** The billing month as the governor reads it: the UTC calendar month around `now`. */
export function utcMonth(now: number): { readonly start: number; readonly end: number } {
  const d = new Date(now);
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

/**
 * The safety slice per tick at a pass length: min(N, max(floor, ⌈N × tick /
 * pass⌉)) — src/doorbell.ts's #safetySlice formula with the pass as a
 * parameter, which is the one thing the governor changes.
 *
 * AT SMALL N IT CHANGES NOTHING, AND THAT IS HONEST. The floor (50 a tick)
 * covers every link of a fleet up to 50, so a stretched pass saves credits only
 * once the fleet is larger than the floor — which is also the only fleet whose
 * safety reads are worth governing.
 */
export function safetySliceSize(links: number, tickMs: number, passMs: number, floor = SAFETY_MIN_PER_SWEEP): number {
  if (links <= 0) return 0;
  const perTick = Math.ceil((links * Math.max(1, tickMs)) / passMs);
  return Math.min(links, Math.max(floor, perTick));
}

export interface GovernorVerdict {
  /** 0, 1 or 2: the index into SAFETY_PASS_STEPS_MS. */
  readonly step: number;
  /** What the safety slice reads (safetySliceSize). The governor's ONLY lever. */
  readonly safetyPassMs: number;
  /** Credits this month so far, at the price decided on, and the plan. */
  readonly monthToDateCredits: number | null;
  readonly planCredits: number;
  /** The month projected at the current pass, and at one step shorter (null at step 0), as a share of the plan. */
  readonly projectedPct: number | null;
  readonly projectedPctShorter: number | null;
  /** The price the decision used, and why: "env" once SIP_SOLANA_ARCHIVAL_CREDITS is set, else the dearer of 1 and 10. */
  readonly archivalCredits: ArchivalCredits;
  readonly evaluatedAt: string;
  /** Why the step did not move when it did not: unmeasured (too little burn seen), dwell, a feed failure, or null. */
  readonly held: "unmeasured" | "dwell" | "feed-failed" | null;
  readonly alert: { readonly fire: Alert | null; readonly clear: boolean };
}

export interface CreditGovernorOptions {
  readonly feed: RpcUsageFeed;
  readonly planCreditsPerMonth?: number;
  readonly archivalCredits: ArchivalCredits;
  readonly archivalCreditsSource: "default" | "env";
  readonly month?: (now: number) => { readonly start: number; readonly end: number };
  readonly now?: () => number;
  readonly readTimeoutMs?: number;
}

const HELIUS_PROVIDERS: ReadonlySet<UsageProvider> = new Set(["helius-rpc", "helius-rest"]);

const pct = (credits: number, plan: number): number => Math.round((credits / plan) * 1_000) / 10;

/**
 * The scheduler's governor, evaluated once a tick (or less often: it is cheap
 * either way).
 *
 * THE PROJECTION: month-to-date credits plus the last hour's burn carried to
 * the month's end. The last hour's burn is split by lane — the `rest` lane is
 * the safety rotation's — so the month can be projected at another pass too:
 * at a pass twice as long the rest lane burns half. That is how the governor
 * knows a step down would not put the month back over 90 % before it takes it.
 *
 * ONE STEP AT A TIME, AN HOUR APART: up when the month at the current pass is
 * projected over GOVERNOR_STRETCH_PCT, down when it is projected under
 * GOVERNOR_RELAX_PCT at the shorter pass.
 *
 * ALERTS on CREDIT_GOVERNOR_ALERT_KEY: warn while the rotation is stretched or
 * the month is projected over 90 %; critical over 100 %; cleared at step 0 and
 * at or under 90 %.
 *
 * A FEED THAT FAILS IS A TICK THAT LEARNED NOTHING. The verdict keeps its step,
 * says so in `held`, and raises nothing: the database's own outage pages under
 * its own key (dep-down, pg-saturated). evaluate() never throws into the tick.
 */
export class CreditGovernor {
  readonly #feed: RpcUsageFeed;
  readonly #plan: number;
  readonly #archival: ArchivalCredits;
  readonly #unsettled: boolean;
  readonly #month: (now: number) => { readonly start: number; readonly end: number };
  readonly #now: () => number;
  readonly #readTimeoutMs: number;
  #step = 0;
  #changedAt: number | null = null;
  #last: GovernorVerdict;

  constructor(options: CreditGovernorOptions) {
    this.#feed = options.feed;
    this.#plan = options.planCreditsPerMonth ?? HELIUS_DEVELOPER_CREDITS_MONTH;
    if (!Number.isFinite(this.#plan) || this.#plan <= 0) throw new Error("a credit governor needs a positive plan of credits a month");
    this.#archival = options.archivalCredits;
    this.#unsettled = options.archivalCreditsSource === "default";
    this.#month = options.month ?? utcMonth;
    this.#now = options.now ?? (() => Date.now());
    this.#readTimeoutMs = options.readTimeoutMs ?? 5_000;
    this.#last = this.#verdict(this.#now(), null, null, null, this.#unsettled ? 10 : this.#archival, "unmeasured", { fire: null, clear: false });
  }

  /** The pass the safety slice should use now: the last verdict's. */
  get safetyPassMs(): number {
    return SAFETY_PASS_STEPS_MS[this.#step]!;
  }

  get verdict(): GovernorVerdict {
    return this.#last;
  }

  #verdict(
    now: number,
    mtd: number | null,
    projected: number | null,
    shorter: number | null,
    price: ArchivalCredits,
    held: GovernorVerdict["held"],
    alert: GovernorVerdict["alert"],
  ): GovernorVerdict {
    return {
      step: this.#step,
      safetyPassMs: SAFETY_PASS_STEPS_MS[this.#step]!,
      monthToDateCredits: mtd,
      planCredits: this.#plan,
      projectedPct: projected,
      projectedPctShorter: shorter,
      archivalCredits: price,
      evaluatedAt: new Date(now).toISOString(),
      held,
      alert,
    };
  }

  async #read(from: number, to: number): Promise<readonly RpcUsageRow[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#feed.read(from, to),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(new Error("the rpc_usage read timed out")), this.#readTimeoutMs);
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async evaluate(): Promise<GovernorVerdict> {
    const now = this.#now();
    const { start, end } = this.#month(now);
    const rows = await this.#read(start, now + 1);
    if (rows === null) {
      this.#last = { ...this.#last, step: this.#step, safetyPassMs: this.safetyPassMs, evaluatedAt: new Date(now).toISOString(), held: "feed-failed", alert: { fire: null, clear: false } };
      return this.#last;
    }
    const recentFrom = Math.max(start, bucketStart(now - GOVERNOR_RECENT_MS));
    const observedMs = now - recentFrom;
    const total: Record<string, number> = {};
    const recentRest: Record<string, number> = {};
    const recentOther: Record<string, number> = {};
    for (const row of rows) {
      if (!HELIUS_PROVIDERS.has(row.provider)) continue;
      total[row.usageClass] = (total[row.usageClass] ?? 0) + row.calls;
      if (row.bucket >= recentFrom) {
        const into = row.lane === "rest" ? recentRest : recentOther;
        into[row.usageClass] = (into[row.usageClass] ?? 0) + row.calls;
      }
    }
    // WHILE THE ARCHIVAL PRICE IS UNSETTLED, THE DEARER READING (header): 10,
    // which can only price the same calls higher than 1.
    const price: ArchivalCredits = this.#unsettled ? 10 : this.#archival;
    const mtd = creditsFor(total, price);
    if (observedMs < GOVERNOR_MIN_OBSERVED_MS) {
      this.#last = this.#verdict(now, mtd, null, null, price, "unmeasured", { fire: null, clear: false });
      return this.#last;
    }
    const remaining = Math.max(0, end - now);
    const restRate = creditsFor(recentRest, price) / observedMs;
    const otherRate = creditsFor(recentOther, price) / observedMs;
    const currentPass = SAFETY_PASS_STEPS_MS[this.#step]!;
    // THE REST LANE SCALES WITH THE PASS: at pass P' it burns restRate × P / P'.
    const projectedAt = (passMs: number): number => mtd + (otherRate + restRate * (currentPass / passMs)) * remaining;
    let projected = pct(projectedAt(currentPass), this.#plan);
    let shorter = this.#step === 0 ? null : pct(projectedAt(SAFETY_PASS_STEPS_MS[this.#step - 1]!), this.#plan);
    let held: GovernorVerdict["held"] = null;
    const dwellOver = this.#changedAt === null || now - this.#changedAt >= GOVERNOR_DWELL_MS;
    const wantsUp = projected > GOVERNOR_STRETCH_PCT && this.#step < SAFETY_PASS_STEPS_MS.length - 1;
    const wantsDown = shorter !== null && shorter < GOVERNOR_RELAX_PCT;
    if ((wantsUp || wantsDown) && !dwellOver) held = "dwell";
    else if (wantsUp || wantsDown) {
      this.#step += wantsUp ? 1 : -1;
      this.#changedAt = now;
      const pass = SAFETY_PASS_STEPS_MS[this.#step]!;
      projected = pct(projectedAt(pass), this.#plan);
      shorter = this.#step === 0 ? null : pct(projectedAt(SAFETY_PASS_STEPS_MS[this.#step - 1]!), this.#plan);
    }
    this.#last = this.#verdict(now, mtd, projected, shorter, price, held, this.#alert(projected, mtd, price));
    return this.#last;
  }

  #alert(projected: number, mtd: number, price: ArchivalCredits): GovernorVerdict["alert"] {
    const stretched = this.#step > 0;
    if (!stretched && projected <= GOVERNOR_STRETCH_PCT) return { fire: null, clear: true };
    const critical = projected > GOVERNOR_PAGE_PCT;
    const pass = Math.round(this.safetyPassMs / 60_000);
    const priceNote = this.#unsettled
      ? `archival calls priced at ${price} credits — the dearer reading, because SIP_SOLANA_ARCHIVAL_CREDITS is not set (E1 not answered)`
      : `archival calls priced at ${price} credits, as configured`;
    return {
      fire: {
        key: CREDIT_GOVERNOR_ALERT_KEY,
        severity: critical ? "critical" : "warn",
        title: critical ? "The fleet is projected to run out of Helius credits this month" : "The fleet's Helius credits are running short this month",
        detail:
          `The month is projected at ${projected} % of the plan's ${this.#plan} credits (${mtd} spent so far, ${priceNote}). ` +
          `The safety rotation is at ${pass} min${stretched ? ", stretched from 30 to save credits: quiet vaults are looked at less often" : ""}; ` +
          "bells, busy vaults, retries and every send run exactly as before. " +
          (critical
            ? "Stretching is not enough: buy credits or move to a larger plan, or raise the tick on the scheduler."
            : "Nothing needs doing yet; if it reaches 100 % this pages."),
        context: { projectedPct: projected, monthToDateCredits: mtd, planCredits: this.#plan, safetyPassMs: this.safetyPassMs, archivalCredits: price },
      },
      clear: false,
    };
  }
}
