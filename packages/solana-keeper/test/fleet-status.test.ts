// The dispatcher's /status and /health (src/fleet-status.ts): the page is a
// snapshot a timer reads and the handler only renders; an unread fleet is not
// an empty one; nothing credential-bearing is served; and /health answers per
// role, never because an upstream answered badly.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Redactor, Secret, hex64Fingerprint } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { FleetAlerts } from "../src/fleet-alerts.js";
import { parseFleetSnapshot, vaultDetailOf, vaultStreaksOf } from "../src/fleet-pg.js";
import {
  FLEET_STATUS_READ_BUDGET_MS,
  FleetStatusReader,
  VAULTS_LISTED,
  VAULT_DETAIL_CHARS,
  VAULT_DETAIL_READ_CHARS,
  VAULT_DETAIL_WITHHELD,
  VAULT_STREAKS_KEYS,
  WORKER_HEARTBEAT_MS,
  decideFleetHealth,
  describeReadFailure,
  fleetStatusView,
  renderFleetStatus,
  samplePool,
  type FleetSnapshot,
  type FleetStatusSource,
  type FleetStatusView,
} from "../src/fleet-status.js";
import { HEALTH_STALE_FLOOR_MS, httpHandler, type LeaderboardReply } from "../src/status.js";
import { completionFor, readStreaks } from "../src/worker-job.js";

const T0 = Date.parse("2026-10-12T12:00:00Z");
const DB = "postgres://sip:FleetDbPassw0rdNeverServed@db.example.test:5432/sip";

/** The owner's vault and wallet (test/doorbell.test.ts), and a PROFIT vault still draining. */
const OWNER_VAULT = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";
const OWNER_WALLET = "9QX53J3Kbs8ogQirZq5iN11rucZAvgF4EKWw98QAkUSe";
const DRAINING_VAULT = "D5J5o2gS1111111111111111111111111111111111";
const BYTE_RUN_TEXT = `the signer's bytes: [${Array.from({ length: 40 }, (_, i) => (i * 7) % 256).join(", ")}]`;
const HEX_KEY = "ab".repeat(32);

