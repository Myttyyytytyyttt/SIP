#!/usr/bin/env node
// Rebuilds sip_solana.settlement_event FROM THE CHAIN.
//
//   bash -c '. ~/sip-keys/sip-hackathon.env; pnpm --dir packages/solana-keeper backfill-settlements'
//   …same, with --write, to actually write
//
// WHY IT EXISTS. sql/sip_solana.sql opens with a promise: the mirror is derived
// and rebuildable, the chain is the truth, and a drop-and-backfill must
// reproduce every row. A promise nobody can execute is not one. This is the
// executable half — and it is not hypothetical: every write in read-model.ts is
// fire-and-forget by design, so a database blink, a deploy ahead of its
// migration, or a settle whose signature never came back (the Privy 504 path)
// leaves a hole that nothing else fills. The leaderboard ranks on these rows,
// which makes a hole a wrong ranking rather than a missing line in a feed.
//
// DRY RUN BY DEFAULT. It prints what it would write and writes nothing until
// --write. Re-running it is safe: the insert is an upsert keyed by
// (wallet_addr, nonce), and a row already written as it happened keeps its own
// timestamp and its own measured volume.
//
// WHAT IT CANNOT RECOVER: `volume_raw`. The notional comes from walking the
// window's transactions at the time (measure-window.ts), and a normal RPC keeps
// two or three days of history — the walk cannot be re-run for a window that
// has aged out. Backfilled rows therefore carry 0 and count for the savings
// board only. That is the honest value: nobody measured their volume.

// FIRST, so every library that prints while loading prints through the redactor.
import "../src/console-bridge.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { Secret, sharedRedactor, summarizeUpstreamError } from "@sip/solana-log";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { createKeeperLogger } from "../src/keeper-log.js";
import { readTransaction } from "../src/measure-window.js";
import { SolanaReadModel, type SettlementRow } from "../src/read-model.js";
import { settledEventsFrom } from "../src/settled-event.js";

const log = createKeeperLogger();

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const option = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const WRITE = flag("write");
const MAX_PAGES = option("max-pages", 5);
const PAGE = 1_000;
/** A pause between transaction reads. A backfill is never urgent; a 429 is. */
const DELAY_MS = option("delay-ms", 120);

// ── the two inputs, registered before anything can fail ──────────────────────
const rpcRaw = (process.env["SIP_SOLANA_RPC_URLS"] ?? process.env["SIP_SOLANA_RPC_URL"] ?? "").split(",")[0]?.trim() ?? "";
if (rpcRaw === "") {
  log.error("SIP_SOLANA_RPC_URLS is not set. Refusing to guess an endpoint.");
  process.exit(2);
}
sharedRedactor.register(rpcRaw, "rpcUrl");
try {
  const key = new URL(rpcRaw).searchParams.get("api-key");
  if (key !== null && key !== "") sharedRedactor.register(key, "rpcUrl");
} catch {
  log.error("SIP_SOLANA_RPC_URLS is not a URL.");
  process.exit(2);
}

const databaseRaw = process.env["DATABASE_URL"]?.trim() ?? "";
if (WRITE && databaseRaw === "") {
  log.error("--write needs DATABASE_URL. Refusing to guess which database to write.");
  process.exit(2);
}
if (databaseRaw !== "") {
  sharedRedactor.register(databaseRaw, "databaseUrl");
  try {
    const password = new URL(databaseRaw).password;
    if (password !== "") sharedRedactor.register(password, "databaseUrl");
  } catch {
    // Unparseable: the whole string is registered, and pg will refuse it below.
  }
}

const programId = new PublicKey(SIP_PROGRAM_ID);
const connection = new Connection(rpcRaw, "finalized");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A READ THAT FAILS IS NOT A BACKFILL THAT FAILS. The first version of this
 * script let a 429 escape, and one throttled response threw away every
 * transaction already read — on a public endpoint that is not an edge case,
 * it is the second minute. Three tries with a widening pause, then the caller
 * decides; nothing here is urgent and everything here is idempotent.
 */
async function attempt<T>(what: string, work: () => Promise<T>): Promise<T | null> {
  for (let tries = 0; tries < 3; tries++) {
    try {
      return await work();
    } catch (error) {
      const wait = 1_000 * 2 ** tries;
      log.warn(`${what} failed; retrying`, { in: `${wait}ms`, detail: summarizeUpstreamError(error) });
      await sleep(wait);
    }
  }
  return null;
}

log.info("backfill starting", { program: SIP_PROGRAM_ID, mode: WRITE ? "WRITE" : "dry run", maxPages: MAX_PAGES });

