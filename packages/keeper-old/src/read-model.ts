// The read model: a DERIVED, REBUILDABLE mirror of what settled and what was
// invested, so the website can show history without re-scanning the chain per
// page — and, on Solana, at all (public-RPC history is ~2-3 days).
//
// TWO RULES, both load-bearing:
//
//  1. THIS IS NEVER A SOURCE OF TRUTH. The chain is (discovery.ts: "ask the
//     chain, not a database"). Every table here can be dropped and rebuilt from
//     chain logs or the keeper's own journal. A row that disagrees with the
//     chain is a bug in this writer, not a fact.
//
//  2. A WRITE FAILURE MUST NEVER BLOCK A SETTLEMENT. The money already moved on
//     chain before this runs; a Supabase hiccup recording it is a warning, not
//     an outage. Every function here swallows its own errors into a boolean and
//     the caller logs — it never throws into the settlement path.
//
// Schemas are per-chain by design (nuvem_rh, nuvem_solana) so the operator
// finds things by schema, not by filtering a column.

import pg from "pg";

import { sslOptionsFor } from "./ledger-pg.js";
import type { Logger } from "./log.js";

export type ReadModelChain = "nuvem_rh" | "nuvem_solana";

export interface SettlementRow {
  readonly walletAddr: string;
  readonly nonce: bigint;
  readonly vaultAddr: string;
  readonly profitRaw: bigint;
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

/**
 * A pooled, fault-isolated writer. Construct once and share; if no
 * DATABASE_URL is configured it is a no-op that reports `enabled: false`, so a
 * keeper without a database simply does not record history — it does not fail.
 */
export class ReadModel {
  readonly enabled: boolean;
  readonly #pool: pg.Pool | null;
  readonly #schema: ReadModelChain;
  readonly #logger: Logger;

  private constructor(pool: pg.Pool | null, schema: ReadModelChain, logger: Logger) {
    this.#pool = pool;
    this.#schema = schema;
    this.#logger = logger;
    this.enabled = pool !== null;
  }

  static create(
    schema: ReadModelChain,
    logger: Logger,
    databaseUrl: string | undefined,
  ): ReadModel {
    if (databaseUrl === undefined || databaseUrl.trim() === "") {
      return new ReadModel(null, schema, logger);
    }
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl: sslOptionsFor(databaseUrl),
      max: 2,
      // The read model is best-effort; a slow DB must not pile up connections
      // behind the settlement loop.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    // A pool-level error handler is REQUIRED: an idle client erroring out
    // (a Supabase restart) otherwise crashes the process via an unhandled
    // 'error' event — which would take settlement down for a feature that must
    // never be able to.
    pool.on("error", (err) => logger.warn("read-model idle pool error (ignored)", { detail: err.message }));
    return new ReadModel(pool, schema, logger);
  }

  async recordSettlement(row: SettlementRow): Promise<boolean> {
    return this.#run("settlement", (client) =>
      client.query(
        `INSERT INTO ${this.#schema}.settlement_event
           (wallet_addr, nonce, vault_addr, profit_raw, contribution_raw, tx_ref, height)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (wallet_addr, nonce) DO NOTHING`,
        [
          row.walletAddr,
          row.nonce.toString(),
          row.vaultAddr,
          row.profitRaw.toString(),
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
        `INSERT INTO ${this.#schema}.investment_event
           (vault_addr, target, spent_raw, received_raw, tx_ref, height)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tx_ref) DO NOTHING`,
        [
          row.vaultAddr,
          row.target,
          row.spentRaw.toString(),
          row.receivedRaw.toString(),
          row.txRef,
          row.height.toString(),
        ],
      ),
    );
  }

  async upsertVault(vaultAddr: string, ownerAddr: string, skimBps: number): Promise<boolean> {
    return this.#run("vault", (client) =>
      client.query(
        `INSERT INTO ${this.#schema}.vault (vault_addr, owner_addr, skim_bps)
         VALUES ($1,$2,$3) ON CONFLICT (vault_addr) DO UPDATE SET skim_bps = EXCLUDED.skim_bps`,
        [vaultAddr, ownerAddr, skimBps],
      ),
    );
  }

  async upsertLink(walletAddr: string, vaultAddr: string, active: boolean): Promise<boolean> {
    return this.#run("link", (client) =>
      client.query(
        `INSERT INTO ${this.#schema}.trading_link (wallet_addr, vault_addr, active)
         VALUES ($1,$2,$3) ON CONFLICT (wallet_addr)
         DO UPDATE SET vault_addr = EXCLUDED.vault_addr, active = EXCLUDED.active`,
        [walletAddr, vaultAddr, active],
      ),
    );
  }

  async close(): Promise<void> {
    await this.#pool?.end();
  }

  /** Runs one query, isolating every failure into a false + a warning. */
  /**
   * Whether history can actually be written — asked ONCE, at startup.
   *
   * WHY THIS EXISTS. Every write here is fire-and-forget and downgrades a
   * failure to a warning, deliberately: a settlement must never fail because
   * its mirror did. The cost of that rule is silence, and the silence is total
   * — a keeper pointed at a database where this schema was never created
   * records nothing for weeks while settling correctly, and says so nowhere.
   * The Solana supervisor had exactly that and the website showed an empty
   * calendar for a vault with real settlements on chain.
   *
   * The hard rule does not change. This reports the answer ONCE, loudly, at the
   * one moment where it is cheap and somebody is looking.
   */
  async preflight(): Promise<{ ok: boolean; detail: string }> {
    if (this.#pool === null) return { ok: false, detail: "off — no DATABASE_URL, so nothing is recorded" };
    let client: pg.PoolClient | null = null;
    try {
      client = await this.#pool.connect();
      // to_regclass answers NULL for a table that is not there without
      // throwing, so one round trip names every missing table at once rather
      // than failing on the first.
      const result = await client.query<{ name: string }>(
        `SELECT t.name
           FROM (VALUES ('vault'),('trading_link'),('settlement_event'),('investment_event')) AS t(name)
          WHERE to_regclass($1 || '.' || t.name) IS NULL`,
        [this.#schema],
      );
      const missing = result.rows.map((row) => row.name);
      if (missing.length > 0) {
        return {
          ok: false,
          detail:
            `BROKEN — ${this.#schema} is missing ${missing.join(", ")}. Run ` +
            "packages/keeper-old/scripts/setup-read-model.mjs against this database. Settlements are " +
            "unaffected; only the history is being lost.",
        };
      }
      return { ok: true, detail: `on — ${this.#schema} is reachable and complete` };
    } catch (error) {
      // UNREADABLE IS ITS OWN ANSWER, not "missing": one of those sends someone
      // to create a schema that already exists.
      return { ok: false, detail: `could not be checked — ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      client?.release();
    }
  }

  async #run(what: string, fn: (client: pg.PoolClient) => Promise<unknown>): Promise<boolean> {
    if (this.#pool === null) return false;
    let client: pg.PoolClient | null = null;
    try {
      client = await this.#pool.connect();
      await fn(client);
      return true;
    } catch (error) {
      this.#logger.warn(`read-model ${what} write failed (settlement unaffected)`, {
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      client?.release();
    }
  }
}
