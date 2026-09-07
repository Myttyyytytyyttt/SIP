// Does the Postgres schema refuse everything the SQLite one refuses?
//
// The journal's safety does not live in application code — it lives in eight
// partial unique indexes and three triggers that fire at INSERT of an INTENT,
// which is BEFORE anything is broadcast. The database refuses to let the keeper
// form the intention to double-settle.
//
// A loose port would remove one of those nets SILENTLY: everything would still
// work, and the store would simply stop refusing something it must refuse. The
// defect would surface as a duplicate settlement, months later, in production.
//
// So each constraint is exercised here against a REAL Postgres rather than
// assumed to have survived translation. These tests skip when DATABASE_URL is
// unset, so the suite still runs without one — but the skip is loud, because a
// silently skipped safety test is the same problem one level up.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { postgresDdl } from "../src/ledger-pg-schema.js";
import { sslOptionsFor } from "../src/ledger-pg.js";

const URL = process.env.DATABASE_URL;
const SCHEMA = "nuvem_ledger_schema_test";
const ACCOUNT = "0xa93095bb98e8b578e1560ded648d194fe4a335fa";

const describeIfPg = URL ? describe : describe.skip;
if (!URL) {
  console.warn(
    "\n  ! ledger-pg-schema.test.ts SKIPPED: DATABASE_URL is not set.\n" +
      "    The Postgres journal's constraints are therefore UNVERIFIED in this run.\n",
  );
}