/** What the statement returns, as json_build_object writes it: numbers, ISO text, nested objects. */
const RAW = {
  now: "2026-10-12T12:00:00.000+00:00",
  fleet: {
    schedulerId: "sched-a",
    tickAt: "2026-10-12T11:59:30.000+00:00",
    tickAgeMs: 30_000,
    fullPassReason: `a bell write failed (Error: connect to ${DB} refused)`,
    boardDirtyAt: null,
    discoveryOkAt: "2026-10-12T11:59:30.000+00:00",
    discoveryAgeMs: 30_000,
  },
  workers: [
    { workerId: "w-alive", kind: "worker", version: "abc", startedAt: "2026-10-12T11:00:00+00:00", heartbeatAgeMs: 4_000, stoppedAt: null, slots: 2, busy: 1, rpsQuota: 16, jupQuota: null, quotaAgeMs: 9_000, leases: 1, stats: { fenceRejects: 0, leaseLosses: 1, jobsLast10Min: 12, privateKey: "never served" } },
    { workerId: "w-dead", kind: "worker", version: "abc", startedAt: "2026-10-12T10:00:00+00:00", heartbeatAgeMs: 180_000, stoppedAt: null, slots: 2, busy: 0, rpsQuota: 16, jupQuota: null, leases: 0, stats: {} },
  ],
  bySystem: { legacy: 2, queue: 3 },
  lanes: { bell: { due: 1, waitP50Ms: 2_000, waitP90Ms: 2_000, waitMaxMs: 2_000 }, safety: { due: 2, waitP50Ms: 70_000, waitP90Ms: 130_000, waitMaxMs: 140_000 } },
  leases: { held: 1, expired: 1, overCeiling: 0, takeovers: 1, claimLagP50Ms: 1_000, claimLagP90Ms: 1_000 },
  parked: { count: 1, vaults: [{ vault: "VaultParked", reason: "5 lapsed leases in a row", attempts: 5 }] },
  outcomes: { none: 1, SETTLED: 2 },
  expiries: [
    { vault: "VaultLapsed", fence: 7, attempts: 1, lapsed: true },
    { vault: "VaultTaken", fence: 9, attempts: 3, lapsed: false },
  ],
  sends: { open: 2, oldestOpenAgeMs: 40_000, unechoed: 1 },
  lastHour: [{ kind: "settle", state: "landed", count: 3 }],
  carries: 2,
  vaults: {
    total: 6,
    rows: [
      {
        vault: DRAINING_VAULT, system: "draining", skimMode: 0, lane: "new", lastOutcome: null, lastDetail: null,
        lastDoneAt: null, dueAt: "2026-10-12T11:40:00+00:00", parkedReason: null, attempts: 0, streaks: {},
      },
      {
        vault: OWNER_VAULT, system: "queue", skimMode: 0, lane: "busy", lastOutcome: "settle RETRY · invest REFUSED",
        lastDetail: `the leg's quote failed (Error: connect to ${DB} refused) with key ${HEX_KEY}`,
        lastDoneAt: "2026-10-12T11:59:00+00:00", dueAt: "2026-10-12T12:01:00+00:00", parkedReason: null, attempts: 1,
        streaks: { settleRetries: { [OWNER_WALLET]: 2, "not an address": 3, ZZ: 4 }, investFailed: 0, investRefused: "2", wrapShort: -1, privateKey: "never served" },
      },
      {
        vault: "4J3En7ug1111111111111111111111111111111111", system: "legacy", skimMode: 1, lane: "new", lastOutcome: "IDLE",
        lastDetail: BYTE_RUN_TEXT, lastDoneAt: null, dueAt: "infinity", parkedReason: null, attempts: 0, streaks: null,
      },
      { vault: "LongDetai1Vau1t11111111111111111111111111111", system: "queue", skimMode: 0, lane: "safety", lastOutcome: "IDLE", lastDetail: "x".repeat(500), attempts: 0, streaks: {} },
      { system: "queue", lane: "safety" },
    ],
  },
  unserved: {
    draining: 1,
    parked: 1,
    vaults: [
      { vault: DRAINING_VAULT, system: "draining", forMs: 1_200_000, from: "due_at", parkedReason: null },
      { vault: "VaultParked", system: "queue", forMs: null, from: null, parkedReason: "5 lapsed leases in a row" },
      { vault: "VaultOddFrom", system: "draining", forMs: 5, from: "whatever", parkedReason: null },
    ],
  },
  legacy: { vaults: 2, newVaultSystem: "legacy", receipts: 3, fresh: "1", lastReadAgeMs: 45_000 },
};

const SNAPSHOT: FleetSnapshot = parseFleetSnapshot(RAW);

class FakeSource implements FleetStatusSource {
  reads = 0;
  next: () => Promise<FleetSnapshot> = async () => SNAPSHOT;
  read(): Promise<FleetSnapshot> {
    this.reads += 1;
    return this.next();
  }
}

function drive(handler: ReturnType<typeof httpHandler>, url: string): { status: number; body: string } {
  let body = "";
  const response = { statusCode: 200, setHeader: () => undefined, end: (chunk?: string) => (body = chunk ?? "") };
  handler({ method: "GET", url, headers: {} } as unknown as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.statusCode, body };
}

const noBoard = (): LeaderboardReply => ({ unavailable: "not here" });

