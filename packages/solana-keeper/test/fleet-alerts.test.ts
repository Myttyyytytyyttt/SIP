// The dispatcher's alerts (src/fleet-alerts.ts): every threshold the ADR sets
// (§6.3) and the three the cut-over added, pinned on the pure rules, and who
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
  VAULT_PARKED_ALERT_PREFIX,
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
  silentLegacyRoles,
  vaultParkedKey,
  vaultUnservedAlert,
  vaultUnservedKey,
} from "../src/fleet-alerts.js";
import { AUTO_ARM_ALERT_KEY, AutoArm } from "../src/auto-arm.js";
import type { FleetLegacy, FleetQueue, FleetSnapshot, FleetUnserved, FleetWorkerRow, UnservedVault } from "../src/fleet-status.js";
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
    parked: FleetQueue["parked"];
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
      parked: over.parked ?? { count: 0, vaults: [] },
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

function evaluator(legacy: { readonly retired: boolean; readonly roles?: readonly string[] } | null = null, autoArm = false) {
  let now = T0;
  const fired: Alert[] = [];
  const clearedKeys: string[] = [];
  const alerts = new FleetAlerts({
    alerter: { fire: (alert) => fired.push(alert), clear: (key) => clearedKeys.push(key) },
    windowMs: WINDOW,
    legacy,
    autoArm,
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
    // RELEASE IS A WAY BACK ONLY WHILE THE LEGACY KEEPERS READ: the page says so, and names the owner's tool that checks.
    expect(warn.detail).toContain("only while they read");
    expect(warn.detail).toContain("flota-prod volver");
    expect(warn.context).toEqual({ vault: VAULT_A, forMs: VAULT_UNSERVED_WARN_MS + 1, from: "due_at", autoArmPages: false });
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

  it("never pages a parked queue row as vault-unserved: it pages as vault-parked, from the parked list", () => {
    const { alerts, keys } = evaluator();
    alerts.observeSnapshot(snapshot({ unserved: unserved([parkedRow(VAULT_A), parkedRow(VAULT_B)]) }), { acting: true });
    expect(keys()).toEqual([]);
    expect(alerts.status().unservedOldestMs).toBeNull();
  });

  it("keeps a vault the scheduler enrolled at a warn while the auto-arm runs: auto-arm-stalled is that stall's page", () => {
    // THE RULE: enrolled (due_at) and the scheduler arming by itself — a warn however long; drained by a handover — the page.
    const enrolled = vaultUnservedAlert({ vault: VAULT_A, forMs: 2 * VAULT_UNSERVED_CRITICAL_MS, from: "due_at", autoArmPages: true }).fire!;
    expect(enrolled.severity).toBe("warn");
    expect(enrolled.detail).toContain("auto-arm-stalled");
    expect(vaultUnservedAlert({ vault: VAULT_A, forMs: 2 * VAULT_UNSERVED_CRITICAL_MS, from: "system_at", autoArmPages: true }).fire?.severity).toBe("critical");
    expect(vaultUnservedAlert({ vault: VAULT_A, forMs: 2 * VAULT_UNSERVED_CRITICAL_MS, from: "due_at" }).fire?.severity).toBe("critical");
    // ON THE EVALUATOR: the same split, by the row's clock.
    const { alerts, keys } = evaluator(null, true);
    alerts.observeSnapshot(
      snapshot({ unserved: unserved([draining(VAULT_A, VAULT_UNSERVED_CRITICAL_MS + 1, "due_at"), draining(VAULT_B, VAULT_UNSERVED_CRITICAL_MS + 1, "system_at")]) }),
      { acting: true },
    );
    expect(keys().sort()).toEqual([`vault-unserved:${VAULT_A}:warn`, `vault-unserved:${VAULT_B}:critical`].sort());
  });

  it("pages ONE stall once per repeat window however many new vaults wait on it: auto-arm-stalled alone, through one alerter", async () => {
    const stuck = async (n: number) => {
      let t = 0;
      const posted: { at: number; key: string }[] = [];
      const alerter = createAlerter({
        webhookUrl: new Secret("https://alerts.example.test/hook", "alertWebhook"),
        minSeverity: "critical",
        log: () => undefined,
        post: async (_url, body) => {
          posted.push({ at: t / MIN, key: (JSON.parse(body) as { key: string }).key });
        },
        now: () => t,
      });
      const vaults = Array.from({ length: n }, (_, i) => `NewVau1t${i}`.padEnd(44, "1"));
      const fleet = new FleetAlerts({ alerter, windowMs: WINDOW, legacy: { retired: false }, autoArm: true, now: () => t });
      const autoArm = new AutoArm({
        enabled: true,
        legacyRoles: ["profit", "volume"],
        store: { pending: async () => ({ total: n, rows: vaults.map((vault) => ({ vault, waitingMs: t })) }) },
        handover: {
          arm: async (vault: string) => ({ vault, system: "draining" as const, moved: false, blockers: ["legacy process old-p (profit) has not yet read this vault as not its own"] }),
        },
        heights: async () => ({ processed: 1_000n, finalized: 990n }),
        log: () => undefined,
        now: () => t,
      });
      for (let minute = 0; minute <= 125; minute++) {
        t = minute * MIN;
        // THE SCHEDULER'S TICK, applied as Scheduler.#autoArm applies it, then the reader's snapshot.
        const tick = await autoArm.step();
        if (tick.alert.fire !== null) alerter.fire(tick.alert.fire);
        else if (tick.alert.clear) alerter.clear(AUTO_ARM_ALERT_KEY);
        fleet.observeSnapshot(snapshot({ unserved: unserved(vaults.map((vault) => draining(vault, t, "due_at"))) }), { acting: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      return posted;
    };
    for (const n of [1, 3]) {
      const posted = await stuck(n);
      expect(posted.map((page) => page.key)).toEqual([AUTO_ARM_ALERT_KEY, AUTO_ARM_ALERT_KEY, AUTO_ARM_ALERT_KEY]);
      expect(posted.map((page) => page.at)).toEqual([60, 90, 120]);
    }
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
const legacyBlock = (over: Partial<FleetLegacy> = {}): FleetLegacy => ({
  vaults: 0,
  newVaultSystem: "queue",
  receipts: 0,
  fresh: 0,
  lastReadAgeMs: 2 * 24 * 60 * 60_000,
  roles: null,
  ...over,
});
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
    expect(down.detail).toContain("the profit keeper (sip-solana-keeper) has not read while acting in 15 min");
    expect(down.detail).toContain("the volume keeper (sip-solana-volume-keeper) has not read while acting in 15 min");
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

describe("legacy-orphaned by role: each watched role's keeper must be acting", () => {
  /** Two legacy vaults, the profit keeper's receipt 20 min old and the volume keeper's fresh: today's `fresh` is 1. */
  const profitDown = (profitAgeMs = 20 * MIN) =>
    legacyBlock({
      vaults: 2,
      receipts: 2,
      fresh: 1,
      lastReadAgeMs: 30_000,
      roles: { profit: { acting: 0, lastReadAgeMs: profitAgeMs }, volume: { acting: 1, lastReadAgeMs: 30_000 } },
    });

  it("holds when the profit keeper is silent though the volume keeper still reads — the one that buys is down", () => {
    expect(silentLegacyRoles(profitDown())).toEqual(["profit"]);
    expect(legacyOrphaned(profitDown(), false)).toBe(true);
    // BEFORE THE ROLES, one fresh receipt of either kept it quiet: the same counts without the block.
    expect(legacyOrphaned({ ...profitDown(), roles: null }, false)).toBe(false);
    // A SCHEDULER THAT WAITS ONLY ON THE PROFIT KEEPER watches only it.
    const volumeDown = legacyBlock({ vaults: 2, fresh: 1, roles: { profit: { acting: 1, lastReadAgeMs: 30_000 }, volume: { acting: 0, lastReadAgeMs: 40 * MIN } } });
    expect(legacyOrphaned(volumeDown, false, ["profit"])).toBe(false);
    expect(legacyOrphaned(volumeDown, false)).toBe(true);
    // A KEEPER READING WITHOUT ACTING (not holding its claim, its carry store not ready) is not serving.
    const dry = legacyBlock({ vaults: 1, fresh: 2, roles: { profit: { acting: 0, lastReadAgeMs: 20_000 }, volume: { acting: 1, lastReadAgeMs: 20_000 } } });
    expect(legacyOrphaned(dry, false)).toBe(true);
    // A ROLE THAT NEVER WROTE A RECEIPT is silent.
    expect(silentLegacyRoles(legacyBlock({ roles: { volume: { acting: 1, lastReadAgeMs: 1_000 } } }))).toEqual(["profit"]);
  });

  it("is timed from the silent role's own last read, not the other role's, and names the silent one and what nobody does", () => {
    expect(legacyOrphanedForMs({ legacy: profitDown(20 * MIN), retired: false, observedForMs: 0 })).toBe(20 * MIN);
    expect(legacyOrphanedAlert({ legacy: profitDown(20 * MIN), retired: false, observedForMs: 0 }).fire?.severity).toBe("warn");
    const page = legacyOrphanedAlert({ legacy: profitDown(LEGACY_ORPHANED_CRITICAL_MS + MIN), retired: false, observedForMs: 0 }).fire!;
    expect(page.severity).toBe("critical");
    expect(page.detail).toContain("the profit keeper (sip-solana-keeper) has not read while acting in 15 min (its last read was 31 min ago)");
    expect(page.detail).toContain("the volume keeper (sip-solana-volume-keeper) still acts, but for those users nobody buys, and nobody settles a PROFIT vault");
    expect(page.detail).not.toContain("the volume keeper (sip-solana-volume-keeper) has not read");
    expect(page.context).toMatchObject({ silentRoles: ["profit"], fresh: 1 });

    const volumeDown = legacyOrphanedAlert({
      legacy: legacyBlock({ vaults: 1, fresh: 1, roles: { profit: { acting: 1, lastReadAgeMs: 30_000 }, volume: { acting: 0, lastReadAgeMs: 16 * MIN } } }),
      retired: false,
      observedForMs: 0,
    }).fire!;
    expect(volumeDown.detail).toContain("the profit keeper (sip-solana-keeper) still acts, but for that user nobody settles a VOLUME vault");
  });

  it("pages on the evaluator with the scheduler's roles, and clears once the profit keeper acts again", () => {
    const { alerts, keys, clearedKeys } = evaluator({ retired: false, roles: ["profit", "volume"] });
    alerts.observeSnapshot(snapshot({ legacy: profitDown(LEGACY_ORPHANED_CRITICAL_MS) }), { acting: true });
    expect(keys()).toEqual([`${LEGACY_ORPHANED_ALERT_KEY}:critical`]);
    const back = legacyBlock({ vaults: 2, fresh: 2, roles: { profit: { acting: 1, lastReadAgeMs: 5_000 }, volume: { acting: 1, lastReadAgeMs: 30_000 } } });
    alerts.observeSnapshot(snapshot({ legacy: back }), { acting: true });
    expect(clearedKeys).toContain(LEGACY_ORPHANED_ALERT_KEY);
    // SIP_SOLANA_LEGACY_ROLES=profit: a silent volume keeper is not this scheduler's to page.
    const onlyProfit = evaluator({ retired: false, roles: ["profit"] });
    onlyProfit.alerts.observeSnapshot(
      snapshot({ legacy: legacyBlock({ vaults: 2, fresh: 1, roles: { profit: { acting: 1, lastReadAgeMs: 5_000 }, volume: { acting: 0, lastReadAgeMs: 99 * MIN } } }) }),
      { acting: true },
    );
    expect(onlyProfit.keys()).toEqual([]);
  });

  it("says which clock is which when a vault is handed to keepers that stopped days ago: it pages at once, and claims no duration it did not see", () => {
    // RETIRED THREE DAYS AGO, receipts marked gone; then a raw `release` makes one vault 'legacy' again.
    const handed = legacyOrphanedAlert({ legacy: legacyBlock({ vaults: 1, fresh: 0, lastReadAgeMs: 3 * 24 * 60 * MIN }), retired: true, observedForMs: 0 }).fire!;
    expect(handed.severity).toBe("critical");
    expect(handed.title).toBe("Users are left to legacy keepers that are retired or not acting");
    expect(handed.detail).toContain("none has read in 15 min (the last read was 4320 min ago)");
    expect(handed.detail).toContain("This scheduler has seen it for 0 min.");
    expect(handed.detail).not.toContain("has held for");
  });
});

describe("vault-parked: a parked queue row pages for as long as it stays parked", () => {
  const PARKED_REASON = "its lease lapsed 5 claims in a row without a completion: a job that never ends";
  const parked = (rows: { vault: string; system: string | null }[], count = rows.length): FleetQueue["parked"] => ({
    count,
    vaults: rows.map((row) => ({ ...row, reason: PARKED_REASON, attempts: 5 })),
  });

  it("raises the reap's own key for every parked QUEUE row each snapshot lists, and clears it once a whole list no longer has it", () => {
    expect(vaultParkedKey(VAULT_A)).toBe(`${VAULT_PARKED_ALERT_PREFIX}:${VAULT_A}`);
    const { alerts, keys, clearedKeys, fired } = evaluator();
    // A PARKED ROW THAT WAS RELEASED is the legacy keepers' to serve; one rolled back pages as vault-unserved.
    alerts.observeSnapshot(snapshot({ parked: parked([{ vault: VAULT_A, system: "queue" }, { vault: VAULT_B, system: "legacy" }]) }), { acting: true });
    expect(keys()).toEqual([`vault-parked:${VAULT_A}:critical`]);
    expect(fired[0]!.detail).toContain("flota-prod desaparcar");
    // EVERY SNAPSHOT RAISES IT AGAIN: the alerter's dedup and 30-minute repeat decide what leaves.
    alerts.observeSnapshot(snapshot({ parked: parked([{ vault: VAULT_A, system: "queue" }]) }), { acting: true });
    expect(keys()).toEqual([`vault-parked:${VAULT_A}:critical`, `vault-parked:${VAULT_A}:critical`]);
    // TWO PARKED, NONE LISTED (past the cap): A may be among them, so its page stands.
    alerts.observeSnapshot(snapshot({ parked: parked([], 2) }), { acting: true });
    expect(clearedKeys).not.toContain(vaultParkedKey(VAULT_A));
    // desaparcar: the whole list no longer has it.
    alerts.observeSnapshot(snapshot({ parked: parked([]) }), { acting: true });
    expect(clearedKeys).toContain(vaultParkedKey(VAULT_A));
    expect(alerts.status().firing).toEqual([]);
  });

  it("is the lock holder's only, and a holder that stops acting hands it back", () => {
    const { alerts, keys, clearedKeys } = evaluator();
    const one = snapshot({ parked: parked([{ vault: VAULT_A, system: "queue" }]) });
    alerts.observeSnapshot(one, { acting: false });
    expect(keys()).toEqual([]);
    alerts.observeSnapshot(one, { acting: true });
    alerts.observeSnapshot(one, { acting: false });
    expect(clearedKeys).toContain(vaultParkedKey(VAULT_A));
    expect(alerts.status().firing).toEqual([]);
  });

  it("pages every 30 minutes for a vault parked a whole day, where the reap alone paged once", async () => {
    let t = 0;
    const posted: { at: number; key: string }[] = [];
    const alerter = createAlerter({
      webhookUrl: new Secret("https://alerts.example.test/hook", "alertWebhook"),
      minSeverity: "critical",
      log: () => undefined,
      post: async (_url, body) => {
        posted.push({ at: t / MIN, key: (JSON.parse(body) as { key: string }).key });
      },
      now: () => t,
    });
    // MINUTE 0: the reap parks it and pages, as src/scheduler.ts does.
    alerter.fire({ key: vaultParkedKey(VAULT_A), severity: "critical", title: "The scheduler parked a vault: its jobs never complete", detail: "parked" });
    const fleet = new FleetAlerts({ alerter, windowMs: WINDOW, now: () => t });
    for (let minute = 1; minute <= 24 * 60; minute++) {
      t = minute * MIN;
      fleet.observeSnapshot(snapshot({ parked: parked([{ vault: VAULT_A, system: "queue" }]) }), { acting: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted.every((page) => page.key === vaultParkedKey(VAULT_A))).toBe(true);
    expect(posted.map((page) => page.at).slice(0, 4)).toEqual([0, 30, 60, 90]);
    expect(posted).toHaveLength(49);
  });
});
