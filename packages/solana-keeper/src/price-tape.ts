// THE PER-TRADE PRICE TAPE (dispatcher ADR §5.2.3; plan §3.4, §7 row 11): Pyth's
// SOL/USD price, sampled once per scheduler tick into sip_solana.sol_price_tape,
// so a ROUND-UP trade is valued at the price of its own minute rather than at
// whatever SOL is worth when the keeper gets round to collecting.
//
// WHY A TAPE. Rounding is discontinuous: a $1.99 trade valued after a +1 % move
// is a $2.01 trade, and saves $0.99 instead of $0.01. Valued at a sample within
// about a minute of the trade, the error per trade shrinks from up to an hour of
// SOL's movement to about a minute of it (ADR §5.2.3, INFERRED √60 ≈ 8×).
//
// SAMPLING (the lock-holding scheduler, src/scheduler.ts): the SOL/USD
// PriceUpdateV2 rides in the tick's first request (src/scheduler-chain.ts, 0
// extra calls) and is kept only under the rules the invest guard already prices
// SOL by — the Pyth receiver's account, the SOL/USD feed id, published within
// MAX_PYTH_AGE_SECONDS of the scheduler's clock and inside MAX_PYTH_CONF_BPS of
// its own price (test/price-tape.test.ts pins both to invest-decision.ts's). One
// row per distinct publish; a tick that reads the same publish twice writes
// nothing new. Kept TAPE_RETENTION_DAYS.
//
// LOOKUP (a settle turn, src/settle-modules.ts): the NEWEST sample published at
// or before the trade's block time and no more than TAPE_LOOKUP_SECONDS before
// it; failing that, the OLDEST one after it within the same window. No sample
// within ±TAPE_LOOKUP_SECONDS — a trade older than the tape, or one made while no
// scheduler was sampling — is priced LATE, at the settle-time Pyth read, and
// counted as such everywhere it is reported.
//
// NON-SECRET MARKET DATA, AND OPERATIONAL: losing the table costs late prices for
// the trades it would have priced, never a key or a carry.

import type { PublicKey } from "@solana/web3.js";
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_FEED_ID_HEX, PythPriceError, decodePythPriceUpdate, type PythPriceUpdate } from "./pyth.js";

/** How far from a trade's block time a sample may sit, either side: 120 s (ADR §5.2.3). */
export const TAPE_LOOKUP_SECONDS = 120;
/** A sample is kept only when published within this many seconds of the sampler's clock (invest-decision.ts's MAX_PYTH_AGE_SECONDS). */
export const TAPE_MAX_AGE_SECONDS = 60;
/** …and with a confidence interval within this many bps of its own price (invest-decision.ts's MAX_PYTH_CONF_BPS). */
export const TAPE_MAX_CONF_BPS = 50n;
/** How long a sample is kept: 35 days, as rpc_usage (ADR §5.2.3: ≈ 1 440 rows a day). */
export const TAPE_RETENTION_DAYS = 35;
/** The most samples a sampler holds while Postgres will not take them; the oldest go first. */
export const TAPE_PENDING_MAX = 120;

/** One sample: the publish it came from, in micro-dollars per SOL. */
export interface TapeSample {
  /** Pyth's publish_time, unix seconds: the tape's key. */
  readonly publishTime: number;
  /** The slot the sampler read it at (the batch's context slot). */
  readonly slot: bigint;
  /** price × 10^(expo + 6), floored: micro-dollars per SOL, the unit settle_v3 signs. */
  readonly priceE6: bigint;
  readonly confE6: bigint;
}

/** A feed value in Pyth's own expo, as micro-dollars, floored (a non-positive price is the caller's to refuse). */
export function toUsdE6(value: bigint, expo: number): bigint {
  const shift = expo + 6;
  return shift >= 0 ? value * 10n ** BigInt(shift) : value / 10n ** BigInt(-shift);
}

/** Why the sampler did not keep a read. */
export type TapeRejection = "missing" | "wrong-owner" | "undecodable" | "not-a-price" | "stale" | "wide";

/**
 * The tape's sample from the SOL/USD account as the tick read it, or why it is
 * not kept. Owner, size and feed are checked here because the read is the only
 * place that knows the account's owner (pyth.ts says the same of its callers).
 */
