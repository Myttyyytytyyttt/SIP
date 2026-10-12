// src/dispatch-store.ts without a database: the statements' text, what each
// method sends and in which order, how every way a gate can fail is reported, the
// pools' sizes and the connection arithmetic, the schema file's dispatcher
// section, and that nothing a legacy keeper runs imports the store (it is DARK).
//
// The races themselves — FOR SHARE, SKIP LOCKED, clock_timestamp(), the stalled
// commit, the SIGTERM drill — need a real Postgres and live in
// test-local/fence-pg.local.test.ts.

import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PublicKey } from "@solana/web3.js";
import { Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import {
  CLAIM_SQL,
  COMPLETE_SQL,
  DISPATCH_STATEMENT_TIMEOUT_MS,
  DISPATCH_TABLES,
  DispatchStore,
  GATE_INSERT_SQL,
  LEGACY_CARRY_POOL_CONNECTIONS,
  LEGACY_KEEPER_CONNECTIONS,
  GATE_LOCK_SQL,
  GATE_MARGIN_SECONDS,
  GATE_ONE_STATEMENT_SQL,
  HEARTBEAT_EVERY_MS,
  HEARTBEAT_SQL,
  JOB_CEILING_MINUTES,
  LANE_PRIORITY,
  LEASE_SECONDS,
  NOT_REBUILDABLE_TABLES,
  LIVE_WORKERS_SQL,
  OPEN_INTENTS_SQL,
  OVERLAP_AUDIT_SQL,
  PLAN_FLOOR_SQL,
  PgRpcUsageFeed,
  RECORD_SIGNATURE_SQL,
  RESOLVE_INTENT_SQL,
  SCHEDULER_POOL_MAX,
  USAGE_ADD_SQL,
  USAGE_PRUNE_SQL,
  USAGE_READ_SQL,
  USAGE_SUMMARY_SQL,
  WORKER_BEAT_SQL,
  WORKER_POOL_MAX,
  WRITE_QUOTAS_SQL,
  createDispatchPool,
  dispatchConnections,
  workerStatsJson,
  type DispatchClient,
  type DispatchPool,
  type IntentDraft,
} from "../src/dispatch-store.js";
import { createCarryPool } from "../src/carry-store.js";
import type { RpcUsageRow } from "../src/credit-governor.js";
import { WORKER_DEAD_AFTER_MS, WORKER_STATS_KEYS } from "../src/fleet-status.js";
import { QuotaFollower, fleetQuotas } from "../src/rpc-quota.js";

const PACKAGE = new URL("..", import.meta.url);
const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, PACKAGE)), "utf8");
const sql = source("sql/sip_solana.sql");

type Answer = { rows: Record<string, unknown>[] } | Error;

