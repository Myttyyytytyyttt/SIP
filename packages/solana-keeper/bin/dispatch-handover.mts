#!/usr/bin/env node
// The two-step handover of a vault between the legacy keepers and the
// dispatcher's queue (src/handover.ts; docs/runbooks/RAILWAY_SOLANA.md §10).
//
//   DATABASE_URL=… SIP_SOLANA_RPC_URLS=… pnpm --dir packages/solana-keeper dispatch-handover <command> …
//
// An OPERATOR'S command, never started by production (test/dispatch-dark.test.ts
// lists it as the dispatcher's own). It writes vault_work, legacy_process and
// fleet in the database DATABASE_URL names — production SQL, which is the
// owner's to run — and READS two block heights from the first endpoint of
// SIP_SOLANA_RPC_URLS for `arm` and `release`; it sends nothing to the chain and
// holds no key.
//
// THE URLS ARE NEVER PRINTED: both are registered with the shared redactor before
// anything can fail, every line goes through the keeper's logger, and a failure
// is reported by its summarized error. The decisions live in src/handover-cli.ts
// and src/handover.ts, tested without a database or a chain.

// FIRST, so every library that prints while loading prints through the redactor.
import "../src/console-bridge.js";
import { Connection } from "@solana/web3.js";
import pg from "pg";
import { sharedRedactor, summarizeUpstreamError } from "@sip/solana-log";
import { Handover, readChainHeights, type ChainHeights } from "../src/handover.js";
import { HANDOVER_USAGE, parseHandoverArgs, runHandoverCommand, type HandoverCommand } from "../src/handover-cli.js";
import { createKeeperLogger } from "../src/keeper-log.js";
import { sslFor } from "../src/read-model.js";

const log = createKeeperLogger();
const bigintSafe = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);

let command: HandoverCommand;
try {
  command = parseHandoverArgs(process.argv.slice(2));
} catch (error) {
  log.error("refused", { detail: error instanceof Error ? error.message : String(error), usage: HANDOVER_USAGE });
  process.exit(2);
}

const databaseUrl = process.env["DATABASE_URL"]?.trim();
if (!databaseUrl) {
  log.error("DATABASE_URL is not set. Refusing to guess which database holds the handover.");
  process.exit(2);
}
sharedRedactor.register(databaseUrl, "databaseUrl");
try {
  const password = new URL(databaseUrl).password;
  if (password !== "") sharedRedactor.register(password, "databaseUrl");
} catch {
  // Unparseable: the whole string is registered, and pg will refuse it below.
}

const rpcUrl = (process.env["SIP_SOLANA_RPC_URLS"] ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .find((entry) => entry !== "");
if (rpcUrl !== undefined) sharedRedactor.register(rpcUrl, "rpcUrl:0");

/**
 * Read only, and only for the commands that wait on the chain: processed first,
 * then finalized, by the one reader the scheduler's auto-arm uses too
 * (readChainHeights, src/handover.ts).
 */
async function heights(): Promise<ChainHeights> {
  if (rpcUrl === undefined) throw new Error("SIP_SOLANA_RPC_URLS is not set: arm and release read the chain's block height");
  return readChainHeights(new Connection(rpcUrl, { commitment: "finalized" }));
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: sslFor(databaseUrl),
  max: 1,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
  query_timeout: 5_000,
  application_name: "dispatch-handover",
});
pool.on("error", (error) => log.warn("idle database connection error (ignored)", { detail: summarizeUpstreamError(error) }));

try {
  const { ok, result } = await runHandoverCommand(command, { handover: new Handover(pool), heights });
  // ONE LINE, through the logger and so through the redactor.
  (ok ? log.info : log.warn)(`dispatch-handover ${command.kind}`, { ok, result: JSON.parse(JSON.stringify(result, bigintSafe)) as unknown });
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  log.error(`dispatch-handover ${command.kind} failed`, { detail: summarizeUpstreamError(error, { take: 3 }) });
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
