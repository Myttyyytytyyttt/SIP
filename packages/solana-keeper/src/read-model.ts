// The keeper's history writer: what the website reads back.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/read-model.ts). The schema is
// SIP's own, sip_solana, created by bin/setup-read-model.mts from
// sql/sip_solana.sql; a settlement row records the attested BASE and the MODE it
// was measured in, because under settle_v2 a base is a profit or a notional and
// the row must say which.
//
// WHY IT EXISTS AT ALL, on Solana specifically: a normal RPC keeps ~2-3 days of
// history. Without this table the website simply cannot show "your vault bought
// NVDAx last Friday" at any price. On the EVM side the same writer is a
// convenience; here it is the only way the past survives.
//
// THE HARD RULE: a write failure is a WARNING, never an exception that reaches
// the settlement loop. History is derived and rebuildable from the chain; a
// settlement is not. If this file ever blocks a settle, it is wrong.

import pg from "pg";
import { summarizeUpstreamError, type Secret } from "@sip/worker/log";

export const READ_MODEL_SCHEMA = "sip_solana";
export const READ_MODEL_TABLES = ["vault", "trading_link", "settlement_event", "investment_event"] as const;
/** What an operator runs when the preflight finds the schema missing. */
export const SETUP_COMMAND = "pnpm --dir packages/solana-keeper setup-read-model";

export interface SettlementRow {
  readonly walletAddr: string;
  readonly nonce: bigint;
  readonly vaultAddr: string;
  /** 0 PROFIT, 1 VOLUME: what `baseRaw` measures. */
  readonly mode: number;
  readonly baseRaw: bigint;
  readonly contributionRaw: bigint;
  readonly txRef: string;
  readonly height: bigint;
}

export interface InvestmentRow {
  readonly vaultAddr: string;
  readonly target: string;
  readonly spentRaw: bigint;
  readonly receivedRaw: bigint;
  readonly txRef: string;
  readonly height: bigint;
}

type Warn = (message: string, fields?: Record<string, unknown>) => void;

/** Supabase terminates TLS with a chain Node rejects by default; encrypt with relaxed validation unless sslmode=disable. */
export function sslFor(databaseUrl: string): false | { rejectUnauthorized: false } {
  try {
    if (new URL(databaseUrl).searchParams.get("sslmode")?.toLowerCase() === "disable") return false;
  } catch {
    // Unparseable: nothing was explicitly disabled, so encrypt.
  }
  return { rejectUnauthorized: false };
}

/**
 * Pooled and fault-isolated. With no DATABASE_URL it is a working no-op that
 * reports `enabled: false` — a keeper without a database records no history and
 * settles exactly as before, which is the honest degradation.
 */
export class SolanaReadModel {
  readonly enabled: boolean;
  readonly #pool: pg.Pool | null;
  readonly #warn: Warn;

  private constructor(pool: pg.Pool | null, warn: Warn) {
    this.#pool = pool;
    this.#warn = warn;
    this.enabled = pool !== null;
  }

  static create(databaseUrl: Secret | null, warn: Warn): SolanaReadModel {
    if (databaseUrl === null) return new SolanaReadModel(null, warn);
    const connectionString = databaseUrl.reveal();
    const pool = new pg.Pool({
      connectionString,
      ssl: sslFor(connectionString),
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      // BOUNDING THE CONNECTION IS NOT BOUNDING THE QUERY. A connection that
      // establishes and then stalls — a pooler under load, a network blackhole —
      // left client.query hanging with no limit. These two make a hang look
      // like a failure, which this file already knows how to survive.
      statement_timeout: 5_000,
      query_timeout: 5_000,
    });
    // REQUIRED. An idle client erroring (a Supabase restart) emits 'error' on
    // the pool; unhandled, that crashes the process — taking settlement down
    // for a feature that must never be able to.
    pool.on("error", (err) => warn("read-model idle pool error (ignored)", { detail: summarizeUpstreamError(err) }));
    return new SolanaReadModel(pool, warn);
  }