/** A pool whose one client answers each statement from `script`, by the statement's first words, and records everything. */
function scripted(script: (text: string, values: unknown[] | undefined) => Answer | Promise<Answer>) {
  const sent: Array<{ text: string; values: unknown[] | undefined }> = [];
  const releases: boolean[] = [];
  let connects = 0;
  let connectError: Error | null = null;
  const client: DispatchClient = {
    async query(text, values) {
      sent.push({ text, values });
      const answer = await script(text, values);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    release(destroy) {
      releases.push(destroy === true);
    },
  };
  const pool: DispatchPool = {
    async connect() {
      connects += 1;
      if (connectError !== null) throw connectError;
      return client;
    },
  };
  return {
    pool,
    sent,
    releases,
    get connects() {
      return connects;
    },
    failConnect(error: Error) {
      connectError = error;
    },
  };
}

/** A server-side error as pg reports it: a DatabaseError with its SQLSTATE. */
function serverError(code: string, message = "server says no"): Error {
  const error = new pg.DatabaseError(message, 0, "error");
  error.code = code;
  return error;
}

const intent = (overrides: Partial<IntentDraft> = {}): IntentDraft => ({
  vault: "Vault1111",
  fence: 7n,
  kind: "wrap",
  link: null,
  blockhash: "Hash1111",
  lastValidBlockHeight: 4_242n,
  planClearedHeight: 4_000n,
  signature: "Sig1111",
  idempotencyKey: null,
  amountRaw: 123n,
  ...overrides,
});

const LINK = { linkAddress: new PublicKey(Buffer.alloc(32, 9)), epoch: 2n, settlementNonce: 5n, frontierSlot: 900n };

describe("the four statements, as ADR §3.5 writes them", () => {
  const leaseStatements = { CLAIM_SQL, HEARTBEAT_SQL, GATE_LOCK_SQL, GATE_ONE_STATEMENT_SQL, COMPLETE_SQL };

  it("judge every lease by clock_timestamp(), never now() and never a worker's time", () => {
    for (const [name, text] of Object.entries(leaseStatements)) {
      expect(text, name).toContain("clock_timestamp()");
      expect(text, name).not.toMatch(/\bnow\(\)/);
      expect(text, name).not.toMatch(/\$\d+::timestamptz/);
    }
  });

  it("CLAIM: due queue vaults only, free or expired, most urgent first and its own last vaults next, SKIP LOCKED, fence + 1", () => {
    expect(CLAIM_SQL).toContain("WHERE system = 'queue' AND parked_reason IS NULL AND due_at <= clock_timestamp()");
    expect(CLAIM_SQL).toContain("AND (holder IS NULL OR lease_until < clock_timestamp())");
    expect(CLAIM_SQL).toMatch(
      /ORDER BY priority,\s+\(due_at < clock_timestamp\(\) - interval '6 minutes'\) DESC,\s+CASE WHEN due_at < clock_timestamp\(\) - interval '6 minutes' THEN due_at END,\s+COALESCE\(last_holder = \$1, false\) DESC, due_at/,
    );
    expect(CLAIM_SQL).toContain("LIMIT $2 FOR UPDATE SKIP LOCKED)");
    expect(CLAIM_SQL).toContain("SET holder = $1, fence = w.fence + 1, claimed_at = clock_timestamp()");
    expect(CLAIM_SQL).toContain("lease_until = clock_timestamp() + interval '45 seconds', attempts = w.attempts + 1");
    expect(CLAIM_SQL).toContain("RETURNING w.vault_addr, w.fence, w.lane, w.skim_mode, w.streaks, w.attempts");
  });

  it("HEARTBEAT: one statement for every held (vault, fence), and nothing past the six-minute ceiling", () => {
    expect(HEARTBEAT_SQL).toContain("SET lease_until = clock_timestamp() + interval '45 seconds'");
    expect(HEARTBEAT_SQL).toContain("WHERE holder = $1 AND (vault_addr, fence) IN (SELECT * FROM unnest($2::text[], $3::bigint[]))");
    expect(HEARTBEAT_SQL).toContain("AND claimed_at > clock_timestamp() - interval '6 minutes'");
  });

  it("GATE: the vault row FOR SHARE, at this holder and fence, with more than the 10 s margin left", () => {
    for (const text of [GATE_LOCK_SQL, GATE_ONE_STATEMENT_SQL]) {
      expect(text).toContain("lease_until > clock_timestamp() + interval '10 seconds'");
      expect(text).toMatch(/FOR SHARE(\),)?$/m);
    }
    expect(GATE_LOCK_SQL).toContain("WHERE vault_addr = $1 AND holder = $2 AND fence = $3");
    expect(GATE_ONE_STATEMENT_SQL).toContain("WHERE vault_addr = $1::text AND holder = $5::text AND fence = $4::bigint");
    // THE ONE-STATEMENT FORM INSERTS ONLY THE ROWS THE LOCK RETURNED, and only past the plan floor.
    expect(GATE_ONE_STATEMENT_SQL).toMatch(/SELECT \$1::text, .* FROM l, p\n\s+WHERE COALESCE\(\$8::bigint > p\.floor, p\.floor IS NULL\)\n\s+RETURNING id\)/);
    expect(GATE_ONE_STATEMENT_SQL).toMatch(/SELECT \(SELECT id FROM i\) AS id, EXISTS \(SELECT 1 FROM l\) AS held, \(SELECT floor FROM p\) AS plan_floor$/);
  });

  it("GATE: the intent goes in only when its plan_cleared_height is above every earlier fence's intent — NULL only when there is none", () => {
    for (const text of [GATE_INSERT_SQL, GATE_ONE_STATEMENT_SQL]) {
      // THE FLOOR IS PLAN_FLOOR_SQL'S, over earlier fences only.
      expect(text).toContain("SELECT max(COALESCE(resolved_height, last_valid_block_height)) AS floor");
      expect(text).toContain("WHERE vault_addr = $1::text AND fence < $4::bigint)");
      // STRICTLY ABOVE; a NULL plan height passes only a NULL floor (no earlier intent at all).
      expect(text).toContain("WHERE COALESCE($8::bigint > p.floor, p.floor IS NULL)");
    }
    expect(GATE_INSERT_SQL).toMatch(/SELECT \$1::text, .* FROM p\n/);
    expect(GATE_INSERT_SQL).toMatch(/SELECT \(SELECT id FROM i\) AS id, \(SELECT floor FROM p\) AS plan_floor$/);
  });

  it("COMPLETE: only the holder at its fence; a bell during the turn makes it due now; the next due is a delay on the database's clock", () => {
    expect(COMPLETE_SQL).toContain("WHERE vault_addr = $1 AND holder = $2 AND fence = $3");
    expect(COMPLETE_SQL).toContain("due_at = CASE WHEN bell_at > claimed_at THEN clock_timestamp()");
    expect(COMPLETE_SQL).toContain("ELSE clock_timestamp() + make_interval(secs => $10::double precision) END");
    expect(COMPLETE_SQL).toContain("SET holder = NULL, lease_until = NULL, last_holder = $2, attempts = 0");
    // NOTHING BUT A CLAIM MOVES A FENCE: complete only matches on it.
    expect(COMPLETE_SQL.slice(COMPLETE_SQL.indexOf("SET"), COMPLETE_SQL.indexOf("WHERE"))).not.toContain("fence");
  });

  it("the overlap audit is the ADR's, except that a NULL plan height is an audit row instead of dropping out of it", () => {
    expect(OVERLAP_AUDIT_SQL.replace(/\s+/g, " ")).toBe(
      "SELECT b.id FROM sip_solana.send_intent a JOIN sip_solana.send_intent b ON b.vault_addr = a.vault_addr AND b.fence > a.fence WHERE COALESCE(b.plan_cleared_height, -1) <= COALESCE(a.resolved_height, a.last_valid_block_height)",
    );
  });

  it("the lengths fit together (ADR §3.7): three missed heartbeats and one statement timeout inside a lease, a lease inside one interval, the ceiling above the worst job", () => {
    expect(3 * HEARTBEAT_EVERY_MS + DISPATCH_STATEMENT_TIMEOUT_MS).toBeLessThan(LEASE_SECONDS * 1_000);
    expect(LEASE_SECONDS * 1_000).toBeLessThan(60_000);
    expect(GATE_MARGIN_SECONDS * 1_000).toBeGreaterThan(DISPATCH_STATEMENT_TIMEOUT_MS);
    // The worst job, 2 links at L = 2, is ≈ 302 s (queue §2.6).
    expect(JOB_CEILING_MINUTES * 60).toBeGreaterThan(302);
  });
});

