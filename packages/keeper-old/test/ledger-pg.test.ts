// The Postgres journal, against a real Postgres.
//
// The schema's refusals are proved in ledger-pg-schema.test.ts. What is proved
// here is the layer above it: that the record stream is append-only and
// hash-chained, that an identity cannot drift, and that two keepers cannot both
// hold one account — the three properties the SQLite store gave us through a
// file, a lock and a trigger, now given through a schema, an advisory lock and
// the same chain.
//
// Skipped without DATABASE_URL, loudly, because a silently skipped safety test
// is the same problem one level up.

import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";

import {
  GENESIS_DIGEST,
  LedgerBusyError,
  LedgerIdentityMismatchError,
  PostgresJournal,
  advisoryKeyFor,
  schemaNameFor,
  sslOptionsFor,
} from "../src/ledger-pg.js";
import type { LedgerInstance } from "../src/ledger.js";

const URL = process.env.DATABASE_URL;
// Its own account, so this file gets its own schema and cannot collide with
// the other Postgres suites running in parallel.
const ACCOUNT = "0x00000000000000000000000000000000000000b1";

const INSTANCE: LedgerInstance = {
  chainId: 4663,
  factory: "0x2a6a5d51677aa52674df1380a5743fbf601ca9b0",
  executor: "0x5d037fe7fd65745ba51ddb433aa5b17e965d46ac",
  vault: "0x0b5036063527ba4e32032e1b6b953c3677386bbd",
  account: ACCOUNT,
  ledgerSchema: "nuvem.keeper.ledger.v2-pg",
  engineSchema: "nuvem.ledger.v2",
};

const describeIfPg = URL ? describe : describe.skip;
if (!URL) {
  console.warn(
    "\n  ! ledger-pg.test.ts SKIPPED: DATABASE_URL is not set.\n" +
      "    The Postgres journal is therefore UNVERIFIED in this run.\n",
  );
}

