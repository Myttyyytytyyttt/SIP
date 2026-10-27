// THE SCHEDULER ARMS WHAT IT ENROLLED (src/auto-arm.ts), without a database or
// a chain: the selection's guard and where it is written, the height reader,
// the step over a scripted store and `arm`, its alert's thresholds, and the
// tick that runs it (src/scheduler.ts) over test/scheduler-fakes.ts.
// test/auto-arm-pg.test.ts runs the statements and the real `arm` on Postgres 16.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  AUTO_ARM_ALERT_KEY,
  AUTO_ARM_BATCH,
  AUTO_ARM_CRITICAL_MS,
  AUTO_ARM_PENDING_SQL,
  AUTO_ARM_RESULTS_KEPT,
  AUTO_ARM_WARN_MS,
  AutoArm,
  autoArmAlert,
  type AutoArmOptions,
  type AutoArmStore,
} from "../src/auto-arm.js";
import { AUTO_ARMABLE_SQL, DRAIN_SQL, HANDOVER_WAIT_BLOCKS, ROLLBACK_SQL, VAULT_FOR_UPDATE_SQL, autoArmable, readChainHeights, type ChainHeights, type Step } from "../src/handover.js";
import type { KeeperRole } from "../src/role-registry.js";
import { ENSURE_VAULTS_SQL } from "../src/scheduler-pg.js";
import { Scheduler, type SchedulerOptions } from "../src/scheduler.js";
import { FakeAlerter, FakeChain, FakeLock, LockServer, MemoryStore, fakeLink } from "./scheduler-fakes.js";

const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const MIN = 60_000;
const V1 = Keypair.generate().publicKey.toBase58();
const V2 = Keypair.generate().publicKey.toBase58();

describe("the guard: only a row the scheduler enrolled and nobody touched since", () => {
  it("is draining, unstamped, never claimed and unheld — each condition alone refuses", () => {
    const enrolled = { system: "draining", systemAt: null, fence: 0n, holder: null };
    expect(autoArmable(enrolled)).toBe(true);
    expect(autoArmable({ ...enrolled, fence: "0" })).toBe(true);
    expect(autoArmable({ ...enrolled, system: "legacy" })).toBe(false);
    expect(autoArmable({ ...enrolled, system: "queue" })).toBe(false);
    expect(autoArmable({ ...enrolled, systemAt: new Date() })).toBe(false);
    expect(autoArmable({ ...enrolled, fence: 1n })).toBe(false);
    expect(autoArmable({ ...enrolled, holder: "w-1" })).toBe(false);
  });

  it("is one SQL condition, read by the selection and again by arm under the row's lock", () => {
    for (const clause of ["system = 'draining'", "system_at IS NULL", "fence = 0", "holder IS NULL"]) expect(AUTO_ARMABLE_SQL).toContain(clause);
    expect(AUTO_ARM_PENDING_SQL).toContain(`WHERE ${AUTO_ARMABLE_SQL}`);
    expect(AUTO_ARM_PENDING_SQL).toMatch(/ORDER BY due_at, vault_addr\s+LIMIT \$1/);
    expect(VAULT_FOR_UPDATE_SQL).toContain(`(${AUTO_ARMABLE_SQL}) AS auto_armable`);
    expect(VAULT_FOR_UPDATE_SQL).toMatch(/FOR UPDATE$/);
    expect(AUTO_ARM_BATCH).toBe(20);
  });

  it("holds because the enrolment never stamps system_at and every handover step does", () => {
    // THE ENROLMENT: no system_at column in its insert.
    expect(ENSURE_VAULTS_SQL).not.toMatch(/system_at/);
    // EVERY STEP: drain (both its paths), rollback, and every UPDATE of `system` in src/handover.ts.
    expect(DRAIN_SQL).toMatch(/\(vault_addr, system, system_at\) VALUES \(\$1, 'draining', clock_timestamp\(\)\)/);
    expect(DRAIN_SQL).toMatch(/DO UPDATE SET system = 'draining', system_at = clock_timestamp\(\)/);
    expect(ROLLBACK_SQL).toMatch(/SET system = 'draining', system_at = clock_timestamp\(\)/);
    const handover = source("../src/handover.ts");
    const writes = [...handover.matchAll(/SET system = '(\w+)'([^\n]*)/g)];
    expect(writes.map((m) => m[1]).sort()).toEqual(["draining", "draining", "legacy", "queue"]);
    for (const write of writes) expect(write[2], write[0]).toMatch(/system_at = clock_timestamp\(\)/);
    // AND NOTHING ELSE UNDER src/ OR bin/ WRITES `system` (the scheduler, the workers and the legacy keepers only read it).
    for (const file of ["../src/scheduler-pg.ts", "../src/dispatch-store.ts", "../src/fleet-pg.ts", "../src/dispatch-select.ts", "../src/worker-takeover.ts"]) {
      expect(source(file), file).not.toMatch(/SET\s+system\s*=/);
    }
  });
});