describe("DispatchStore, over a scripted client", () => {
  it("claims with its own holder name and the number of free slots, and reads fences as bigints", async () => {
    const db = scripted(() => ({ rows: [{ vault_addr: "V", fence: "9007199254740993", lane: "bell", skim_mode: 1, streaks: { w: 2 }, attempts: 3 }] }));
    const claimed = await new DispatchStore(db.pool, "worker-a").claim(2);
    expect(db.sent).toEqual([{ text: CLAIM_SQL, values: ["worker-a", 2] }]);
    expect(claimed).toEqual([{ vault: "V", fence: 9_007_199_254_740_993n, lane: "bell", skimMode: 1, streaks: { w: 2 }, attempts: 3 }]);
    expect(db.releases).toEqual([false]);
  });

  it("asks nothing for no free slot, and refuses to exist without a worker_id", async () => {
    const db = scripted(() => ({ rows: [] }));
    expect(await new DispatchStore(db.pool, "w").claim(0)).toEqual([]);
    expect(db.connects).toBe(0);
    expect(() => new DispatchStore(db.pool, " ")).toThrow(/worker_id/);
  });

  it("beats every held vault in one statement, and answers only those renewed", async () => {
    const db = scripted(() => ({ rows: [{ vault_addr: "A" }] }));
    const renewed = await new DispatchStore(db.pool, "w").heartbeat([
      { vault: "A", fence: 3n },
      { vault: "B", fence: 4n },
    ]);
    expect(db.sent).toEqual([{ text: HEARTBEAT_SQL, values: ["w", ["A", "B"], ["3", "4"]] }]);
    expect([...renewed]).toEqual(["A"]);
    expect(await new DispatchStore(db.pool, "w").heartbeat([])).toEqual(new Set());
    expect(db.sent).toHaveLength(1);
  });

  describe("the gate", () => {
    const gatedScript = (text: string): Answer =>
      text.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : text === GATE_INSERT_SQL ? { rows: [{ id: "41", plan_floor: "3999" }] } : { rows: [] };
    const settleIntent = (overrides: Partial<IntentDraft> = {}) => intent({ kind: "settle", link: LINK.linkAddress.toBase58(), signature: null, ...overrides });

    it("locks, inserts, commits — in that order, in one transaction — and only then answers gated", async () => {
      const db = scripted(gatedScript);
      const answer = await new DispatchStore(db.pool, "w").gate(intent());
      expect(answer).toEqual({ kind: "gated", intentId: 41n, carryWritten: false });
      expect(db.sent.map((s) => s.text)).toEqual(["BEGIN", GATE_LOCK_SQL, GATE_INSERT_SQL, "COMMIT"]);
      expect(db.sent[1]!.values).toEqual(["Vault1111", "w", "7"]);
      expect(db.sent[2]!.values).toEqual(["Vault1111", null, "wrap", "7", "w", "Hash1111", "4242", "4000", "Sig1111", null, "123", "intent"]);
      expect(db.releases).toEqual([false]);
    });

    it("refuses, rolls back and inserts nothing when the lock returns no row", async () => {
      const db = scripted((text) => ({ rows: text.startsWith("SELECT 1") ? [] : [] }));
      const answer = await new DispatchStore(db.pool, "w").gate(intent());
      expect(answer).toMatchObject({ kind: "refused", reason: "lease" });
      expect(answer.kind === "refused" && answer.detail).toMatch(/no longer held at fence 7 with more than 10 s of lease left; the signed bytes were dropped/);
      expect(db.sent.map((s) => s.text)).toEqual(["BEGIN", GATE_LOCK_SQL, "ROLLBACK"]);
    });

    it("refuses, rolls back and writes no carry when the plan did not clear the floor: the insert inserted nothing", async () => {
      const db = scripted((text) => (text === GATE_INSERT_SQL ? { rows: [{ id: null, plan_floor: "4242" }] } : gatedScript(text)));
      const answer = await new DispatchStore(db.pool, "w").gate(settleIntent({ planClearedHeight: null }), {
        carry: { link: LINK, endSlot: 950n, carry: { lossLamports: 77n, walletSignedTxCount: 4 }, validUntilSlot: 1_100n },
      });
      expect(answer).toMatchObject({ kind: "refused", reason: "plan-floor" });
      expect(answer.kind === "refused" && answer.detail).toContain("planned with no plan_cleared_height, which is not above 4242");
      expect(db.sent.map((s) => s.text)).toEqual(["BEGIN", GATE_LOCK_SQL, GATE_INSERT_SQL, "ROLLBACK"]);
      expect(db.releases).toEqual([false]);
    });

    it("writes the carry inside the transaction, after the intent and before COMMIT, stamped with the fence and the intent", async () => {
      const db = scripted(gatedScript);
      const answer = await new DispatchStore(db.pool, "w").gate(settleIntent(), {
        carry: { link: LINK, endSlot: 950n, carry: { lossLamports: 77n, walletSignedTxCount: 4 }, validUntilSlot: 1_100n },
      });
      expect(answer).toEqual({ kind: "gated", intentId: 41n, carryWritten: true });
      const texts = db.sent.map((s) => s.text.split("\n")[0]);
      expect(texts).toEqual([
        "BEGIN",
        "SELECT 1 FROM sip_solana.vault_work",
        "WITH p AS (",
        "SELECT pg_advisory_xact_lock($1, hashtext($2))",
        "DELETE FROM sip_solana.loss_carry",
        "INSERT INTO sip_solana.loss_carry",
        "COMMIT",
      ]);
      expect(db.sent[4]!.values).toEqual([LINK.linkAddress.toBase58(), "2", "5", "900"]);
      expect(db.sent[5]!.values).toEqual([LINK.linkAddress.toBase58(), "2", "6", "950", "77", 4, "1100", "w", "7", "41"]);
    });

    it("with no carry to keep, still deletes the link's other states, as recordCarry does", async () => {
      const db = scripted(gatedScript);
      await new DispatchStore(db.pool, "w").gate(settleIntent(), { carry: { link: LINK, endSlot: 950n, carry: null, validUntilSlot: 1n } });
      expect(db.sent.map((s) => s.text.split("\n")[0])).toContain("DELETE FROM sip_solana.loss_carry");
      expect(db.sent.map((s) => s.text.split("\n")[0])).not.toContain("INSERT INTO sip_solana.loss_carry");
    });

    it("refuses a carry that is not a loss before it asks anything", async () => {
      const db = scripted(gatedScript);
      await expect(
        new DispatchStore(db.pool, "w").gate(settleIntent(), { carry: { link: LINK, endSlot: 950n, carry: { lossLamports: 0n, walletSignedTxCount: 1 }, validUntilSlot: 1n } }),
      ).rejects.toThrow(/a carried loss is positive, not 0 lamports/);
      expect(db.connects).toBe(0);
    });

    it("refuses, before it asks anything, a carry that is not for the settle it is gated with — in either world", async () => {
      // THE LOCK AND THE FENCE COVER intent.vault ONLY: a carry for another link
      // would delete that link's states under a fence that is not its vault's.
      const other = new PublicKey(Buffer.alloc(32, 10)).toBase58();
      const carry = { link: LINK, endSlot: 950n, carry: { lossLamports: 77n, walletSignedTxCount: 4 }, validUntilSlot: 1n };
      for (const world of ["live", "shadow"] as const) {
        const db = scripted(gatedScript);
        const store = new DispatchStore(db.pool, "w", world);
        await expect(store.gate(intent(), { carry }), world).rejects.toThrow(/a carry is written only with the settle of its own link: this gate is a wrap for no link/);
        await expect(store.gate(settleIntent({ link: other }), { carry }), world).rejects.toThrow(
          new RegExp(`this gate is a settle for link ${other} and the carry is for link ${LINK.linkAddress.toBase58()}`),
        );
        expect(db.connects, world).toBe(0);
        // ITS OWN LINK'S SETTLE PASSES, and a gate with no carry is never asked.
        expect((await store.gate(settleIntent(), { carry })).kind, world).toBe("gated");
        expect((await store.gate(intent(), { carry: null })).kind, world).toBe("gated");
      }
    });

    it("in the shadow world writes 'shadow' rows and never a carry", async () => {
      const db = scripted(gatedScript);
      const answer = await new DispatchStore(db.pool, "w", "shadow").gate(settleIntent(), {
        carry: { link: LINK, endSlot: 950n, carry: { lossLamports: 77n, walletSignedTxCount: 4 }, validUntilSlot: 1n },
      });
      expect(answer).toEqual({ kind: "gated", intentId: 41n, carryWritten: false });
      expect(db.sent.map((s) => s.text)).toEqual(["BEGIN", GATE_LOCK_SQL, GATE_INSERT_SQL, "COMMIT"]);
      expect(db.sent[2]!.values!.at(-1)).toBe("shadow");
    });

    it("anything that fails before COMMIT is unavailable: rolled back, the client destroyed, nothing sent", async () => {
      for (const failing of ["BEGIN", "SELECT 1", "WITH p AS ("]) {
        const db = scripted((text) => (text.startsWith(failing) ? new Error("socket hang up") : gatedScript(text)));
        const answer = await new DispatchStore(db.pool, "w").gate(intent());
        expect(answer.kind, failing).toBe("unavailable");
        expect(db.sent.at(-1)!.text, failing).toBe("ROLLBACK");
        expect(db.releases, failing).toEqual([true]);
      }
      const down = scripted(gatedScript);
      down.failConnect(new Error("connect ECONNREFUSED"));
      expect((await new DispatchStore(down.pool, "w").gate(intent())).kind).toBe("unavailable");
    });

    it("a COMMIT with no answer, or with one that says the server is in trouble, is unacknowledged — never gated, the client destroyed", async () => {
      for (const error of [new Error("Query read timeout"), new Error("Connection terminated unexpectedly"), serverError("57P01", "terminating connection due to administrator command")]) {
        const db = scripted((text) => (text === "COMMIT" ? error : gatedScript(text)));
        const answer = await new DispatchStore(db.pool, "w").gate(intent());
        expect(answer.kind, error.message).toBe("unacknowledged");
        expect(db.sent.map((s) => s.text), error.message).not.toContain("ROLLBACK");
        expect(db.releases).toEqual([true]);
      }
    });

    it("a COMMIT the server refuses on the request's own account committed nothing: unavailable", async () => {
      const db = scripted((text) => (text === "COMMIT" ? serverError("23514") : gatedScript(text)));
      expect((await new DispatchStore(db.pool, "w").gate(intent())).kind).toBe("unavailable");
    });

    it("the one-statement form: one round trip; no row is refused; no answer is unacknowledged; a refusal on the request is unavailable", async () => {
      const ok = scripted(() => ({ rows: [{ id: "5", held: true, plan_floor: null }] }));
      expect(await new DispatchStore(ok.pool, "w").gateOneStatement(intent())).toEqual({ kind: "gated", intentId: 5n, carryWritten: false });
      expect(ok.sent).toEqual([{ text: GATE_ONE_STATEMENT_SQL, values: ["Vault1111", null, "wrap", "7", "w", "Hash1111", "4242", "4000", "Sig1111", null, "123", "intent"] }]);
      // NOTHING INSERTED: the lock found no row (lease), or it did and the plan was under the floor (plan-floor).
      const lost = await new DispatchStore(scripted(() => ({ rows: [{ id: null, held: false, plan_floor: "9000" }] })).pool, "w").gateOneStatement(intent());
      expect(lost).toMatchObject({ kind: "refused", reason: "lease" });
      const early = await new DispatchStore(scripted(() => ({ rows: [{ id: null, held: true, plan_floor: "4000" }] })).pool, "w").gateOneStatement(intent());
      expect(early).toMatchObject({ kind: "refused", reason: "plan-floor" });
      expect(early.kind === "refused" && early.detail).toContain("planned with plan_cleared_height 4000, which is not above 4000");
      const silent = scripted(() => new Error("Query read timeout"));
      expect((await new DispatchStore(silent.pool, "w").gateOneStatement(intent())).kind).toBe("unacknowledged");
      expect(silent.releases).toEqual([true]);
      expect((await new DispatchStore(scripted(() => serverError("23505")).pool, "w").gateOneStatement(intent())).kind).toBe("unavailable");
    });
  });

  it("completes with the job's fields, the lane's priority, and the next due as a delay", async () => {
    const db = scripted(() => ({ rows: [{ vault_addr: "V" }] }));
    const done = await new DispatchStore(db.pool, "w").complete({ vault: "V", fence: 3n }, { rests: true, lane: "busy", streaks: { a: 1 }, outcome: "INVESTED", detail: "more left", dueInSeconds: 60 });
    expect(done).toBe(true);
    expect(db.sent).toEqual([{ text: COMPLETE_SQL, values: ["V", "w", "3", true, "busy", LANE_PRIORITY.busy, '{"a":1}', "INVESTED", "more left", 60] }]);
    await expect(new DispatchStore(db.pool, "w").complete({ vault: "V", fence: 3n }, { rests: true, lane: "busy", streaks: {}, outcome: "X", detail: null, dueInSeconds: -1 })).rejects.toThrow(
      /delay of 0 or more seconds/,
    );
  });

  it("releases due at once, not resting, its lane and streaks kept, outcome RELEASED", async () => {
    const db = scripted(() => ({ rows: [] }));
    const released = await new DispatchStore(db.pool, "w").release({ vault: "V", fence: 3n, lane: "safety", skimMode: 0, streaks: { s: 1 }, attempts: 2 }, "SIGTERM");
    expect(released).toBe(false);
    expect(db.sent[0]!.values).toEqual(["V", "w", "3", false, "safety", LANE_PRIORITY.safety, '{"s":1}', "RELEASED", "SIGTERM", 0]);
  });

  it("records a settle's signature once, when Privy answers, and never over another", async () => {
    const db = scripted(() => ({ rows: [] }));
    expect(await new DispatchStore(db.pool, "w").recordSignature(41n, "Sig")).toBe(false);
    expect(db.sent).toEqual([{ text: RECORD_SIGNATURE_SQL, values: ["41", "Sig"] }]);
    expect(RECORD_SIGNATURE_SQL).toContain("WHERE id = $1 AND signature IS NULL");
  });

  it("resolves an intent once, and leaves a shadow row 'shadow'", async () => {
    const db = scripted(() => ({ rows: [{ id: "8" }] }));
    expect(await new DispatchStore(db.pool, "w").resolveIntent(8n, "expired", 4_242n)).toBe(true);
    expect(db.sent).toEqual([{ text: RESOLVE_INTENT_SQL, values: ["8", "expired", "4242"] }]);
    expect(RESOLVE_INTENT_SQL).toContain("SET state = CASE WHEN state = 'shadow' THEN 'shadow' ELSE $2 END");
    expect(RESOLVE_INTENT_SQL).toContain("WHERE id = $1 AND resolved_at IS NULL");
  });

  it("reads the earlier fences' open intents and the plan floor, the audit's own right-hand side", async () => {
    const db = scripted((text) =>
      text === OPEN_INTENTS_SQL
        ? { rows: [{ id: "3", vault_addr: "V", link_addr: null, kind: "wrap", fence: "6", worker_id: "old", blockhash: "h", last_valid_block_height: "900", plan_cleared_height: "700", signature: "s", idempotency_key: null, amount_raw: "5", state: "intent" }] }
        : { rows: [{ floor: "900" }] },
    );
    const prior = await new DispatchStore(db.pool, "w").priorIntents({ vault: "V", fence: 7n });
    expect(prior).toEqual({
      open: [{ id: 3n, vault: "V", link: null, kind: "wrap", fence: 6n, worker: "old", blockhash: "h", lastValidBlockHeight: 900n, planClearedHeight: 700n, signature: "s", idempotencyKey: null, amountRaw: 5n, state: "intent" }],
      planFloor: 900n,
    });
    expect(db.sent.map((s) => [s.text, s.values])).toEqual([
      [OPEN_INTENTS_SQL, ["V", "7"]],
      [PLAN_FLOOR_SQL, ["V", "7"]],
    ]);
    expect(OPEN_INTENTS_SQL).toContain("WHERE vault_addr = $1 AND fence < $2 AND resolved_at IS NULL");
    expect(PLAN_FLOOR_SQL).toContain("max(COALESCE(resolved_height, last_valid_block_height))");
    expect(PLAN_FLOOR_SQL).toContain("WHERE vault_addr = $1 AND fence < $2");
  });

  it("destroys a client whose statement failed instead of handing it back", async () => {
    const db = scripted(() => new Error("boom"));
    await expect(new DispatchStore(db.pool, "w").claim(1)).rejects.toThrow("boom");
    expect(db.releases).toEqual([true]);
  });
});

