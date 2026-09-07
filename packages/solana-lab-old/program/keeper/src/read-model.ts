// The Solana supervisor's history writer: what the website reads back.
//
// WHY THE LAB CARRIES ITS OWN COPY. packages/keeper-old has an equivalent class,
// but solana-lab is deliberately outside the pnpm workspace (PLAN.md §"el
// laboratorio"), so importing across that boundary would tie the lab's build to
// the product's. The shared thing is the SQL contract — the `nuvem_solana`
// schema created by packages/keeper-old/scripts/setup-read-model.mjs — not the
// code. Both writers must agree on that schema and nothing else.
//
// WHY IT EXISTS AT ALL, on Solana specifically: a normal RPC keeps ~2-3 days of
// history (measured in M4). Without this table the website simply cannot show
// "your vault bought NVDAx last Friday" at any price. On the EVM side the same
// writer is a convenience; here it is the only way the past survives.
//
// THE HARD RULE: a write failure is a WARNING, never an exception that reaches
// the settlement loop. History is derived and rebuildable from the chain; a
// settlement is not. If this file ever blocks a settle, it is wrong.

import pg from "pg";

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

type Warn = (message: string, fields?: Record<string, unknown>) => void;

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

  static create(databaseUrl: string | undefined, warn: Warn): SolanaReadModel {
    if (databaseUrl === undefined || databaseUrl.trim() === "") {
      return new SolanaReadModel(null, warn);
    }
    // Supabase terminates TLS with a chain Node rejects by default; encrypt
    // with relaxed validation unless sslmode=disable was explicit. Same posture
    // as the EVM keeper's journal (ledger-pg.ts sslOptionsFor).
    let ssl: false | { rejectUnauthorized: false } = { rejectUnauthorized: false };
    try {
      if (new URL(databaseUrl).searchParams.get("sslmode")?.toLowerCase() === "disable") ssl = false;
    } catch {
      // Unparseable: nothing was explicitly disabled, so encrypt.
    }
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      ssl,
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
    pool.on("error", (err) => warn("read-model idle pool error (ignored)", { detail: err.message }));
    return new SolanaReadModel(pool, warn);
  }

  /**
   * Claims the right to be THE supervisor, or reports that someone else holds
   * it. Returns the held client, which must stay open — a Postgres advisory
   * lock is SESSION scoped, so releasing the connection releases the claim.
   *
   * WHY IT MATTERS HERE. Railway overlaps the old and new container on every
   * deploy, so two supervisors run concurrently as a matter of course. The
   * on-chain frontier already prevents a double settle, but nothing prevents
   * two instances both wrapping, converting and investing the same vault —
   * two independent purchases, each up to max_per_call, plus crank fees burned
   * on the transactions that lose the race and revert.
   *
   * The EVM keeper has held such a lock since the beginning
   * (ledger-pg.ts: pg_try_advisory_lock). This is the same mechanism.
   */
  async claimSingleton(key: bigint): Promise<{ held: boolean; client?: pg.PoolClient }> {
    // NO DATABASE, NO LOCK — and that is a fact to report, not to paper over.
    // The caller decides what to do with an unenforced singleton; pretending
    // it is held would be the one answer that could not be acted on.
    if (this.#pool === null) return { held: true };
    let client: pg.PoolClient | undefined;
    try {
      client = await this.#pool.connect();
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [
        key.toString(),
      ]);
      if (result.rows[0]?.locked === true) {
        // THE HELD CLIENT NEEDS ITS OWN ERROR LISTENER. pg-pool removes its
        // idle listener the moment a client is checked out and attaches no
        // replacement, so a server-side disconnect on this deliberately
        // never-released connection emits 'error' with nobody listening —
        // which in Node is an uncaught exception that takes the supervisor
        // down. The whole point of holding it is that it outlives everything.
        client.on("error", (err: Error) => {
          this.#warn("the supervisor claim's connection errored; the lock is no longer held", {
            detail: err.message,
          });
        });
        return { held: true, client };
      }
      client.release();
      return { held: false };
    } catch (error) {
      client?.release();
      this.#warn("singleton claim failed — staying in dry run rather than acting unclaimed", {
        detail: error instanceof Error ? error.message : String(error),
      });
      // NOT `held: true`. A claim that could not be ATTEMPTED is not a claim
      // granted: returning true here sent an armed supervisor live without the
      // lock, which is the precise situation the lock exists to prevent — and
      // a database that is unreachable for us is just as likely reachable for
      // the other instance. The caller retries every sweep, so a transient
      // failure costs one cycle of dry run rather than a double-acting keeper.
      return { held: false };
    }
  }

  /**
   * Whether history can actually be written — asked ONCE, at startup.
   *
   * WHY THIS EXISTS. Every write here is fire-and-forget and turns a failure
   * into a warning, deliberately: a settlement must never fail because its
   * mirror did. The cost of that rule is silence, and the silence was total —
   * a supervisor with no DATABASE_URL, or one pointed at a database where the
   * `nuvem_solana` schema was never created, recorded nothing for weeks while
   * settling correctly and logging nothing at boot to say so. The website then
   * showed an empty calendar for a vault with real settlements on chain, and
   * the two causes were indistinguishable from outside.
   *
   * This does not change the hard rule. It reports the answer ONCE, loudly, at
   * the only moment where it is cheap and where somebody is looking.
   */
  async preflight(): Promise<{ ok: boolean; detail: string }> {
    if (this.#pool === null) {
      return { ok: false, detail: "off — no DATABASE_URL, so nothing is recorded" };
    }
    let client: pg.PoolClient | undefined;
    try {
      client = await this.#pool.connect();
      // to_regclass answers NULL for a table that is not there, without
      // throwing — so one round trip names every missing table at once
      // instead of failing on the first.
      const result = await client.query<{ name: string }>(
        `SELECT t.name
           FROM (VALUES ('vault'),('trading_link'),('settlement_event'),('investment_event')) AS t(name)
          WHERE to_regclass('nuvem_solana.' || t.name) IS NULL`,
      );
      const missing = result.rows.map((row) => row.name);
      if (missing.length > 0) {
        return {
          ok: false,
          detail:
            `BROKEN — nuvem_solana is missing ${missing.join(", ")}. ` +
            "Run packages/keeper-old/scripts/setup-read-model.mjs against this database. " +
            "Settlements are unaffected; only the history is being lost.",
        };
      }
      return { ok: true, detail: "on — nuvem_solana is reachable and complete" };
    } catch (error) {
      // UNREADABLE IS ITS OWN ANSWER, not "missing": one sends someone to
      // create a schema that already exists.
      return {
        ok: false,
        detail: `could not be checked — ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      client?.release();
    }
  }

  async recordSettlement(row: SettlementRow): Promise<boolean> {
    return this.#run("settlement", (client) =>
      client.query(
        `INSERT INTO nuvem_solana.settlement_event
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
        `INSERT INTO nuvem_solana.investment_event
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

  /** Records the vault and its link, so the website can list them without
   * re-deriving PDAs. Upsert: the chain stays the truth, this is a mirror. */
  async recordLink(vaultAddr: string, ownerAddr: string, skimBps: number, walletAddr: string): Promise<boolean> {
    return this.#run("link", async (client) => {
      await client.query(
        `INSERT INTO nuvem_solana.vault (vault_addr, owner_addr, skim_bps)
         VALUES ($1,$2,$3)
         ON CONFLICT (vault_addr) DO UPDATE SET owner_addr = EXCLUDED.owner_addr, skim_bps = EXCLUDED.skim_bps`,
        [vaultAddr, ownerAddr, skimBps],
      );
      await client.query(
        `INSERT INTO nuvem_solana.trading_link (wallet_addr, vault_addr, active)
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
      this.#warn(`read-model ${what} write failed (settlement unaffected)`, {
        detail: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      client?.release();
    }
  }
}
