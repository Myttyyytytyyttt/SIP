-- SIP's Solana read model: the sip_solana schema. Idempotent; applied by
-- bin/setup-read-model.mts (pnpm --dir packages/solana-keeper setup-read-model).
--
-- Ported from Nuvem's packages/keeper/scripts/setup-read-model.mjs, which
-- created the same four tables as nuvem_solana. One table changed shape:
-- settlement_event records the attested BASE and the MODE it was measured in,
-- because under settle_v2 a base is a profit (mode 0) or a notional (mode 1) and
-- a row that only said "profit" would be wrong for every volume vault.
--
-- DERIVED AND REBUILDABLE. Written only by the keeper; the web only reads. The
-- chain is the truth: drop-and-backfill must reproduce every row, and a row
-- that disagrees with the chain is a writer bug.

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
