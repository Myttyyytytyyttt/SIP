// The journal, backed by Postgres instead of a local file.
//
// WHY. On Railway a container's filesystem does not survive a redeploy, and the
// records lost that way include unresolved INTENT rows — precisely the ones the
// startup recovery needs in order to resolve a settlement that was in flight
// when the process died. A volume fixes durability but pins the service to a
// single instance forever, because a Railway volume has one writer.
//
// TWO DECISIONS THAT SHAPE EVERYTHING BELOW.
//
// ONE SCHEMA PER ACCOUNT. The SQLite store is one FILE per account and its
// `instance` table carries CHECK (id = 1), so a store structurally cannot come
// to describe two deployments. A shared table with an account column would throw
// that away and make a missed WHERE clause into a cross-account write. A schema
// per account keeps the invariant exactly and costs nothing: Postgres schemas
// are free.
//
// STATE STAYS SYNCHRONOUS, WRITES BECOME ASYNCHRONOUS. `ledger.state` is read at
// 47 call sites, usually as a property deep inside a decision. Making those
// async would ripple through every one of them, on the money path, for no gain —
// the state was already an in-memory projection. So the records are loaded once
// at open() and the projection is maintained in memory, while `append` awaits
// its write. That await is the durability guarantee: when it resolves, the
// record is in Postgres, and only then does the keeper act on it.
//
// WHAT IS NOT PORTED, AND WHY THAT IS NOT A LOSS. The SQLite store carries a
// large amount of machinery for detecting a corrupt FILE: PRAGMA quick_check,
// zero-byte files, truncated headers, orphaned -wal siblings. All of it exists
// because SQLite is a file this process opens, and a file can be found
// half-written. Postgres owns its storage, so that entire class of failure is
// gone. What IS kept is the hash-chain integrity check, because it detects
// something Postgres cannot: a row edited out of band by someone with database
// access.

import { createHash } from "node:crypto";
import pg from "pg";

import { postgresDdl } from "./ledger-pg-schema.js";
import type { LedgerInstance } from "./ledger.js";

/** Postgres identifiers cap at 63 bytes; chain + account fits in 53. */
export function schemaNameFor(chainId: number, account: string): string {
  return `nuvem_${chainId}_${account.toLowerCase().replace(/^0x/, "")}`;
}

/**
 * A 64-bit key for pg_advisory_lock, derived from the schema name.
 *
 * The lock is SESSION scoped, which is the property that matters: it is released
 * when the connection drops, so a keeper that is killed — or a container that
 * vanishes — frees its own lock without anyone reclaiming a stale pid file. That
 * is strictly better than the file lock it replaces, and it is what makes more
 * than one instance possible later.
 */
