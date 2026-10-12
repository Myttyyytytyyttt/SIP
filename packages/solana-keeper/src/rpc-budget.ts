// ONE PROCESS'S SHARE OF THE FLEET'S RPC RATE: a token bucket inside the pool's
// transport, with lanes, and what a 429 does to it (ADR §3.9, [QUEUE] §2.8;
// PLAN §3.3.1 "Global RPC budget"; failure-matrix row 18).
//
// WHY A BUCKET AT ALL. Today each keeper sweeps one turn at a time and peaks at
// no more than about 30 requests a second (COST_MODEL §3 notes). The dispatcher
// runs r workers with s slots each beside a scheduler, all at once, and at scale
// two loops sweeping together can peak at about 91 a second against Developer's
// 50 ([QUEUE] §5, P3). A provider's rate limit is a REFUSAL, not a slowdown
// (test/bench-ceiling.test.ts pins the pool's half of that): a refused read ends
// a turn RETRY and a refused send is a settle that lands late. So every
// dispatcher process paces itself to a quota, and the quotas add up to less than
// the plan (src/rpc-quota.ts hands them out).
//
// PER PROCESS, NOT IN POSTGRES. A bucket kept in the database would add a round
// trip to every RPC call, and was rejected for that ([QUEUE] §2.8). The
// scheduler writes each process's quota into its worker row; the process reads
// it on its heartbeat and sets it here (QuotaFollower, src/rpc-quota.ts).
//
// LANES, BECAUSE NOT EVERY CALL CAN WAIT THE SAME. Four, tagged on the async
// context so no call site changes (withRpcLane; Anchor, runSettleTick and
// runInvestTick never learn the lane exists):
//   * send  — blockhash, fee, sendTransaction, statuses, receipts, the nonce
//             re-read: served FIRST, whatever else is waiting. A send held behind
//             a backlog of probes is a blockhash that expires in the queue.
//   * hot   — bell, busy and retry jobs.
//   * rest  — the safety rotation and the real probes.
//   * sched — the scheduler's own tick (snapshot, listing, batch read).
// hot, sched and rest share what send leaves by weight, 4 : 4 : 1, so when hot
// and rest both wait, rest still gets one token in five — the 80 : 20 of the
// ADR — and THE 30-MINUTE SAFETY GUARANTEE NEVER STARVES behind a busy day.
// sendTransaction rides the send lane even untagged: a caller that forgot the
// tag must not be able to park a signed transaction behind the rotation.
//
// 429: HALVE, HOLD, RECOVER. A 429 halves this process's rate for 30 s; then
// the rate climbs back by a tenth of the quota every 10 s (additive increase,
// multiplicative decrease — the ADR's "+10 % every 10 s" read as ten points of
// the quota, so a halving is undone 70 s after it). Only a 429 for a request
// sent AT THE CURRENT RATE cuts again: requests already in flight when the first
// 429 came back were sent at the old rate, and letting each of them halve the
// rate once more would turn one refusal into a 1/256 crawl. `Retry-After` up to
// 2 s is honoured on the same endpoint by the pool (rpc-pool.ts), and a retried
// send is the same signed bytes, which is safe by signature.
//
// NOTHING DEPENDS ON IT TODAY, AND THAT IS PINNED. The legacy keepers build
// their pool with no budget — bin/keeper.mts hands poolFetch five arguments —
// and a pool without one makes the same requests, in the same order, with no
// await added before any of them (test/rpc-budget-parity.test.ts). Only the
// dispatcher's entry points will pass one: another track's, and not started by
// production.
//
// NOTHING HERE READS THE CLOCK OR SETS A TIMER ON ITS OWN. Both are injected,
// with Date.now and setTimeout as defaults, so the tests drive minutes of
// pacing on a clock they own.

import { AsyncLocalStorage } from "node:async_hooks";
import { creditClassOf, jsonRpcCalls, type CreditClass } from "./rpc-usage.js";

