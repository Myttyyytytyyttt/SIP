// The worker's ledger schema in Postgres.
//
// Ported from packages/keeper-old/src/ledger-pg-schema.ts — the DDL DISCIPLINE (re-runnable
// statements, lowercase-address CHECKs, immutability as triggers, "the constraints are the safety");
// the tables themselves are new, because what this ledger records is volume, not profit sessions.
//
// WHAT IS AND IS NOT THE AUTHORITY. The chain remains the authority on whether money moved: the
// executor binds every attestation to the account's settlementNonce and reverts on a mismatch, so a
// ledger that is lost, stale or wrong cannot produce a double pull. What this ledger IS the authority
// on is volume: which fills were seen, which blocks were refused, and which fills a window has already
// committed to a batchRoot. A fill counted in two windows is fabricated volume — the one unforgivable
// output — so that rule lives here as a constraint (one window per fill, one fill per (wallet, tx),
// a windowed fill immutable), not in application code that could miss a WHERE clause.
//
// DIALECT NOTES.
//   * Wei is NUMERIC(78,0): the decimal width of a uint256. A BIGINT cannot hold it and TEXT cannot be
//     summed. Block heights, indices and nonces are BIGINT/INTEGER, which is what they are.
//   * Addresses and hashes are TEXT, LOWERCASE, and CHECKed: mixed-case EIP-55 against lowercase is a
//     classic silent miss in a text equality join, and a missed join here is a missed dedup.
//   * Every statement is re-runnable (IF NOT EXISTS / OR REPLACE / DROP TRIGGER IF EXISTS), because a
//     worker that restarts must be able to execute the whole list without failing.
//   * One statement per array element, so the client can run them in order without a splitter that
//     would trip over the semicolons inside the PL/pgSQL bodies.

const ADDRESS = `~ '^0x[0-9a-f]{40}$'`;
const HASH = `~ '^0x[0-9a-f]{64}$'`;

/** Mirrors ExclusionReason in src/types.ts. Adding a reason there means adding it here. */
export const EXCLUSION_REASONS = ["TOKEN_FOR_TOKEN", "WETH_WRAP", "AIRDROP", "NOT_A_TRADE", "SELF_TRANSFER", "REVERTED"] as const;
/** Mirrors RefusalReason in src/types.ts. */
export const REFUSAL_REASONS = [
  "MULTI_FILL_BLOCK",
  "UNEXPLAINED_INFLOW",
  "WALLET_HAS_CODE",
  "STATE_UNAVAILABLE",
  "INCOMPLETE_RANGE",
  "UNDECODED_SELL",
] as const;
/** Mirrors WindowStatus in src/types.ts. */
export const WINDOW_STATUSES = ["OPEN", "SIGNED", "SUBMITTED", "CONFIRMED", "FAILED"] as const;
/** Mirrors PullOutcome["kind"] in src/types.ts. */
export const PULL_OUTCOMES = ["DRY_RUN", "SENT", "SKIPPED"] as const;

const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(",");

/** The tables this schema creates, in creation order (sip_window before sip_fill: the fill references it). */
export const SIP_TABLES = ["sip_instance", "sip_wallet", "sip_window", "sip_fill", "sip_exclusion", "sip_refusal", "sip_pull"] as const;

/**
 * Every statement needed to bring an empty database up to date, in order.
 *
 * Executed by openPgLedger AFTER the advisory lock is held, so two workers racing to create the same
 * tables is not a case that exists.
 */