export function advisoryKeyFor(schema: string): bigint {
  const digest = createHash("sha256").update(schema).digest();
  // Signed 64-bit, which is what pg_advisory_lock takes.
  return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

/**
 * How this process will appear to whoever later finds it holding a lock.
 *
 * WITHOUT THIS, "another instance has it" is a dead end. A live deployment sat
 * with held: 0 and heldByOtherInstances: 1 and there was no way to tell, from
 * either the logs or the database, whether the holder was a healthy sibling
 * replica or a stale dry-run container that had never been torn down. Those two
 * need opposite responses, and one of them means nothing is settling at all.
 *
 * THE MODE GOES FIRST because it is the part that changes the answer. A dry-run
 * instance holding the lock while an armed one waits is a system that looks
 * healthy and settles nothing — the failure this whole codebase is arranged to
 * make impossible to miss.
 *
 * Postgres truncates application_name at 63 bytes SILENTLY, so it is capped
 * here instead: losing the tail to the server would eat the identifiers, which
 * is the half that says which container.
 */
export function keeperApplicationName(options: {
  readonly broadcast: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): string {
  const env = options.env ?? process.env;
  const short = (value: string | undefined): string | undefined =>
    value === undefined || value === "" ? undefined : value.slice(0, 8);

  const parts = [`nuvem-keeper`, options.broadcast ? "live" : "dry-run"];
  const deployment = short(env.RAILWAY_DEPLOYMENT_ID ?? env.NUVEM_KEEPER_DEPLOYMENT_ID);
  const replica = short(env.RAILWAY_REPLICA_ID ?? env.NUVEM_KEEPER_REPLICA_ID);
  if (deployment !== undefined) parts.push(`d:${deployment}`);
  if (replica !== undefined) parts.push(`r:${replica}`);
  return parts.join(" ").slice(0, 63);
}

/**
 * TLS for a journal connection: relaxed by default, off only when asked.
 *
 * THE DEFAULT IS THE POINT. Supabase and most managed providers terminate TLS at
 * a proxy whose chain Node does not carry, so the chain check is relaxed — the
 * connection is still encrypted. Anything that is not an explicit `sslmode=disable`
 * gets that treatment, including a malformed string, because the failure mode of
 * guessing wrong has to be "refuses to connect", never "connects in plaintext".
 *
 * `sslmode=disable` is honoured because without it the durable journal cannot be
 * exercised against a plain Postgres — not locally and not in CI. The advisory
 * lock is the property that stops two keepers settling for one user, and a
 * property that can only be tested against production infrastructure is a
 * property that stops being tested.
 *
 * It is safe to honour because it is not reachable by accident: no managed
 * provider hands out a URL containing it, so it only appears where somebody
 * typed it.
 */
export function sslOptionsFor(connectionString: string): { rejectUnauthorized: false } | false {
  const relaxed = { rejectUnauthorized: false } as const;
  let mode: string | null;
  try {
    mode = new URL(connectionString).searchParams.get("sslmode");
  } catch {
    // Unparseable, so nothing was explicitly disabled. Encrypt.
    return relaxed;
  }
  return mode?.toLowerCase() === "disable" ? false : relaxed;
}

/** Who holds a lock, when nobody expected anyone to. */
export interface LockHolder {
  readonly applicationName: string | null;
  /** When that connection opened. An hours-old holder is not a rolling deploy. */
  readonly since: string | null;
  readonly state: string | null;
}

/**
 * What the lock's holder actually is.
 *
 * THE CASE THAT WAS MISSING IS `NOT_A_KEEPER`, and its absence is what turned an
 * outage into silence. The first version of this check asked only "does the name
 * contain dry-run?", and cleared the alert on every other answer. Through
 * Supavisor the answer is always the literal "Supavisor" — the pooler overwrites
 * application_name and does not forward the client's (supavisor#343, open since
 * 2024) — so for four consecutive sweeps the supervisor took the branch that
 * ACTIVELY CLEARED the only alert that could have fired, while the account was
 * held by an orphaned pooled backend and nothing was being settled.
 *
 * So the default is now suspicion. Anything this code cannot positively identify
 * as one of its own keepers is reported, because a lock held by something that
 * is not a keeper is either a leaked backend or a stranger, and both mean the
 * user's account is going unserved.
 */
export type HolderVerdict =
  /** A Nuvem keeper. `armed` says whether it can actually broadcast. */
  | { readonly kind: "KEEPER"; readonly armed: boolean }
  /** A pooler backend, an unnamed connection, or something else entirely. */
  | { readonly kind: "NOT_A_KEEPER"; readonly name: string };

export function classifyLockHolder(holder: LockHolder | undefined): HolderVerdict {
  const name = holder?.applicationName ?? null;
  if (name === null) return { kind: "NOT_A_KEEPER", name: "an unnamed connection" };
  if (!name.startsWith("nuvem-keeper ")) return { kind: "NOT_A_KEEPER", name };
  // Positive identification only: a keeper name that says neither is a keeper
  // whose mode we cannot read, and guessing "armed" would suppress the alarm.
  if (name.includes(" live")) return { kind: "KEEPER", armed: true };
  return { kind: "KEEPER", armed: false };
}

export class LedgerBusyError extends Error {
  constructor(
    readonly schema: string,
    readonly holder?: LockHolder,
  ) {
    super(
      `Another keeper already holds the advisory lock for ${schema}. Two keepers on one ` +
        "account would both form intents against the same frontier, and the chain would " +
        "refuse the second — wasted gas, not a double settlement, but still wrong." +
        (holder === undefined
          ? ""
          : ` It is held by ${holder.applicationName ?? "a connection that did not name itself"}` +
            (holder.since === null ? "" : `, open since ${holder.since}`) +
            "."),
    );
    this.name = "LedgerBusyError";
  }
}

/**
 * Asks Postgres who holds the lock. Best effort, and never fatal.
 *
 * A single bigint advisory key is stored split across two oid columns: the high
 * 32 bits in classid, the low 32 in objid, with objsubid 1 marking it as the
 * one-argument form.
 *
 * A failure here must not become the error the caller sees. Some managed
 * providers restrict pg_stat_activity, and "could not identify the holder" is
 * strictly less useful than "the lock is held" — not a reason to lose it.
 */
async function findLockHolder(client: pg.Client, key: bigint): Promise<LockHolder | undefined> {
  const classid = Number(BigInt.asUintN(64, key) >> 32n);
  const objid = Number(BigInt.asUintN(64, key) & 0xffff_ffffn);
  try {
    const found = await client.query<{
      application_name: string | null;
      backend_start: Date | null;
      state: string | null;
    }>(
      `SELECT a.application_name, a.backend_start, a.state
         FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2
          AND l.objsubid = 1 AND l.granted
        LIMIT 1`,
      [classid, objid],
    );
    const row = found.rows[0];
    if (row === undefined) return undefined;
    return {
      applicationName: row.application_name === "" ? null : row.application_name,
      since: row.backend_start === null ? null : row.backend_start.toISOString(),
      state: row.state,
    };
  } catch {
    return undefined;
  }
}

/**
 * The journal's connection died under it.
 *
 * DISTINCT FROM AN ORDINARY QUERY FAILURE, because the response is different: a
 * failed query is retried, whereas a dead connection means this journal can
 * never write again AND that its advisory lock is gone — so the account has to
 * be dropped and re-claimed rather than kept.
 */
export class JournalConnectionLostError extends Error {
  constructor(
    readonly schema: string,
    readonly cause: string,
  ) {
    super(
      `The Postgres connection for ${schema} was lost (${cause}). This journal cannot write ` +
        "again and no longer holds its advisory lock, so the account must be released and " +
        "claimed afresh.",
    );
    this.name = "JournalConnectionLostError";
  }
}

export class LedgerIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIdentityMismatchError";
  }
}