// ── 1. every signature that touched the program, newest first ────────────────
const signatures: { signature: string; slot: number; err: unknown }[] = [];
let before: string | undefined;
for (let page = 0; page < MAX_PAGES; page++) {
  const batch = await attempt("signature page", () =>
    connection.getSignaturesForAddress(programId, before === undefined ? { limit: PAGE } : { before, limit: PAGE }, "finalized"),
  );
  if (batch === null) {
    // Refusing to continue is the honest answer: the pages below this one are
    // the OLDER history, and skipping them silently would look complete.
    log.error("a page of signatures could not be read; stopping rather than rebuilding a partial history", { read: signatures.length });
    process.exit(1);
  }
  signatures.push(...batch.map((entry) => ({ signature: entry.signature, slot: entry.slot, err: entry.err })));
  if (batch.length < PAGE) break;
  before = batch[batch.length - 1]!.signature;
  if (page === MAX_PAGES - 1) {
    // SAYING SO IS THE POINT. A silent stop looks like "that is all there is",
    // and the operator would believe a partial rebuild was a complete one.
    log.warn("stopped at the page limit; older history was not read", { maxPages: MAX_PAGES, raise: "--max-pages N" });
  }
}
// Oldest first: the order they happened, which is the order to write them in.
signatures.reverse();
log.info("signatures read", { count: signatures.length, failed: signatures.filter((entry) => entry.err !== null).length });

// ── 2. the settlements they prove ────────────────────────────────────────────
const rows: (SettlementRow & { day: string })[] = [];
let read = 0;
let unreadable = 0;
for (const entry of signatures) {
  // A REVERTED TRANSACTION SETTLED NOTHING, and its logs may still carry an
  // event from the part that ran before the failure.
  if (entry.err !== null) continue;
  // THROUGH readTransaction, for its version contract: the signatures above are
  // EVERY transaction that touched the program, not only the keeper's own, and
  // one signed as version 1 (Axiom signs that way) is refused under 0: retried
  // three times, then reported below as a hole that no re-run fills.
  const tx = await attempt("transaction", () => readTransaction(connection, entry.signature, "finalized"));
  read += 1;
  if (tx === null || !tx.meta) {
    // A null is not an absence: a throttling RPC returns one without erroring.
    unreadable += 1;
    continue;
  }
  if (tx.meta.err !== null) continue;
  for (const event of settledEventsFrom(tx.meta.logMessages ?? [], SIP_PROGRAM_ID)) {
    const at = new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000);
    rows.push({
      walletAddr: event.wallet,
      nonce: event.settlementNonce,
      vaultAddr: event.vault,
      mode: event.mode,
      baseRaw: event.baseLamports,
      contributionRaw: event.paid,
      // Unrecoverable from here, and 0 is the honest value — see the header.
      volumeRaw: 0n,
      txRef: entry.signature,
      height: event.sessionEndSlot,
      // THE BLOCK'S TIME, NOT now(). The leaderboard groups by calendar day.
      at,
      day: at.toISOString().slice(0, 10),
    });
  }
  if (DELAY_MS > 0) await sleep(DELAY_MS);
}

const byVault = new Map<string, number>();
for (const row of rows) byVault.set(row.vaultAddr, (byVault.get(row.vaultAddr) ?? 0) + 1);
log.info("settlements found", {
  rows: rows.length,
  transactionsRead: read,
  unreadable,
  vaults: byVault.size,
  firstDay: rows[0]?.day ?? null,
  lastDay: rows[rows.length - 1]?.day ?? null,
  lamports: rows.reduce((total, row) => total + row.contributionRaw, 0n).toString(),
});
for (const row of rows) {
  log.info("settlement", {
    day: row.day,
    vault: row.vaultAddr,
    wallet: row.walletAddr,
    nonce: row.nonce.toString(),
    mode: row.mode === 1 ? "VOLUME" : "PROFIT",
    base: row.baseRaw.toString(),
    paid: row.contributionRaw.toString(),
    tx: row.txRef.slice(0, 12),
  });
}

if (unreadable > 0) {
  // An incomplete read must not be presented as a complete rebuild.
  log.warn("some transactions could not be read; this rebuild has holes", { unreadable, advice: "re-run; the upsert is idempotent" });
}

if (!WRITE) {
  log.info("dry run: nothing was written", { wouldWrite: rows.length, howToWrite: "re-run with --write" });
  process.exit(0);
}

// ── 3. write them ────────────────────────────────────────────────────────────
const readModel = SolanaReadModel.create(new Secret(databaseRaw, "databaseUrl"), (message, fields) => log.warn(message, fields));
const preflight = await readModel.preflight();
if (!preflight.ok) {
  log.error("the read model is not usable; nothing was written", { detail: preflight.detail });
  await readModel.close();
  process.exit(1);
}
let written = 0;
let refused = 0;
for (const row of rows) {
  const ok = await readModel.recordSettlement(row);
  if (ok) written += 1;
  else refused += 1;
}
await readModel.close();
log.info("backfill finished", { written, refused, note: "volume_raw is 0 on rebuilt rows; the savings board is unaffected" });
if (refused > 0) process.exitCode = 1;
