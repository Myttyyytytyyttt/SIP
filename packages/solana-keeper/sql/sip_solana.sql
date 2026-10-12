-- SIP's Solana read model: the sip_solana schema. Idempotent; applied by
-- bin/setup-read-model.mts (pnpm --dir packages/solana-keeper setup-read-model).
--
-- Ported from Nuvem's packages/keeper/scripts/setup-read-model.mjs, which
-- created the same four tables as nuvem_solana. One table changed shape:
-- settlement_event records the attested BASE and the MODE it was measured in,
-- because under settle_v2 a base is a profit (mode 0) or a notional (mode 1) and
-- a row that only said "profit" would be wrong for every volume vault.
--
-- DERIVED AND REBUILDABLE — EXCEPT sip_solana.loss_carry, sip_solana.send_intent
-- AND sip_solana.vault_work, AT THE END. Written only by the keeper; the web only
-- reads. The chain is the truth for the four read-model tables above the
-- dispatcher's section: drop-and-backfill must reproduce every row, and a row
-- that disagrees with the chain is a writer bug.
--
-- loss_carry IS NOT DERIVED AND CANNOT BE REBUILT. It holds losses the chain
-- does not record (the program keeps no high-water mark), and a dropped row is a
-- loss forgotten: the next win of that link is over-charged. No backfill, reset
-- or cleanup may ever drop or truncate it.
--
-- send_intent AND vault_work ARE NOT DERIVED AND CANNOT BE REBUILT EITHER (the
-- dispatcher, ADR §3.4). send_intent is the record of every transaction a worker
-- was allowed to send: a dropped open row is a transaction still able to land
-- that the next holder no longer waits for, and it plans from balances that do
-- not contain it — the double wrap, convert or buy the fence exists to stop.
-- vault_work holds each vault's fence: rebuilt, the fences start again from 0
-- and a holder that lost its lease could meet its own number again. Neither may
-- ever be dropped, truncated or rebuilt; a restore of either is the runbook's
-- `SIP_SOLANA_DISPATCH=off` quiet period (ADR §4.9 row 11).
--
-- The dispatcher's other four (keeper_link, worker, rpc_usage, fleet) are
-- operational: keeper_link is the chain's listing, kept; the rest are counters
-- and flags. Losing them costs a full pass and some history, never money.

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

-- ─── The dispatcher's tables (ADR §3.4, plan P3a Q1) ─────────────────────────
--
-- DARK. Nothing in a legacy keeper reads or writes any of these: they belong to
-- src/dispatch-store.ts, which only the dispatcher's own entry points use, and
-- with SIP_SOLANA_DISPATCH unset no such entry point runs. Creating them changes
-- nothing for the keepers that run today.
--
-- ADDITIVE AND IDEMPOTENT, like the rest of this file: CREATE … IF NOT EXISTS,
-- ADD COLUMN IF NOT EXISTS, and one INSERT … ON CONFLICT DO NOTHING. Every lease
-- comparison the store makes uses clock_timestamp(), the database's own wall
-- clock — never now(), the start of a transaction, and never a worker's clock —
-- and the column defaults below follow it.

-- The loss carries, reconciled with the dispatcher (ADR §3.4, safety §3.2). L2's
-- table above keeps every column it has; a carry written inside a settle's gate
-- (src/dispatch-store.ts) also says which fence wrote it and the intent whose
-- post-state it is, so an audit can tie each carry to the gate that let it be.
-- NULL on every row L2 writes: one keeper, no fence, no intent.
ALTER TABLE sip_solana.loss_carry
  ADD COLUMN IF NOT EXISTS written_fence bigint;
ALTER TABLE sip_solana.loss_carry
  ADD COLUMN IF NOT EXISTS send_intent_id bigint;

-- Last-known-good discovery: one row per link the chain listed, kept when a
-- listing fails (C6 + L3 in the scheduler). Written only by the scheduler. A
-- cached row is never trusted for an attestation: a job re-reads the link.
CREATE TABLE IF NOT EXISTS sip_solana.keeper_link (
  link_addr        text        PRIMARY KEY,
  wallet_addr      text        NOT NULL,
  vault_addr       text        NOT NULL,
  epoch            bigint      NOT NULL CHECK (epoch >= 0),
  settlement_nonce bigint      NOT NULL CHECK (settlement_nonce >= 0),
  frontier_slot    bigint      NOT NULL CHECK (frontier_slot >= 0),
  -- The context slot of the listing that saw it.
  seen_slot        bigint      NOT NULL CHECK (seen_slot >= 0),
  seen_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Absent from a SUCCESSFUL listing (an unlink closes the account).
  gone_at          timestamptz,
  -- C8: the Privy wallet id, resolved once by address.
  privy_wallet_id  text,
  -- C4: the newest signature known to be this keeper's own settle.
  last_own_settle  text
);
CREATE INDEX IF NOT EXISTS keeper_link_by_vault ON sip_solana.keeper_link (vault_addr) WHERE gone_at IS NULL;
CREATE INDEX IF NOT EXISTS keeper_link_by_wallet ON sip_solana.keeper_link (wallet_addr) WHERE gone_at IS NULL;

