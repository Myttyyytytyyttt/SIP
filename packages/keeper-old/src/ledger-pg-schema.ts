// The journal's schema in Postgres, translated constraint for constraint from
// the SQLite one in ledger.ts.
//
// WHY THIS EXISTS. The SQLite journal lives on local disk, and on Railway local
// disk does not survive a redeploy: a new container gets a new filesystem. The
// records lost that way include unresolved INTENT rows, which are exactly the
// ones the startup recovery needs in order to resolve a settlement that was in
// flight when the process died. A volume would fix durability but pins the whole
// service to one instance forever, because a Railway volume has a single writer.
//
// WHAT IS AND IS NOT THE AUTHORITY. The chain remains the authority on whether
// money moved: SettlementExecutor compares `attestation.settlementNonce` against
// the account's and reverts on a mismatch (SettlementExecutor.sol:338), so even a
// journal that is lost, stale or wrong cannot produce a double settlement. This
// table is the keeper's own record of what it did and why — durable so that a
// restart can resolve its own unfinished business, not so that it can be trusted
// over the chain.
//
// THE CONSTRAINTS ARE THE SAFETY, NOT THE APPLICATION CODE. Every rule below
// fires at INSERT of an INTENT — BEFORE anything is broadcast — so the database
// refuses to let the keeper form the intention to double-settle. Porting them
// loosely would remove a net silently: the code would still work, and would stop
// refusing something it must refuse. That is why every one of them is exercised
// by ledger-pg.test.ts rather than assumed.
//
// DIALECT NOTES, where SQLite and Postgres genuinely differ:
//   * GLOB pattern checks become POSIX regex (`~`). Same intent, stricter engine.
//   * INTEGER PRIMARY KEY AUTOINCREMENT becomes BIGSERIAL; block heights and
//     nonces become BIGINT, which is what SQLite's INTEGER already was.
//   * RAISE(ABORT, …) becomes RAISE EXCEPTION inside a PL/pgSQL trigger.
//   * `IS NOT` is NULL-safe in BOTH, which the frontier trigger depends on: `<>`
//     would evaluate to NULL for the genesis row and wave it through.
//   * STRICT is unnecessary — Postgres columns are typed to begin with.

/** Live: an intent in flight, or a settlement that landed. */
const LIVE = "status IN ('INTENT','CONFIRMED')";

/**
 * The COVERAGE set: live settlements that make a claim on the L2 frontier chain.
 * UNRESOLVED (the L2 window is unknown) and COVERED (it lies wholly below the
 * frontier already) are deliberately outside it.
 */
const COVERING = `${LIVE} AND l2_precision NOT IN ('UNRESOLVED','COVERED')`;

/**
 * Every statement needed to bring an empty schema up to date.
 *
 * Written to be re-runnable: a keeper that restarts, or a second keeper for a
 * different account, must be able to execute this without failing.
 */