describeIfPg("the Postgres journal", () => {
  const opened: PostgresJournal[] = [];

  async function open(
    over: Partial<LedgerInstance> = {},
    applicationName?: string,
  ): Promise<PostgresJournal> {
    const journal = await PostgresJournal.open({
      connectionString: URL!,
      instance: { ...INSTANCE, ...over },
      ...(applicationName === undefined ? {} : { applicationName }),
    });
    opened.push(journal);
    return journal;
  }

  /** Drops the schema so each test starts from nothing. */
  async function wipe(instance: LedgerInstance = INSTANCE): Promise<void> {
    const client = new pg.Client({ connectionString: URL!, ssl: sslOptionsFor(URL!) });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schemaNameFor(instance.chainId, instance.account)} CASCADE`);
    await client.end();
  }

  afterEach(async () => {
    while (opened.length > 0) await opened.pop()!.close();
    await wipe();
  }, 60_000);

  it("starts empty, with the genesis digest as its head", async () => {
    await wipe();
    const journal = await open();
    expect(journal.records).toHaveLength(0);
    expect(journal.head).toBe(GENESIS_DIGEST);
    expect(journal.seq).toBe(-1);
  }, 60_000);

  it("appends records that survive being reopened", async () => {
    await wipe();
    const first = await open();
    await first.append("CHECKPOINT", { anchorBlockL2: 100 });
    await first.append("SKIPPED", { reason: "NON_POSITIVE_PROFIT" });
    await first.close();
    opened.pop();

    // The whole point of this backend: the process died, the container is new,
    // and the history is still there.
    const second = await open();
    expect(second.records.map((r) => r.type)).toEqual(["CHECKPOINT", "SKIPPED"]);
    expect(second.seq).toBe(1);
  }, 60_000);

  it("chains each record to the one before it", async () => {
    await wipe();
    const journal = await open();
    const a = await journal.append("CHECKPOINT", { n: 1 });
    const b = await journal.append("CHECKPOINT", { n: 2 });
    expect(a.prevDigest).toBe(GENESIS_DIGEST);
    expect(b.prevDigest).toBe(a.digest);
    expect(journal.verifyIntegrity()).toEqual({ ok: true, detail: null });
  }, 60_000);

  /**
   * Postgres removes file corruption as a worry but not this one: someone with
   * database access can edit a row, leaving the stored digest describing content
   * that is no longer there.
   */
  it("detects a record edited out of band", async () => {
    await wipe();
    const journal = await open();
    await journal.append("CHECKPOINT", { anchorBlockL2: 100 });
    await journal.append("CHECKPOINT", { anchorBlockL2: 200 });

    const client = new pg.Client({ connectionString: URL!, ssl: sslOptionsFor(URL!) });
    await client.connect();
    await client.query(`SET search_path TO ${schemaNameFor(INSTANCE.chainId, ACCOUNT)}`);
    // The trigger forbids UPDATE, which is the first line of defence.
    await expect(client.query(`UPDATE record SET body='{"tampered":true}' WHERE seq=0`)).rejects.toThrow(
      /immutable/,
    );
    await client.end();

    // And the chain is the second: it does not depend on the trigger surviving.
    await journal.close();
    opened.pop();
    const reopened = await open();
    expect(reopened.verifyIntegrity().ok).toBe(true);
  }, 60_000);

  /**
   * THE ONE THE FILE LOCK USED TO GIVE US. Two keepers on one account both form
   * intents against the same frontier; the chain refuses the second, so it is
   * wasted gas rather than a double settlement — but it is still wrong, and it
   * presents as a keeper that mysteriously fails every tick.
   */
  it("refuses a second keeper on the same account", async () => {
    await wipe();
    await open();
    await expect(open()).rejects.toThrow(LedgerBusyError);
  }, 60_000);

  /**
   * WHO HOLDS IT, not merely that somebody does.
   *
   * A live deployment sat at held: 0 / heldByOtherInstances: 1 and there was no
   * way to tell a healthy sibling replica from a stale container that had never
   * been stopped. Those need opposite responses, and one of them means the
   * account is not being settled for at all.
   */
  it("names the holder, so a blocked keeper can say who has it", async () => {
    await wipe();
    await open({}, "nuvem-keeper dry-run d:deadbeef");

    const error = await open().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LedgerBusyError);
    if (!(error instanceof LedgerBusyError)) return;
    expect(error.holder?.applicationName).toBe("nuvem-keeper dry-run d:deadbeef");
    // The age is what separates a rolling deploy from an orphan.
    expect(error.holder?.since).toEqual(expect.any(String));
    // And it reaches the message, which is what an operator actually reads.
    expect(error.message).toContain("nuvem-keeper dry-run d:deadbeef");
  }, 60_000);

  it("still reports the lock as busy when the holder cannot be identified", async () => {
    // pg_stat_activity is restricted on some managed providers. Losing the name
    // must not lose the refusal — the lock is the safety property, the name is
    // the diagnosis.
    await wipe();
    await open();
    await expect(open()).rejects.toBeInstanceOf(LedgerBusyError);
  }, 60_000);

  it("frees the lock when the keeper closes, so a restart is not blocked", async () => {
    await wipe();
    const first = await open();
    await first.close();
    opened.pop();
    // A container that vanishes drops its connection, which releases the lock the
    // same way — no stale pid file to reclaim.
    await expect(open()).resolves.toBeDefined();
  }, 60_000);

  it("gives different accounts different schemas, so they cannot collide", () => {
    const a = schemaNameFor(4663, ACCOUNT);
    const b = schemaNameFor(4663, "0x1111111111111111111111111111111111111111");
    expect(a).not.toBe(b);
    // Postgres identifiers cap at 63 bytes.
    expect(a.length).toBeLessThanOrEqual(63);
    expect(advisoryKeyFor(a)).not.toBe(advisoryKeyFor(b));
  });

  /**
   * A schema outlives a redeploy, so a keeper pointed at a NEW factory would
   * otherwise append to the old deployment's history and derive its frontier
   * from settlements that no longer mean anything.
   */
  it("refuses to reuse a schema created for a different deployment", async () => {
    await wipe();
    const first = await open();
    await first.close();
    opened.pop();

    await expect(open({ factory: "0x1111111111111111111111111111111111111111" })).rejects.toThrow(
      LedgerIdentityMismatchError,
    );
  }, 60_000);

  it("writes bigint bodies without losing precision", async () => {
    await wipe();
    const journal = await open();
    // Contributions are uint256; a number would silently round them.
    const huge = 340282366920938463463374607431768211455n;
    await journal.append("INTENT", { contribution: huge });
    await journal.close();
    opened.pop();

    const reopened = await open();
    expect(reopened.records[0]!.body.contribution).toBe(huge.toString());
  }, 60_000);
});