-- One standing row per vault with at least one live link: its due time, lane,
-- holder, FENCE and lease. NOT REBUILDABLE (the header says why).
--
-- system IS WHO ACTS ON THE VAULT, NEVER THE MODE BYTE (ADR §3.12, RT-4):
-- 'legacy' (today's keepers), 'draining' (the handover's first step: the legacy
-- keepers already leave it alone, no worker takes it yet), 'queue' (workers).
-- A vault moves only by the two-step handover. Only 'queue' is ever claimed.
--
-- fence GROWS BY ONE ON EVERY CLAIM AND NOTHING ELSE CHANGES IT: complete and
-- release leave it, so a number is never handed out twice.
CREATE TABLE IF NOT EXISTS sip_solana.vault_work (
  vault_addr    text        PRIMARY KEY,
  system        text        NOT NULL DEFAULT 'legacy' CHECK (system IN ('legacy', 'draining', 'queue')),
  -- The last mode byte read: selects the job's module, never trusted to settle.
  skim_mode     smallint,
  -- bell | busy | retry | new | full | safety; priority 0 bell, 1 busy/retry, 2 new, 3 full, 4 safety.
  lane          text        NOT NULL DEFAULT 'new',
  priority      smallint    NOT NULL DEFAULT 2 CHECK (priority >= 0),
  due_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  rests         boolean     NOT NULL DEFAULT false,
  bell_at       timestamptz,
  -- The worker_id while leased.
  holder        text,
  fence         bigint      NOT NULL DEFAULT 0 CHECK (fence >= 0),
  lease_until   timestamptz,
  claimed_at    timestamptz,
  -- Soft affinity for the in-memory walk cache: claims prefer the last holder.
  last_holder   text,
  -- Consecutive claims that did not complete; the scheduler parks at 5 expiries.
  attempts      integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_outcome  text,
  last_detail   text,
  last_done_at  timestamptz,
  -- Per-wallet streaks (settleRetries, wrapShort, investFailed, leg fees), read only by the vault's job.
  streaks       jsonb       NOT NULL DEFAULT '{}',
  parked_reason text,
  -- A held row has a lease; a free one has neither.
  CONSTRAINT vault_work_held_has_lease CHECK ((holder IS NULL) = (lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS vault_work_due ON sip_solana.vault_work (priority, due_at)
  WHERE holder IS NULL AND parked_reason IS NULL AND system = 'queue';

-- Every transaction a worker is allowed to send: the gate's INSERT, committed
-- before the bytes leave (ADR §3.5, §3.6). NOT REBUILDABLE (the header says why).
--
-- signature IS NULLABLE: Privy signs a settle as its fee payer, so its id is
-- known only once Privy answers; idempotency_key carries the settle until then.
-- UNIQUE still allows several NULLs.
--
-- EXPIRY IS A FINALIZED BLOCK HEIGHT, never a clock: an intent whose signature
-- status is unknown is over only once getBlockHeight({commitment: "finalized"})
-- has passed last_valid_block_height. plan_cleared_height is the finalized
-- height the holder had seen pass every older fence's intents before it planned;
-- resolved_height the last height at which this one's transaction could still
-- act (where it landed or reverted; for an expired one, its last valid height).
--
-- state 'shadow' (plan P3a design detail 1): a row written by a worker under
-- SIP_SOLANA_DISPATCH=shadow, which gates exactly as `on` and NEVER SENDS. The
-- gate and the overlap audit then run on real scheduling. A shadow row stays
-- 'shadow' when it is resolved; resolved_at says it was.
CREATE TABLE IF NOT EXISTS sip_solana.send_intent (
  id                      bigserial   PRIMARY KEY,
  vault_addr              text        NOT NULL,
  -- Settle only.
  link_addr               text,
  kind                    text        NOT NULL CHECK (kind IN ('settle', 'wrap', 'convert', 'invest')),
  fence                   bigint      NOT NULL CHECK (fence >= 1),
  worker_id               text        NOT NULL,
  blockhash               text        NOT NULL,
  last_valid_block_height bigint      NOT NULL CHECK (last_valid_block_height >= 0),
  plan_cleared_height     bigint      CHECK (plan_cleared_height >= 0),
  signature               text        UNIQUE,
  -- settleIdempotencyKey (src/settle-tick.ts).
  idempotency_key         text,
  amount_raw              numeric,
  state                   text        NOT NULL DEFAULT 'intent' CHECK (state IN ('intent', 'landed', 'failed', 'expired', 'shadow')),
  resolved_height         bigint      CHECK (resolved_height >= 0),
  created_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at             timestamptz,
  -- Seen in a Helius delivery: the doorbell's echo evidence.
  echoed_at               timestamptz,
  CONSTRAINT send_intent_settle_has_link CHECK (kind <> 'settle' OR link_addr IS NOT NULL),
  -- An 'intent' is open; landed, failed and expired are resolved; a shadow row may be either.
  CONSTRAINT send_intent_open_is_unresolved CHECK (state <> 'intent' OR resolved_at IS NULL),
  CONSTRAINT send_intent_resolved_has_time CHECK (state IN ('intent', 'shadow') OR resolved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS send_intent_open ON sip_solana.send_intent (vault_addr, fence) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS send_intent_by_vault ON sip_solana.send_intent (vault_addr, fence);
-- The fleet page's last hour (src/fleet-pg.ts, every 15 s on each scheduler
-- replica): without it that read is a scan of 35 days of intents, ≈ 490k rows at
-- N = 1,000. With it and send_intent_open, the page reads the open intents and
-- the last hour's, and nothing older.
CREATE INDEX IF NOT EXISTS send_intent_created ON sip_solana.send_intent (created_at);

-- Every dispatcher process: the fleet view and the quota hand-out.
CREATE TABLE IF NOT EXISTS sip_solana.worker (
  -- A uuid at boot (plus host or replica, for humans).
  worker_id    text        PRIMARY KEY,
  kind         text        NOT NULL CHECK (kind IN ('scheduler', 'worker')),
  -- The image's git sha.
  version      text        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  slots        smallint    NOT NULL CHECK (slots >= 0),
  busy         smallint    NOT NULL DEFAULT 0 CHECK (busy >= 0),
  -- Written by the scheduler, read on heartbeat. jup_quota is Jupiter calls a
  -- MINUTE, the pacer's unit (src/rpc-quota.ts).
  rps_quota    real,
  jup_quota    real,
  -- When the scheduler last wrote the two quotas, by the database's clock. A
  -- worker reads clock_timestamp() − quota_at, an age on one clock, and drops to
  -- its floor two minutes after the SCHEDULER last wrote, never after its own
  -- last read: heartbeat_at is the worker's own and stays fresh while the
  -- scheduler is dead. NULL until the first hand-out.
  quota_at     timestamptz,
  stopped_at   timestamptz,
  stats        jsonb       NOT NULL DEFAULT '{}'
);

-- RPC and REST usage in 10-minute buckets, by lane and bill line. Kept 35 days.
-- Written by every process's RpcUsageCollector and read by the scheduler's
-- credit governor (src/credit-governor.ts), through PgRpcUsageFeed
-- (src/dispatch-store.ts), which ADDS a flush onto the row it shares a key with.
CREATE TABLE IF NOT EXISTS sip_solana.rpc_usage (
  bucket       timestamptz NOT NULL,
  worker_id    text        NOT NULL,
  -- helius-rpc | helius-rest | jupiter | privy | other
  provider     text        NOT NULL,
  -- send | hot | rest | sched: a send is told apart by its lane.
  lane         text        NOT NULL,
  -- The code's bill lines (CreditClass in src/rpc-usage.ts: standard,
  -- programAccounts, programAccountsV2, archival, webSocketConfirmation,
  -- webhookEvent, …) plus jupiter and privy; not the queue draft's
  -- std | gpa | … vocabulary, which would need a translation that could drift.
  -- Unchecked here so that a new bill line needs no schema change.
  class        text        NOT NULL,
  calls        bigint      NOT NULL CHECK (calls >= 0),
  errors_429   bigint      NOT NULL DEFAULT 0 CHECK (errors_429 >= 0),
  errors_other bigint      NOT NULL DEFAULT 0 CHECK (errors_other >= 0),
  PRIMARY KEY (bucket, worker_id, provider, lane, class)
);

-- One row of fleet-wide flags any replica may raise and the scheduler consumes.
--
-- new_vault_system (plan P3a design detail 3): what a newly discovered vault is
-- inserted as. 'legacy' until the last vault moves (P3d), then 'queue'.
CREATE TABLE IF NOT EXISTS sip_solana.fleet (
  id               boolean     PRIMARY KEY DEFAULT true CHECK (id),
  scheduler_id     text,
  tick_at          timestamptz,
  -- e.g. a delivery lost on a receiver replica.
  full_pass_reason text,
  -- The debounced leaderboard refresh.
  board_dirty_at   timestamptz,
  discovery_ok_at  timestamptz,
  new_vault_system text        NOT NULL DEFAULT 'legacy' CHECK (new_vault_system IN ('legacy', 'queue'))
);
INSERT INTO sip_solana.fleet (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