export const SCHEMA_SQL: readonly string[] = [
  // The identity pin. One row, enforced structurally, so a database cannot come to describe two
  // deployments: a worker pointed at a new factory or executor would otherwise mix two deployments'
  // fills and windows into one history.
  `CREATE TABLE IF NOT EXISTS sip_instance (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  chain_id   BIGINT NOT NULL CHECK (chain_id > 0),
  factory    TEXT NOT NULL CHECK (factory ${ADDRESS}),
  executor   TEXT NOT NULL CHECK (executor ${ADDRESS}),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`,

  // One row per trading wallet bound to a vault. The cursor is the L2 height up to which this wallet's
  // fills have been windowed; the two totals are the running "apartado / cobrado" the website shows.
  // owed - collected is the debt Phase 0 cannot carry on-chain, so it lives here and is never lost.
  `CREATE TABLE IF NOT EXISTS sip_wallet (
  address             TEXT PRIMARY KEY CHECK (address ${ADDRESS}),
  vault               TEXT NOT NULL CHECK (vault ${ADDRESS}),
  cursor_l2           BIGINT NOT NULL DEFAULT 0 CHECK (cursor_l2 >= 0),
  owed_total_wei      NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (owed_total_wei >= 0),
  collected_total_wei NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (collected_total_wei >= 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);`,

  // A closed range (start_l2 .. end_l2] of one wallet's fills, committed to batch_root. Status rather
  // than deletion: a FAILED window must persist for audit while releasing its range for a retry.
  `CREATE TABLE IF NOT EXISTS sip_window (
  id               SERIAL PRIMARY KEY,
  wallet           TEXT NOT NULL REFERENCES sip_wallet(address),
  vault            TEXT NOT NULL CHECK (vault ${ADDRESS}),
  start_l2         BIGINT NOT NULL CHECK (start_l2 >= 0),
  end_l2           BIGINT NOT NULL,
  batch_root       TEXT NOT NULL CHECK (batch_root ${HASH}),
  sum_notional_wei NUMERIC(78,0) NOT NULL CHECK (sum_notional_wei >= 0),
  owed_wei         NUMERIC(78,0) NOT NULL CHECK (owed_wei >= 0),
  savings_bps      INTEGER NOT NULL CHECK (savings_bps >= 0 AND savings_bps <= 10000),
  status           TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (${sqlList(WINDOW_STATUSES)})),
  detail           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_l2 >= start_l2)
);`,
  // A live (non-FAILED) window's bounds and root exist at most once per wallet. Equal bounds are the
  // exact replay; the general overlap is refused by openPgLedger before the insert, since a range
  // overlap is not expressible as a unique index.
  `CREATE UNIQUE INDEX IF NOT EXISTS sip_window_live_start ON sip_window(wallet, start_l2) WHERE status <> 'FAILED';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sip_window_live_end ON sip_window(wallet, end_l2) WHERE status <> 'FAILED';`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sip_window_live_root ON sip_window(wallet, batch_root) WHERE status <> 'FAILED';`,
  `CREATE INDEX IF NOT EXISTS sip_window_by_status ON sip_window(status, wallet);`,

  // THE TABLE THAT DOES THE WORK. One row per (wallet, tx): a tx is one fill or it is not a fill.
  // window_id NULL means "seen, not yet attested"; once set it never changes (trigger below).
  `CREATE TABLE IF NOT EXISTS sip_fill (
  wallet       TEXT NOT NULL REFERENCES sip_wallet(address),
  tx_hash      TEXT NOT NULL CHECK (tx_hash ${HASH}),
  block_l2     BIGINT NOT NULL CHECK (block_l2 >= 0),
  tx_index     INTEGER NOT NULL CHECK (tx_index >= 0),
  side         TEXT NOT NULL CHECK (side IN ('buy','sell')),
  venue        TEXT NOT NULL,
  token_in     TEXT NOT NULL CHECK (token_in = 'native' OR token_in ${ADDRESS}),
  token_out    TEXT NOT NULL CHECK (token_out = 'native' OR token_out ${ADDRESS}),
  notional_wei NUMERIC(78,0) NOT NULL CHECK (notional_wei >= 0),
  fee_wei      NUMERIC(78,0) NOT NULL CHECK (fee_wei >= 0),
  source       TEXT NOT NULL CHECK (source IN ('venue','value','residual')),
  window_id    INTEGER REFERENCES sip_window(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, tx_hash)
);`,
  `CREATE INDEX IF NOT EXISTS sip_fill_unwindowed ON sip_fill(wallet, block_l2, tx_index) WHERE window_id IS NULL;`,
  `CREATE INDEX IF NOT EXISTS sip_fill_by_window ON sip_fill(window_id) WHERE window_id IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS sip_fill_by_block ON sip_fill(wallet, block_l2);`,

  // Transactions the reconciler looked at and set aside, with the reason. Audit only; never attested.
  `CREATE TABLE IF NOT EXISTS sip_exclusion (
  wallet     TEXT NOT NULL REFERENCES sip_wallet(address),
  tx_hash    TEXT NOT NULL CHECK (tx_hash ${HASH}),
  block_l2   BIGINT NOT NULL CHECK (block_l2 >= 0),
  reason     TEXT NOT NULL CHECK (reason IN (${sqlList(EXCLUSION_REASONS)})),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, tx_hash)
);`,
  `CREATE INDEX IF NOT EXISTS sip_exclusion_by_block ON sip_exclusion(wallet, block_l2);`,

  // A (wallet, block) whose cash movement could not be attributed to exactly one fill. While a row is
  // here the wallet's window cannot close past block_l2. times_seen and first_seen_at are what a
  // retention policy reads: a refusal that persists stays refused, it is never attested.
  `CREATE TABLE IF NOT EXISTS sip_refusal (
  wallet        TEXT NOT NULL REFERENCES sip_wallet(address),
  block_l2      BIGINT NOT NULL CHECK (block_l2 >= 0),
  reason        TEXT NOT NULL CHECK (reason IN (${sqlList(REFUSAL_REASONS)})),
  detail        TEXT,
  times_seen    INTEGER NOT NULL DEFAULT 1 CHECK (times_seen >= 1),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet, block_l2)
);`,

  // One row per pull attempt against a window. tx_hash is keccak256(rawTx), known BEFORE the send, so
  // the intent recorded before eth_sendRawTransaction and the outcome recorded after it are the same
  // row (unique on tx_hash), not two.
  `CREATE TABLE IF NOT EXISTS sip_pull (
  id               SERIAL PRIMARY KEY,
  window_id        INTEGER NOT NULL REFERENCES sip_window(id),
  tx_hash          TEXT CHECK (tx_hash IS NULL OR tx_hash ${HASH}),
  nonce            BIGINT CHECK (nonce IS NULL OR nonce >= 0),
  contribution_wei NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (contribution_wei >= 0),
  outcome          TEXT NOT NULL CHECK (outcome IN (${sqlList(PULL_OUTCOMES)})),
  detail           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sip_pull_tx_hash ON sip_pull(tx_hash) WHERE tx_hash IS NOT NULL;`,
  `CREATE INDEX IF NOT EXISTS sip_pull_by_window ON sip_pull(window_id);`,

  // A window's identity — what its batch_root and owed commit to — never changes; only status and
  // detail move. CONFIRMED is terminal: money moved against that root, and re-marking it would lie.
  `CREATE OR REPLACE FUNCTION sip_window_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.wallet           IS DISTINCT FROM OLD.wallet
  OR NEW.vault            IS DISTINCT FROM OLD.vault
  OR NEW.start_l2         IS DISTINCT FROM OLD.start_l2
  OR NEW.end_l2           IS DISTINCT FROM OLD.end_l2
  OR NEW.batch_root       IS DISTINCT FROM OLD.batch_root
  OR NEW.sum_notional_wei IS DISTINCT FROM OLD.sum_notional_wei
  OR NEW.owed_wei         IS DISTINCT FROM OLD.owed_wei
  OR NEW.savings_bps      IS DISTINCT FROM OLD.savings_bps
  THEN
    RAISE EXCEPTION 'sip_window rows are immutable except for status and detail';
  END IF;
  IF OLD.status = 'CONFIRMED' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a CONFIRMED window is terminal: money moved against its batch root';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;`,
  `DROP TRIGGER IF EXISTS sip_window_immutable ON sip_window;`,
  `CREATE TRIGGER sip_window_immutable BEFORE UPDATE ON sip_window
  FOR EACH ROW EXECUTE FUNCTION sip_window_guard();`,

  `CREATE OR REPLACE FUNCTION sip_window_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sip_window rows are never deleted; mark them FAILED';
END; $$ LANGUAGE plpgsql;`,
  `DROP TRIGGER IF EXISTS sip_window_keep ON sip_window;`,
  `CREATE TRIGGER sip_window_keep BEFORE DELETE ON sip_window
  FOR EACH ROW EXECUTE FUNCTION sip_window_no_delete();`,

  // A fill belongs to one window. Once windowed its content is committed to a batch root and to the
  // window's sum, so neither the assignment nor the amounts may change, and it may not be deleted.
  // The IS NOT NULL guards keep the unwindowed row fully mutable: a block retried after a refusal
  // may decode differently, and that is the case the retry exists for.
  `CREATE OR REPLACE FUNCTION sip_fill_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.window_id IS NOT NULL AND NEW.window_id IS DISTINCT FROM OLD.window_id THEN
    RAISE EXCEPTION 'a fill belongs to one window: re-assigning it would count its notional twice';
  END IF;
  IF OLD.window_id IS NOT NULL AND (
       NEW.block_l2     IS DISTINCT FROM OLD.block_l2
    OR NEW.tx_index     IS DISTINCT FROM OLD.tx_index
    OR NEW.side         IS DISTINCT FROM OLD.side
    OR NEW.venue        IS DISTINCT FROM OLD.venue
    OR NEW.token_in     IS DISTINCT FROM OLD.token_in
    OR NEW.token_out    IS DISTINCT FROM OLD.token_out
    OR NEW.notional_wei IS DISTINCT FROM OLD.notional_wei
    OR NEW.fee_wei      IS DISTINCT FROM OLD.fee_wei
    OR NEW.source       IS DISTINCT FROM OLD.source)
  THEN
    RAISE EXCEPTION 'a windowed fill is committed to a batch root and cannot change';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;`,
  `DROP TRIGGER IF EXISTS sip_fill_immutable ON sip_fill;`,
  `CREATE TRIGGER sip_fill_immutable BEFORE UPDATE ON sip_fill
  FOR EACH ROW EXECUTE FUNCTION sip_fill_guard();`,

  `CREATE OR REPLACE FUNCTION sip_fill_no_delete_windowed() RETURNS trigger AS $$
BEGIN
  IF OLD.window_id IS NOT NULL THEN
    RAISE EXCEPTION 'a windowed fill is never deleted: its window attested it';
  END IF;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;`,
  `DROP TRIGGER IF EXISTS sip_fill_keep_windowed ON sip_fill;`,
  `CREATE TRIGGER sip_fill_keep_windowed BEFORE DELETE ON sip_fill
  FOR EACH ROW EXECUTE FUNCTION sip_fill_no_delete_windowed();`,
];