describe("the snapshot as the statement returns it", () => {
  it("serves only the worker stats it names, marks a heartbeat past 2 minutes dead, and reads the lanes' oldest wait", () => {
    const [alive, dead] = SNAPSHOT.workers;
    expect(alive!.stats).toEqual({ fenceRejects: 0, fenceRejectsLastHour: null, leaseLosses: 1, jobsLast10Min: 12, releasedOnSigterm: null });
    // The quota's age (worker.quota_at, Q1) as the statement computed it; a row never handed out reads null, not 0.
    expect([alive!.quotaAgeMs, dead!.quotaAgeMs]).toEqual([9_000, null]);
    expect(JSON.stringify(SNAPSHOT)).not.toContain("never served");
    expect(alive!.dead).toBe(false);
    expect(dead!.dead).toBe(true);
    expect(SNAPSHOT.queue.due).toBe(3);
    expect(SNAPSHOT.queue.oldestDueMs).toBe(140_000);
    expect(SNAPSHOT.carries.pending).toBe(2);
  });

  it("reads a lapse at its own fence, and a takeover's earlier claims at the fences below it", () => {
    expect(SNAPSHOT.expiries).toEqual([
      { vault: "VaultLapsed", fence: 7 },
      { vault: "VaultTaken", fence: 8 },
      { vault: "VaultTaken", fence: 7 },
    ]);
  });

  it("is empty, never a throw, for a statement that returned nothing", () => {
    const empty = parseFleetSnapshot(undefined);
    expect(empty.scheduler).toBeNull();
    expect(empty.workers).toEqual([]);
    expect(empty.queue.oldestDueMs).toBeNull();
    expect([empty.vaults, empty.vaultsTruncated, empty.unserved]).toEqual([[], 0, { draining: 0, parked: 0, vaults: [] }]);
    // AN UNREAD LEGACY BLOCK IS NOT A FLEET WITH NO LEGACY KEEPER UP: null, never zeros.
    expect(empty.legacy).toBeNull();
    expect(parseFleetSnapshot({ legacy: [] }).legacy).toBeNull();
  });

  it("serves the legacy keepers' side (fleet.legacy): the vaults still theirs, where new vaults go, and their receipts", () => {
    expect(SNAPSHOT.legacy).toEqual({ vaults: 2, newVaultSystem: "legacy", receipts: 3, fresh: 1, lastReadAgeMs: 45_000 });
    expect(parseFleetSnapshot({ legacy: { vaults: 0, newVaultSystem: null, receipts: 0, fresh: 0, lastReadAgeMs: null } }).legacy).toEqual({
      vaults: 0,
      newVaultSystem: null,
      receipts: 0,
      fresh: 0,
      lastReadAgeMs: null,
    });
  });
});