/** Which queue a request waits in. See the header for what each one carries. */
export type RpcLane = "send" | "hot" | "rest" | "sched";

/** Every lane, in the order /status lists them. */
export const RPC_LANES: readonly RpcLane[] = ["send", "hot", "rest", "sched"];

/** The lanes that share by weight. `send` is not among them: it is served before any of them. */
export type WeightedLane = Exclude<RpcLane, "send">;

/**
 * What each weighted lane gets when they all wait: hot and sched 4, rest 1. With
 * hot and rest both waiting that is 80 : 20 (ADR §3.9; the split is ASSUMED
 * there and kept here). Ties go hot, then sched, then rest.
 */
export const LANE_WEIGHTS: Readonly<Record<WeightedLane, number>> = { hot: 4, sched: 4, rest: 1 };
const WEIGHTED_ORDER: readonly WeightedLane[] = ["hot", "sched", "rest"];

/** How long a 429's halving holds before the rate starts to climb back: 30 s (ADR §3.9). */
export const RATE_CUT_HOLD_MS = 30_000;

/** The climb back after the hold: a tenth of the quota every 10 s (ADR §3.9). */
export const RATE_RECOVERY_STEP_MS = 10_000;
export const RATE_RECOVERY_STEP = 0.1;

/**
 * The lowest the halvings go: a sixteenth of the quota. Four halvings in a row,
 * each from a request sent at the rate the previous one set, is a provider that
 * is refusing everything; past that, a slower bucket only makes the queue
 * longer, and the pool's endpoint cooldown is what answers it.
 */
export const MIN_RATE_MULTIPLIER = 1 / 16;

/**
 * The longest `Retry-After` the pool waits out on the same endpoint: 2 s (ADR
 * §3.9). Past it the endpoint is set aside for its 30 s, exactly as without a
 * budget, and the request goes to the next one.
 */
export const RETRY_AFTER_HONOUR_MAX_MS = 2_000;

/** A bucket holds one second of its rate (at least one token): a second's burst, as the plan's own limit is per second. */
export const BURST_SECONDS = 1;

/** Methods that ride the send lane whatever the context says. */
export const SEND_LANE_METHODS: ReadonlySet<string> = new Set(["sendTransaction"]);

/** Floating-point slack when comparing token counts that were integrated over time. */
const EPSILON = 1e-9;

/** What a request runs under: its lane and, when its job has one, the signal that ends it. */
export interface RpcContext {
  readonly lane: RpcLane;
  /**
   * The job's own deadline (the worker's 6-minute ceiling, ADR §4.9 row 7). A
   * request waiting for tokens stops waiting when it fires, and the pool's
   * request carries it, so a job past its ceiling sends nothing after it.
   */
  readonly signal?: AbortSignal;
}

const rpcContext = new AsyncLocalStorage<RpcContext>();

/**
 * Runs `fn` with every RPC request it makes, however deep, in `lane`.
 *
 * NESTED CONTEXTS: the inner lane wins, and an inner call that names no signal
 * keeps the outer one — a send phase inside a job is still bounded by the job.
 */
export function withRpcLane<T>(lane: RpcLane, fn: () => T, signal?: AbortSignal): T {
  const outer = rpcContext.getStore();
  const inherited = signal ?? outer?.signal;
  return rpcContext.run(inherited === undefined ? { lane } : { lane, signal: inherited }, fn);
}

/** The context the current async call chain runs under, if any. */
export function currentRpcContext(): RpcContext | undefined {
  return rpcContext.getStore();
}

/**
 * How long a `Retry-After` header asks to wait, in ms, or null when there is no
 * usable one. Both forms of RFC 9110 §10.2.3: whole seconds, or an HTTP date
 * (a date already past is 0). Anything else is not believed.
 */
export function retryAfterMs(value: string | null | undefined, now: number): number | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  if (/^[0-9]{1,9}$/.test(text)) return Number(text) * 1_000;
  if (!/[A-Za-z]/.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - now);
}