describe("connections (ADR §3.11, the queue section's when.out)", () => {
  it("reproduces the table: steady 3 + 2r, doubled at a deploy, + 2 per legacy keeper", () => {
    const table = [1, 2, 3, 4, 8].map((r) => [
      r,
      dispatchConnections({ workerReplicas: r }),
      dispatchConnections({ workerReplicas: r, deploying: true }),
      dispatchConnections({ workerReplicas: r, legacyKeepers: 2 }),
      dispatchConnections({ workerReplicas: r, deploying: true, legacyKeepers: 2 }),
    ]);
    expect(table).toEqual([
      [1, 5, 10, 9, 18],
      [2, 7, 14, 11, 22],
      [3, 9, 18, 13, 26],
      [4, 11, 22, 15, 30],
      [8, 19, 38, 23, 46],
    ]);
  });

  it("an ASSUMED 15-connection session pool fits r ≤ 2 through a deploy, and no r while the legacy keepers shadow a push", () => {
    const fits = (r: number, legacyKeepers = 0) => dispatchConnections({ workerReplicas: r, deploying: true, legacyKeepers }) <= 15;
    expect([1, 2, 3].map((r) => fits(r))).toEqual([true, true, false]);
    expect(fits(1, 2)).toBe(false);
  });

  it("counts the carry store's own pool on a legacy profit keeper that runs one: 3 + 2 + 3 + 2 = 10 at r = 1, 20 through a deploy", () => {
    // THE SHADOW STAGE S-4 ASKS FOR: profit with SIP_SOLANA_CARRY_STORE on (its read model's 2 + the carry pool's 1), volume (2).
    expect(dispatchConnections({ workerReplicas: 1, legacyKeepers: 2, legacyCarryStores: 1 })).toBe(10);
    expect(dispatchConnections({ workerReplicas: 1, deploying: true, legacyKeepers: 2, legacyCarryStores: 1 })).toBe(20);
    expect(dispatchConnections({ workerReplicas: 1, legacyKeepers: 2, legacyCarryStores: 1 }) - dispatchConnections({ workerReplicas: 1, legacyKeepers: 2 })).toBe(
      LEGACY_CARRY_POOL_CONNECTIONS,
    );
    expect([LEGACY_KEEPER_CONNECTIONS, LEGACY_CARRY_POOL_CONNECTIONS]).toEqual([2, 1]);
    // MORE CARRY STORES THAN LEGACY KEEPERS IS A MISCOUNT, not a fleet.
    expect(() => dispatchConnections({ workerReplicas: 1, legacyKeepers: 1, legacyCarryStores: 2 })).toThrow(/legacyCarryStores/);
    expect(() => dispatchConnections({ workerReplicas: 1, legacyCarryStores: -1 })).toThrow(/legacyCarryStores/);
  });

  it("LEGACY_CARRY_POOL_CONNECTIONS and LEGACY_KEEPER_CONNECTIONS are the pools the legacy keeper really builds", async () => {
    const url = new Secret("postgresql://u:p@127.0.0.1:1/db?sslmode=disable", "databaseUrl");
    const carry = createCarryPool(url, () => undefined);
    expect(carry.options.max).toBe(LEGACY_CARRY_POOL_CONNECTIONS);
    await carry.end();
    expect(source("src/read-model.ts")).toMatch(new RegExp(`\\n\\s+max: ${LEGACY_KEEPER_CONNECTIONS},\\n`));
  });

  it("sizes each pool to the table and bounds every statement and every wait for a connection", async () => {
    const warned: string[] = [];
    const worker = createDispatchPool(new Secret("postgresql://u:p@127.0.0.1:1/db?sslmode=disable", "databaseUrl"), "worker", "app-w", (m) => warned.push(m));
    const scheduler = createDispatchPool(new Secret("postgresql://u:p@127.0.0.1:1/db?sslmode=disable", "databaseUrl"), "scheduler", "app-s", () => undefined);
    expect(worker.options).toMatchObject({
      max: WORKER_POOL_MAX,
      connectionTimeoutMillis: DISPATCH_STATEMENT_TIMEOUT_MS,
      statement_timeout: DISPATCH_STATEMENT_TIMEOUT_MS,
      query_timeout: DISPATCH_STATEMENT_TIMEOUT_MS,
      // THE GAP BETWEEN A GATE'S STATEMENTS: a process stopped mid-transaction loses its row lock at the same bound.
      idle_in_transaction_session_timeout: DISPATCH_STATEMENT_TIMEOUT_MS,
      application_name: "app-w",
    });
    expect(scheduler.options).toMatchObject({ idle_in_transaction_session_timeout: DISPATCH_STATEMENT_TIMEOUT_MS });
    expect(scheduler.options.max).toBe(SCHEDULER_POOL_MAX);
    expect([WORKER_POOL_MAX, SCHEDULER_POOL_MAX]).toEqual([2, 1]);
    // AN IDLE CLIENT'S ERROR IS HEARD, NOT THROWN.
    expect(worker.listenerCount("error")).toBe(1);
    worker.emit("error", new Error("idle client died"), undefined as never);
    expect(warned).toEqual(["dispatch pool idle client error (ignored)"]);
    // AND A LENT CLIENT'S: pg-pool takes its own listener off while it is lent, and
    // an 'error' nobody hears throws (the idle-in-transaction bound ending a stalled gate).
    const lent = new EventEmitter();
    worker.emit("connect", lent as never);
    expect(() => lent.emit("error", new Error("terminating connection due to idle-in-transaction timeout"))).not.toThrow();
    expect(warned.at(-1)).toBe("dispatch pool client error while lent (its next statement fails)");
    await Promise.all([worker.end(), scheduler.end()]);
  });
});