describe("the per-vault table (fleet.vaults) and the unserved view (fleet.unserved)", () => {
  it("serves each row the statement listed — the full address, who acts, its mode byte, lane, last outcome and when — and counts what the cap left out", () => {
    expect(SNAPSHOT.vaults.map((row) => row.vault)).toEqual([DRAINING_VAULT, OWNER_VAULT, "4J3En7ug1111111111111111111111111111111111", "LongDetai1Vau1t11111111111111111111111111111"]);
    // A ROW WITHOUT AN ADDRESS IS NOT A ROW; the total still counts it, so it shows as left out.
    expect(SNAPSHOT.vaultsTruncated).toBe(2);
    expect(SNAPSHOT.vaults[1]).toMatchObject({
      system: "queue",
      skimMode: 0,
      lane: "busy",
      lastOutcome: "settle RETRY · invest REFUSED",
      lastDoneAt: "2026-10-12T11:59:00+00:00",
      dueAt: "2026-10-12T12:01:00+00:00",
      parkedReason: null,
      attempts: 1,
    });
    // A RETIRED QUEUE ROW IS DUE AT INFINITY, said as Postgres says it.
    expect(SNAPSHOT.vaults[2]!.dueAt).toBe("infinity");
    expect(VAULTS_LISTED).toBe(500);
  });

  it("serves only the four streak counts, a settle retry only under an address, and a count that is not a whole number as 0", () => {
    expect(SNAPSHOT.vaults[1]!.streaks).toEqual({ settleRetries: { [OWNER_WALLET]: 2 }, investFailed: 0, investRefused: 2, wrapShort: 0 });
    expect(JSON.stringify(SNAPSHOT)).not.toContain("never served");
    expect(SNAPSHOT.vaults[2]!.streaks).toEqual({ settleRetries: {}, investFailed: 0, investRefused: 0, wrapShort: 0 });
    expect(vaultStreaksOf({ investFailed: 1.5, investRefused: Number.MAX_SAFE_INTEGER + 2, wrapShort: 3 })).toEqual({ settleRetries: {}, investFailed: 0, investRefused: 0, wrapShort: 3 });
  });

  it("reads the same four keys a worker's job writes (completionFor), so a new streak cannot reach the page unnamed or vanish from it", () => {
    const completion = completionFor({ settles: [], invest: { outcome: "REFUSED", detail: "refused" }, wrapShort: true, previous: readStreaks({}), unfinished: false });
    expect(Object.keys(completion.streaks).sort()).toEqual([...VAULT_STREAKS_KEYS].sort());
    expect(vaultStreaksOf(completion.streaks)).toEqual(completion.streaks);
  });

  it("cuts a detail to 200 characters, scrubs it with this process's redactor, and withholds one that carries a key nobody registered, row by row", () => {
    expect(SNAPSHOT.vaults[3]!.lastDetail).toBe("x".repeat(VAULT_DETAIL_CHARS));
    // A 64-HEX RUN IS MASKED; THE ROW STAYS.
    expect(SNAPSHOT.vaults[1]!.lastDetail).toContain("<redacted:hex64:");
    expect(SNAPSHOT.vaults[1]!.lastDetail).not.toContain(HEX_KEY);
    // A RUN OF BYTE VALUES IS A KEY'S PRINTED FORM: this one row's text is withheld, not the page.
    expect(SNAPSHOT.vaults[2]!.lastDetail).toBe(VAULT_DETAIL_WITHHELD);
    expect(vaultDetailOf(null)).toBeNull();
    expect(vaultDetailOf("landed; receipt read")).toBe("landed; receipt read");
  });

  it("scrubs a detail BEFORE it cuts it: a key that straddles the 200th character is masked whole, not served as its first characters", () => {
    // NOT A REPEATING PATTERN, so its first twenty characters cannot turn up by chance in the mask's fingerprint.
    const key = createHash("sha256").update("a key that straddles the cut").digest("hex");
    const detail = vaultDetailOf(`${"x".repeat(VAULT_DETAIL_CHARS - 20)}${key} and then the rest of the line`)!;
    expect(detail).toHaveLength(VAULT_DETAIL_CHARS);
    expect(detail).not.toContain(key.slice(0, 20));
    expect(detail.slice(VAULT_DETAIL_CHARS - 20)).toBe("<redacted:hex64:".concat(hex64Fingerprint(key)).slice(0, 20));
    // A RUN OF BYTE VALUES PAST THE CUT still withholds the row: the nets see the text as read.
    expect(vaultDetailOf(`${"x".repeat(VAULT_DETAIL_CHARS)} ${BYTE_RUN_TEXT}`)).toBe(VAULT_DETAIL_WITHHELD);
    expect(VAULT_DETAIL_READ_CHARS).toBeGreaterThan(VAULT_DETAIL_CHARS);
  });

  it("reads the unserved view whole: draining and parked counted, each draining row's time and the column it is measured from", () => {
    expect(SNAPSHOT.unserved.draining).toBe(1);
    expect(SNAPSHOT.unserved.parked).toBe(1);
    expect(SNAPSHOT.unserved.vaults).toEqual([
      { vault: DRAINING_VAULT, system: "draining", forMs: 1_200_000, from: "due_at", parkedReason: null },
      { vault: "VaultParked", system: "queue", forMs: null, from: null, parkedReason: "5 lapsed leases in a row" },
      // A `from` the statement never writes is not served as if it were one.
      { vault: "VaultOddFrom", system: "draining", forMs: 5, from: null, parkedReason: null },
    ]);
  });
});

