-- SIP's Solana read model: the sip_solana schema. Idempotent; applied by
-- bin/setup-read-model.mts (pnpm --dir packages/solana-keeper setup-read-model).
--
-- Ported from Nuvem's packages/keeper/scripts/setup-read-model.mjs, which
-- created the same four tables as nuvem_solana. One table changed shape:
-- settlement_event records the attested BASE and the MODE it was measured in,
-- because under settle_v2 a base is a profit (mode 0) or a notional (mode 1) and
-- a row that only said "profit" would be wrong for every volume vault.
--
-- DERIVED AND REBUILDABLE — EXCEPT sip_solana.loss_carry, AT THE END. Written
-- only by the keeper; the web only reads. The chain is the truth for every other
-- table: drop-and-backfill must reproduce every row, and a row that disagrees
-- with the chain is a writer bug.
--
-- loss_carry IS NOT DERIVED AND CANNOT BE REBUILT. It holds losses the chain
-- does not record (the program keeps no high-water mark), and a dropped row is a
-- loss forgotten: the next win of that link is over-charged. No backfill, reset
-- or cleanup may ever drop or truncate it.

CREATE SCHEMA IF NOT EXISTS sip_solana;

CREATE TABLE IF NOT EXISTS sip_solana.vault (
  vault_addr   text PRIMARY KEY,
  owner_addr   text NOT NULL,
  skim_bps     integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sip_solana.trading_link (
  wallet_addr  text PRIMARY KEY,
  vault_addr   text NOT NULL,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS sip_solana.settlement_event (
  wallet_addr       text NOT NULL,
  nonce             bigint NOT NULL,
  vault_addr        text NOT NULL,
  -- 0 PROFIT, 1 VOLUME: what base_raw measures.
  mode              smallint NOT NULL,
  base_raw          numeric NOT NULL,
  contribution_raw  numeric NOT NULL,
  tx_ref            text NOT NULL,
  height            bigint NOT NULL,
  at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_addr, nonce)
);

CREATE TABLE IF NOT EXISTS sip_solana.investment_event (
  id            bigserial PRIMARY KEY,
  vault_addr    text NOT NULL,
  target        text NOT NULL,
  spent_raw     numeric NOT NULL,
  received_raw  numeric NOT NULL,
  tx_ref        text NOT NULL UNIQUE,
  height        bigint NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sip_solana_settle_by_vault
  ON sip_solana.settlement_event (vault_addr, at DESC);
CREATE INDEX IF NOT EXISTS sip_solana_invest_by_vault
  ON sip_solana.investment_event (vault_addr, at DESC);

-- ─── Added after this schema was already applied to a live database ──────────
--
-- AN ALTER, NOT A COLUMN IN THE CREATE ABOVE. `CREATE TABLE IF NOT EXISTS` does
-- nothing at all to a table that exists, so a column added inside it would be
-- missing on every database this file has already run against — including the
-- one the keeper is writing to right now.

-- The notional the settled window traded, from the same walk that measured the
-- window (measure-window.ts). MEASURED, NEVER ATTESTED: no settlement is
-- computed from it, and nothing is charged on it — it feeds the usage
-- leaderboard. Rows written before the column existed read 0, which is the
-- honest value: nobody measured their volume.
ALTER TABLE sip_solana.settlement_event
  ADD COLUMN IF NOT EXISTS volume_raw numeric NOT NULL DEFAULT 0;

-- The leaderboard reads the whole table grouped by day, newest seasons first.
CREATE INDEX IF NOT EXISTS sip_solana_settle_by_at
  ON sip_solana.settlement_event (at DESC);

-- ─── Loss carries: SIP_SOLANA_CARRY_STORE (L2, dispatcher ADR §4.6) ──────────
--
-- The losses a PROFIT prefix's zero settle carries into the window above it
-- (LossCarry, src/settle-decision.ts), kept where a restart cannot forget them.
-- Written and read only by src/carry-store.ts, and only when the variable is
-- dual or on; with off (the default) nothing reads or writes this table, and its
-- presence changes nothing.
--
-- KEYED EXACTLY AS THE MEMORY BOOK: the link, then the link state the carry
-- belongs to — epoch, settlement nonce and frontier slot, carryKey's
-- `${epoch}:${settlementNonce}:${frontierSlot}`. A carry applies only to that
-- exact state, so a row for a state the chain has left can never match.
--
-- loss_lamports > 0, as recordCarry refuses anything else in code: a carry that
-- is not a loss would RAISE the next base. bigint everywhere: slots (~4.6e8) and
-- lamports (< 9.2e18) fit, and the CHECKs refuse a wrapped value.
--
-- valid_until_slot is the deadline of the settle whose post-state this row is:
-- until it passes, that settle may still land, and on's gate will not delete the
-- row under it. written_by is the writing process, so a successor can tell
-- another keeper's row from its own.
CREATE TABLE IF NOT EXISTS sip_solana.loss_carry (
  link_addr              text        NOT NULL,
  epoch                  bigint      NOT NULL CHECK (epoch >= 0),
  settlement_nonce       bigint      NOT NULL CHECK (settlement_nonce >= 0),
  frontier_slot          bigint      NOT NULL CHECK (frontier_slot >= 0),
  loss_lamports          bigint      NOT NULL CHECK (loss_lamports > 0),
  wallet_signed_tx_count integer     NOT NULL CHECK (wallet_signed_tx_count >= 0),
  valid_until_slot       bigint      NOT NULL CHECK (valid_until_slot >= 0),
  written_by             text        NOT NULL,
  written_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (link_addr, epoch, settlement_nonce, frontier_slot)
);