describe("readChainHeights: the one reader of the two heights", () => {
  it("reads processed first, then finalized, and refuses a processed height below the finalized one", async () => {
    const asked: string[] = [];
    const chain = (processed: number, finalized: number) => ({
      getBlockHeight: async (commitment: "processed" | "finalized") => {
        asked.push(commitment);
        return commitment === "processed" ? processed : finalized;
      },
    });
    expect(await readChainHeights(chain(1_032, 1_000))).toEqual({ processed: 1_032n, finalized: 1_000n });
    expect(asked).toEqual(["processed", "finalized"]);
    expect(await readChainHeights(chain(1_000, 1_000))).toEqual({ processed: 1_000n, finalized: 1_000n });
    await expect(readChainHeights(chain(990, 1_000))).rejects.toThrow(/processed height \(990\) below its finalized one \(1000\)/);
  });
});

/** A scripted `arm`: each vault waits `waits` calls, then moves. Records every call. */
class ScriptedHandover {
  readonly calls: { vault: string; heights: ChainHeights; options: unknown }[] = [];
  readonly waits = new Map<string, number>();
  readonly fails = new Set<string>();
  readonly blockers = new Map<string, string>();
  async arm(vault: string, heights: ChainHeights, options: unknown = {}): Promise<Step> {
    this.calls.push({ vault, heights, options });
    if (this.fails.has(vault)) throw new Error("Connection terminated unexpectedly");
    const blocker = this.blockers.get(vault);
    if (blocker !== undefined) return { vault, system: "draining", moved: false, blockers: [blocker] };
    const left = this.waits.get(vault) ?? 0;
    if (left > 0) {
      this.waits.set(vault, left - 1);
      const above = heights.processed + HANDOVER_WAIT_BLOCKS;
      return { vault, system: "draining", moved: false, blockers: [`waiting for the finalized height to pass ${above} (now ${heights.finalized})`], waitUntilFinalizedAbove: above };
    }
    return { vault, system: "queue", moved: true, blockers: [] };
  }
}

class ScriptedStore implements AutoArmStore {
  rows: { vault: string; waitingMs: number }[] = [];
  fail: Error | null = null;
  calls = 0;
  async pending(limit: number) {
    this.calls += 1;
    if (this.fail !== null) throw this.fail;
    return { total: this.rows.length, rows: this.rows.slice(0, limit) };
  }
}