export interface PostgresLedgerOptions {
  readonly connectionString: string;
  readonly instance: LedgerInstance;
  /** Skip the advisory lock. Read-only commands only — never a keeper that writes. */
  readonly noLock?: boolean;
  /**
   * How this connection identifies itself in pg_stat_activity, so that a keeper
   * blocked on this lock can say who is holding it. See keeperApplicationName.
   */
  readonly applicationName?: string;
}

export interface StoredRecord {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly prevDigest: string;
  readonly digest: string;
  readonly body: Record<string, unknown>;
}

/**
 * The record stream in Postgres, with the same hash chain and the same identity
 * pin as the SQLite store.
 *
 * This class deliberately owns ONLY storage. The projection from records to
 * LedgerState lives in ledger.ts and is shared, so the two backends cannot drift
 * into disagreeing about what a given history means.
 */
export class PostgresJournal {
  readonly #client: pg.Client;
  readonly #schema: string;
  readonly #instance: LedgerInstance;
  #records: StoredRecord[] = [];
  #closed = false;
  /** Set by the connection's error handler. Non-null means this journal is dead. */
  #lost: string | null = null;

  private constructor(client: pg.Client, schema: string, instance: LedgerInstance) {
    this.#client = client;
    this.#schema = schema;
    this.#instance = instance;
  }

  static async open(options: PostgresLedgerOptions): Promise<PostgresJournal> {
    const schema = schemaNameFor(options.instance.chainId, options.instance.account);
    const client = new pg.Client({
      connectionString: options.connectionString,
      ssl: sslOptionsFor(options.connectionString),
      ...(options.applicationName === undefined
        ? {}
        : { application_name: options.applicationName }),
    });
    await client.connect();

    try {
      await client.query(postgresDdl(schema));
      await client.query(`SET search_path TO ${schema}`);

      if (options.noLock !== true) {
        // try_ rather than the blocking form: a keeper that cannot get the lock
        // must say so and exit, not hang forever looking healthy.
        const key = advisoryKeyFor(schema);
        const lock = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1) AS locked",
          [key.toString()],
        );
        if (lock.rows[0]?.locked !== true) {
          // Asked before throwing, on this same connection, because the answer
          // stops being available the moment it is closed.
          const holder = await findLockHolder(client, key);
          throw new LedgerBusyError(schema, holder);
        }
      }

      const journal = new PostgresJournal(client, schema, options.instance);

