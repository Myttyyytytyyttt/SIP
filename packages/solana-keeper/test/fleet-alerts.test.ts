// The dispatcher's alerts (src/fleet-alerts.ts): every threshold the ADR sets
// (§6.3) and the two the cut-over added, pinned on the pure rules, and who
// raises what on the evaluator.

import { Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { createAlerter, type Alert } from "../src/alerts.js";
import {
  FENCE_REJECT_ALERT_KEY,
  FleetAlerts,
  LEASE_EXPIRED_ALERT_KEY,
  LEASE_EXPIRED_CRITICAL_PER_HOUR,
  LEGACY_ORPHANED_ALERT_KEY,
  LEGACY_ORPHANED_CRITICAL_MS,
  LEGACY_SILENT_AFTER_MS,
  PG_SATURATED_ALERT_KEY,
  PG_SATURATED_CRITICAL_STREAK,
  QUEUE_LAG_ALERT_KEY,
  SCHEDULER_STALE_AFTER_MS,
  SCHEDULER_STALE_ALERT_KEY,
  SchedulerStaleWatch,
  VAULT_UNSERVED_CRITICAL_MS,
  VAULT_UNSERVED_WARN_MS,
  fenceRejectAlert,
  leaseExpiredAlert,
  legacyOrphaned,
  legacyOrphanedAlert,
  legacyOrphanedForMs,
  pgSaturatedAlert,
  queueLagAlert,
  schedulerStaleAlert,
  vaultUnservedAlert,
  vaultUnservedKey,
} from "../src/fleet-alerts.js";
import type { FleetLegacy, FleetSnapshot, FleetUnserved, FleetWorkerRow, UnservedVault } from "../src/fleet-status.js";
import { LEGACY_READ_FRESH_MS } from "../src/handover.js";

const WINDOW = 60_000;
const T0 = Date.parse("2026-10-12T12:00:00Z");

function worker(workerId: string, fenceRejects: number | null, fenceRejectsLastHour: number | null = null): FleetWorkerRow {
  return {
    workerId,
    kind: "worker",
    version: "test",
    startedAt: null,
    heartbeatAgeMs: 1_000,
    dead: false,
    stoppedAt: null,
    slots: 2,
    busy: 0,
    leases: 0,
    rpsQuota: null,
    jupQuota: null,
    quotaAgeMs: null,
    stats: { fenceRejects, fenceRejectsLastHour, leaseLosses: null, jobsLast10Min: null, releasedOnSigterm: null },
  };
}

function snapshot(
  over: Partial<{
    expiries: FleetSnapshot["expiries"];
    workers: FleetWorkerRow[];
    oldestDueMs: number | null;
    due: number;
    tickAgeMs: number | null;
    unserved: FleetUnserved;
    legacy: FleetLegacy | null;
  }> = {},
): FleetSnapshot {
  return {
    now: new Date(T0).toISOString(),
    scheduler: {
      schedulerId: "s1",
      tickAt: null,
      tickAgeMs: over.tickAgeMs === undefined ? 5_000 : over.tickAgeMs,
      fullPassReason: null,
      boardDirtyAt: null,
      discoveryOkAt: null,
      discoveryAgeMs: null,
    },
    workers: over.workers ?? [],
    queue: {
      bySystem: {},
      lanes: {},
      due: over.due ?? 0,
      oldestDueMs: over.oldestDueMs ?? null,
      leases: { held: 0, expired: 0, overCeiling: 0, takeovers: 0, claimLagP50Ms: null, claimLagP90Ms: null },
      parked: { count: 0, vaults: [] },
      outcomes: {},
    },
    sends: { open: 0, oldestOpenAgeMs: null, unechoed: 0, lastHour: [] },
    carries: { pending: 0 },
    expiries: over.expiries ?? [],
    vaults: [],
    vaultsTruncated: 0,
    unserved: over.unserved ?? { draining: 0, parked: 0, vaults: [] },
    legacy: over.legacy ?? null,
  };
}

const VAULT_A = "D5J5o2gS1111111111111111111111111111111111";
const VAULT_B = "4J3En7ug1111111111111111111111111111111111";
const draining = (vault: string, forMs: number | null, from: UnservedVault["from"] = "due_at"): UnservedVault => ({ vault, system: "draining", forMs, from, parkedReason: null });
const parkedRow = (vault: string): UnservedVault => ({ vault, system: "queue", forMs: null, from: null, parkedReason: "its lease lapsed 5 claims in a row" });
/** The unserved view as FLEET_SNAPSHOT_SQL lists it: every draining row first, then the parked ones, whole unless `draining` says more. */
const unserved = (rows: UnservedVault[], counts: Partial<{ draining: number; parked: number }> = {}): FleetUnserved => ({
  draining: counts.draining ?? rows.filter((row) => row.system === "draining").length,
  parked: counts.parked ?? rows.filter((row) => row.system === "queue").length,
  vaults: rows,
});

function evaluator(legacy: { readonly retired: boolean } | null = null) {
  let now = T0;
  const fired: Alert[] = [];
  const clearedKeys: string[] = [];
  const alerts = new FleetAlerts({
    alerter: { fire: (alert) => fired.push(alert), clear: (key) => clearedKeys.push(key) },
    windowMs: WINDOW,
    legacy,
    now: () => now,
  });
  return {
    alerts,
    fired,
    clearedKeys,
    at: (ms: number) => {
      now = ms;
    },
    keys: () => fired.map((alert) => `${alert.key}:${alert.severity}`),
  };
}

describe("the rules, at the ADR's thresholds (§6.3)", () => {
  it("lease-expired warns on a lapse and pages from 3 in an hour", () => {
    expect(leaseExpiredAlert({ expiredLastHour: 0, latest: null })).toEqual({ fire: null, clear: true });
    expect(leaseExpiredAlert({ expiredLastHour: 1, latest: "v" }).fire?.severity).toBe("warn");
    expect(leaseExpiredAlert({ expiredLastHour: LEASE_EXPIRED_CRITICAL_PER_HOUR - 1, latest: "v" }).fire?.severity).toBe("warn");
    expect(leaseExpiredAlert({ expiredLastHour: LEASE_EXPIRED_CRITICAL_PER_HOUR, latest: "v" }).fire?.severity).toBe("critical");
  });

  it("fence-reject pages on any", () => {
    expect(fenceRejectAlert({ rejectsLastHour: 0, workers: [] })).toEqual({ fire: null, clear: true });
    const one = fenceRejectAlert({ rejectsLastHour: 1, workers: ["w1"] }).fire!;
    expect(one.severity).toBe("critical");
    expect(one.key).toBe(FENCE_REJECT_ALERT_KEY);
    expect(one.detail).toContain("w1");
  });

  it("queue-lag pages beyond 2 windows, stays quiet between 1 and 2, and clears only under 1", () => {
    expect(queueLagAlert({ oldestDueMs: null, due: 0, windowMs: WINDOW })).toEqual({ fire: null, clear: true });
    expect(queueLagAlert({ oldestDueMs: WINDOW, due: 1, windowMs: WINDOW })).toEqual({ fire: null, clear: true });
    expect(queueLagAlert({ oldestDueMs: WINDOW + 1, due: 1, windowMs: WINDOW })).toEqual({ fire: null, clear: false });
    expect(queueLagAlert({ oldestDueMs: 2 * WINDOW, due: 1, windowMs: WINDOW })).toEqual({ fire: null, clear: false });
    expect(queueLagAlert({ oldestDueMs: 2 * WINDOW + 1, due: 3, windowMs: WINDOW }).fire?.severity).toBe("critical");
  });

  it("scheduler-stale pages past 10 minutes of tick_at, and on a fleet that never ticked once this process has waited as long", () => {
    expect(schedulerStaleAlert({ tickAgeMs: SCHEDULER_STALE_AFTER_MS, upMs: 0 })).toEqual({ fire: null, clear: true });
    expect(schedulerStaleAlert({ tickAgeMs: SCHEDULER_STALE_AFTER_MS + 1, upMs: 0 }).fire?.severity).toBe("critical");
    expect(schedulerStaleAlert({ tickAgeMs: null, upMs: SCHEDULER_STALE_AFTER_MS })).toEqual({ fire: null, clear: false });
    const never = schedulerStaleAlert({ tickAgeMs: null, upMs: SCHEDULER_STALE_AFTER_MS + 1 }).fire!;
    expect(never.severity).toBe("critical");
    expect(never.title).toBe("No dispatcher scheduler has ever ticked");
  });

  it("vault-unserved warns past 15 minutes of draining, pages past an hour, and clears on no evidence", () => {
    expect(vaultUnservedAlert({ vault: VAULT_A, forMs: null, from: null })).toEqual({ fire: null, clear: true });
    expect(vaultUnservedAlert({ vault: VAULT_A, forMs: VAULT_UNSERVED_WARN_MS, from: "due_at" })).toEqual({ fire: null, clear: true });
    const warn = vaultUnservedAlert({ vault: VAULT_A, forMs: VAULT_UNSERVED_WARN_MS + 1, from: "due_at" }).fire!;
    expect(warn.severity).toBe("warn");
    expect(warn.key).toBe(`vault-unserved:${VAULT_A}`);
    expect(warn.key).toBe(vaultUnservedKey(VAULT_A));
    // WHO PUT IT THERE, AND WHAT TO RUN: the person reading it is the one who runs arm or release.
    expect(warn.detail).toContain("since the scheduler enrolled it");
    expect(warn.detail).toContain("dispatch-handover arm");
    expect(warn.detail).toContain("dispatch-handover release");
    expect(warn.context).toEqual({ vault: VAULT_A, forMs: VAULT_UNSERVED_WARN_MS + 1, from: "due_at" });
    expect(vaultUnservedAlert({ vault: VAULT_A, forMs: VAULT_UNSERVED_CRITICAL_MS, from: "system_at" }).fire?.severity).toBe("warn");
    const page = vaultUnservedAlert({ vault: VAULT_A, forMs: VAULT_UNSERVED_CRITICAL_MS + 1, from: "system_at" }).fire!;
    expect(page.severity).toBe("critical");
    expect(page.detail).toContain("since a handover drained it");
    expect([VAULT_UNSERVED_WARN_MS, VAULT_UNSERVED_CRITICAL_MS]).toEqual([15 * 60_000, 60 * 60_000]);
  });

  it("pg-saturated pages after 3 ticks in a row and says nothing before", () => {
    expect(pgSaturatedAlert({ streak: 0, waiting: 0, total: 2 })).toEqual({ fire: null, clear: true });
    expect(pgSaturatedAlert({ streak: PG_SATURATED_CRITICAL_STREAK - 1, waiting: 1, total: 2 })).toEqual({ fire: null, clear: false });
    expect(pgSaturatedAlert({ streak: PG_SATURATED_CRITICAL_STREAK, waiting: 1, total: 2 }).fire?.severity).toBe("critical");
  });
});

describe("the evaluator", () => {
  it("counts each lapsed lease once, pages at the third in the hour, and forgets them after the hour", () => {
    const { alerts, at, keys, clearedKeys } = evaluator();
    const v = (fence: number) => ({ vault: "VaultA", fence });
    alerts.observeSnapshot(snapshot({ expiries: [v(1)] }), { acting: true });
    alerts.observeSnapshot(snapshot({ expiries: [v(1)] }), { acting: true }); // the same lapse, seen again
    expect(alerts.status().leaseExpiredLastHour).toBe(1);
    expect(keys()).toEqual([`${LEASE_EXPIRED_ALERT_KEY}:warn`, `${LEASE_EXPIRED_ALERT_KEY}:warn`]);
    at(T0 + 10 * 60_000);
    alerts.observeSnapshot(snapshot({ expiries: [v(2), v(3)] }), { acting: true });
    expect(alerts.status().leaseExpiredLastHour).toBe(3);
    expect(keys().at(-1)).toBe(`${LEASE_EXPIRED_ALERT_KEY}:critical`);
    at(T0 + 75 * 60_000);
    alerts.observeSnapshot(snapshot(), { acting: true });
    expect(alerts.status().leaseExpiredLastHour).toBe(0);
    expect(clearedKeys).toContain(LEASE_EXPIRED_ALERT_KEY);
  });

  it("takes the workers at its first snapshot as a baseline, pages a reject that happens after it, and counts a worker that appears later whole", () => {
    const { alerts, keys } = evaluator();
    alerts.observeSnapshot(snapshot({ workers: [worker("w1", 4)] }), { acting: true });
    expect(keys().filter((key) => key.startsWith(FENCE_REJECT_ALERT_KEY))).toEqual([]);
    expect(alerts.status().fenceRejectsTotal).toBe(4);
    alerts.observeSnapshot(snapshot({ workers: [worker("w1", 5)] }), { acting: true });
    expect(keys()).toContain(`${FENCE_REJECT_ALERT_KEY}:critical`);
    expect(alerts.status().fenceRejectsLastHour).toBe(1);
    alerts.observeSnapshot(snapshot({ workers: [worker("w1", 5), worker("w2", 2)] }), { acting: true });
    expect(alerts.status().fenceRejectsLastHour).toBe(3);
  });

  it("pages, at its FIRST snapshot, a reject inside the worker's own last hour: one met between the old scheduler's last read and this one's first is not lost", () => {
    // THE REVIEW'S CASE: the scheduler service is redeployed (SIGKILL, draining 0);
    // worker w1's gate refused a send ~10 s after the old acting replica's last read.
    const { alerts, at, keys, clearedKeys } = evaluator();
    alerts.observeSnapshot(snapshot({ workers: [worker("w1", 1, 1), worker("w2", 6, 0)] }), { acting: true });
    expect(keys()).toContain(`${FENCE_REJECT_ALERT_KEY}:critical`);
    // w2'S SIX ARE OLDER THAN ITS HOUR: a baseline, as before.
    expect(alerts.status().fenceRejectsLastHour).toBe(1);
    // THE WORKER'S OWN HOUR IS WHAT ENDS IT: still in it, still paging; out of it, cleared.
    at(T0 + 20 * 60_000);
    alerts.observeSnapshot(snapshot({ workers: [worker("w1", 1, 1), worker("w2", 6, 0)] }), { acting: true });
    expect(alerts.status().fenceRejectsLastHour).toBe(1);
    at(T0 + 50 * 60_000);
    alerts.observeSnapshot(snapshot({ workers: [worker("w1", 1, 0), worker("w2", 6, 0)] }), { acting: true });
    expect(alerts.status().fenceRejectsLastHour).toBe(0);
    expect(clearedKeys).toContain(FENCE_REJECT_ALERT_KEY);
    // A NEW REJECT AFTER THAT: counted once, by growth, not again by its last-hour figure.
    at(T0 + 55 * 60_000);
    alerts.observeSnapshot(snapshot({ workers: [worker("w1", 2, 1), worker("w2", 6, 0)] }), { acting: true });
    expect(alerts.status().fenceRejectsLastHour).toBe(1);
  });

  it("forgets a seeded reject an hour after it read it, when its worker is gone and cannot report its hour", () => {
    const { alerts, at } = evaluator();
    alerts.observeSnapshot(snapshot({ workers: [worker("w1", 3, 2)] }), { acting: true });
    expect(alerts.status().fenceRejectsLastHour).toBe(2);
    at(T0 + 61 * 60_000);
    alerts.observeSnapshot(snapshot({ workers: [] }), { acting: true });
    expect(alerts.status().fenceRejectsLastHour).toBe(0);
  });

  it("raises the fleet's conditions only while acting, and hands them back when it stops", () => {
    const { alerts, fired, clearedKeys } = evaluator();
    const bad = snapshot({ expiries: [{ vault: "V", fence: 1 }], oldestDueMs: 3 * WINDOW, due: 2 });
    alerts.observeSnapshot(bad, { acting: false });
    expect(fired.map((alert) => alert.key)).toEqual([]);
    alerts.observeSnapshot(bad, { acting: true });
    expect(fired.map((alert) => alert.key).sort()).toEqual([LEASE_EXPIRED_ALERT_KEY, QUEUE_LAG_ALERT_KEY]);
    alerts.observeSnapshot(bad, { acting: false });
    expect(clearedKeys).toEqual(expect.arrayContaining([LEASE_EXPIRED_ALERT_KEY, QUEUE_LAG_ALERT_KEY, FENCE_REJECT_ALERT_KEY]));
    expect(alerts.status().firing).toEqual([]);
  });

  it("pages scheduler-stale from a standby too: the hung lock holder will not page about itself", () => {
    const { alerts, keys } = evaluator();
    alerts.observeSnapshot(snapshot({ tickAgeMs: SCHEDULER_STALE_AFTER_MS + 60_000 }), { acting: false });
    expect(keys()).toEqual([`${SCHEDULER_STALE_ALERT_KEY}:critical`]);
  });

  it("counts pg-saturated ticks in a row from this process's pools, and resets on a tick with none waiting", () => {
    const { alerts, keys, clearedKeys } = evaluator();
    const busy = [{ total: 2, idle: 0, waiting: 1 }, { total: 1, idle: 1, waiting: 0 }];
    alerts.observePools(busy);
    alerts.observePools(busy);
    expect(keys()).toEqual([]);
    alerts.observePools(busy);
    expect(keys()).toEqual([`${PG_SATURATED_ALERT_KEY}:critical`]);
    expect(alerts.status().pg).toEqual({ waiting: 1, total: 3, idle: 1, saturatedStreak: 3 });
    alerts.observePools([{ total: 2, idle: 2, waiting: 0 }]);
    expect(clearedKeys).toContain(PG_SATURATED_ALERT_KEY);
    expect(alerts.status().pg?.saturatedStreak).toBe(0);
  });
});

describe("vault-unserved on the evaluator", () => {
  it("raises one key per draining vault while acting, escalates it at the hour, and clears it when the vault leaves draining", () => {
    const { alerts, keys, clearedKeys } = evaluator();
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_A, VAULT_UNSERVED_WARN_MS - 1)]) }), { acting: true });
    expect(keys()).toEqual([]);
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_A, VAULT_UNSERVED_WARN_MS + 60_000), draining(VAULT_B, 60_000)]) }), { acting: true });
    expect(keys()).toEqual([`vault-unserved:${VAULT_A}:warn`]);
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_A, VAULT_UNSERVED_CRITICAL_MS + 60_000), draining(VAULT_B, 120_000)]) }), { acting: true });
    expect(keys().at(-1)).toBe(`vault-unserved:${VAULT_A}:critical`);
    expect(alerts.status().firing).toEqual([`vault-unserved:${VAULT_A}`]);
    expect(alerts.status().unservedOldestMs).toBe(VAULT_UNSERVED_CRITICAL_MS + 60_000);
    // A WAVE OF ARM MOVES A TO THE QUEUE: its row is no longer listed, and its page ends. B never paged, so nothing clears for it.
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_B, 180_000)]) }), { acting: true });
    expect(clearedKeys.filter((key) => key.startsWith("vault-unserved"))).toEqual([`vault-unserved:${VAULT_A}`]);
    expect(alerts.status().firing).toEqual([]);
  });

  it("never pages a parked queue row from here: vault-parked already did, when the reap parked it", () => {
    const { alerts, keys } = evaluator();
    alerts.observeSnapshot(snapshot({ unserved: unserved([parkedRow(VAULT_A), parkedRow(VAULT_B)]) }), { acting: true });
    expect(keys()).toEqual([]);
    expect(alerts.status().unservedOldestMs).toBeNull();
  });

  it("keeps a page standing for a vault the list left out when the list was cut at the cap, and clears it once a whole list omits it", () => {
    const { alerts, keys, clearedKeys } = evaluator();
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_A, VAULT_UNSERVED_WARN_MS + 1)]) }), { acting: true });
    expect(keys()).toEqual([`vault-unserved:${VAULT_A}:warn`]);
    // TWO DRAINING, ONE LISTED: A may be the one left out, so its page stands.
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_B, VAULT_UNSERVED_WARN_MS + 2)], { draining: 2 }) }), { acting: true });
    expect(clearedKeys).not.toContain(`vault-unserved:${VAULT_A}`);
    expect(alerts.status().firing).toEqual([`vault-unserved:${VAULT_A}`, `vault-unserved:${VAULT_B}`].sort());
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_B, VAULT_UNSERVED_WARN_MS + 3)]) }), { acting: true });
    expect(clearedKeys).toContain(`vault-unserved:${VAULT_A}`);
    expect(alerts.status().firing).toEqual([`vault-unserved:${VAULT_B}`]);
  });

  it("clears a page when the same vault comes back drained afresh (a rollback re-stamps system_at), and a time it could not measure is no evidence", () => {
    const { alerts, clearedKeys } = evaluator();
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_A, VAULT_UNSERVED_CRITICAL_MS + 1)]) }), { acting: true });
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_A, 30_000, "system_at")]) }), { acting: true });
    expect(clearedKeys.filter((key) => key.startsWith("vault-unserved"))).toEqual([`vault-unserved:${VAULT_A}`]);
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_B, VAULT_UNSERVED_WARN_MS + 1)]) }), { acting: true });
    alerts.observeSnapshot(snapshot({ unserved: unserved([draining(VAULT_B, null)]) }), { acting: true });
    expect(alerts.status().firing).toEqual([]);
  });

  it("is the lock holder's only: a standby raises none, and a holder that stops acting hands every vault's page back", () => {
    const { alerts, keys, clearedKeys } = evaluator();
    const long = snapshot({ unserved: unserved([draining(VAULT_A, VAULT_UNSERVED_CRITICAL_MS + 1), draining(VAULT_B, VAULT_UNSERVED_WARN_MS + 1)]) });
    alerts.observeSnapshot(long, { acting: false });
    expect(keys()).toEqual([]);
    // THE STANDBY STILL SHOWS WHAT IT READ: the view is the same on every replica.
    expect(alerts.status().unservedOldestMs).toBe(VAULT_UNSERVED_CRITICAL_MS + 1);
    alerts.observeSnapshot(long, { acting: true });
    expect(keys().sort()).toEqual([`vault-unserved:${VAULT_A}:critical`, `vault-unserved:${VAULT_B}:warn`].sort());
    alerts.observeSnapshot(long, { acting: false });
    expect(clearedKeys).toEqual(expect.arrayContaining([`vault-unserved:${VAULT_A}`, `vault-unserved:${VAULT_B}`]));
    expect(alerts.status().firing).toEqual([]);
  });
});