function rig(over: Partial<AutoArmOptions> = {}) {
  const store = new ScriptedStore();
  const handover = new ScriptedHandover();
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  let heightsRead = 0;
  let heightsFail: Error | null = null;
  let height = 5_000n;
  let clock = 1_000_000;
  const autoArm = new AutoArm({
    enabled: true,
    legacyRoles: ["profit", "volume"] as KeeperRole[],
    store,
    handover,
    heights: async () => {
      heightsRead += 1;
      if (heightsFail !== null) throw heightsFail;
      return { processed: height, finalized: height - 32n };
    },
    log: (level, message, fields) => logs.push({ level, message, ...(fields === undefined ? {} : { fields }) }),
    now: () => clock,
    ...over,
  });
  return {
    autoArm,
    store,
    handover,
    logs,
    heightsRead: () => heightsRead,
    failHeights: (error: Error | null) => void (heightsFail = error),
    advance: (ms: number, blocks = 0n) => {
      clock += ms;
      height += blocks;
    },
  };
}

describe("the step", () => {
  it("does nothing while it is off: no statement, no chain, nothing on /status but the setting", async () => {
    const r = rig({ enabled: false, legacyRoles: [] });
    r.store.rows = [{ vault: V1, waitingMs: 0 }];
    expect(await r.autoArm.step()).toEqual({ ran: false, moved: [], pending: null, error: null, alert: { fire: null, clear: false } });
    expect(r.store.calls).toBe(0);
    expect(r.heightsRead()).toBe(0);
    expect(r.autoArm.status()).toEqual({
      enabled: false,
      legacyRoles: [],
      pending: null,
      oldestWaitingMs: null,
      lastArmedAt: null,
      armed: 0,
      lastResults: [],
      lastError: null,
      failingSince: null,
    });
  });

  it("asks the chain nothing when no enrolled row waits, and clears its alert", async () => {
    const r = rig();
    const tick = await r.autoArm.step();
    expect(tick).toMatchObject({ ran: true, moved: [], pending: 0, error: null, alert: { fire: null, clear: true } });
    expect(r.heightsRead()).toBe(0);
    expect(r.handover.calls).toEqual([]);
  });

  it("arms through the handover's own arm, with the configured roles and enrolledOnly: first a recorded height, then the move", async () => {
    const r = rig();
    r.store.rows = [{ vault: V1, waitingMs: 30_000 }];
    r.handover.waits.set(V1, 1);
    const first = await r.autoArm.step();
    expect(first).toMatchObject({ ran: true, moved: [], pending: 1, error: null });
    expect(r.handover.calls[0]).toEqual({ vault: V1, heights: { processed: 5_000n, finalized: 4_968n }, options: { requiredRoles: ["profit", "volume"], enrolledOnly: true } });
    expect(r.autoArm.status()).toMatchObject({
      pending: 1,
      oldestWaitingMs: 30_000,
      lastArmedAt: null,
      lastResults: [{ vault: V1, moved: false, blocker: expect.stringMatching(/waiting for the finalized height to pass 5150/) }],
    });
    r.advance(MIN, 160n);
    const second = await r.autoArm.step();
    expect(second).toMatchObject({ moved: [V1], pending: 0, error: null, alert: { clear: true } });
    expect(r.autoArm.status()).toMatchObject({ pending: 0, armed: 1, lastArmedAt: new Date(1_000_000 + MIN).toISOString(), lastResults: [{ vault: V1, moved: true }] });
    expect(r.autoArm.status().lastResults[0]).not.toHaveProperty("blocker");
    expect(r.logs.filter((l) => l.message.includes("moved a vault"))).toEqual([expect.objectContaining({ level: "info", fields: { vault: V1, waitedMs: 30_000 } })]);
  });

  it("logs a waiting vault once per kind of blocker, not every tick its block count moves", async () => {
    const r = rig();
    r.store.rows = [{ vault: V1, waitingMs: 0 }];
    r.handover.waits.set(V1, 4);
    for (let i = 0; i < 4; i++) {
      await r.autoArm.step();
      r.advance(MIN, 40n);
    }
    expect(r.logs.filter((l) => l.message.includes("is waiting"))).toHaveLength(1);
    r.handover.blockers.set(V1, "legacy process p-1 (profit, …) has not yet read this vault as not its own");
    await r.autoArm.step();
    await r.autoArm.step();
    expect(r.logs.filter((l) => l.message.includes("is waiting"))).toHaveLength(2);
  });

  it("never throws: a read that fails is lastError and a warning, the streak is timed, and a clean step ends it", async () => {
    const r = rig();
    r.store.fail = new Error("Connection terminated unexpectedly");
    const failed = await r.autoArm.step();
    expect(failed).toMatchObject({ ran: true, moved: [], error: expect.stringContaining("the enrolled draining vaults could not be read"), alert: { clear: true } });
    expect(r.autoArm.status()).toMatchObject({ lastError: expect.stringContaining("Connection terminated"), failingSince: new Date(1_000_000).toISOString() });
    expect(r.logs.at(-1)).toMatchObject({ level: "warn", message: expect.stringContaining("the auto-arm step failed") });
    r.advance(AUTO_ARM_WARN_MS);
    expect((await r.autoArm.step()).alert.fire).toMatchObject({ key: AUTO_ARM_ALERT_KEY, severity: "warn" });
    r.advance(AUTO_ARM_CRITICAL_MS - AUTO_ARM_WARN_MS);
    expect((await r.autoArm.step()).alert.fire).toMatchObject({ key: AUTO_ARM_ALERT_KEY, severity: "critical", detail: expect.stringContaining("failing for 60 min") });
    r.store.fail = null;
    expect((await r.autoArm.step()).alert).toEqual({ fire: null, clear: true });
    expect(r.autoArm.status()).toMatchObject({ lastError: null, failingSince: null });
  });

  it("a chain that cannot be read fails the step, not the vaults: nothing is armed and arm is not asked", async () => {
    const r = rig();
    r.store.rows = [{ vault: V1, waitingMs: 20 * MIN }];
    r.failHeights(new Error("429 Too Many Requests"));
    const tick = await r.autoArm.step();
    expect(tick).toMatchObject({ moved: [], pending: 1, error: expect.stringContaining("the chain's block heights could not be read") });
    // THE VAULT HAS WAITED 20 MIN: that alone warns, whatever the streak.
    expect(tick.alert.fire).toMatchObject({ severity: "warn", detail: expect.stringContaining("1 vault the scheduler enrolled is still draining") });
    expect(r.handover.calls).toEqual([]);
  });

  it("one vault's arm that throws does not stop the others; it is the step's error and that vault's result", async () => {
    const r = rig();
    r.store.rows = [
      { vault: V1, waitingMs: 0 },
      { vault: V2, waitingMs: 0 },
    ];
    r.handover.fails.add(V1);
    const tick = await r.autoArm.step();
    expect(tick).toMatchObject({ moved: [V2], pending: 1, error: expect.stringContaining(`vault ${V1}: arm failed`) });
    expect(r.autoArm.status().lastResults).toEqual([
      { vault: V2, moved: true, at: expect.any(String) },
      { vault: V1, moved: false, blocker: expect.stringContaining("arm failed"), at: expect.any(String) },
    ]);
  });

  it("keeps the latest result of at most five vaults, newest first", async () => {
    const r = rig();
    const vaults = Array.from({ length: 7 }, () => Keypair.generate().publicKey.toBase58());
    r.store.rows = vaults.map((vault) => ({ vault, waitingMs: 0 }));
    for (const vault of vaults) r.handover.waits.set(vault, 5);
    await r.autoArm.step();
    await r.autoArm.step();
    const results = r.autoArm.status().lastResults;
    expect(results).toHaveLength(AUTO_ARM_RESULTS_KEPT);
    expect(results.map((result) => result.vault)).toEqual(vaults.slice(-5).reverse());
  });

  it("asks for at most AUTO_ARM_BATCH rows a tick, and counts the rest as pending", async () => {
    const r = rig({ batch: 2 });
    r.store.rows = [V1, V2, Keypair.generate().publicKey.toBase58()].map((vault) => ({ vault, waitingMs: 0 }));
    expect(await r.autoArm.step()).toMatchObject({ moved: [V1, V2], pending: 1 });
    expect(r.handover.calls).toHaveLength(2);
  });
});