export function sampleSolUsd(
  info: { readonly owner: PublicKey; readonly data: Uint8Array } | null,
  nowSeconds: number,
  slot: bigint,
): { readonly sample: TapeSample } | { readonly rejected: TapeRejection; readonly detail: string } {
  if (info === null) return { rejected: "missing", detail: "the SOL/USD price account was not in the read" };
  if (!info.owner.equals(PYTH_RECEIVER_PROGRAM)) return { rejected: "wrong-owner", detail: `the SOL/USD price account is owned by ${info.owner.toBase58()}, not the Pyth receiver` };
  let update: PythPriceUpdate;
  try {
    update = decodePythPriceUpdate(info.data, PYTH_SOL_USD_FEED_ID_HEX);
  } catch (error) {
    return { rejected: "undecodable", detail: error instanceof PythPriceError ? error.message : String(error) };
  }
  if (update.price <= 0n || update.expo < -18 || update.expo > 18) return { rejected: "not-a-price", detail: `the feed quotes ${update.price} at expo ${update.expo}` };
  const age = nowSeconds - Number(update.publishTime);
  // A NEGATIVE AGE IS KEPT: a publish ahead of this clock is fresher than the clock can tell (invest-decision.ts).
  if (age > TAPE_MAX_AGE_SECONDS) return { rejected: "stale", detail: `published ${age} s before the sampler's clock, past ${TAPE_MAX_AGE_SECONDS} s` };
  if (update.conf * 10_000n > TAPE_MAX_CONF_BPS * update.price) {
    return { rejected: "wide", detail: `its confidence interval is ${(update.conf * 10_000n) / update.price} bps of its price, past ${TAPE_MAX_CONF_BPS}` };
  }
  return { sample: { publishTime: Number(update.publishTime), slot, priceE6: toUsdE6(update.price, update.expo), confE6: toUsdE6(update.conf, update.expo) } };
}

/**
 * THE LOOKUP RULE, over samples in any order: the newest at or before `at` within
 * TAPE_LOOKUP_SECONDS, else the oldest after it within the same window, else null.
 * PgPriceTape's SQL answers the same; test/price-tape.test.ts holds the two equal.
 */
export function pickSample(samples: Iterable<TapeSample>, at: number): TapeSample | null {
  let before: TapeSample | null = null;
  let after: TapeSample | null = null;
  for (const sample of samples) {
    if (sample.publishTime <= at && sample.publishTime >= at - TAPE_LOOKUP_SECONDS) {
      if (before === null || sample.publishTime > before.publishTime) before = sample;
    } else if (sample.publishTime > at && sample.publishTime <= at + TAPE_LOOKUP_SECONDS) {
      if (after === null || sample.publishTime < after.publishTime) after = sample;
    }
  }
  return before ?? after;
}

/** What a settle turn asks of the tape: one answer per block time, in one request. */
export interface PriceTapeReader {
  /** The sample pickSample would choose for each time, by that time; null where none is within the window. Throws when it cannot read. */
  pricesAt(times: readonly number[]): Promise<ReadonlyMap<number, TapeSample | null>>;
}

/** What the sampler writes. */
export interface PriceTapeWriter {
  /** One sample; a publish already on the tape is left as it is. */
  record(sample: TapeSample): Promise<void>;
  /** Drops samples published before `beforeSeconds`; how many went. */
  prune(beforeSeconds: number): Promise<number>;
}

/** The tape in memory: tests, and a process with no database. */
export class MemoryPriceTape implements PriceTapeReader, PriceTapeWriter {
  readonly #samples = new Map<number, TapeSample>();

  get size(): number {
    return this.#samples.size;
  }

