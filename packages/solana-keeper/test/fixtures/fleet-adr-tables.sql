-- The dispatcher's tables AS THE ADR DESIGNS THEM (ADR §3.4, [QUEUE] §2.3, with
-- ADR §3.4's send_intent amendments and §3.12's `draining`), for
-- test/fleet-pg.test.ts only. NOT the schema: sql/sip_solana.sql is.
--
-- WHY A FIXTURE. The queue's store track (Q1) adds these tables to
-- sql/sip_solana.sql on its own branch; this branch builds the receiver and the
-- fleet page against them before that merges. The test applies the schema file
-- FIRST and this file second, and every statement here is IF NOT EXISTS: once
-- the schema file creates a table, this file's version of it is a no-op, and
-- the test runs against Q1's table — so a drift between the two shows up as a
-- failing statement in this test, not in production.

CREATE TABLE IF NOT EXISTS sip_solana.keeper_link (
  link_addr        text PRIMARY KEY,
  wallet_addr      text NOT NULL,
  vault_addr       text NOT NULL,
  epoch            bigint NOT NULL,
  settlement_nonce bigint NOT NULL,
  frontier_slot    bigint NOT NULL,
  seen_slot        bigint NOT NULL,
  seen_at          timestamptz NOT NULL,
  gone_at          timestamptz,
  privy_wallet_id  text,
  last_own_settle  text
);
CREATE INDEX IF NOT EXISTS keeper_link_by_vault ON sip_solana.keeper_link (vault_addr) WHERE gone_at IS NULL;
CREATE INDEX IF NOT EXISTS keeper_link_by_wallet ON sip_solana.keeper_link (wallet_addr) WHERE gone_at IS NULL;

CREATE TABLE IF NOT EXISTS sip_solana.vault_work (
  vault_addr    text PRIMARY KEY,
  system        text NOT NULL DEFAULT 'legacy',
  skim_mode     smallint,
  lane          text NOT NULL DEFAULT 'new',
  priority      smallint NOT NULL DEFAULT 2,
  due_at        timestamptz NOT NULL DEFAULT now(),
  rests         boolean NOT NULL DEFAULT false,
  bell_at       timestamptz,
  holder        text,
  fence         bigint NOT NULL DEFAULT 0,
  lease_until   timestamptz,
  claimed_at    timestamptz,
  last_holder   text,
  attempts      integer NOT NULL DEFAULT 0,
  last_outcome  text,
  last_detail   text,
  last_done_at  timestamptz,
  streaks       jsonb NOT NULL DEFAULT '{}',
  parked_reason text
);
CREATE INDEX IF NOT EXISTS vault_work_due ON sip_solana.vault_work (priority, due_at)
  WHERE holder IS NULL AND parked_reason IS NULL AND system = 'queue';

CREATE TABLE IF NOT EXISTS sip_solana.send_intent (
  id                      bigserial PRIMARY KEY,
  vault_addr              text   NOT NULL,
  link_addr               text,
  kind                    text   NOT NULL,
  fence                   bigint NOT NULL,
  worker_id               text   NOT NULL,
  blockhash               text   NOT NULL,
  last_valid_block_height bigint NOT NULL,
  plan_cleared_height     bigint,
  signature               text UNIQUE,
  idempotency_key         text,
  amount_raw              numeric,
  state                   text   NOT NULL DEFAULT 'intent',
  resolved_height         bigint,
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at             timestamptz,
  echoed_at               timestamptz
);
CREATE INDEX IF NOT EXISTS send_intent_open ON sip_solana.send_intent (vault_addr) WHERE state = 'intent';

CREATE TABLE IF NOT EXISTS sip_solana.worker (
  worker_id    text PRIMARY KEY,
  kind         text NOT NULL,
  version      text NOT NULL,
  started_at   timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  slots        smallint NOT NULL,
  busy         smallint NOT NULL DEFAULT 0,
  rps_quota    real,
  jup_quota    real,
  stopped_at   timestamptz,
  stats        jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sip_solana.fleet (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  scheduler_id     text,
  tick_at          timestamptz,
  full_pass_reason text,
  board_dirty_at   timestamptz,
  discovery_ok_at  timestamptz
);