  /**
   * Claims the right to be THE acting keeper, or reports that someone else holds
   * it. The claim is a session-scoped pg_try_advisory_lock held on ONE checked-out
   * client, so releasing that connection releases the claim.
   *
   * WHY IT MATTERS HERE. Railway overlaps the old and new container on every
   * deploy, so two keepers run concurrently as a matter of course. The on-chain
   * frontier already prevents a double settle, but nothing prevents two
   * instances both wrapping, converting and investing the same vault — two
   * independent purchases, each up to max_per_call, plus crank fees burned on
   * the transactions that lose the race and revert.
   *
   * `onLost` fires when the held session errors: the server has dropped it, the
   * lock went with it, and the caller must stop acting until it claims again.
   */
  async claimSingleton(key: bigint, onLost: () => void): Promise<{ held: boolean; release?: () => void }> {
    // NO DATABASE, NO LOCK — and that is a fact to report, not to paper over.
    // The caller decides what to do with an unenforced singleton.
    if (this.#pool === null) return { held: true };
    let client: pg.PoolClient | undefined;
    try {
      client = await this.#pool.connect();
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key.toString()]);
      if (result.rows[0]?.locked === true) {
        const held = client;
        let released = false;
        // THE HELD CLIENT NEEDS ITS OWN ERROR LISTENER. pg-pool removes its
        // idle listener the moment a client is checked out and attaches no
        // replacement, so a server-side disconnect on this deliberately
        // never-released connection emits 'error' with nobody listening —
        // which in Node is an uncaught exception that takes the keeper down.
        held.on("error", (err: Error) => {
          this.#warn("the keeper claim's connection errored; the lock is no longer held", {
            detail: summarizeUpstreamError(err),
          });
          if (!released) {
            released = true;
            held.release(true);
            onLost();
          }
        });
        return {
          held: true,
          // DESTROYED, NOT RETURNED TO THE POOL. A session lock survives
          // client.release(): the pooled connection would keep holding it, and
          // the next instance would wait out the idle timeout to take over.
          release: () => {
            if (released) return;
            released = true;
            held.release(true);
          },
        };
      }
      client.release();
      return { held: false };
    } catch (error) {
      client?.release();
      this.#warn("singleton claim failed — staying in dry run rather than acting unclaimed", {
        detail: summarizeUpstreamError(error),
      });
      // NOT `held: true`. A claim that could not be ATTEMPTED is not a claim
      // granted, and a database unreachable for us is just as likely reachable
      // for the other instance. The caller retries every sweep, so a transient
      // failure costs one cycle of dry run rather than a double-acting keeper.
      return { held: false };
    }
  }

  /**
   * Whether history can actually be written — asked ONCE, at startup.
   *
   * WHY THIS EXISTS. Every write here is fire-and-forget and turns a failure
   * into a warning, deliberately. The cost of that rule is silence, and the
   * silence was total: a keeper with no DATABASE_URL, or one pointed at a
   * database where the schema was never created, recorded nothing for weeks
   * while settling correctly and logging nothing at boot to say so. This reports
   * the answer ONCE, loudly, at the only moment where somebody is looking.
   */
  async preflight(): Promise<{ ok: boolean; detail: string }> {
    if (this.#pool === null) {
      return { ok: false, detail: "off — no DATABASE_URL, so nothing is recorded" };
    }
    let client: pg.PoolClient | undefined;
    try {
      client = await this.#pool.connect();
      // to_regclass answers NULL for a table that is not there, without
      // throwing — so one round trip names every missing table at once.
      const result = await client.query<{ name: string }>(
        `SELECT t.name
           FROM unnest($1::text[]) AS t(name)
          WHERE to_regclass('${READ_MODEL_SCHEMA}.' || t.name) IS NULL`,
        [[...READ_MODEL_TABLES]],
      );
      const missing = result.rows.map((row) => row.name);
      if (missing.length > 0) {
        return {
          ok: false,
          detail:
            `BROKEN — ${READ_MODEL_SCHEMA} is missing ${missing.join(", ")}. Run \`${SETUP_COMMAND}\` ` +
            "against this database. Settlements are unaffected; only the history is being lost.",
        };
      }
      return { ok: true, detail: `on — ${READ_MODEL_SCHEMA} is reachable and complete` };
    } catch (error) {
      // UNREADABLE IS ITS OWN ANSWER, not "missing": one sends someone to
      // create a schema that already exists.
      return { ok: false, detail: `could not be checked — ${summarizeUpstreamError(error)}` };
    } finally {
      client?.release();
    }
  }

  async recordSettlement(row: SettlementRow): Promise<boolean> {
    return this.#run("settlement", (client) =>
      client.query(
        `INSERT INTO ${READ_MODEL_SCHEMA}.settlement_event
           (wallet_addr, nonce, vault_addr, mode, base_raw, contribution_raw, tx_ref, height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (wallet_addr, nonce) DO NOTHING`,
        [
          row.walletAddr,
          row.nonce.toString(),
          row.vaultAddr,
          row.mode,
          row.baseRaw.toString(),
          row.contributionRaw.toString(),
          row.txRef,
          row.height.toString(),
        ],
      ),
    );
  }

  async recordInvestment(row: InvestmentRow): Promise<boolean> {
    return this.#run("investment", (client) =>
      client.query(
        `INSERT INTO ${READ_MODEL_SCHEMA}.investment_event
           (vault_addr, target, spent_raw, received_raw, tx_ref, height)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tx_ref) DO NOTHING`,
        [row.vaultAddr, row.target, row.spentRaw.toString(), row.receivedRaw.toString(), row.txRef, row.height.toString()],
      ),
    );
  }

  /** Records the vault and its link, so the website can list them without
   * re-deriving PDAs. Upsert: the chain stays the truth, this is a mirror. */
  async recordLink(vaultAddr: string, ownerAddr: string, skimBps: number, walletAddr: string): Promise<boolean> {
    return this.#run("link", async (client) => {
      await client.query(
        `INSERT INTO ${READ_MODEL_SCHEMA}.vault (vault_addr, owner_addr, skim_bps)
         VALUES ($1,$2,$3)
         ON CONFLICT (vault_addr) DO UPDATE SET owner_addr = EXCLUDED.owner_addr, skim_bps = EXCLUDED.skim_bps`,
        [vaultAddr, ownerAddr, skimBps],
      );
      await client.query(
        `INSERT INTO ${READ_MODEL_SCHEMA}.trading_link (wallet_addr, vault_addr, active)
         VALUES ($1,$2,true)
         ON CONFLICT (wallet_addr) DO UPDATE SET vault_addr = EXCLUDED.vault_addr, active = true`,
        [walletAddr, vaultAddr],
      );
    });
  }

  async close(): Promise<void> {
    await this.#pool?.end();
  }

  async #run(what: string, work: (client: pg.PoolClient) => Promise<unknown>): Promise<boolean> {
    if (this.#pool === null) return false;
    let client: pg.PoolClient | undefined;
    try {
      client = await this.#pool.connect();
      await work(client);
      return true;
    } catch (error) {
      this.#warn(`read-model ${what} write failed (settlement unaffected)`, { detail: summarizeUpstreamError(error) });
      return false;
    } finally {
      client?.release();
    }
  }
}