  async record(sample: TapeSample): Promise<void> {
    if (!this.#samples.has(sample.publishTime)) this.#samples.set(sample.publishTime, sample);
  }

  async prune(beforeSeconds: number): Promise<number> {
    let gone = 0;
    for (const at of [...this.#samples.keys()]) {
      if (at < beforeSeconds) {
        this.#samples.delete(at);
        gone += 1;
      }
    }
    return gone;
  }

  async pricesAt(times: readonly number[]): Promise<ReadonlyMap<number, TapeSample | null>> {
    const out = new Map<number, TapeSample | null>();
    for (const at of times) out.set(at, pickSample(this.#samples.values(), at));
    return out;
  }
}

export const TAPE_RECORD_SQL = `
  INSERT INTO sip_solana.sol_price_tape (publish_time, slot, price_e6, conf_e6)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (publish_time) DO NOTHING`;

export const TAPE_PRUNE_SQL = `DELETE FROM sip_solana.sol_price_tape WHERE publish_time < $1`;

/**
 * pickSample in SQL, for every time at once: two index probes per time on the
 * primary key, one statement per settle decision (ADR §5.2.3's "one indexed
 * SELECT").
 */
export const TAPE_LOOKUP_SQL = `
  SELECT t.at::bigint AS at,
         b.publish_time AS b_time, b.slot AS b_slot, b.price_e6 AS b_price, b.conf_e6 AS b_conf,
         a.publish_time AS a_time, a.slot AS a_slot, a.price_e6 AS a_price, a.conf_e6 AS a_conf
    FROM unnest($1::bigint[]) AS t(at)
    LEFT JOIN LATERAL (
      SELECT publish_time, slot, price_e6, conf_e6 FROM sip_solana.sol_price_tape
       WHERE publish_time <= t.at AND publish_time >= t.at - $2
       ORDER BY publish_time DESC LIMIT 1) b ON true
    LEFT JOIN LATERAL (
      SELECT publish_time, slot, price_e6, conf_e6 FROM sip_solana.sol_price_tape
       WHERE publish_time > t.at AND publish_time <= t.at + $2
       ORDER BY publish_time ASC LIMIT 1) a ON true`;

const sampleOf = (row: Readonly<Record<string, unknown>>, side: "b" | "a"): TapeSample | null => {
  const time = row[`${side}_time`];
  if (time === null || time === undefined) return null;
  return {
    publishTime: Number(time),
    slot: BigInt(String(row[`${side}_slot`])),
    priceE6: BigInt(String(row[`${side}_price`])),
    confE6: BigInt(String(row[`${side}_conf`])),
  };
};

/**
 * A pool as this file uses one: pg's Pool, or the dispatcher's DispatchPool. Its
 * own shape rather than an import, so the tape reaches nothing of the dispatch
 * store (test/dispatch-store.test.ts keeps that store to the dispatcher's files).
 */
export interface TapePool {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
    release(destroy?: boolean): void;
  }>;
}

/** The tape in sip_solana.sol_price_tape. */
export class PgPriceTape implements PriceTapeReader, PriceTapeWriter {
  constructor(private readonly pool: TapePool) {}

  async record(sample: TapeSample): Promise<void> {
    await this.#query(TAPE_RECORD_SQL, [sample.publishTime, sample.slot.toString(), sample.priceE6.toString(), sample.confE6.toString()]);
  }

  async prune(beforeSeconds: number): Promise<number> {
    const rows = await this.#query(`${TAPE_PRUNE_SQL} RETURNING publish_time`, [beforeSeconds]);
    return rows.length;
  }

  async pricesAt(times: readonly number[]): Promise<ReadonlyMap<number, TapeSample | null>> {
    const out = new Map<number, TapeSample | null>();
    const unique = [...new Set(times)];
    if (unique.length === 0) return out;
    for (const at of unique) {
      if (!Number.isSafeInteger(at)) throw new RangeError(`a block time is a whole number of seconds, not ${at}`);
    }
    const rows = await this.#query(TAPE_LOOKUP_SQL, [unique.map(String), TAPE_LOOKUP_SECONDS]);
    for (const row of rows) out.set(Number(row["at"]), sampleOf(row, "b") ?? sampleOf(row, "a"));
    for (const at of unique) if (!out.has(at)) out.set(at, null);
    return out;
  }

  async #query(text: string, values: unknown[]): Promise<readonly Record<string, unknown>[]> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      return (await client.query(text, values)).rows;
    } catch (error) {
      destroy = true;
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}

/** What the sampler has done since boot, for /status (additive) and the log. */
export interface TapeSamplerStatus {
  readonly sampled: number;
  readonly written: number;
  readonly repeated: number;
  readonly rejected: Readonly<Partial<Record<TapeRejection, number>>>;
  /** Samples held in memory because Postgres would not take them yet. */
  readonly pending: number;
  readonly writeFailures: number;
  readonly lastPublishTime: number | null;
  readonly lastRejection: string | null;
}

/**
 * The scheduler's half: one read a tick, kept or rejected, written through. A
 * write Postgres refuses is held in memory (up to TAPE_PENDING_MAX, oldest
 * dropped first) and offered again on the next tick, so a short database outage
 * leaves no hole the trades of that minute would be priced late for.
 */
export class TapeSampler {
  readonly #writer: PriceTapeWriter;
  readonly #pending: TapeSample[] = [];
  #lastPublish: number | null = null;
  #sampled = 0;
  #written = 0;
  #repeated = 0;
  #writeFailures = 0;
  #lastRejection: string | null = null;
  readonly #rejected: Partial<Record<TapeRejection, number>> = {};
  #lastPrune = Number.NEGATIVE_INFINITY;

  constructor(writer: PriceTapeWriter) {
    this.#writer = writer;
  }

  /**
   * One tick's read. Never throws: a sample the tape cannot take now is held, and
   * a read it will not keep is counted by why. Returns what it did, for the log.
   */
  async sample(
    info: { readonly owner: PublicKey; readonly data: Uint8Array } | null,
    nowSeconds: number,
    slot: bigint,
  ): Promise<{ readonly kind: "written" | "repeated" | "held" } | { readonly kind: "rejected"; readonly reason: TapeRejection; readonly detail: string }> {
    this.#sampled += 1;
    const read = sampleSolUsd(info, nowSeconds, slot);
    if ("rejected" in read) {
      this.#rejected[read.rejected] = (this.#rejected[read.rejected] ?? 0) + 1;
      this.#lastRejection = `${read.rejected}: ${read.detail}`;
      return { kind: "rejected", reason: read.rejected, detail: read.detail };
    }
    const { sample } = read;
    const repeated = this.#lastPublish !== null && sample.publishTime === this.#lastPublish;
    this.#lastPublish = sample.publishTime;
    if (repeated && this.#pending.length === 0) {
      this.#repeated += 1;
      return { kind: "repeated" };
    }
    if (!repeated) this.#pending.push(sample);
    while (this.#pending.length > TAPE_PENDING_MAX) this.#pending.shift();
    while (this.#pending.length > 0) {
      try {
        await this.#writer.record(this.#pending[0]!);
      } catch {
        this.#writeFailures += 1;
        return { kind: "held" };
      }
      this.#pending.shift();
      this.#written += 1;
    }
    return { kind: repeated ? "repeated" : "written" };
  }

  /** The retention, at most hourly: how many samples went, or null when it did not run or failed. */
  async prune(nowSeconds: number): Promise<number | null> {
    if (nowSeconds - this.#lastPrune < 3_600) return null;
    this.#lastPrune = nowSeconds;
    try {
      return await this.#writer.prune(nowSeconds - TAPE_RETENTION_DAYS * 86_400);
    } catch {
      return null;
    }
  }

  status(): TapeSamplerStatus {
    return {
      sampled: this.#sampled,
      written: this.#written,
      repeated: this.#repeated,
      rejected: { ...this.#rejected },
      pending: this.#pending.length,
      writeFailures: this.#writeFailures,
      lastPublishTime: this.#lastPublish,
      lastRejection: this.#lastRejection,
    };
  }
}

/** The tape's columns, as sql/sip_solana.sql declares them. */
export const TAPE_COLUMNS = ["publish_time", "slot", "price_e6", "conf_e6", "sampled_at"] as const;

/**
 * The `sol_price_tape.column` names this database lacks: a scheduler that samples
 * the tape, or a worker that prices round-up trades from it, refuses to start by
 * name rather than fail every tick or every turn on a missing table.
 */
export async function missingTapeColumns(db: { query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }> }): Promise<string[]> {
  const result = await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'sip_solana' AND table_name = 'sol_price_tape'",
  );
  const have = new Set(result.rows.map((row) => String(row["column_name"])));
  return TAPE_COLUMNS.filter((column) => !have.has(column)).map((column) => `sol_price_tape.${column}`);
}