describe("autoArmAlert: a new vault nobody serves", () => {
  it("clears under 15 minutes, warns from 15, pages from 60 — the longer of the failure streak and the oldest wait", () => {
    expect(autoArmAlert({ failingForMs: null, oldestWaitingMs: null, pending: 0, why: null })).toEqual({ fire: null, clear: true });
    expect(autoArmAlert({ failingForMs: AUTO_ARM_WARN_MS - 1, oldestWaitingMs: 5 * MIN, pending: 1, why: null })).toEqual({ fire: null, clear: true });
    expect(autoArmAlert({ failingForMs: null, oldestWaitingMs: AUTO_ARM_WARN_MS, pending: 2, why: "no ACTING volume keeper has read this vault" }).fire).toMatchObject({
      key: AUTO_ARM_ALERT_KEY,
      severity: "warn",
      detail: expect.stringMatching(/^2 vaults the scheduler enrolled are still draining.*the oldest has waited 15 min\. Last: no ACTING volume keeper/),
    });
    expect(autoArmAlert({ failingForMs: AUTO_ARM_CRITICAL_MS, oldestWaitingMs: 2 * MIN, pending: 1, why: "boom" }).fire).toMatchObject({ severity: "critical" });
    expect(autoArmAlert({ failingForMs: null, oldestWaitingMs: AUTO_ARM_CRITICAL_MS - 1, pending: 1, why: null }).fire).toMatchObject({ severity: "warn" });
    expect(autoArmAlert({ failingForMs: null, oldestWaitingMs: 3 * 60 * MIN, pending: 1, why: null }).fire?.detail).toContain("dispatch-handover gone");
  });
});

