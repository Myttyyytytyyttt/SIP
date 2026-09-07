// One-shot Supabase cleanup + the Nuvem read-model schemas, idempotent.
//
//   DATABASE_URL=postgresql://… node scripts/setup-read-model.mjs [--dry-run]
//
// WHAT IT DELETES: exactly the eight tables another (unrelated) app left in
// `public`, each one named here by hand. The owner confirmed the deletion,
// warned that it is permanent. There is NO wildcard and NO `DROP SCHEMA
// public` — Supabase hangs extensions and internal objects off that schema.
//
// WHAT IT NEVER TOUCHES: the `nuvem_4663_*` schemas. They are the RH keeper's
// LIVE durable journal (settlements, anchors, locks); this script counts them
// before and after and aborts loudly if the numbers were ever to differ.
//
// WHAT IT CREATES: `nuvem_rh` and `nuvem_solana`, mirror-image read models —
// one per chain, because the owner wants to find things by schema, not by a
// `chain` column. THE CONTRACT, stated here and in the table comments:
// everything in them is DERIVED and REBUILDABLE from the chain or the keeper
// journal. It is never a source of truth (discovery.ts: "ask the chain, not a
// database"); a row that disagrees with the chain is a writer bug.

import pg from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const url = process.env.DATABASE_URL ?? process.env.NUVEM_KEEPER_DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Refusing to guess where to run DDL.");
  process.exit(2);
}

// Same TLS posture as the keeper's journal (ledger-pg.ts sslOptionsFor):
// Supabase terminates TLS with a cert the default chain rejects; encrypted
// with relaxed validation unless sslmode=disable was explicit.
const sslmode = (() => {
  try {
    return new URL(url).searchParams.get("sslmode")?.toLowerCase() ?? null;
  } catch {
    return null;
  }
})();
const ssl = sslmode === "disable" ? false : { rejectUnauthorized: false };

/** The other app's tables, a CLOSED list. Nothing else in public is touched. */
const FOREIGN_TABLES = [
  "agent_decisions",
  "agent_profiles",
  "follows",
  "fund_channels",
  "message_reactions",
  "messages",
  "notifications",
  "profiles",
];

const READ_MODEL_TABLES = (schema) => `
CREATE SCHEMA IF NOT EXISTS ${schema};

-- DERIVED AND REBUILDABLE. Written only by the Nuvem keeper/drill; the web
-- only reads. Drop-and-backfill must reproduce it; the chain is the truth.

CREATE TABLE IF NOT EXISTS ${schema}.vault (
  vault_addr   text PRIMARY KEY,
  owner_addr   text NOT NULL,
  skim_bps     integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${schema}.trading_link (
  wallet_addr  text PRIMARY KEY,
  vault_addr   text NOT NULL,
  linked_at    timestamptz NOT NULL DEFAULT now(),
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS ${schema}.settlement_event (
  wallet_addr       text NOT NULL,
  nonce             bigint NOT NULL,
  vault_addr        text NOT NULL,
  profit_raw        numeric NOT NULL,
  contribution_raw  numeric NOT NULL,
  tx_ref            text NOT NULL,
  height            bigint NOT NULL,
  at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_addr, nonce)
);

CREATE TABLE IF NOT EXISTS ${schema}.investment_event (
  id            bigserial PRIMARY KEY,
  vault_addr    text NOT NULL,
  target        text NOT NULL,
  spent_raw     numeric NOT NULL,
  received_raw  numeric NOT NULL,
  tx_ref        text NOT NULL UNIQUE,
  height        bigint NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ${schema}_settle_by_vault
  ON ${schema}.settlement_event (vault_addr, at DESC);
CREATE INDEX IF NOT EXISTS ${schema}_invest_by_vault
  ON ${schema}.investment_event (vault_addr, at DESC);
`;

const client = new pg.Client({ connectionString: url, ssl });
await client.connect();

const journalCount = async () =>
  Number(
    (
      await client.query(
        `SELECT count(*) FROM information_schema.schemata WHERE schema_name LIKE 'nuvem\\_4663\\_%'`,
      )
    ).rows[0].count,
  );

try {
  const journalsBefore = await journalCount();
  console.log(`RH keeper journals present (untouchable): ${journalsBefore}`);

  console.log(DRY_RUN ? "\n[dry-run] would drop from public:" : "\ndropping from public:");
  for (const table of FOREIGN_TABLES) {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [table],
    );
    const tag = exists.rowCount ? "drop" : "absent (skip)";
    console.log(`  ${tag.padEnd(14)} public.${table}`);
    if (!DRY_RUN && exists.rowCount) {
      await client.query(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    }
  }

  console.log(DRY_RUN ? "\n[dry-run] would create:" : "\ncreating:");
  for (const schema of ["nuvem_rh", "nuvem_solana"]) {
    console.log(`  ${schema}.{vault, trading_link, settlement_event, investment_event}`);
    if (!DRY_RUN) await client.query(READ_MODEL_TABLES(schema));
  }

  const journalsAfter = await journalCount();
  if (journalsAfter !== journalsBefore) {
    throw new Error(
      `journal schema count moved ${journalsBefore} -> ${journalsAfter}; this script must never affect them`,
    );
  }
  console.log(`\njournals verified intact: ${journalsAfter}. Done${DRY_RUN ? " (dry-run, nothing changed)" : ""}.`);
} finally {
  await client.end();
}