describeIfPg("the Postgres journal refuses what the SQLite one refuses", () => {
  let client: pg.Client;
  let seq = 0;

  /** A settlement row, with only the fields a given case needs overridden. */
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    record_seq: null,
    account: ACCOUNT,
    status: "INTENT",
    origin: "KEEPER",
    start_block_l2: 1000,
    end_block_l2: 1100,
    prev_end_block_l2: null,
    l2_precision: "EXACT",
    binding_epoch: 1,
    settlement_nonce: 0,
    start_block_l1: 500,
    end_block_l1: 501,
    session_id: "0xsession",
    ledger_root: "0xroot",
    contribution_wei: "1000",
    realized_profit_wei: "5000",
    created_at: "2026-08-10T00:00:00Z",
    ...over,
  });

  /** Inserts a settlement, writing the record row it references first. */
  async function insert(over: Record<string, unknown> = {}): Promise<void> {
    seq += 1;
    await client.query(
      `INSERT INTO record(seq, ts, type, prev_digest, digest, body)
       VALUES ($1, 'now', 'INTENT', '0x0', '0x1', '{}')`,
      [seq],
    );
    const data = row({ record_seq: seq, ...over });
    const keys = Object.keys(data);
    await client.query(
      `INSERT INTO settlement(${keys.join(",")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
      keys.map((k) => data[k]),
    );
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: URL, ssl: sslOptionsFor(URL!) });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(postgresDdl(SCHEMA));
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(
      `INSERT INTO instance(id, chain_id, factory, executor, vault, account,
                            ledger_schema, engine_schema, created_at)
       VALUES (1, 4663, '0xf', '0xe', '0xv', $1, 'v2', 'v2', 'now')`,
      [ACCOUNT],
    );
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it("accepts the first settlement, which is the control", async () => {
    await expect(insert()).resolves.toBeUndefined();
  });

  it("refuses an exact replay of a settled window", async () => {
    await expect(insert({ settlement_nonce: 1, session_id: "0xdifferent" })).rejects.toThrow();
  });

  /** binding_epoch is audit data. A rebind must not re-open a settled window. */
  it("refuses a replay under a NEW binding epoch, which is the whole point", async () => {
    await expect(
      insert({ binding_epoch: 99, settlement_nonce: 1, session_id: "0xnew" }),
    ).rejects.toThrow();
  });

  it("refuses a second origin of the frontier chain", async () => {
    // prev = NULL twice would be two unlinked beginnings of history.
    await expect(
      insert({ start_block_l2: 5000, end_block_l2: 5100, settlement_nonce: 1, session_id: "0xg" }),
    ).rejects.toThrow();
  });

  it("refuses a window that does not extend the CURRENT frontier", async () => {
    // Frontier is 1100. Linking from 900 is a fork, not an extension.
    await expect(
      insert({
        start_block_l2: 2000,
        end_block_l2: 2100,
        prev_end_block_l2: 900,
        settlement_nonce: 1,
        session_id: "0xfork",
      }),
    ).rejects.toThrow(/frontier violation/);
  });

  it("refuses a second intent while one is unresolved (single flight)", async () => {
    await expect(
      insert({
        start_block_l2: 2000,
        end_block_l2: 2100,
        prev_end_block_l2: 1100,
        settlement_nonce: 1,
        session_id: "0xsecond",
      }),
    ).rejects.toThrow();
  });

  it("refuses a settlement nonce the vault has already consumed", async () => {
    await client.query(
      `UPDATE settlement SET status='CONFIRMED', resolved_at='now' WHERE status='INTENT'`,
    );
    await expect(
      insert({
        start_block_l2: 2000,
        end_block_l2: 2100,
        prev_end_block_l2: 1100,
        settlement_nonce: 0,
        session_id: "0xnonce",
      }),
    ).rejects.toThrow();
  });

  it("accepts a genuine forward extension", async () => {
    await expect(
      insert({
        start_block_l2: 2000,
        end_block_l2: 2100,
        prev_end_block_l2: 1100,
        settlement_nonce: 1,
        session_id: "0xforward",
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a window that runs backwards", async () => {
    await expect(insert({ start_block_l2: 3000, end_block_l2: 2900 })).rejects.toThrow();
  });

  it("refuses a wei value that is not a decimal integer", async () => {
    await expect(insert({ contribution_wei: "1.5" })).rejects.toThrow();
    await expect(insert({ contribution_wei: "0x10" })).rejects.toThrow();
  });

  it("refuses an account that is not a lowercase 20-byte address", async () => {
    // Mixed-case EIP-55 against lowercase is a silent miss in a text join, and a
    // missed join here is a missed dedup.
    await expect(
      client.query(
        `INSERT INTO instance(id, chain_id, factory, executor, vault, account,
                              ledger_schema, engine_schema, created_at)
         VALUES (2, 4663, '0xf', '0xe', '0xv', '0xA93095BB98E8B578E1560DED648D194FE4A335FA',
                 'v2', 'v2', 'now')`,
      ),
    ).rejects.toThrow();
  });

  it("refuses a second identity in one store", async () => {
    await expect(
      client.query(
        `INSERT INTO instance(id, chain_id, factory, executor, vault, account,
                              ledger_schema, engine_schema, created_at)
         VALUES (1, 4663, '0xf', '0xe', '0xv', '0x1111111111111111111111111111111111111111',
                 'v2', 'v2', 'now')`,
      ),
    ).rejects.toThrow();
  });

  it("never lets a record be edited or deleted", async () => {
    await expect(client.query(`UPDATE record SET body='{"tampered":true}' WHERE seq=1`)).rejects.toThrow(
      /immutable/,
    );
    await expect(client.query(`DELETE FROM record WHERE seq=1`)).rejects.toThrow(/immutable/);
  });

  it("never lets a settlement be deleted", async () => {
    await expect(client.query(`DELETE FROM settlement`)).rejects.toThrow(/never deleted/);
  });

  it("never lets a settled window's identity be rewritten", async () => {
    await expect(
      client.query(`UPDATE settlement SET contribution_wei='999999' WHERE settlement_nonce=0`),
    ).rejects.toThrow(/immutable/);
  });

  it("never lets a resolved settlement change status again", async () => {
    await expect(
      client.query(`UPDATE settlement SET status='FAILED' WHERE status='CONFIRMED'`),
    ).rejects.toThrow(/only an INTENT/);
  });
});