describe("the tick runs it (src/scheduler.ts)", () => {
  const TICK = 60_000;

  /** The fake database's rows, and an `arm` that moves a draining row on its second call, as the real one does after 150 blocks. */
  function world(vaults = 2) {
    const chain = new FakeChain();
    for (let i = 0; i < vaults; i++) chain.links.push(fakeLink(Keypair.generate().publicKey));
    const store = new MemoryStore();
    store.armOnEnrol = false;
    const server = new LockServer();
    const calls: string[] = [];
    const twice = new Map<string, number>();
    const autoArmStore: AutoArmStore = {
      pending: async (limit) => {
        const rows = [...store.rows.values()].filter((row) => row.system === "draining" && row.fence === 0n && !row.held).map((row) => ({ vault: row.vault, waitingMs: store.now - row.dueAt }));
        return { total: rows.length, rows: rows.slice(0, limit) };
      },
    };
    const handover = {
      arm: async (vault: string): Promise<Step> => {
        calls.push(vault);
        const seen = (twice.get(vault) ?? 0) + 1;
        twice.set(vault, seen);
        if (seen < 2) return { vault, system: "draining", moved: false, blockers: ["waiting for the finalized height to pass 1150 (now 1000)"] };
        store.row(vault).system = "queue";
        return { vault, system: "queue", moved: true, blockers: [] };
      },
    };
    return { chain, store, server, calls, autoArmStore, handover };
  }

  function scheduler(w: ReturnType<typeof world>, name: string, over: Partial<SchedulerOptions> = {}, autoArm: Partial<AutoArmOptions> = {}) {
    const alerter = new FakeAlerter();
    const arm = new AutoArm({
      enabled: true,
      legacyRoles: ["profit", "volume"],
      store: w.autoArmStore,
      handover: w.handover,
      heights: async () => ({ processed: 1_000n, finalized: 968n }),
      log: () => undefined,
      now: () => w.store.now,
      ...autoArm,
    });
    const s = new Scheduler({
      id: name,
      mode: "on",
      tickMs: TICK,
      lock: new FakeLock(w.server, name),
      store: w.store,
      fullPass: { takeFullPass: async () => null },
      intents: { resolveIntent: async () => true },
      chain: w.chain,
      alerter,
      log: () => undefined,
      lamportsFilter: false,
      doorbellSecret: false,
      autoArm: arm,
      ...over,
    });
    return { scheduler: s, alerter, arm };
  }

  it("by the holder only: the vaults it enrolled reach the queue at the second tick, and that tick makes them due", async () => {
    const w = world();
    const a = scheduler(w, "A");
    const b = scheduler(w, "B");
    const first = await a.scheduler.tick();
    expect(first).toMatchObject({ kind: "acted", autoArmed: [], marked: [] });
    expect((await b.scheduler.tick()).kind).toBe("standby");
    expect(w.calls).toHaveLength(2);
    w.store.now += TICK;
    const second = await a.scheduler.tick();
    expect(second).toMatchObject({ kind: "acted" });
    if (second.kind !== "acted") throw new Error("unreachable");
    expect([...second.autoArmed].sort()).toEqual([...w.store.rows.keys()].sort());
    expect([...second.marked].sort()).toEqual([...w.store.rows.keys()].sort());
    expect(a.scheduler.status().autoArm).toMatchObject({ enabled: true, legacyRoles: ["profit", "volume"], pending: 0, armed: 2 });
    expect(b.scheduler.status().autoArm).toMatchObject({ pending: null, armed: 0 });
    await b.scheduler.tick();
    expect(w.calls).toHaveLength(4);
  });

  it("not in shadow, not while disabled; /status still says which", async () => {
    for (const [over, enabled] of [
      [{ mode: "shadow" as const }, true],
      [{}, false],
    ] as const) {
      const w = world(1);
      const s = scheduler(w, "A", over, { enabled });
      expect(await s.scheduler.tick()).toMatchObject({ kind: "acted", autoArmed: [] });
      expect(w.calls).toEqual([]);
      expect(s.scheduler.status().autoArm).toMatchObject({ enabled, pending: null });
    }
    // WITHOUT THE STEP AT ALL (a process that built none): no field.
    const w = world(1);
    const bare = scheduler(w, "A", { autoArm: null });
    await bare.scheduler.tick();
    expect(bare.scheduler.status()).not.toHaveProperty("autoArm");
  });

  it("a step that fails, or a wrapper that throws, never fails the tick; a vault unserved for 15 minutes warns through the alerter, and clears", async () => {
    const w = world(1);
    const s = scheduler(w, "A", {}, { store: { pending: async () => Promise.reject(new Error("statement timeout")) } });
    expect((await s.scheduler.tick()).kind).toBe("acted");
    expect(s.scheduler.status()).toMatchObject({ consecutiveFailures: 0, autoArm: { lastError: expect.stringContaining("statement timeout") } });
    w.store.now += AUTO_ARM_WARN_MS;
    expect((await s.scheduler.tick()).kind).toBe("acted");
    expect(s.alerter.firing.get(AUTO_ARM_ALERT_KEY)).toMatchObject({ severity: "warn" });
    const thrower = scheduler(world(1), "B", {
      autoArm: { enabled: true, step: async () => Promise.reject(new Error("bug")), status: () => s.arm.status() },
    });
    expect((await thrower.scheduler.tick()).kind).toBe("acted");
    // THE STEP RUNS CLEAN AGAIN, NOTHING WAITS: the alert clears.
    const clean = scheduler(w, "C", {}, { store: { pending: async () => ({ total: 0, rows: [] }) } });
    clean.alerter.fire({ key: AUTO_ARM_ALERT_KEY, severity: "warn", title: "t", detail: "d" });
    s.scheduler.stop();
    w.server.holder = null;
    await clean.scheduler.tick();
    expect(clean.alerter.firing.has(AUTO_ARM_ALERT_KEY)).toBe(false);
  });
});