describe("scheduler-stale from a worker (SchedulerStaleWatch)", () => {
  function watch() {
    let now = T0;
    const fired: Alert[] = [];
    const clearedKeys: string[] = [];
    const watcher = new SchedulerStaleWatch({ alerter: { fire: (alert) => fired.push(alert), clear: (key) => clearedKeys.push(key) }, now: () => now });
    return {
      watcher,
      fired,
      clearedKeys,
      at: (ms: number) => {
        now = ms;
      },
    };
  }

  it("pages past the replicas' own ten minutes, says nothing while the tick is fresh, and clears once it is fresh again", () => {
    const { watcher, fired, clearedKeys } = watch();
    expect(watcher.observe(5_000)).toEqual({ fire: null, clear: true });
    expect(watcher.observe(SCHEDULER_STALE_AFTER_MS)).toEqual({ fire: null, clear: true });
    // A CLEAR WITH NOTHING RAISED IS NOT SENT: the beat is every 10 s.
    expect([fired, clearedKeys]).toEqual([[], []]);
    watcher.observe(SCHEDULER_STALE_AFTER_MS + 1);
    expect(fired.map((alert) => [alert.key, alert.severity, alert.title])).toEqual([
      [SCHEDULER_STALE_ALERT_KEY, "critical", "The dispatcher's scheduler has stopped ticking"],
    ]);
    expect(watcher.status()).toMatchObject({ tickAgeMs: SCHEDULER_STALE_AFTER_MS + 1, firing: true });
    watcher.observe(20 * 60_000);
    expect(fired).toHaveLength(2);
    watcher.observe(30_000);
    expect(clearedKeys).toEqual([SCHEDULER_STALE_ALERT_KEY]);
    expect(watcher.status().firing).toBe(false);
  });

  it("judges a tick never written by its own uptime, and takes a value that is not a number for none", () => {
    const { watcher, fired, at } = watch();
    expect(watcher.observe(null)).toEqual({ fire: null, clear: false });
    at(T0 + SCHEDULER_STALE_AFTER_MS + 1);
    watcher.observe(Number.NaN);
    expect(fired.map((alert) => alert.title)).toEqual(["No dispatcher scheduler has ever ticked"]);
    expect(watcher.status().tickAgeMs).toBeNull();
  });

  it("reaches the chat titled as the worker's, critical so it leaves the box, and repeats only on the alerter's window", () => {
    const lines: string[] = [];
    const posted: string[] = [];
    let now = T0;
    const alerter = createAlerter({
      webhookUrl: new Secret("https://alerts.example.test/hook", "alertWebhook"),
      minSeverity: "critical",
      titlePrefix: "[worker] ",
      log: (_severity, line) => lines.push(line),
      post: async (_url, body) => {
        posted.push(body);
      },
      now: () => now,
    });
    const watcher = new SchedulerStaleWatch({ alerter, now: () => now });
    watcher.observe(SCHEDULER_STALE_AFTER_MS + 60_000);
    now += 10_000;
    watcher.observe(SCHEDULER_STALE_AFTER_MS + 70_000);
    expect(lines).toEqual([expect.stringMatching(/^\[CRITICAL\] \[worker\] The dispatcher's scheduler has stopped ticking — fleet\.tick_at is 11 min old/)]);
    expect(posted).toHaveLength(1);
  });
});

/** fleet.legacy as FLEET_SNAPSHOT_SQL counts it; by default the cut-over's end state: nothing legacy, keepers stopped and marked gone. */
const legacyBlock = (over: Partial<FleetLegacy> = {}): FleetLegacy => ({ vaults: 0, newVaultSystem: "queue", receipts: 0, fresh: 0, lastReadAgeMs: 2 * 24 * 60 * 60_000, ...over });
const MIN = 60_000;

describe("legacy-orphaned: vaults the legacy keepers alone serve, while they are retired or silent", () => {
  it("holds only when a legacy vault exists or new vaults go legacy, AND the keepers are retired or none has read in 15 minutes", () => {
    // THE END STATE: nothing legacy, new vaults to the queue, keepers retired and silent. Nobody is left behind.
    expect(legacyOrphaned(legacyBlock(), true)).toBe(false);
    // THE MIDDLE OF THE MOVE: two legacy vaults, keepers up and not declared retired.
    expect(legacyOrphaned(legacyBlock({ vaults: 2, receipts: 2, fresh: 2, lastReadAgeMs: 30_000 }), false)).toBe(false);
    // RETIRED BY THE OPERATOR, whatever they are doing.
    expect(legacyOrphaned(legacyBlock({ vaults: 2, receipts: 2, fresh: 2, lastReadAgeMs: 30_000 }), true)).toBe(true);
    // SILENT, whatever the operator said.
    expect(legacyOrphaned(legacyBlock({ vaults: 1, receipts: 2, fresh: 0, lastReadAgeMs: 16 * MIN }), false)).toBe(true);
    // NO LEGACY VAULT, BUT EVERY NEW ONE GOES LEGACY.
    expect(legacyOrphaned(legacyBlock({ newVaultSystem: "legacy" }), true)).toBe(true);
    expect(legacyOrphaned(legacyBlock({ newVaultSystem: "legacy", receipts: 2, fresh: 2, lastReadAgeMs: 30_000 }), false)).toBe(false);
    // NO fleet ROW: nothing is enrolled at all, so nothing goes legacy.
    expect(legacyOrphaned(legacyBlock({ newVaultSystem: null }), true)).toBe(false);
    // THE SAME 15 MINUTES AS THE HANDOVER'S RECEIPTS, which fleet.legacy.fresh is counted by.
    expect(LEGACY_SILENT_AFTER_MS).toBe(LEGACY_READ_FRESH_MS);
  });

  it("warns as soon as it holds and pages at 30 minutes, timed from the last legacy read when the keepers are silent", () => {
    const silent = (lastReadAgeMs: number) => legacyOrphanedAlert({ legacy: legacyBlock({ vaults: 2, receipts: 2, fresh: 0, lastReadAgeMs }), retired: false, observedForMs: 0 });
    const warn = silent(16 * MIN).fire!;
    expect([warn.key, warn.severity]).toEqual([LEGACY_ORPHANED_ALERT_KEY, "warn"]);
    expect(silent(LEGACY_ORPHANED_CRITICAL_MS - 1).fire?.severity).toBe("warn");
    expect(silent(LEGACY_ORPHANED_CRITICAL_MS).fire?.severity).toBe("critical");
    // STOPPED TWO DAYS AGO, SEEN JUST NOW: it has been two days, and it pages at once.
    expect(silent(2 * 24 * 60 * MIN).fire?.severity).toBe("critical");
    expect(LEGACY_ORPHANED_CRITICAL_MS).toBe(30 * MIN);
  });

  it("is timed by what this process has watched while retired keepers still read, or when none ever read", () => {
    const reading = legacyBlock({ vaults: 1, receipts: 1, fresh: 1, lastReadAgeMs: 20_000 });
    expect(legacyOrphanedForMs({ legacy: reading, retired: true, observedForMs: 5 * MIN })).toBe(5 * MIN);
    expect(legacyOrphanedAlert({ legacy: reading, retired: true, observedForMs: 0 }).fire?.severity).toBe("warn");
    expect(legacyOrphanedAlert({ legacy: reading, retired: true, observedForMs: LEGACY_ORPHANED_CRITICAL_MS }).fire?.severity).toBe("critical");
    const never = legacyBlock({ vaults: 1, receipts: 0, fresh: 0, lastReadAgeMs: null });
    expect(legacyOrphanedForMs({ legacy: never, retired: false, observedForMs: 0 })).toBe(0);
    expect(legacyOrphanedAlert({ legacy: never, retired: false, observedForMs: LEGACY_ORPHANED_CRITICAL_MS }).fire?.severity).toBe("critical");
    expect(legacyOrphanedForMs({ legacy: legacyBlock(), retired: true, observedForMs: 99 * MIN })).toBeNull();
    expect(legacyOrphanedAlert({ legacy: legacyBlock(), retired: true, observedForMs: 99 * MIN })).toEqual({ fire: null, clear: true });
  });

  it("names how many, why, and what the owner runs — and never says nobody serves them while a retired keeper still reads", () => {
    const silent = legacyOrphanedAlert({ legacy: legacyBlock({ vaults: 2, receipts: 2, fresh: 0, lastReadAgeMs: 40 * MIN }), retired: true, observedForMs: 0 }).fire!;
    expect(silent.detail).toContain("2 vaults with a live link are still 'legacy'");
    expect(silent.detail).toContain("SIP_SOLANA_LEGACY_ROLES=none");
    expect(silent.detail).toContain("none has read in 15 min (the last read was 40 min ago)");
    expect(silent.detail).toContain("nobody settles or buys for those users");
    expect(silent.detail).toContain("flota-prod traspasar-todos");
    expect(silent.detail).toContain("flota-prod nuevos-a-la-cola");
    expect(silent.detail).toContain("restart sip-solana-keeper and sip-solana-volume-keeper and unset SIP_SOLANA_LEGACY_ROLES");
    expect(silent.context).toMatchObject({ legacyVaults: 2, retired: true, fresh: 0, forMs: 40 * MIN });

    const reading = legacyOrphanedAlert({ legacy: legacyBlock({ vaults: 1, receipts: 1, fresh: 1, lastReadAgeMs: 20_000 }), retired: true, observedForMs: 0 }).fire!;
    expect(reading.detail).toContain("1 vault with a live link is still 'legacy'");
    expect(reading.detail).toContain("1 legacy keeper still reads, and once it stops nobody settles or buys for that user");

    const down = legacyOrphanedAlert({ legacy: legacyBlock({ newVaultSystem: "legacy", receipts: 2, fresh: 0, lastReadAgeMs: 17 * MIN }), retired: false, observedForMs: 0 }).fire!;
    expect(down.detail).toContain("fleet.new_vault_system is 'legacy'");
    expect(down.detail).toContain("no legacy keeper has read in 15 min");
    expect(down.detail).toContain("nobody settles or buys for new users");
    expect(down.detail).not.toContain("unset SIP_SOLANA_LEGACY_ROLES");
    expect(down.detail).not.toContain("still 'legacy' (vault_work.system)");
  });
});

describe("legacy-orphaned on the evaluator", () => {
  it("is not evaluated without the scheduler's configuration (a worker, a shadow scheduler)", () => {
    const { alerts, keys, clearedKeys } = evaluator(null);
    alerts.observeSnapshot(snapshot({ legacy: legacyBlock({ vaults: 2 }) }), { acting: true });
    alerts.observeSnapshot(snapshot({ legacy: legacyBlock({ vaults: 2 }) }), { acting: false });
    expect(keys()).toEqual([]);
    expect(clearedKeys).not.toContain(LEGACY_ORPHANED_ALERT_KEY);
    expect(alerts.status().legacyOrphanedForMs).toBeNull();
  });

  it("warns while acting, pages once it has lasted 30 minutes, and clears once the last vault is moved and new vaults go to the queue", () => {
    const { alerts, keys, clearedKeys, at } = evaluator({ retired: true });
    const twoLeft = snapshot({ legacy: legacyBlock({ vaults: 2, receipts: 2, fresh: 2, lastReadAgeMs: 30_000 }) });
    alerts.observeSnapshot(twoLeft, { acting: true });
    expect(keys()).toEqual([`${LEGACY_ORPHANED_ALERT_KEY}:warn`]);
    expect(alerts.status().legacyOrphanedForMs).toBe(0);
    at(T0 + LEGACY_ORPHANED_CRITICAL_MS);
    alerts.observeSnapshot(twoLeft, { acting: true });
    expect(keys().at(-1)).toBe(`${LEGACY_ORPHANED_ALERT_KEY}:critical`);
    expect(alerts.status().firing).toEqual([LEGACY_ORPHANED_ALERT_KEY]);
    // traspasar-todos AND nuevos-a-la-cola: nothing legacy is left, and nothing new goes there.
    alerts.observeSnapshot(snapshot({ legacy: legacyBlock() }), { acting: true });
    expect(clearedKeys).toContain(LEGACY_ORPHANED_ALERT_KEY);
    expect(alerts.status().firing).toEqual([]);
    expect(alerts.status().legacyOrphanedForMs).toBeNull();
    // A NEXT TIME STARTS ITS OWN CLOCK: a warn, not the old page.
    at(T0 + 2 * LEGACY_ORPHANED_CRITICAL_MS);
    alerts.observeSnapshot(twoLeft, { acting: true });
    expect(keys().at(-1)).toBe(`${LEGACY_ORPHANED_ALERT_KEY}:warn`);
  });

  it("clears when the keepers are not retired and read again", () => {
    const { alerts, keys, clearedKeys } = evaluator({ retired: false });
    alerts.observeSnapshot(snapshot({ legacy: legacyBlock({ vaults: 2, receipts: 2, fresh: 0, lastReadAgeMs: 20 * MIN }) }), { acting: true });
    expect(keys()).toEqual([`${LEGACY_ORPHANED_ALERT_KEY}:warn`]);
    alerts.observeSnapshot(snapshot({ legacy: legacyBlock({ vaults: 2, receipts: 2, fresh: 1, lastReadAgeMs: 10_000 }) }), { acting: true });
    expect(clearedKeys).toContain(LEGACY_ORPHANED_ALERT_KEY);
    expect(alerts.status().firing).toEqual([]);
  });

  it("is the lock holder's only, on a clock every replica keeps: a standby that takes the lock pages on the half hour it watched", () => {
    const { alerts, keys, clearedKeys, at } = evaluator({ retired: true });
    const left = snapshot({ legacy: legacyBlock({ vaults: 1, receipts: 1, fresh: 1, lastReadAgeMs: 20_000 }) });
    alerts.observeSnapshot(left, { acting: false });
    at(T0 + LEGACY_ORPHANED_CRITICAL_MS + MIN);
    alerts.observeSnapshot(left, { acting: false });
    expect(keys()).toEqual([]);
    expect(alerts.status().legacyOrphanedForMs).toBe(LEGACY_ORPHANED_CRITICAL_MS + MIN);
    alerts.observeSnapshot(left, { acting: true });
    expect(keys()).toEqual([`${LEGACY_ORPHANED_ALERT_KEY}:critical`]);
    // IT STOPS ACTING: the page goes back to whoever holds the lock now.
    alerts.observeSnapshot(left, { acting: false });
    expect(clearedKeys).toContain(LEGACY_ORPHANED_ALERT_KEY);
    expect(alerts.status().firing).toEqual([]);
  });

  it("takes a snapshot without the block for no evidence: the page and its clock stand", () => {
    const { alerts, keys, clearedKeys, at } = evaluator({ retired: false });
    alerts.observeSnapshot(snapshot({ legacy: legacyBlock({ vaults: 1, receipts: 1, fresh: 0, lastReadAgeMs: 16 * MIN }) }), { acting: true });
    at(T0 + 5 * MIN);
    alerts.observeSnapshot(snapshot({ legacy: null }), { acting: true });
    expect(keys()).toEqual([`${LEGACY_ORPHANED_ALERT_KEY}:warn`]);
    expect(clearedKeys).not.toContain(LEGACY_ORPHANED_ALERT_KEY);
    expect(alerts.status().firing).toEqual([LEGACY_ORPHANED_ALERT_KEY]);
  });
});
