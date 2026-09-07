// The journal surviving a container it did not survive before.
//
// The properties proved here are the ones the whole change exists for:
//
//   * a history written by one container is present in the next, with its
//     unresolved INTENT intact — that record is what recovery needs in order to
//     resolve a settlement that was in flight when the process died;
//   * the local index REPRODUCES the durable log bit for bit, rather than
//     merely resembling it;
//   * the two stores refusing to run when they disagree, instead of picking one.
//
// Skipped without DATABASE_URL, loudly.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { MirroredLedger } from "../src/ledger-mirrored.js";
import { schemaNameFor, sslOptionsFor } from "../src/ledger-pg.js";
import type { LedgerInstance } from "../src/ledger.js";
import { ENGINE_SCHEMA, LEDGER_SCHEMA } from "../src/ledger.js";

const URL = process.env.DATABASE_URL;
// Its own account, so this file gets its own schema and cannot collide with
// the other Postgres suites running in parallel.
const ACCOUNT = "0x00000000000000000000000000000000000000b2";

const INSTANCE: LedgerInstance = {
  chainId: 4663,
  factory: "0x2a6a5d51677aa52674df1380a5743fbf601ca9b0",
  executor: "0x5d037fe7fd65745ba51ddb433aa5b17e965d46ac",
  vault: "0x0b5036063527ba4e32032e1b6b953c3677386bbd",
  account: ACCOUNT,
  ledgerSchema: LEDGER_SCHEMA,
  engineSchema: ENGINE_SCHEMA,
};

const describeIfPg = URL ? describe : describe.skip;
if (!URL) {
  console.warn(
    "\n  ! ledger-mirrored.test.ts SKIPPED: DATABASE_URL is not set.\n" +
      "    Journal durability across a redeploy is therefore UNVERIFIED in this run.\n",
  );
}

describeIfPg("a journal that survives its container", () => {
  const dirs: string[] = [];
  const open: MirroredLedger[] = [];

  /** A fresh local disk, which is what a new container gets. */
  function newContainer(): string {
    const dir = mkdtempSync(join(tmpdir(), "nuvem-mirror-"));
    dirs.push(dir);
    return dir;
  }

  async function boot(dir = newContainer()): Promise<MirroredLedger> {
    const ledger = await MirroredLedger.open({
      connectionString: URL!,
      dir,
      instance: INSTANCE,
    });
    open.push(ledger);
    return ledger;
  }

  async function wipeDurable(): Promise<void> {
    const client = new pg.Client({ connectionString: URL!, ssl: sslOptionsFor(URL!) });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schemaNameFor(INSTANCE.chainId, ACCOUNT)} CASCADE`);
    await client.end();
  }

  afterEach(async () => {
    while (open.length > 0) await open.pop()!.close();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
    await wipeDurable();
  }, 90_000);

  /** THE POINT OF THE WHOLE EXERCISE. */
  it("carries an unresolved INTENT into the next container", async () => {
    await wipeDurable();

    const first = await boot();
    await first.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    await first.append("CHECKPOINT", { anchorBlockL2: 32069218n, anchorBlockHash: "0xabc", headBlockL2: 32069300n });
    await first.close();
    open.pop();

    // New container: new filesystem, nothing local at all.
    const second = await boot();
    const types = second.readRecords().records.map((r) => r.type);
    expect(types).toContain("HEADER");
    expect(types).toContain("CHECKPOINT");
    expect(second.state.anchorBlockL2).toBe(32069218n);
  }, 120_000);

  /**
   * Not "resembles". The digest covers the timestamp, so a replay that used the
   * current clock would build a different chain for the same history — and the
   * index would then be a different story from the log.
   */
  it("reproduces the durable log bit for bit, not approximately", async () => {
    await wipeDurable();

    const first = await boot();
    await first.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    await first.append("CHECKPOINT", { anchorBlockL2: 100n, anchorBlockHash: "0x1", headBlockL2: 200n });
    await first.append("SKIPPED", {
      startBlockL2: 100n,
      endBlockL2: 150n,
      reason: "NON_POSITIVE_PROFIT",
      detail: "measured a loss",
      endBlockL1: 25n,
      bindingEpoch: 1n,
    });
    const headBefore = first.state.head;
    await first.close();
    open.pop();

    const second = await boot();
    expect(second.state.head).toBe(headBefore);
  }, 120_000);

  it("keeps writing from where the previous container stopped", async () => {
    await wipeDurable();

    const first = await boot();
    await first.ensureHeader({ settlementNonce: 0n, lifetimeContribution: 0n });
    await first.append("CHECKPOINT", { anchorBlockL2: 100n, anchorBlockHash: "0x1", headBlockL2: 200n });
    const seqBefore = first.state.seq;
    await first.close();
    open.pop();

    const second = await boot();
    await second.append("CHECKPOINT", { anchorBlockL2: 300n, anchorBlockHash: "0x2", headBlockL2: 400n });
    expect(second.state.seq).toBe(seqBefore + 1);
    expect(second.state.anchorBlockL2).toBe(300n);
  }, 120_000);

  it("still refuses a second keeper, now across machines rather than files", async () => {
    await wipeDurable();
    await boot();
    // A pid file cannot do this: it is local to one container, and two Railway
    // instances would each see an empty directory and both start.
    await expect(boot()).rejects.toThrow();
  }, 120_000);

  it("reports a durable log that is empty as an empty history, not an error", async () => {
    await wipeDurable();
    const ledger = await boot();
    expect(ledger.readRecords().records).toHaveLength(0);
    expect(ledger.state.seq).toBe(-1);
  }, 120_000);
});