export function postgresDdl(schema: string): string {
  return `
CREATE SCHEMA IF NOT EXISTS ${schema};
SET search_path TO ${schema};

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  description TEXT NOT NULL
);

-- The identity pin. One row, enforced structurally, so a store cannot come to
-- describe two deployments. Addresses are stored LOWERCASE: mixed-case EIP-55
-- against lowercase is a classic silent miss in a text equality join, and a
-- missed join here is a missed dedup.
CREATE TABLE IF NOT EXISTS instance (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  chain_id      BIGINT NOT NULL CHECK (chain_id > 0),
  factory       TEXT NOT NULL,
  executor      TEXT NOT NULL,
  vault         TEXT NOT NULL,
  account       TEXT NOT NULL UNIQUE CHECK (account ~ '^0x[0-9a-f]{40}$'),
  ledger_schema TEXT NOT NULL,
  engine_schema TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- The append-only record stream, carrying the per-row digest that detects an
-- out-of-band edit.
CREATE TABLE IF NOT EXISTS record (
  seq         BIGINT PRIMARY KEY CHECK (seq >= 0),
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,
  prev_digest TEXT NOT NULL,
  digest      TEXT NOT NULL,
  body        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS record_by_type ON record(type);

-- THE TABLE THAT DOES THE WORK.
--
-- One table, not two. The obvious split — attempts here, settlements there —
-- puts the dedup constraints on the settled side only, so an INTENT could be
-- FORMED for a window that is already covered and would only blow up at
-- confirmation time, after the money moved. Here every constraint fires at
-- INSERT ... 'INTENT', which is BEFORE the broadcast.
--
-- Status rather than deletion, because FAILED and ABANDONED rows must persist for
-- audit while RELEASING the frontier so a retry is possible.
CREATE TABLE IF NOT EXISTS settlement (
  id                  BIGSERIAL PRIMARY KEY,
  record_seq          BIGINT NOT NULL UNIQUE REFERENCES record(seq),
  resolved_record_seq BIGINT REFERENCES record(seq),
  account             TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('INTENT','CONFIRMED','FAILED','ABANDONED')),
  origin              TEXT NOT NULL CHECK (origin IN ('KEEPER','ADOPTED')),

  -- ---- THE DEDUP KEY. Epoch-independent, content-independent. ----
  start_block_l2      BIGINT NOT NULL CHECK (start_block_l2 >= 0),
  end_block_l2        BIGINT NOT NULL,
  prev_end_block_l2   BIGINT,
  l2_precision        TEXT NOT NULL CHECK (l2_precision IN ('EXACT','L1_CLAMP','COVERED','UNRESOLVED')),

  -- ---- Recorded, never keyed. binding_epoch is audit data and nothing else. ----
  binding_epoch       BIGINT NOT NULL CHECK (binding_epoch >= 0),
  settlement_nonce    BIGINT NOT NULL CHECK (settlement_nonce >= 0),
  start_block_l1      BIGINT NOT NULL CHECK (start_block_l1 >= 0),
  end_block_l1        BIGINT NOT NULL,
  session_id          TEXT NOT NULL,
  ledger_root         TEXT NOT NULL,

  -- ---- uint256 as decimal TEXT: a BIGINT column cannot hold these. ----
  contribution_wei    TEXT NOT NULL
    CHECK (contribution_wei ~ '^[0-9]{1,78}$'),
  realized_profit_wei TEXT NOT NULL
    CHECK (realized_profit_wei ~ '^-?[0-9]{1,78}$'),

  raw_tx_hash         TEXT,
  tx_hash             TEXT,
  eoa_nonce           BIGINT,
  deadline            BIGINT,
  created_at          TEXT NOT NULL,
  resolved_at         TEXT,
  resolution_detail   TEXT,

  CHECK (end_block_l2 >= start_block_l2),
  CHECK (end_block_l1 >= start_block_l1),
  -- You may only ever extend the frontier FORWARD. This alone kills the exact
  -- replay, the right-overlap and the interior subset.
  CHECK (prev_end_block_l2 IS NULL OR start_block_l2 > prev_end_block_l2),
  CHECK ((status = 'INTENT') = (resolved_at IS NULL)),
  CHECK (origin <> 'ADOPTED' OR status = 'CONFIRMED'),
  CHECK (l2_precision NOT IN ('UNRESOLVED','COVERED') OR origin = 'ADOPTED'),
  FOREIGN KEY (account) REFERENCES instance(account)
);

-- (1) the exact duplicate, epoch-independent
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_window
  ON settlement(account, start_block_l2, end_block_l2) WHERE ${COVERING};
-- (2) a frontier value exists at most once
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_end
  ON settlement(account, end_block_l2) WHERE ${COVERING};
-- (3) a frontier is EXTENDED at most once, which forbids forks and overlaps
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_prev
  ON settlement(account, prev_end_block_l2) WHERE ${COVERING};
-- (4) exactly one origin of the chain. Postgres, like SQLite, treats NULLs as
--     distinct in a UNIQUE index, so without this a second prev=NULL row inserts
--     freely — and every one would be an unlinked replay of the beginning.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_genesis
  ON settlement(account) WHERE ${COVERING} AND prev_end_block_l2 IS NULL;
-- (5) SINGLE FLIGHT, enforced by the database rather than by counting in JS
CREATE UNIQUE INDEX IF NOT EXISTS settlement_open_intent
  ON settlement(account) WHERE status = 'INTENT';
-- (6) the vault consumes settlementNonce strictly in order and never reuses it
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_nonce
  ON settlement(account, settlement_nonce) WHERE ${LIVE};
-- (7) mirrors usedSessions[keccak(account, epoch, sessionId)]. DELIBERATELY
--     REDUNDANT AND DELIBERATELY WEAKER: its epoch scoping is the very defect
--     being fixed, so it is a second net and must never be the only one.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_live_session
  ON settlement(account, binding_epoch, session_id) WHERE ${LIVE};
-- (8) never sign two different attestations onto one raw transaction hash
CREATE UNIQUE INDEX IF NOT EXISTS settlement_raw_tx
  ON settlement(raw_tx_hash) WHERE raw_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS settlement_by_epoch_l1
  ON settlement(account, binding_epoch, end_block_l1) WHERE status = 'CONFIRMED';

-- Records are immutable and are never deleted. In SQLite these are RAISE(ABORT)
-- triggers; here they are the same rule expressed in PL/pgSQL.
CREATE OR REPLACE FUNCTION record_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'records are immutable and are never deleted';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS record_no_change ON record;
CREATE TRIGGER record_no_change BEFORE UPDATE OR DELETE ON record
  FOR EACH ROW EXECUTE FUNCTION record_immutable();

-- A foreign key cannot reference a partial index, so "prev_end must BE the
-- current live frontier" is a trigger. It is strictly stronger than an FK: an FK
-- would happily accept a link to a stale interior end. IS DISTINCT FROM rather
-- than <>, because NULL <> NULL is NULL — falsy — which would wave the genesis
-- case through. MAX() over zero rows is NULL, and NULL IS DISTINCT FROM NULL is
-- false, so the first insert is accepted and every later unlinked one is not.
CREATE OR REPLACE FUNCTION settlement_frontier_check() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('INTENT','CONFIRMED')
     AND NEW.l2_precision NOT IN ('UNRESOLVED','COVERED')
     AND NEW.prev_end_block_l2 IS DISTINCT FROM (
       SELECT MAX(end_block_l2) FROM settlement
       WHERE account = NEW.account AND ${COVERING})
  THEN
    RAISE EXCEPTION 'frontier violation: prev_end_block_l2 is not the current live frontier';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS settlement_frontier_insert ON settlement;
CREATE TRIGGER settlement_frontier_insert BEFORE INSERT ON settlement
  FOR EACH ROW EXECUTE FUNCTION settlement_frontier_check();

-- With this, the only legal mutation in the whole schema is
-- INTENT -> {CONFIRMED, FAILED, ABANDONED}, exactly once.
CREATE OR REPLACE FUNCTION settlement_immutable_check() RETURNS trigger AS $$
BEGIN
  IF NEW.account           IS DISTINCT FROM OLD.account
  OR NEW.record_seq        IS DISTINCT FROM OLD.record_seq
  OR NEW.start_block_l2    IS DISTINCT FROM OLD.start_block_l2
  OR NEW.end_block_l2      IS DISTINCT FROM OLD.end_block_l2
  OR NEW.prev_end_block_l2 IS DISTINCT FROM OLD.prev_end_block_l2
  OR NEW.l2_precision      IS DISTINCT FROM OLD.l2_precision
  OR NEW.binding_epoch     IS DISTINCT FROM OLD.binding_epoch
  OR NEW.settlement_nonce  IS DISTINCT FROM OLD.settlement_nonce
  OR NEW.session_id        IS DISTINCT FROM OLD.session_id
  OR NEW.ledger_root       IS DISTINCT FROM OLD.ledger_root
  OR NEW.contribution_wei  IS DISTINCT FROM OLD.contribution_wei
  OR NEW.origin            IS DISTINCT FROM OLD.origin
  THEN
    RAISE EXCEPTION 'settlement rows are immutable except for resolution fields';
  END IF;
  IF OLD.status <> 'INTENT' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'only an INTENT may change status';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS settlement_immutable ON settlement;
CREATE TRIGGER settlement_immutable BEFORE UPDATE ON settlement
  FOR EACH ROW EXECUTE FUNCTION settlement_immutable_check();

CREATE OR REPLACE FUNCTION settlement_no_delete_check() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'settlement rows are never deleted';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS settlement_no_delete ON settlement;
CREATE TRIGGER settlement_no_delete BEFORE DELETE ON settlement
  FOR EACH ROW EXECUTE FUNCTION settlement_no_delete_check();

-- Refused and skipped windows, keyed on the same epoch-independent L2 window so
-- a REFUSED verdict survives a rebind. Separate from settlement on purpose.
CREATE TABLE IF NOT EXISTS terminal_window (
  account        TEXT NOT NULL,
  start_block_l2 BIGINT NOT NULL,
  end_block_l2   BIGINT NOT NULL,
  reason         TEXT NOT NULL,
  detail         TEXT,
  record_seq     BIGINT NOT NULL REFERENCES record(seq),
  created_at     TEXT NOT NULL,
  PRIMARY KEY (account, start_block_l2, end_block_l2)
);

-- The halt latch. An open row here means the keeper refuses EVERYTHING, so it
-- must be as durable as the settlements themselves — a halt lost in a redeploy
-- would let a keeper resume against a condition nobody resolved.
CREATE TABLE IF NOT EXISTS halt (
  record_seq            BIGINT PRIMARY KEY REFERENCES record(seq),
  reason                TEXT NOT NULL,
  detail                TEXT NOT NULL,
  unaccounted_below     BIGINT,
  raised_at             TEXT NOT NULL,
  cleared_at            TEXT,
  cleared_by_record_seq BIGINT REFERENCES record(seq),
  cleared_note          TEXT,
  CHECK ((cleared_at IS NULL) = (cleared_by_record_seq IS NULL))
);
CREATE INDEX IF NOT EXISTS halt_open ON halt(record_seq) WHERE cleared_at IS NULL;

-- The watermark. Losing it is not dangerous — it re-derives from the chain — but
-- it is expensive: the keeper would rescan from its configured start.
CREATE TABLE IF NOT EXISTS chain_checkpoint (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  anchor_block_l2   BIGINT NOT NULL,
  anchor_block_hash TEXT NOT NULL,
  head_block_l2     BIGINT NOT NULL,
  record_seq        BIGINT NOT NULL,
  updated_at        TEXT NOT NULL
);
`;
}

export { COVERING, LIVE };
