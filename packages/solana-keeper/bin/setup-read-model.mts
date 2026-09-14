#!/usr/bin/env node
// Creates SIP's Solana read model — the sip_solana schema — idempotently.
//
//   DATABASE_URL=postgresql://… pnpm --dir packages/solana-keeper setup-read-model [--dry-run]
//
// Ported from Nuvem's packages/keeper/scripts/setup-read-model.mjs, keeping only
// the part that belongs to this keeper: the schema, from sql/sip_solana.sql.
// Nuvem's script also dropped another app's tables from `public` and created the
// Robinhood Chain read model beside this one; neither is SIP's to touch.
//
// THE URL IS NEVER PRINTED. It carries the database password, so it is
// registered with the shared redactor before anything can fail, every line goes
// through the keeper's logger, and a failure is reported by its summarized
// error, never by the connection string.

// FIRST, so every library that prints while loading prints through the redactor.
import "../src/console-bridge.js";
import { readFileSync } from "node:fs";
import pg from "pg";
import { sharedRedactor, summarizeUpstreamError } from "@sip/solana-log";
import { createKeeperLogger } from "../src/keeper-log.js";
import { READ_MODEL_SCHEMA, READ_MODEL_TABLES, sslFor } from "../src/read-model.js";

const log = createKeeperLogger();
const DRY_RUN = process.argv.includes("--dry-run");
const sql = readFileSync(new URL("../sql/sip_solana.sql", import.meta.url), "utf8");

const url = process.env["DATABASE_URL"]?.trim();
if (!url) {
  log.error("DATABASE_URL is not set. Refusing to guess where to run DDL.");
  process.exit(2);
}
sharedRedactor.register(url, "databaseUrl");
try {
  const password = new URL(url).password;
  if (password !== "") sharedRedactor.register(password, "databaseUrl");
} catch {
  // Unparseable: the whole string is registered, and pg will refuse it below.
}

if (DRY_RUN) {
  log.info("dry run: would apply sql/sip_solana.sql", { schema: READ_MODEL_SCHEMA, tables: [...READ_MODEL_TABLES] });
  process.exit(0);
}

const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });
try {
  await client.connect();
  await client.query(sql);
  const missing = await client.query<{ name: string }>(
    `SELECT t.name FROM unnest($1::text[]) AS t(name) WHERE to_regclass('${READ_MODEL_SCHEMA}.' || t.name) IS NULL`,
    [[...READ_MODEL_TABLES]],
  );
  if (missing.rows.length > 0) {
    log.error("the schema was applied but tables are still missing", { missing: missing.rows.map((row) => row.name) });
    process.exitCode = 1;
  } else {
    log.info("read model ready", { schema: READ_MODEL_SCHEMA, tables: [...READ_MODEL_TABLES] });
  }
} catch (error) {
  log.error("read model setup failed", { detail: summarizeUpstreamError(error, { take: 3 }) });
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