      // THIS LISTENER IS NOT OPTIONAL, IT IS LOAD-BEARING. pg.Client is an
      // EventEmitter, and an 'error' with no listener is an uncaught exception:
      // Node exits. Reproduced against a real Postgres — terminating this
      // backend killed the whole process, printing FATAL 57P01 and never
      // reaching the next line.
      //
      // In the single-account binary that was merely a crash. In the supervisor
      // every account shares one process, so ONE user's connection dropping took
      // down settlement for ALL of them — from a Supabase restart, a pooler
      // failover, or an operator clearing a stuck lock with pg_terminate_backend.
      //
      // Recorded rather than thrown: the throw would have nowhere to go from an
      // async event. The next write turns it into a real error, at a call site
      // that can respond.
      client.on("error", (error: Error) => {
        journal.#lost ??= error.message;
      });

      await journal.#pinIdentity();
      await journal.#load();
      return journal;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Writes the identity on first use, and refuses to proceed if it disagrees.
   *
   * The same rule as the SQLite store: a store belongs to one deployment. Here it
   * matters more, not less — a schema persists across redeploys, so a keeper
   * pointed at a new factory would otherwise append to the old deployment's
   * history and derive a frontier from settlements that no longer mean anything.
   */
  async #pinIdentity(): Promise<void> {
    const existing = await this.#client.query<{
      chain_id: string;
      factory: string;
      executor: string;
      vault: string;
      account: string;
      ledger_schema: string;
      engine_schema: string;
    }>("SELECT * FROM instance WHERE id = 1");

    const want = {
      chain_id: String(this.#instance.chainId),
      factory: this.#instance.factory.toLowerCase(),
      executor: this.#instance.executor.toLowerCase(),
      vault: this.#instance.vault.toLowerCase(),
      account: this.#instance.account.toLowerCase(),
      ledger_schema: this.#instance.ledgerSchema,
      engine_schema: this.#instance.engineSchema,
    };

    if (existing.rowCount === 0) {
      await this.#client.query(
        `INSERT INTO instance(id, chain_id, factory, executor, vault, account,
                              ledger_schema, engine_schema, created_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          want.chain_id,
          want.factory,
          want.executor,
          want.vault,
          want.account,
          want.ledger_schema,
          want.engine_schema,
          new Date().toISOString(),
        ],
      );
      return;
    }

    const found = existing.rows[0]!;
    const differences: string[] = [];
    for (const key of Object.keys(want) as (keyof typeof want)[]) {
      if (String(found[key]) !== want[key]) {
        differences.push(`${key}: ${String(found[key])} != ${want[key]}`);
      }
    }
    if (differences.length > 0) {
      throw new LedgerIdentityMismatchError(
        `Schema ${this.#schema} was created for a different deployment (${differences.join("; ")}). ` +
          "Refusing to start. Point at a fresh schema rather than mixing two deployments' history.",
      );
    }
  }

  /** Loads the whole record stream. The projection is built from this in memory. */
  async #load(): Promise<void> {
    const rows = await this.#client.query<{
      seq: string;
      ts: string;
      type: string;
      prev_digest: string;
      digest: string;
      body: string;
    }>("SELECT seq, ts, type, prev_digest, digest, body FROM record ORDER BY seq");

    this.#records = rows.rows.map((row) => ({
      seq: Number(row.seq),
      ts: row.ts,
      type: row.type,
      prevDigest: row.prev_digest,
      digest: row.digest,
      body: JSON.parse(row.body) as Record<string, unknown>,
    }));
  }

  get records(): readonly StoredRecord[] {
    return this.#records;
  }

  get schema(): string {
    return this.#schema;
  }

  /** Digest of the last record: a stable summary of the whole history. */
  get head(): string {
    return this.#records.at(-1)?.digest ?? GENESIS_DIGEST;
  }

  get seq(): number {
    return this.#records.length - 1;
  }

  /**
   * Appends one record, awaiting its durability before returning.
   *
   * The await is the whole point: when this resolves the record is in Postgres,
   * and only then may the keeper act on it. An append that returned before the
   * write landed would reintroduce exactly the failure this backend exists to
   * prevent — an intent formed, a transaction broadcast, and no record of either.
   */
  async append(type: string, body: Record<string, unknown>): Promise<StoredRecord> {
    if (this.#closed) throw new Error("append on a closed journal");
    this.#refuseIfLost();

    const seq = this.#records.length;
    const prevDigest = this.head;
    const ts = new Date().toISOString();
    const encoded = JSON.stringify(body, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    const digest = digestFor({ seq, ts, type, prevDigest, body: encoded });

    await this.#client.query(
      `INSERT INTO record(seq, ts, type, prev_digest, digest, body) VALUES ($1,$2,$3,$4,$5,$6)`,
      [seq, ts, type, prevDigest, digest, encoded],
    );

    const record: StoredRecord = {
      seq,
      ts,
      type,
      prevDigest,
      digest,
      body: JSON.parse(encoded) as Record<string, unknown>,
    };
    this.#records.push(record);
    return record;
  }

  /**
   * Stores a record that already has its seq, timestamp and digest.
   *
   * Used when the durable log is MIRRORING a local one rather than originating
   * the record: the digest covers the timestamp, so recomputing either here
   * would produce a different chain for the same history and the two stores
   * would disagree about what happened.
   */
  async appendRaw(record: StoredRecord): Promise<void> {
    if (this.#closed) throw new Error("appendRaw on a closed journal");
    this.#refuseIfLost();
    if (record.seq !== this.#records.length) {
      // A gap or an overlap means the caller's idea of the history and this
      // one's have already diverged. Writing anyway would paper over that.
      throw new Error(
        `refusing to store record ${record.seq} into a log of length ${this.#records.length}: ` +
          "the sequence must be dense and in order",
      );
    }
    const encoded = JSON.stringify(record.body, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    await this.#client.query(
      `INSERT INTO record(seq, ts, type, prev_digest, digest, body) VALUES ($1,$2,$3,$4,$5,$6)`,
      [record.seq, record.ts, record.type, record.prevDigest, record.digest, encoded],
    );
    this.#records.push({ ...record, body: JSON.parse(encoded) as Record<string, unknown> });
  }

  /**
   * Recomputes the chain and reports the first row that disagrees.
   *
   * Postgres removes file corruption as a concern but not this one: a row edited
   * by someone with database access leaves the stored digest intact while the
   * content beneath it changed. The chain is what notices.
   */
  verifyIntegrity(): { ok: boolean; detail: string | null } {
    let prev = GENESIS_DIGEST;
    for (const record of this.#records) {
      if (record.prevDigest !== prev) {
        return {
          ok: false,
          detail: `record ${record.seq} claims a previous digest the chain does not have; the history was edited out of band`,
        };
      }
      const expected = digestFor({
        seq: record.seq,
        ts: record.ts,
        type: record.type,
        prevDigest: record.prevDigest,
        body: JSON.stringify(record.body),
      });
      if (expected !== record.digest) {
        return { ok: false, detail: `record ${record.seq} does not match its own digest` };
      }
      prev = record.digest;
    }
    return { ok: true, detail: null };
  }

  /**
   * True once the connection has died. The account has to be released.
   *
   * Exposed so a caller can notice WITHOUT attempting a write. A keeper that
   * only found out by failing to append would find out while settling.
   */
  get lost(): string | null {
    return this.#lost;
  }

  /**
   * Refuses a write on a dead connection, naming what happened.
   *
   * Without this the write reaches node-postgres and comes back as a generic
   * "Client has encountered a connection error and is not queryable" — true, but
   * indistinguishable from a transient fault, so the caller would retry forever
   * against a connection that can never recover and a lock it no longer holds.
   */
  #refuseIfLost(): void {
    if (this.#lost !== null) throw new JournalConnectionLostError(this.#schema, this.#lost);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // A dead connection has no session left to unlock, and querying it throws
    // where a close must not. The backend released the lock when it died.
    if (this.#lost !== null) {
      await this.#client.end().catch(() => undefined);
      return;
    }
    // Ending the connection releases the advisory lock; doing it explicitly makes
    // an orderly shutdown release immediately rather than at TCP timeout.
    await this.#client.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
    await this.#client.end().catch(() => undefined);
  }
}

/** The digest of an empty history. Anchors the chain so record 0 has a previous. */
export const GENESIS_DIGEST = "0x" + "0".repeat(64);

function digestFor(input: {
  seq: number;
  ts: string;
  type: string;
  prevDigest: string;
  body: string;
}): string {
  // The seq and the previous digest are inside the hash, so neither a reorder nor
  // a splice survives: moving a record changes its own digest and every one after.
  return (
    "0x" +
    createHash("sha256")
      .update(`${input.seq}|${input.ts}|${input.type}|${input.prevDigest}|${input.body}`)
      .digest("hex")
  );
}