describe("the schema file's dispatcher section", () => {
  const section = sql.slice(sql.indexOf("-- ─── The dispatcher's tables"));
  const statements = (text: string) =>
    text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

  it("creates the seven tables, additively and idempotently", () => {
    expect(DISPATCH_TABLES).toHaveLength(7);
    for (const table of DISPATCH_TABLES.filter((t) => t !== "loss_carry")) {
      expect(section, table).toContain(`CREATE TABLE IF NOT EXISTS sip_solana.${table} (`);
    }
    // loss_carry IS L2's, reconciled by ALTERs: CREATE TABLE IF NOT EXISTS would add nothing to a table that exists.
    expect(section).toContain("ALTER TABLE sip_solana.loss_carry\n  ADD COLUMN IF NOT EXISTS written_fence bigint;");
    expect(section).toContain("ALTER TABLE sip_solana.loss_carry\n  ADD COLUMN IF NOT EXISTS send_intent_id bigint;");
    expect(statements(sql)).not.toMatch(/DROP\s+|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+(DROP|ALTER|RENAME)/i);
    expect(statements(section)).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(section).toContain("INSERT INTO sip_solana.fleet (id) VALUES (true) ON CONFLICT (id) DO NOTHING;");
  });

  it("says in its header that loss_carry, send_intent and vault_work can never be rebuilt", () => {
    const header = sql.slice(0, sql.indexOf("CREATE SCHEMA"));
    expect(NOT_REBUILDABLE_TABLES).toEqual(["loss_carry", "send_intent", "vault_work"]);
    expect(header).toContain("DERIVED AND REBUILDABLE — EXCEPT sip_solana.loss_carry, sip_solana.send_intent\n-- AND sip_solana.vault_work");
    expect(header).toContain("send_intent AND vault_work ARE NOT DERIVED AND CANNOT BE REBUILT EITHER");
    expect(header).toContain("Neither may\n-- ever be dropped, truncated or rebuilt");
  });

  it("send_intent: a nullable unique signature, the finalized-height fields, the shadow state", () => {
    const ddl = section.slice(section.indexOf("CREATE TABLE IF NOT EXISTS sip_solana.send_intent ("), section.indexOf("CREATE INDEX IF NOT EXISTS send_intent_open"));
    expect(ddl).toMatch(/\n\s+signature\s+text\s+UNIQUE,\n/);
    expect(ddl).not.toMatch(/\n\s+signature\s+text\s+NOT NULL/);
    for (const column of ["blockhash", "last_valid_block_height", "plan_cleared_height", "resolved_height", "idempotency_key"]) {
      expect(ddl, column).toMatch(new RegExp(`\\n\\s+${column}\\s`));
    }
    expect(ddl).toContain("CHECK (state IN ('intent', 'landed', 'failed', 'expired', 'shadow'))");
    expect(ddl).toContain("created_at              timestamptz NOT NULL DEFAULT clock_timestamp()");
  });

  it("worker: quota_at beside the two quotas; send_intent: an index for the fleet page's last hour", () => {
    const worker = section.slice(section.indexOf("CREATE TABLE IF NOT EXISTS sip_solana.worker ("), section.indexOf("CREATE TABLE IF NOT EXISTS sip_solana.rpc_usage ("));
    expect(worker).toMatch(/\n\s+rps_quota\s+real,\n\s+jup_quota\s+real,\n(\s+--.*\n)+\s+quota_at\s+timestamptz,\n/);
    expect(section).toContain("CREATE INDEX IF NOT EXISTS send_intent_created ON sip_solana.send_intent (created_at);");
  });

  it("vault_work: who acts is `system` (legacy | draining | queue), never the mode byte, and the fence starts at 0", () => {
    const ddl = section.slice(section.indexOf("CREATE TABLE IF NOT EXISTS sip_solana.vault_work ("), section.indexOf("CREATE INDEX IF NOT EXISTS vault_work_due"));
    expect(ddl).toContain("system        text        NOT NULL DEFAULT 'legacy' CHECK (system IN ('legacy', 'draining', 'queue'))");
    expect(ddl).toContain("fence         bigint      NOT NULL DEFAULT 0 CHECK (fence >= 0)");
    expect(ddl).toContain("CONSTRAINT vault_work_held_has_lease CHECK ((holder IS NULL) = (lease_until IS NULL))");
  });
});