describe("the reader", () => {
  it("serves nothing before the first read and says so: an unread fleet is not an empty one", () => {
    const reader = new FleetStatusReader({ source: new FakeSource(), now: () => T0 });
    expect(reader.snapshot()).toBeNull();
    expect(reader.status().ok).toBeNull();
    expect(reader.status().at).toBeNull();
  });

  it("keeps the last good snapshot through a failed read, marked stale with the failure", async () => {
    let now = T0;
    const source = new FakeSource();
    const reader = new FleetStatusReader({ source, now: () => now });
    expect(await reader.refresh()).toBe(true);
    source.next = async () => {
      throw Object.assign(new Error('relation "sip_solana.vault_work" does not exist'), { code: "42P01" });
    };
    now = T0 + 30_000;
    expect(await reader.refresh()).toBe(false);
    expect(reader.snapshot()).toBe(SNAPSHOT);
    const status = reader.status();
    expect(status.ok).toBe(false);
    expect(status.ageMs).toBe(30_000);
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastError).toContain("apply sql/sip_solana.sql with setup-read-model");
  });

  it("gives up on a read past its budget and starts no second one until the first has settled", async () => {
    const source = new FakeSource();
    let release!: (snapshot: FleetSnapshot) => void;
    source.next = () =>
      new Promise<FleetSnapshot>((resolve) => {
        release = resolve;
      });
    const reader = new FleetStatusReader({ source, now: () => T0, budgetMs: 5 });
    expect(await reader.refresh()).toBe(false);
    expect(reader.status().lastError).toBe("Error: the fleet read took longer than 5 ms");
    expect(await reader.refresh()).toBe(false);
    expect(source.reads).toBe(1);
    expect(reader.status().skipped).toBe(1);
    release(SNAPSHOT);
    await new Promise((resolve) => setImmediate(resolve));
    source.next = async () => SNAPSHOT;
    expect(await reader.refresh()).toBe(true);
    expect(source.reads).toBe(2);
  });

  it("hands every snapshot to the alerts, and a throw there does not cost the page", async () => {
    const seen: FleetSnapshot[] = [];
    const reader = new FleetStatusReader({
      source: new FakeSource(),
      onSnapshot: (snapshot) => {
        seen.push(snapshot);
        throw new Error("an evaluator bug");
      },
    });
    expect(await reader.refresh()).toBe(true);
    expect(seen).toEqual([SNAPSHOT]);
    expect(reader.snapshot()).toBe(SNAPSHOT);
  });

  it("budgets a read at the pool's own statement timeout", () => {
    expect(FLEET_STATUS_READ_BUDGET_MS).toBe(5_000);
  });
});

describe("/health per role", () => {
  it("fails a scheduler whose tick has not moved for max(3 ticks, 10 min), and a standby's tick counts as moving", () => {
    const base = { role: "scheduler" as const, startedAt: T0, intervalMs: 60_000 };
    expect(decideFleetHealth({ ...base, now: T0 + HEALTH_STALE_FLOOR_MS - 1, lastProgressAt: T0 }).ok).toBe(true);
    const stale = decideFleetHealth({ ...base, now: T0 + HEALTH_STALE_FLOOR_MS, lastProgressAt: T0 });
    expect(stale).toEqual({ ok: false, detail: "the scheduler's tick last moved 600s ago", quietForMs: HEALTH_STALE_FLOOR_MS, staleAfterMs: HEALTH_STALE_FLOOR_MS });
    expect(decideFleetHealth({ ...base, now: T0 + HEALTH_STALE_FLOOR_MS, lastProgressAt: null }).detail).toBe(
      "no tick has run in the 600s since this scheduler came up",
    );
    // A slower tick stretches the bound to three of them.
    expect(decideFleetHealth({ ...base, intervalMs: 300_000, now: T0 + HEALTH_STALE_FLOOR_MS + 1, lastProgressAt: T0 }).ok).toBe(true);
  });

  it("keeps a worker healthy while its heartbeat loop runs — 10 minutes for a 10-second loop, because its leases lapse in 45 s anyway", () => {
    const base = { role: "worker" as const, startedAt: T0, intervalMs: WORKER_HEARTBEAT_MS };
    expect(decideFleetHealth({ ...base, now: T0 + 5 * 60_000, lastProgressAt: T0 }).ok).toBe(true);
    const stopped = decideFleetHealth({ ...base, now: T0 + HEALTH_STALE_FLOOR_MS, lastProgressAt: T0 });
    expect(stopped.ok).toBe(false);
    expect(stopped.detail).toBe("the worker's heartbeat loop last moved 600s ago");
  });
});