/**
 * Where the budget reports what it admitted and how each attempt ended: the
 * rows of `rpc_usage` (RpcUsageCollector in src/credit-governor.ts). Told after
 * the fact, never asked; a sink that throws loses a count, never a request.
 */
export interface RpcUsageSink {
  asked(lane: RpcLane, line: CreditClass, calls: number, at: number): void;
  ended(lane: RpcLane, line: CreditClass, result: number | "unreachable", at: number): void;
}

/** One admission: what it waited in, what it took, and the rate epoch it was sent at. */
export interface RpcPermit {
  readonly lane: RpcLane;
  readonly tokens: number;
  /** The halving count when it was admitted. A 429 for a permit from an older epoch does not cut again. */
  readonly epoch: number;
  /** The bill line of the request's first call: where its errors are filed in rpc_usage. */
  readonly line: CreditClass;
  readonly waitedMs: number;
}

/** The bucket as /status reads it. */
export interface RpcBudgetStatus {
  /** The quota this process was handed, and the rate it runs at now (lower while a 429's halving holds). */
  readonly quotaPerSecond: number;
  readonly ratePerSecond: number;
  readonly multiplier: number;
  /** While a halving holds: until when. Null once the rate is climbing back or whole. */
  readonly cutHeldUntil: string | null;
  readonly tokens: number;
  readonly capacity: number;
  readonly waiting: Readonly<Record<RpcLane, number>>;
  readonly granted: Readonly<Record<RpcLane, number>>;
  /** The longest any request of each lane waited for its tokens since boot. */
  readonly maxWaitMs: Readonly<Record<RpcLane, number>>;
  readonly http429: number;
  /** 429s that halved the rate, and those that did not because their request was sent before the last halving. */
  readonly cuts: number;
  readonly stale429: number;
  readonly retryAfterHonoured: number;
  /** Requests that stopped waiting because their job's signal fired. */
  readonly aborted: number;
}

export interface RpcBudgetOptions {
  /**
   * The quota at boot, in requests a second. A worker starts at the static floor
   * (src/rpc-quota.ts, fleetQuotas().floorRps), which fits any number of live
   * workers up to the configured maximum, and moves to its handed-out quota at
   * the first heartbeat that reads one.
   */
  readonly ratePerSecond: number;
  /** The lane of a request made outside any withRpcLane: "sched" in a scheduler, "hot" in a worker. */
  readonly defaultLane: RpcLane;
  readonly usage?: RpcUsageSink;
  readonly now?: () => number;
  /** Schedules `fn` after `ms`, returning a cancel. Defaults to setTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

interface Waiter {
  readonly lane: RpcLane;
  readonly tokens: number;
  readonly line: CreditClass;
  readonly since: number;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (permit: RpcPermit) => void;
  readonly reject: (error: unknown) => void;
  onAbort: (() => void) | null;
}

const zeroByLane = (): Record<RpcLane, number> => ({ send: 0, hot: 0, rest: 0, sched: 0 });

/** The error a request waiting for tokens rejects with when its job's signal fires. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("the RPC request was aborted while it waited for the budget");
}

/**
 * One process's bucket.
 *
 * FIFO WITHIN A LANE, ALWAYS: two requests of one lane are admitted in the order
 * they asked, so a lane's own sequence never changes; only how long each waits.
 * Across lanes, send first, then the weighted lanes by stride: each grant
 * advances its lane's pass by tokens / weight, and the waiting lane with the
 * lowest pass goes next. A lane that was idle rejoins at the current pass, so it
 * cannot bank a share it did not use and then burst.
 *
 * A REQUEST LARGER THAN THE BUCKET (a JSON-RPC batch of more calls than a
 * second's rate) is admitted when the bucket is full and leaves it in debt: the
 * requests after it wait the debt out. Refusing it would make a batch that
 * exceeds the burst impossible forever.
 */
export class RpcBudget {
  readonly defaultLane: RpcLane;
  readonly #usage: RpcUsageSink | undefined;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => () => void;
  #quota: number;
  #tokens: number;
  #refilledAt: number;
  /** The halving in force: the multiplier it set, and when its hold ends. Whole and long past at boot. */
  #cutTo = 1;
  #cutUntil = Number.NEGATIVE_INFINITY;
  #epoch = 0;
  readonly #queues: Record<RpcLane, Waiter[]> = { send: [], hot: [], rest: [], sched: [] };
  readonly #pass: Record<WeightedLane, number> = { hot: 0, sched: 0, rest: 0 };
  #virtual = 0;
  #cancelTimer: (() => void) | null = null;
  readonly #granted = zeroByLane();
  readonly #maxWait = zeroByLane();
  #http429 = 0;
  #cuts = 0;
  #stale429 = 0;
  #retryAfterHonoured = 0;
  #aborted = 0;