describe("the merge's wiring, over a scripted client: the quota hand-out, worker.stats and rpc_usage", () => {
  it("states every wiring statement on the database's clock, and the quota's age as clock_timestamp() − quota_at", () => {
    for (const [name, text] of Object.entries({ WORKER_BEAT_SQL, LIVE_WORKERS_SQL, WRITE_QUOTAS_SQL })) {
      expect(text, name).toContain("clock_timestamp()");
      expect(text, name).not.toMatch(/\bnow\(\)/);
      expect(text, name).not.toMatch(/\$\d+::timestamptz/);
    }
    expect(WORKER_BEAT_SQL).toContain("round(extract(epoch FROM clock_timestamp() - quota_at) * 1000) AS quota_age_ms");
    expect(WORKER_BEAT_SQL).toContain("stats = COALESCE($3::jsonb, stats)");
    expect(WRITE_QUOTAS_SQL).toContain("SET rps_quota = $2, jup_quota = $3, quota_at = clock_timestamp()");
    expect(WRITE_QUOTAS_SQL).toContain("WHERE kind = 'worker' AND worker_id = ANY($1::text[])");
    expect(LIVE_WORKERS_SQL).toContain("WHERE kind = 'worker' AND stopped_at IS NULL AND heartbeat_at > clock_timestamp() - make_interval(secs => $1::double precision)");
  });

  it("beats with the page's stats keys only, and answers the quotas as QuotaFollower reads them, age included", async () => {
    const db = scripted(() => ({ rows: [{ rps_quota: 16, jup_quota: "30", quota_age_ms: "9000" }] }));
    const store = new DispatchStore(db.pool, "w");
    const row = await store.beatProcess(1, { fenceRejects: 2, leaseLosses: 0, ...({ privateKey: 7, jobsLast10Min: -1 } as object) });
    expect(row).toEqual({ rpsQuota: 16, jupQuotaPerMinute: 30, ageMs: 9_000 });
    expect(db.sent[0]).toEqual({ text: WORKER_BEAT_SQL, values: ["w", 1, JSON.stringify({ fenceRejects: 2, leaseLosses: 0 })] });
    // NO STATS GIVEN: NULL, and the row keeps what it had.
    await store.beatProcess(0);
    expect(db.sent[1]!.values).toEqual(["w", 0, null]);
  });

  it("answers a quota never handed out as ages and quotas of null, and a missing row as null", async () => {
    const never = scripted(() => ({ rows: [{ rps_quota: null, jup_quota: null, quota_age_ms: null }] }));
    expect(await new DispatchStore(never.pool, "w").beatProcess(0)).toEqual({ rpsQuota: null, jupQuotaPerMinute: null, ageMs: null });
    const gone = scripted(() => ({ rows: [] }));
    expect(await new DispatchStore(gone.pool, "w").beatProcess(0)).toBeNull();
  });

  it("writes into worker.stats only the counters the public page names, each a whole number of zero or more", () => {
    expect(workerStatsJson(undefined)).toBeNull();
    expect(JSON.parse(workerStatsJson({ fenceRejects: 1, fenceRejectsLastHour: 1, leaseLosses: 2, jobsLast10Min: 3, releasedOnSigterm: 4 })!)).toEqual({
      fenceRejects: 1,
      fenceRejectsLastHour: 1,
      leaseLosses: 2,
      jobsLast10Min: 3,
      releasedOnSigterm: 4,
    });
    expect(Object.keys(JSON.parse(workerStatsJson({ fenceRejects: 1 })!))).toEqual(["fenceRejects"]);
    expect(JSON.parse(workerStatsJson({ fenceRejects: 1.5, leaseLosses: Number.NaN, jobsLast10Min: -2, ...({ secret: 1 } as object) })!)).toEqual({});
    expect([...WORKER_STATS_KEYS]).toEqual(["fenceRejects", "fenceRejectsLastHour", "leaseLosses", "jobsLast10Min", "releasedOnSigterm"]);
  });

  it("is the follower's source: each read IS the beat, one statement, and the follower sets what it answered", async () => {
    const db = scripted(() => ({ rows: [{ rps_quota: 10.5, jup_quota: 20, quota_age_ms: 1_000 }] }));
    const store = new DispatchStore(db.pool, "w");
    const quotas: number[] = [];
    const tunes: number[] = [];
    const follower = new QuotaFollower({
      budget: { setQuota: (rps) => quotas.push(rps) > 0 },
      pacer: { retune: (perMinute) => tunes.push(perMinute) > 0 },
      floorRps: 4,
      floorJupiterPerMinute: 6,
      maxRps: 40,
    });
    const status = await follower.refresh(store.quotaSource(() => ({ busy: 2, stats: { jobsLast10Min: 5 } })));
    expect(status.state).toBe("row");
    expect(quotas).toEqual([4, 10.5]);
    expect(tunes).toEqual([6, 20]);
    expect(db.sent).toEqual([{ text: WORKER_BEAT_SQL, values: ["w", 2, JSON.stringify({ jobsLast10Min: 5 })] }]);
  });

  it("hands out fleetQuotas over the workers alive now, writes exactly those, and divides among all of them when more than r_max are alive", async () => {
    const live = (ids: string[]) =>
      scripted((text) => (text === LIVE_WORKERS_SQL ? { rows: ids.map((worker_id) => ({ worker_id })) } : { rows: ids.map((worker_id) => ({ worker_id })) }));
    const three = live(["a", "b", "c"]);
    const out = await new DispatchStore(three.pool, "sched").handOutQuotas({ maxWorkers: 4, jupiterPerMinute: 60 });
    const expected = fleetQuotas({ liveWorkers: 3, maxWorkers: 4, jupiterPerMinute: 60 });
    expect(out).toEqual({ quotas: expected, workers: ["a", "b", "c"] });
    expect(three.sent).toEqual([
      { text: LIVE_WORKERS_SQL, values: [WORKER_DEAD_AFTER_MS / 1000] },
      { text: WRITE_QUOTAS_SQL, values: [["a", "b", "c"], expected.perWorkerRps, 20] },
    ]);
    // A DEPLOY'S OVERLAP: five alive against r_max = 2. Each gets a fifth, so the shares still sum to the budget.
    const five = live(["a", "b", "c", "d", "e"]);
    const overlap = await new DispatchStore(five.pool, "sched").handOutQuotas({ maxWorkers: 2, jupiterPerMinute: null });
    expect(overlap.quotas.perWorkerRps! * 5).toBeCloseTo(overlap.quotas.fleetRps - overlap.quotas.schedulerRps, 9);
    expect(five.sent[1]!.values).toEqual([["a", "b", "c", "d", "e"], overlap.quotas.perWorkerRps, null]);
    // NOBODY ALIVE: the arithmetic, and no write.
    const none = live([]);
    expect((await new DispatchStore(none.pool, "sched").handOutQuotas({ maxWorkers: 2 })).workers).toEqual([]);
    expect(none.sent).toHaveLength(1);
    await expect(new DispatchStore(none.pool, "sched").handOutQuotas({ maxWorkers: 0 })).rejects.toThrow(/maxWorkers/);
    expect(none.sent).toHaveLength(1);
  });

  it("PgRpcUsageFeed: a flush is one statement of eight arrays that ADDS onto its key; nothing for nothing", async () => {
    expect(USAGE_ADD_SQL).toContain("GROUP BY 1, 2, 3, 4, 5");
    expect(USAGE_ADD_SQL).toContain("ON CONFLICT (bucket, worker_id, provider, lane, class) DO UPDATE SET");
    expect(USAGE_ADD_SQL).toContain("calls = u.calls + EXCLUDED.calls");
    expect(USAGE_ADD_SQL).toContain("errors_429 = u.errors_429 + EXCLUDED.errors_429");
    expect(USAGE_ADD_SQL).toContain("errors_other = u.errors_other + EXCLUDED.errors_other");
    const db = scripted(() => ({ rows: [] }));
    const feed = new PgRpcUsageFeed(db.pool);
    await feed.add([]);
    expect(db.connects).toBe(0);
    const row: RpcUsageRow = { bucket: 1_760_000_400_000, workerId: "w", provider: "helius-rpc", lane: "send", usageClass: "standard", calls: 3, errors429: 1, errorsOther: 0 };
    await feed.add([row, { ...row, lane: "rest", usageClass: "archival" }]);
    expect(db.sent).toEqual([
      {
        text: USAGE_ADD_SQL,
        values: [["1760000400000", "1760000400000"], ["w", "w"], ["helius-rpc", "helius-rpc"], ["send", "rest"], ["standard", "archival"], ["3", "3"], ["1", "1"], ["0", "0"]],
      },
    ]);
  });

  it("PgRpcUsageFeed: summarizes in SQL — Helius's providers and the code's lanes only, by class, recent and rest — and adds up what it answers", async () => {
    expect(USAGE_SUMMARY_SQL).toContain("sum(calls) AS calls");
    expect(USAGE_SUMMARY_SQL).toContain("GROUP BY 1, 2, 3");
    expect(USAGE_SUMMARY_SQL).toContain("provider = ANY($4::text[]) AND lane = ANY($5::text[])");
    const db = scripted(() => ({
      rows: [
        { class: "standard", rest: false, recent: false, calls: "100" },
        { class: "standard", rest: true, recent: true, calls: "7" },
        { class: "standard", rest: false, recent: true, calls: "3" },
        { class: "archival", rest: false, recent: true, calls: "2" },
      ],
    }));
    expect(await new PgRpcUsageFeed(db.pool).summarize(10, 20, 30)).toEqual({
      total: { standard: 110, archival: 2 },
      recentRest: { standard: 7 },
      recentOther: { standard: 3, archival: 2 },
    });
    expect(db.sent).toEqual([{ text: USAGE_SUMMARY_SQL, values: [10, 20, 30, ["helius-rpc", "helius-rest"], ["send", "hot", "rest", "sched"]] }]);
  });

  it("PgRpcUsageFeed: reads buckets back as ms, skips a provider or lane the code does not name, and destroys a failed client", async () => {
    const db = scripted((text) =>
      text === USAGE_READ_SQL
        ? {
            rows: [
              { bucket_ms: "1760000400000", worker_id: "w", provider: "helius-rpc", lane: "hot", class: "standard", calls: "12", errors_429: "1", errors_other: "0" },
              { bucket_ms: "1760000400000", worker_id: "w", provider: "somebody-else", lane: "hot", class: "standard", calls: "5", errors_429: "0", errors_other: "0" },
              { bucket_ms: "1760000400000", worker_id: "w", provider: "helius-rpc", lane: "vip", class: "standard", calls: "5", errors_429: "0", errors_other: "0" },
            ],
          }
        : new Error("down"),
    );
    const feed = new PgRpcUsageFeed(db.pool);
    expect(await feed.read(1, 2)).toEqual([
      { bucket: 1_760_000_400_000, workerId: "w", provider: "helius-rpc", lane: "hot", usageClass: "standard", calls: 12, errors429: 1, errorsOther: 0 },
    ]);
    expect(db.sent[0]).toEqual({ text: USAGE_READ_SQL, values: [1, 2] });
    await expect(feed.prune(5)).rejects.toThrow("down");
    expect(db.sent[1]).toEqual({ text: USAGE_PRUNE_SQL, values: [5] });
    expect(db.releases).toEqual([false, true]);
  });
});