describe("the page", () => {
  function view(reader: FleetStatusReader, health = decideFleetHealth({ role: "scheduler", now: T0, startedAt: T0, lastProgressAt: T0, intervalMs: 60_000 })): FleetStatusView {
    const alerts = new FleetAlerts({ alerter: { fire: () => undefined, clear: () => undefined }, windowMs: 60_000, now: () => T0 });
    alerts.observePools([samplePool({ totalCount: 2, idleCount: 1, waitingCount: 0 })]);
    return fleetStatusView({ role: "scheduler", processId: "sched-a", startedAt: T0, version: "abc", health, reader, alerts });
  }

  it("renders with no read of its own: GET /status serves what the timer read, and GET /health the role's verdict", async () => {
    const source = new FakeSource();
    const reader = new FleetStatusReader({ source, now: () => T0 });
    await reader.refresh();
    const redactor = new Redactor().register(new Secret(DB, "databaseUrl"));
    let health = decideFleetHealth({ role: "scheduler", now: T0, startedAt: T0, lastProgressAt: T0, intervalMs: 60_000 });
    const handler = httpHandler(() => renderFleetStatus(view(reader, health), redactor), () => health, noBoard, null);
    const served = drive(handler, "/status");
    expect(source.reads).toBe(1);
    const parsed = JSON.parse(served.body) as FleetStatusView;
    expect(parsed.role).toBe("scheduler");
    expect(parsed.fleet?.queue.oldestDueMs).toBe(140_000);
    expect(parsed.read.ok).toBe(true);
    expect(parsed.alerts?.pg).toEqual({ waiting: 0, total: 2, idle: 1, saturatedStreak: 0 });
    // THE PER-USER TABLE IS IN THE FLEET BLOCK, every address whole.
    expect(parsed.fleet?.vaults.map((row) => row.vault)).toContain(OWNER_VAULT);
    expect(parsed.fleet?.vaultsTruncated).toBe(2);
    expect(parsed.fleet?.unserved.draining).toBe(1);
    drive(handler, "/status");
    expect(source.reads, "a GET is not a read").toBe(1);
    expect(drive(handler, "/health").status).toBe(200);
    health = decideFleetHealth({ role: "scheduler", now: T0 + HEALTH_STALE_FLOOR_MS, startedAt: T0, lastProgressAt: T0, intervalMs: 60_000 });
    expect(drive(handler, "/health").status).toBe(503);
  });

  it("scrubs what other processes wrote — a full-pass reason built from an upstream error — and withholds the page if a secret survives", async () => {
    const reader = new FleetStatusReader({ source: new FakeSource(), now: () => T0 });
    await reader.refresh();
    const redactor = new Redactor().register(new Secret(DB, "databaseUrl"));
    const served = renderFleetStatus(view(reader), redactor);
    expect(served).not.toContain("FleetDbPassw0rdNeverServed");
    expect(served).toContain("<redacted:databaseUrl>");
    const tripwire = { scrub: (text: string) => text, contains: () => true } as unknown as Redactor;
    expect(JSON.parse(renderFleetStatus(view(reader), tripwire))).toEqual({ service: expect.any(String), status: "withheld: redaction tripwire" });
  });

  it("names a missing schema by what to run, and anything else by the upstream's scrubbed summary", () => {
    expect(describeReadFailure(Object.assign(new Error("column x does not exist"), { code: "42703" }))).toContain("setup-read-model");
    expect(describeReadFailure(new Error("Connection terminated unexpectedly"))).toBe("Error: Connection terminated unexpectedly");
  });
});