  constructor(options: RpcBudgetOptions) {
    if (!Number.isFinite(options.ratePerSecond) || options.ratePerSecond <= 0) {
      throw new Error("an RPC budget needs a positive, finite number of requests a second");
    }
    this.defaultLane = options.defaultLane;
    this.#usage = options.usage;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        return () => clearTimeout(handle);
      });
    this.#quota = options.ratePerSecond;
    this.#refilledAt = this.#now();
    // FULL AT BOOT: a second's burst, as a process that had been idle would hold.
    this.#tokens = this.#capacityAt(this.#refilledAt);
  }

  /** The multiplier on the quota at instant `t`: the halving while it holds, then a tenth more per step, to 1. */
  #multiplierAt(t: number): number {
    if (this.#cutTo >= 1) return 1;
    if (t < this.#cutUntil) return this.#cutTo;
    const steps = Math.floor((t - this.#cutUntil) / RATE_RECOVERY_STEP_MS) + 1;
    return Math.min(1, this.#cutTo + steps * RATE_RECOVERY_STEP);
  }

  /** The next instant after `t` at which the multiplier changes, or Infinity once it is whole. */
  #nextChangeAfter(t: number): number {
    if (this.#multiplierAt(t) >= 1) return Number.POSITIVE_INFINITY;
    if (t < this.#cutUntil) return this.#cutUntil;
    return this.#cutUntil + (Math.floor((t - this.#cutUntil) / RATE_RECOVERY_STEP_MS) + 1) * RATE_RECOVERY_STEP_MS;
  }

  #rateAt(t: number): number {
    return this.#quota * this.#multiplierAt(t);
  }

  #capacityAt(t: number): number {
    return Math.max(1, this.#rateAt(t) * BURST_SECONDS);
  }

  /** Tokens earned between two instants, integrated across every step of the recovery between them. */
  #earned(from: number, to: number): number {
    let total = 0;
    let t = from;
    while (t < to) {
      const end = Math.min(to, this.#nextChangeAfter(t));
      total += ((end - t) / 1_000) * this.#rateAt(t);
      t = end;
    }
    return total;
  }

  #refill(now: number): void {
    if (now > this.#refilledAt) {
      this.#tokens = Math.min(this.#capacityAt(now), this.#tokens + this.#earned(this.#refilledAt, now));
      this.#refilledAt = now;
    }
  }

  #quietly(report: (sink: RpcUsageSink) => void): void {
    if (this.#usage === undefined) return;
    try {
      report(this.#usage);
    } catch {
      // A lost count is a gap in rpc_usage; a thrown one could be a lost send.
    }
  }

  /**
   * Waits for the tokens of one request and resolves to its permit.
   *
   * THE LANE: the async context's (withRpcLane), or this process's default —
   * except that a body carrying sendTransaction always waits in `send`. THE
   * TOKENS: one per JSON-RPC call, a batch counted per item as rpc-usage.ts
   * counts it. `first` is false for the pool's further attempts at one request
   * (another endpoint, or the same one after a Retry-After): they take tokens —
   * each is a request the provider sees — but rpc_usage counts what was ASKED,
   * once.
   */
  admit(body: unknown, options: { readonly first?: boolean } = {}): Promise<RpcPermit> {
    const calls = jsonRpcCalls(body);
    const context = rpcContext.getStore();
    const lane: RpcLane = calls.some((call) => SEND_LANE_METHODS.has(call.method)) ? "send" : (context?.lane ?? this.defaultLane);
    const tokens = Math.max(1, calls.length);
    const line = creditClassOf(calls[0]!.method, calls[0]!.params);
    if (options.first !== false) {
      const now = this.#now();
      const byLine = new Map<CreditClass, number>();
      for (const call of calls) {
        const which = creditClassOf(call.method, call.params);
        byLine.set(which, (byLine.get(which) ?? 0) + 1);
      }
      this.#quietly((sink) => {
        for (const [which, n] of byLine) sink.asked(lane, which, n, now);
      });
    }
    return this.acquire(lane, tokens, line, context?.signal);
  }

  /** The bucket itself: `tokens` on `lane`, resolved when they are granted. admit() is the pool's way in. */
  acquire(lane: RpcLane, tokens: number, line: CreditClass = "standard", signal?: AbortSignal): Promise<RpcPermit> {
    if (signal?.aborted === true) {
      this.#aborted += 1;
      return Promise.reject(abortReason(signal));
    }
    const now = this.#now();
    this.#refill(now);
    // THE FAST PATH: nothing it must yield to is waiting, and the tokens are here.
    const ahead = lane === "send" ? this.#queues.send.length > 0 : RPC_LANES.some((l) => this.#queues[l].length > 0);
    if (!ahead && this.#tokens + EPSILON >= Math.min(tokens, this.#capacityAt(now))) {
      // Every queue is empty here, so a weighted lane rejoins at the current pass as a queued one would.
      if (lane !== "send") this.#pass[lane] = Math.max(this.#pass[lane], this.#virtual);
      return Promise.resolve(this.#grant(lane, tokens, line, now, now));
    }
    return new Promise<RpcPermit>((resolve, reject) => {
      const waiter: Waiter = { lane, tokens, line, since: now, signal, resolve, reject, onAbort: null };
      if (lane !== "send" && this.#queues[lane].length === 0) {
        // REJOINING AT THE CURRENT PASS: an idle lane banks nothing.
        this.#pass[lane] = Math.max(this.#pass[lane], this.#virtual);
      }
      this.#queues[lane].push(waiter);
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const queue = this.#queues[lane];
          const at = queue.indexOf(waiter);
          if (at < 0) return;
          queue.splice(at, 1);
          this.#aborted += 1;
          reject(abortReason(signal));
          this.#pump();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#pump();
    });
  }

  #grant(lane: RpcLane, tokens: number, line: CreditClass, since: number, now: number): RpcPermit {
    this.#tokens -= tokens;
    this.#granted[lane] += 1;
    const waitedMs = Math.max(0, now - since);
    if (waitedMs > this.#maxWait[lane]) this.#maxWait[lane] = waitedMs;
    if (lane !== "send") {
      this.#virtual = this.#pass[lane];
      this.#pass[lane] += tokens / LANE_WEIGHTS[lane];
    }
    return { lane, tokens, epoch: this.#epoch, line, waitedMs };
  }

  /** The waiter that goes next: the head of `send`, else the weighted head with the lowest pass. */
  #next(): Waiter | undefined {
    const send = this.#queues.send[0];
    if (send !== undefined) return send;
    let best: WeightedLane | null = null;
    for (const lane of WEIGHTED_ORDER) {
      if (this.#queues[lane].length === 0) continue;
      if (best === null || this.#pass[lane] < this.#pass[best] - EPSILON) best = lane;
    }
    return best === null ? undefined : this.#queues[best][0];
  }

  /** Grants every waiter the bucket can cover now, in order, then sleeps until the next one can be. */
  #pump(): void {
    if (this.#cancelTimer !== null) {
      this.#cancelTimer();
      this.#cancelTimer = null;
    }
    for (;;) {
      const waiter = this.#next();
      if (waiter === undefined) return;
      const now = this.#now();
      this.#refill(now);
      const need = Math.min(waiter.tokens, this.#capacityAt(now));
      if (this.#tokens + EPSILON >= need) {
        this.#queues[waiter.lane].shift();
        if (waiter.signal !== undefined && waiter.onAbort !== null) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.#grant(waiter.lane, waiter.tokens, waiter.line, waiter.since, now));
        continue;
      }
      // UNTIL THE TOKENS ARE THERE AT TODAY'S RATE, OR THE RATE NEXT CHANGES —
      // whichever is first; the wake re-reads both.
      const deficitMs = Math.ceil(((need - this.#tokens) / this.#rateAt(now)) * 1_000);
      const change = this.#nextChangeAfter(now) - now;
      const wait = Math.max(1, Math.min(deficitMs, change));
      this.#cancelTimer = this.#setTimer(() => {
        this.#cancelTimer = null;
        this.#pump();
      }, wait);
      return;
    }
  }

  /**
   * How one attempt under `permit` ended. A 429 halves the rate — unless the
   * permit predates the last halving — empties the bucket, and holds for 30 s.
   */
  answered(permit: RpcPermit, result: number | "unreachable"): void {
    const now = this.#now();
    this.#quietly((sink) => sink.ended(permit.lane, permit.line, result, now));
    if (result !== 429) return;
    this.#http429 += 1;
    if (permit.epoch < this.#epoch) {
      this.#stale429 += 1;
      return;
    }
    this.#refill(now);
    this.#epoch += 1;
    this.#cuts += 1;
    this.#cutTo = Math.max(MIN_RATE_MULTIPLIER, this.#multiplierAt(now) / 2);
    this.#cutUntil = now + RATE_CUT_HOLD_MS;
    // EMPTIED, NOT ONLY CLAMPED: the provider has just refused, and what was left
    // of the last second's burst would go out at the rate it refused.
    this.#tokens = Math.min(this.#tokens, 0);
    this.#pump();
  }

  /** Waits out a `Retry-After` the pool chose to honour, on this budget's timer; a job's signal ends the wait. */
  pause(ms: number, signal?: AbortSignal): Promise<void> {
    this.#retryAfterHonoured += 1;
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        cancel();
        reject(abortReason(signal!));
      };
      const cancel = this.#setTimer(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * A new quota, from this process's worker row (QuotaFollower). Tokens earned
   * so far are earned at the old rate; the new one applies from now. A value
   * that is not a positive finite number is refused and changes nothing.
   */
  setQuota(ratePerSecond: number): boolean {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return false;
    const now = this.#now();
    this.#refill(now);
    this.#quota = ratePerSecond;
    this.#tokens = Math.min(this.#tokens, this.#capacityAt(now));
    this.#pump();
    return true;
  }

  get quotaPerSecond(): number {
    return this.#quota;
  }

  status(): RpcBudgetStatus {
    const now = this.#now();
    this.#refill(now);
    const waiting = zeroByLane();
    for (const lane of RPC_LANES) waiting[lane] = this.#queues[lane].length;
    return {
      quotaPerSecond: this.#quota,
      ratePerSecond: this.#rateAt(now),
      multiplier: this.#multiplierAt(now),
      cutHeldUntil: now < this.#cutUntil ? new Date(this.#cutUntil).toISOString() : null,
      tokens: Math.round(this.#tokens * 1_000) / 1_000,
      capacity: this.#capacityAt(now),
      waiting,
      granted: { ...this.#granted },
      maxWaitMs: { ...this.#maxWait },
      http429: this.#http429,
      cuts: this.#cuts,
      stale429: this.#stale429,
      retryAfterHonoured: this.#retryAfterHonoured,
      aborted: this.#aborted,
    };
  }
}