describe("DARK: nothing a legacy keeper runs imports the store", () => {
  // BY IMPORT SPECIFIER, static or dynamic, not by any mention: the fleet's and
  // the budget's modules name this file in their comments since the merge, and a
  // comment imports nothing. test/dispatch-dark.test.ts adds the stronger
  // property — no entry point reaches any dispatcher module through any chain.
  const importsStore = (text: string): boolean =>
    /\bfrom\s+["'][^"']*\/dispatch-store(\.js)?["']|\bimport\s*\(\s*["'][^"']*\/dispatch-store(\.js)?["']|\bimport\s+["'][^"']*\/dispatch-store(\.js)?["']/.test(text);

  it("recognises an import, a dynamic import and a bare import, and not a mention", () => {
    expect(importsStore('import { DispatchStore } from "./dispatch-store.js";')).toBe(true);
    expect(importsStore('const m = await import("../src/dispatch-store.js");')).toBe(true);
    expect(importsStore('import "./dispatch-store.js";')).toBe(true);
    expect(importsStore("// SCHEDULER_POOL_MAX in src/dispatch-store.ts")).toBe(false);
  });

  // THE DISPATCHER'S OWN FILES, and only they, since the scheduler (Q2) landed:
  // its entry point and the modules only that entry point loads. Whether a
  // process production starts can reach any of them is test/dispatch-dark.test.ts's.
  const DISPATCHER_FILES = ["bin/scheduler.mts", "src/scheduler-pg.ts", "src/scheduler-select.ts", "src/scheduler.ts"];

  it("is imported by no file under src/ or bin/ but the dispatcher's own", () => {
    const importers: string[] = [];
    for (const dir of ["src", "bin"]) {
      for (const name of readdirSync(fileURLToPath(new URL(`${dir}/`, PACKAGE)))) {
        if (!/\.(ts|mts)$/.test(name) || name === "dispatch-store.ts") continue;
        if (importsStore(source(`${dir}/${name}`))) importers.push(`${dir}/${name}`);
      }
    }
    expect(importers.sort()).toEqual(DISPATCHER_FILES);
  });
});
