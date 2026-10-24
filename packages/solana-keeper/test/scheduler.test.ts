// The scheduler's tick (src/scheduler.ts), over in-memory fakes of its lock,
// its store and its chain (test/scheduler-fakes.ts). What the Postgres
// statements do is test/scheduler-pg.test.ts's; here, what a tick asks for, in
// what order, how often, and what it decides — across two schedulers sharing
// one database and one chain where it matters (ADR §4.9 rows 14–16).

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { CreditGovernor } from "../src/credit-governor.js";
import { DISCOVERY_STALE_ALERT_KEY } from "../src/discovery-lkg.js";
import { DOORBELL_DEAF_ALERT_KEY } from "../src/doorbell.js";
import { decideFleetHealth } from "../src/fleet-status.js";
import { C7_REAL_PROBE_MS } from "../src/lamports-filter.js";
import { DISCOVERY_WARN_AFTER_FAILURES, Scheduler, TICK_FAILED_CRITICAL_STREAK, doorbellTrust, type SchedulerOptions, type SchedulerWebhook } from "../src/scheduler.js";
import { WATCHDOG_EXIT_CODE, startWatchdog, type WatchdogTimers } from "../src/watchdog.js";
import { FakeAlerter, FakeChain, FakeLock, LockServer, MemoryStore, fakeLink } from "./scheduler-fakes.js";

const TICK = 60_000;

interface Rig {
  readonly store: MemoryStore;
  readonly chain: FakeChain;
  readonly server: LockServer;
}

function rig(vaults = 3): Rig {
  const chain = new FakeChain();
  for (let i = 0; i < vaults; i++) chain.links.push(fakeLink(Keypair.generate().publicKey));
  return { store: new MemoryStore(), chain, server: new LockServer() };
}

function scheduler(r: Rig, name: string, over: Partial<SchedulerOptions> = {}): { readonly scheduler: Scheduler; readonly lock: FakeLock; readonly alerter: FakeAlerter; readonly resolved: unknown[][] } {
  const lock = new FakeLock(r.server, name);
  const alerter = new FakeAlerter();
  const resolved: unknown[][] = [];
  const s = new Scheduler({
    id: name,
    mode: "on",
    tickMs: TICK,
    lock,
    store: r.store,
    fullPass: { takeFullPass: async () => null },
    intents: {
      resolveIntent: async (...args) => {
        resolved.push(args);
        return true;
      },
    },
    chain: r.chain,
    alerter,
    log: () => undefined,
    lamportsFilter: false,
    doorbellSecret: false,
    ...over,
  });
  return { scheduler: s, lock, alerter, resolved };
}

const vaultsOf = (chain: FakeChain): string[] => [...new Set(chain.links.map((l) => l.vault.toBase58()))].sort();

describe("two schedulers, one lock (ADR §4.9 rows 14 and 16)", () => {
  it("only the holder lists — exactly one discovery a tick for the pair — and the standby's tick is its lock attempt", async () => {
    const r = rig();
    const a = scheduler(r, "A");
    const b = scheduler(r, "B");
    for (let round = 0; round < 10; round++) {
      const before = r.chain.calls.filter((c) => c === "list").length;
      // IN EITHER ORDER: who ticks first in a round is not who holds the lock.
      const first = round % 2 === 0 ? a : b;
      const second = first === a ? b : a;
      const reports = [await first.scheduler.tick(), await second.scheduler.tick()];
      expect(r.chain.calls.filter((c) => c === "list").length - before, `round ${round}`).toBe(1);
      expect(reports.map((report) => report.kind).sort()).toEqual(["acted", "standby"]);
      r.store.now += TICK;
    }
    expect(a.scheduler.acting).toBe(true);
    expect(b.scheduler.acting).toBe(false);
    expect(b.scheduler.status().standbyTicks).toBe(10);
    expect(r.store.ticks.every((t) => t.id === "A")).toBe(true);
  });

  it("standby takeover: the holder dies, the standby takes the lock at its next tick and that tick is a full pass", async () => {
    const r = rig();
    // A DOORBELL THAT COULD BE TRUSTED, so the full pass is the takeover's and says so
    // (with none, every tick is a full pass for that reason first, as in the legacy doorbell).
    r.store.webhookOwner = "scheduler";
    r.store.evidence = { lastBellAt: r.store.now + 10 * TICK, lastEchoAt: null, deafSince: null };
    const a = scheduler(r, "A", { doorbellSecret: true });
    const b = scheduler(r, "B", { doorbellSecret: true });
    expect((await a.scheduler.tick()).kind).toBe("acted");
    expect((await b.scheduler.tick()).kind).toBe("standby");
    r.store.now += TICK;
    // A's process dies: its session, and the lock with it.
    a.lock.release();
    const took = await b.scheduler.tick();
    expect(took).toMatchObject({ kind: "acted", tookOver: true });
    if (took.kind !== "acted") throw new Error("unreachable");
    expect(took.fullReason).toMatch(/took the lock/);
    expect([...took.marked].sort()).toEqual(vaultsOf(r.chain));
    expect(b.scheduler.status().takeovers).toBe(1);
  });

  it("a holder whose session died stands by, says so, and a later takeover is a full pass again", async () => {
    const r = rig();
    const a = scheduler(r, "A");
    const b = scheduler(r, "B");
    await a.scheduler.tick();
    a.lock.sessionDied = true;
    r.server.holder = null;
    expect(await a.scheduler.tick()).toEqual({ kind: "standby", lock: "lost" });
    expect(a.alerter.firing.has("scheduler-lock-lost")).toBe(true);
    const took = await b.scheduler.tick();
    expect(took).toMatchObject({ kind: "acted", tookOver: true });
    // A asks again and stands by while B holds it.
    expect(await a.scheduler.tick()).toEqual({ kind: "standby", lock: "standby" });
  });

  it("a process that loses the lock and takes it back starts over: its next acting tick is a full pass, whatever it knew", async () => {
    const r = rig(2);
    r.store.webhookOwner = "scheduler";
    r.store.evidence = { lastBellAt: r.store.now + 100 * TICK, lastEchoAt: null, deafSince: null };
    const a = scheduler(r, "A", { doorbellSecret: true });
    const b = scheduler(r, "B", { doorbellSecret: true });
    await a.scheduler.tick();
    for (const vault of vaultsOf(r.chain)) r.store.complete(vault, { claimedAt: r.store.now + 30_000, doneAt: r.store.now + 40_000, rests: true });
    r.store.now += TICK;
    // TRUSTED AND RESTING: not a full pass.
    expect(await a.scheduler.tick()).toMatchObject({ kind: "acted", fullReason: null });
    a.lock.release();
    r.store.now += TICK;
    expect(await b.scheduler.tick()).toMatchObject({ kind: "acted", tookOver: true });
    b.lock.release();
    r.store.now += TICK;
    const back = await a.scheduler.tick();
    expect(back).toMatchObject({ kind: "acted", tookOver: true, fullReason: "this scheduler just took the lock" });
  });

  it("scheduler-split-brain: two holders at once double the writes and nothing else — every write is a due time", async () => {
    const r = rig();
    const a = scheduler(r, "A");
    const b = scheduler(r, "B");
    await a.scheduler.tick();
    // A SPLIT BRAIN: B is handed the lock too (a session A still thinks it has).
    r.server.holder = null;
    await b.scheduler.tick();
    r.server.holder = "A";
    const before = new Map([...r.store.rows].map(([v, row]) => [v, { ...row }]));
    await a.scheduler.tick();
    await b.scheduler.tick();
    for (const [vault, row] of r.store.rows) {
      expect(row.fence, vault).toBe(before.get(vault)!.fence);
      expect(row.dueAt, vault).toBeLessThanOrEqual(before.get(vault)!.dueAt);
    }
  });
});

describe("discovery into keeper_link, and the last-known-good list", () => {
  it("a successful listing is upserted, the vaults it names get rows, the rest are marked gone and retired", async () => {
    const r = rig(2);
    const s = scheduler(r, "A");
    await s.scheduler.tick();
    expect([...r.store.rows.keys()].sort()).toEqual(vaultsOf(r.chain));
    const dropped = r.chain.links.pop()!;
    r.store.now += TICK;
    const report = await s.scheduler.tick();
    expect(report).toMatchObject({ kind: "acted", discovery: { source: "fresh", links: 1 } });
    expect(r.store.links.get(dropped.linkAddress.toBase58())?.gone).toBe(true);
    expect(r.store.row(dropped.vault.toBase58()).dueAt).toBe(Number.POSITIVE_INFINITY);
    expect(r.store.ticks.at(-1)).toEqual({ id: "A", discoveryOk: true });
  });

  it("a failed listing schedules keeper_link re-read fresh, warns from the third failure, and pages once the list is ten minutes old", async () => {
    const r = rig(2);
    const s = scheduler(r, "A");
    await s.scheduler.tick();
    r.chain.listFails = new Error("overloaded");
    for (let failure = 1; failure <= DISCOVERY_WARN_AFTER_FAILURES; failure++) {
      r.store.now += TICK;
      const report = await s.scheduler.tick();
      expect(report).toMatchObject({ kind: "acted", discovery: { source: "lkg", links: 2, freshLinks: true } });
      expect(s.alerter.firing.has(DISCOVERY_STALE_ALERT_KEY), `failure ${failure}`).toBe(failure >= DISCOVERY_WARN_AFTER_FAILURES);
    }
    expect(s.alerter.firing.get(DISCOVERY_STALE_ALERT_KEY)?.severity).toBe("warn");
    r.store.now += 10 * TICK;
    await s.scheduler.tick();
    expect(s.alerter.firing.get(DISCOVERY_STALE_ALERT_KEY)?.severity).toBe("critical");
    // NOTHING WAS UPSERTED OR MARKED GONE FROM A LIST THAT IS NOT A LISTING.
    expect(r.store.ticks.slice(1).every((t) => !t.discoveryOk)).toBe(true);
    r.chain.listFails = null;
    await s.scheduler.tick();
    expect(s.alerter.firing.has(DISCOVERY_STALE_ALERT_KEY)).toBe(false);
  });

  it("when even the re-read is refused, keeps scheduling keeper_link's addresses; with nothing cached, the tick fails", async () => {
    const r = rig(2);
    const s = scheduler(r, "A");
    await s.scheduler.tick();
    r.chain.listFails = new Error("overloaded");
    r.chain.rereadFails = new Error("overloaded");
    r.store.now += TICK;
    expect(await s.scheduler.tick()).toMatchObject({ kind: "acted", discovery: { source: "lkg", links: 2, freshLinks: false } });
    const empty = rig(0);
    empty.chain.listFails = new Error("overloaded");
    expect(await scheduler(empty, "B").scheduler.tick()).toMatchObject({ kind: "failed", error: expect.stringContaining("overloaded") });
  });

  it("under new_vault_system = 'queue' a new vault is enrolled draining, and a draining row is never made due until it is armed", async () => {
    const r = rig(2);
    r.store.armOnEnrol = false;
    const s = scheduler(r, "A");
    const first = await s.scheduler.tick();
    expect([...r.store.rows.values()].map((row) => row.system)).toEqual(["draining", "draining"]);
    expect(first).toMatchObject({ kind: "acted", marked: [] });
    for (const row of r.store.rows.values()) row.system = "queue";
    r.store.now += TICK;
    const armed = await s.scheduler.tick();
    expect(armed.kind === "acted" && [...armed.marked].sort()).toEqual([...r.store.rows.keys()].sort());
  });

  it("names a vault's new row by the fleet flag: legacy until P3d, and a legacy row is never made due", async () => {
    const r = rig(2);
    r.store.newVaultSystem = "legacy";
    const s = scheduler(r, "A");
    const report = await s.scheduler.tick();
    expect([...r.store.rows.values()].every((row) => row.system === "legacy")).toBe(true);
    expect(report).toMatchObject({ kind: "acted", marked: [] });
  });
});

describe("what a selection writes", () => {
  it("makes due the vaults it selected, and leaves a busy vault to its own retry time, a held or a parked one alone", async () => {
    const r = rig(4);
    const s = scheduler(r, "A");
    await s.scheduler.tick(); // the full pass
    const [busy, held, parked, quiet] = vaultsOf(r.chain);
    r.store.complete(busy!, { claimedAt: r.store.now + 1, doneAt: r.store.now + 2, rests: false, dueAt: r.store.now + 10 * TICK });
    r.store.complete(quiet!, { claimedAt: r.store.now + 1, doneAt: r.store.now + 2, rests: true });
    r.store.row(held!).held = true;
    r.store.row(parked!).parked = true;
    r.store.now += TICK;
    // The doorbell is not trusted (no secret), so this tick is a full pass too.
    const report = await s.scheduler.tick();
    if (report.kind !== "acted") throw new Error(report.kind);
    expect(report.fullReason).not.toBeNull();
    expect([...report.marked].sort()).toEqual([busy, quiet].sort());
    // A FULL PASS TURNS THE BUSY VAULT TOO, as the legacy full pass did; outside one it is left to its retry.
    expect(r.store.row(busy!).dueAt).toBe(r.store.now);
  });

  it("a tick that dies after its selection owes the next one a full pass", async () => {
    const r = rig(2);
    const s = scheduler(r, "A", { doorbellSecret: true });
    r.store.webhookOwner = "scheduler";
    r.store.evidence = { lastBellAt: r.store.now, lastEchoAt: null, deafSince: null };
    await s.scheduler.tick();
    r.store.now += TICK;
    r.store.evidence = { lastBellAt: r.store.now - 1, lastEchoAt: null, deafSince: null };
    for (const vault of vaultsOf(r.chain)) r.store.complete(vault, { claimedAt: r.store.now - 10, doneAt: r.store.now - 5, rests: true });
    const trusted = await s.scheduler.tick();
    expect(trusted).toMatchObject({ kind: "acted", fullReason: null });
    r.store.fail.markDue = new Error("connection reset");
    r.store.now += TICK;
    expect((await s.scheduler.tick()).kind).toBe("failed");
    delete r.store.fail.markDue;
    r.store.now += TICK;
    expect(await s.scheduler.tick()).toMatchObject({ kind: "acted", fullReason: "the previous tick failed before it made its selection due" });
  });
});

describe("C7 inside the scheduler (lamports-filter)", () => {
  /** Two ticks: the boot full pass, then every job rests; returns the rig at the third tick's door. */
  async function settled(vaults = 3): Promise<{ r: Rig; s: Scheduler }> {
    const r = rig(vaults);
    const { scheduler: s } = scheduler(r, "A", { lamportsFilter: true });
    const boot = await s.tick();
    expect(boot).toMatchObject({ kind: "acted", completedIdle: [] });
    for (const vault of vaultsOf(r.chain)) r.store.complete(vault, { claimedAt: r.store.now + 1_000, doneAt: r.store.now + 2_000, rests: true });
    r.store.now += TICK;
    return { r, s };
  }

  it("completes a quiet vault itself — no wallet moved since a resting real probe, its invest half rests — and makes due the one whose wallet moved", async () => {
    const { r, s } = await settled();
    const [moved] = vaultsOf(r.chain);
    const wallet = r.chain.links.find((l) => l.vault.toBase58() === moved)!.wallet.toBase58();
    r.chain.lamports.set(wallet, 999_000_000n);
    const report = await s.tick();
    if (report.kind !== "acted") throw new Error(report.kind);
    // STILL A FULL PASS (no doorbell): C7 is what makes it cheap.
    expect(report.fullReason).not.toBeNull();
    expect(report.marked).toEqual([moved]);
    expect([...report.completedIdle].sort()).toEqual(vaultsOf(r.chain).filter((v) => v !== moved));
    expect(r.store.row(vaultsOf(r.chain).find((v) => v !== moved)!).dueAt).toBe(r.store.now + 30 * 60_000);
  });

  it("makes due a quiet vault whose invest half does not rest, every vault when the batch read fails, and every vault once its real probe is 30 minutes old", async () => {
    const { r, s } = await settled();
    const [investing] = vaultsOf(r.chain);
    r.chain.investRests.set(investing!, false);
    let report = await s.tick();
    if (report.kind !== "acted") throw new Error(report.kind);
    expect(report.marked).toEqual([investing]);

    r.chain.investRests.clear();
    r.chain.fingerprintFails = new Error("throttled");
    r.store.now += TICK;
    report = await s.tick();
    if (report.kind !== "acted") throw new Error(report.kind);
    expect([...report.marked].sort()).toEqual(vaultsOf(r.chain));
    expect(report.completedIdle).toEqual([]);

    r.chain.fingerprintFails = null;
    r.store.now += C7_REAL_PROBE_MS;
    report = await s.tick();
    if (report.kind !== "acted") throw new Error(report.kind);
    expect([...report.marked].sort()).toEqual(vaultsOf(r.chain));
  });

  it("never completes a vault with an open intent, or whose last job did not rest: a full pass makes both due", async () => {
    const { r, s } = await settled(2);
    const [withIntent, other] = vaultsOf(r.chain);
    r.store.row(withIntent!).openIntents = 1;
    r.store.row(other!).rests = false;
    const report = await s.tick();
    if (report.kind !== "acted") throw new Error(report.kind);
    expect(report.completedIdle).toEqual([]);
    expect([...report.marked].sort()).toEqual([withIntent, other].sort());
  });

  it("never completes a vault in the bell lane, and leaves a busy one to its retry outside a full pass", async () => {
    const r = rig(2);
    r.store.webhookOwner = "scheduler";
    const { scheduler: s } = scheduler(r, "A", { lamportsFilter: true, doorbellSecret: true });
    r.store.evidence = { lastBellAt: r.store.now + 1, lastEchoAt: null, deafSince: null };
    await s.tick();
    for (const vault of vaultsOf(r.chain)) r.store.complete(vault, { claimedAt: r.store.now + 1_000, doneAt: r.store.now + 2_000, rests: true });
    r.store.now += TICK;
    const [rung, busy] = vaultsOf(r.chain);
    r.store.row(rung!).bellAt = r.store.now - 5_000;
    r.store.row(busy!).rests = false;
    const report = await s.tick();
    if (report.kind !== "acted") throw new Error(report.kind);
    expect(report.fullReason).toBeNull();
    expect(report.lanes).toMatchObject({ bell: 1, busy: 1 });
    expect(report.marked).toEqual([rung]);
    expect(report.completedIdle).toEqual([]);
    expect(report.leftBusy).toBe(1);
  });
});

describe("the webhook is the legacy keeper's until the fleet says otherwise (plan design detail 2)", () => {
  const webhook = (): SchedulerWebhook & { ticks: number } => {
    const w = { ticks: 0, tick: () => void (w.ticks += 1), watched: () => null, alert: () => ({ fire: null, clear: true }) };
    return w;
  };

  it("is synced only by the holder, only when fleet.webhook_owner is 'scheduler', only in `on`, only from a fresh listing", async () => {
    const r = rig(2);
    const hook = webhook();
    const s = scheduler(r, "A", { webhook: hook, doorbellSecret: true });
    await s.scheduler.tick();
    expect(hook.ticks).toBe(0);
    r.store.webhookOwner = "scheduler";
    await s.scheduler.tick();
    expect(hook.ticks).toBe(1);
    r.chain.listFails = new Error("overloaded");
    await s.scheduler.tick();
    expect(hook.ticks).toBe(1);
    // SHADOW NEVER TOUCHES A WEBHOOK, even one the fleet row says is the scheduler's.
    const shadowRig = rig(2);
    shadowRig.store.webhookOwner = "scheduler";
    const shadowHook = webhook();
    const shadow = scheduler(shadowRig, "S", { webhook: shadowHook, mode: "shadow", doorbellSecret: true });
    await shadow.scheduler.tick();
    await shadow.scheduler.tick();
    expect(shadowHook.ticks).toBe(0);
  });

  it("trusts the doorbell only when it is the scheduler's, heard since the takeover, and not deaf", () => {
    expect(doorbellTrust({ doorbellSecret: false, webhookOwner: "scheduler", takeoverAt: 0, evidence: null })).toMatchObject({ enabled: false });
    expect(doorbellTrust({ doorbellSecret: true, webhookOwner: "legacy", takeoverAt: 0, evidence: null })).toMatchObject({ enabled: false, reason: expect.stringContaining("legacy profit keeper") });
    expect(doorbellTrust({ doorbellSecret: true, webhookOwner: "scheduler", takeoverAt: 100, evidence: { lastBellAt: 99, lastEchoAt: null, deafSince: null } })).toMatchObject({ enabled: true, trusted: false });
    expect(doorbellTrust({ doorbellSecret: true, webhookOwner: "scheduler", takeoverAt: 100, evidence: { lastBellAt: 150, lastEchoAt: null, deafSince: null } })).toEqual({ enabled: true, trusted: true, reason: null });
    expect(doorbellTrust({ doorbellSecret: true, webhookOwner: "scheduler", takeoverAt: 100, evidence: { lastBellAt: 150, lastEchoAt: null, deafSince: 160 } })).toMatchObject({ trusted: false, reason: expect.stringContaining("did not come back") });
    expect(doorbellTrust({ doorbellSecret: true, webhookOwner: "scheduler", takeoverAt: 100, evidence: { lastBellAt: 150, lastEchoAt: 170, deafSince: 160 } })).toMatchObject({ trusted: true });
  });

  it("pages doorbell-deaf only for a doorbell that was trusted and went deaf", async () => {
    const r = rig(1);
    r.store.webhookOwner = "scheduler";
    const s = scheduler(r, "A", { doorbellSecret: true });
    await s.scheduler.tick();
    expect(s.alerter.firing.has(DOORBELL_DEAF_ALERT_KEY)).toBe(false);
    r.store.evidence = { lastBellAt: r.store.now + 1, lastEchoAt: null, deafSince: null };
    r.store.now += TICK;
    await s.scheduler.tick();
    r.store.evidence = { lastBellAt: r.store.now - TICK + 1, lastEchoAt: null, deafSince: r.store.now };
    r.store.now += TICK;
    await s.scheduler.tick();
    expect(s.alerter.firing.has(DOORBELL_DEAF_ALERT_KEY)).toBe(true);
  });
});

describe("the reap, the quotas, the governor", () => {
  it("resolves an unreclaimed intent only from what the chain says, at its last valid height, and leaves a settle with no signature", async () => {
    const r = rig(1);
    const s = scheduler(r, "A");
    r.chain.finalized = 500n;
    r.chain.statuses.set("landed-sig", { err: null });
    r.chain.statuses.set("failed-sig", { err: { InstructionError: [0, "Custom"] } });
    r.store.stale = [
      { id: 1n, vault: "V", kind: "wrap", signature: "landed-sig", lastValidBlockHeight: 900n },
      { id: 2n, vault: "V", kind: "invest", signature: "failed-sig", lastValidBlockHeight: 400n },
      { id: 3n, vault: "V", kind: "convert", signature: "gone-sig", lastValidBlockHeight: 450n },
      { id: 4n, vault: "V", kind: "convert", signature: "young-sig", lastValidBlockHeight: 600n },
      { id: 5n, vault: "V", kind: "settle", signature: null, lastValidBlockHeight: 300n },
    ];
    const report = await s.scheduler.tick();
    expect(report).toMatchObject({ kind: "acted", resolvedIntents: 3 });
    expect(s.resolved).toEqual([
      [1n, "landed", 900n],
      [2n, "failed", 400n],
      [3n, "expired", 450n],
    ]);
  });

  it("hands out the quotas and asks the governor every tick, as the holder only", async () => {
    const r = rig(1);
    let handOuts = 0;
    const a = scheduler(r, "A", { quotas: async () => ((handOuts += 1), { quotas: {} as never, workers: ["w1", "w2"] }) });
    const b = scheduler(r, "B", { quotas: async () => ((handOuts += 100), { quotas: {} as never, workers: [] }) });
    const report = await a.scheduler.tick();
    await b.scheduler.tick();
    expect(report).toMatchObject({ kind: "acted", quotaWorkers: 2 });
    expect(handOuts).toBe(1);
  });
});

describe("the credit governor's lever reaches the vaults the workers rest (ADR §3.9)", () => {
  it("at a stretched 60-minute pass every resting vault is turned once an hour by the rotation, not every 30 minutes by its own due time", async () => {
    const SLOW_TICK = 15 * 60_000;
    // 200 links: the safety slice's floor of 50 a tick is then exactly the pass's share, 200 × 15 / 60.
    const r = rig(200);
    r.store.webhookOwner = "scheduler";
    const governor = {
      safetyPassMs: 60 * 60_000,
      verdict: null,
      evaluate: async () => ({ alert: { fire: null, clear: false } }),
    } as unknown as CreditGovernor;
    const s = scheduler(r, "A", { doorbellSecret: true, governor, tickMs: SLOW_TICK });
    const turns = new Map<string, number>();
    /** The workers: every free due vault is claimed, and its job rests (completionFor's due time). */
    const work = (): void => {
      for (const [vault, row] of r.store.rows) {
        if (row.system !== "queue" || row.held || row.dueAt > r.store.now) continue;
        r.store.complete(vault, { claimedAt: r.store.now, doneAt: r.store.now, rests: true });
        turns.set(vault, (turns.get(vault) ?? 0) + 1);
      }
    };
    const tick = async (): Promise<void> => {
      // A TRUSTED DOORBELL that rang nobody: only the safety slice selects.
      r.store.evidence = { lastBellAt: r.store.now - 1, lastEchoAt: null, deafSince: null };
      expect(await s.scheduler.tick()).toMatchObject({ kind: "acted" });
      work();
      r.store.now += SLOW_TICK;
    };
    await tick(); // the takeover's full pass
    await tick();
    turns.clear();
    for (let i = 0; i < 8; i++) await tick(); // two hours
    expect(turns.size).toBe(200);
    expect(new Set(turns.values())).toEqual(new Set([2]));
  });
});

describe("failures, skips and the watchdog", () => {
  it("a failing tick warns, then pages at the third in a row, and clears once a tick goes through", async () => {
    const r = rig(1);
    const s = scheduler(r, "A");
    r.store.fail.readFleet = new Error("too many clients");
    for (let i = 1; i <= TICK_FAILED_CRITICAL_STREAK; i++) {
      expect((await s.scheduler.tick()).kind).toBe("failed");
      expect(s.alerter.firing.get("scheduler-tick-failed")?.severity).toBe(i >= TICK_FAILED_CRITICAL_STREAK ? "critical" : "warn");
    }
    delete r.store.fail.readFleet;
    expect((await s.scheduler.tick()).kind).toBe("acted");
    expect(s.alerter.firing.has("scheduler-tick-failed")).toBe(false);
  });

  it("an overlapping tick is a skip, counted, and does not move the progress clock", async () => {
    const r = rig(1);
    r.chain.hang = true;
    let stamps = 0;
    const s = scheduler(r, "A", { progress: () => void (stamps += 1) });
    void s.scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = stamps;
    expect(await s.scheduler.tick()).toEqual({ kind: "skipped" });
    expect(stamps).toBe(before);
    expect(s.scheduler.status().skipped).toBe(1);
  });

  it("a stopped scheduler never asks for the lock again: the watchdog's exit grace is the standby's, not one more tick of the dying holder", async () => {
    const r = rig(1);
    const a = scheduler(r, "A");
    const b = scheduler(r, "B");
    expect((await a.scheduler.tick()).kind).toBe("acted");
    expect(r.server.holder).toBe("A");
    // bin/scheduler.mts's watchdog beforeExit: the ticks stop, then the session goes.
    a.scheduler.stop();
    a.lock.release();
    const attempts = r.server.attempts;
    expect(await a.scheduler.tick()).toEqual({ kind: "stopped" });
    expect(await a.scheduler.tick()).toEqual({ kind: "stopped" });
    expect(r.server.attempts).toBe(attempts);
    expect(r.server.holder).toBeNull();
    expect(a.scheduler.acting).toBe(false);
    expect(await b.scheduler.tick()).toMatchObject({ kind: "acted", tookOver: true });
    expect(r.server.holder).toBe("B");
  });

  it("a stop that lands while the lock is being asked for gives the lock straight back and acts on nothing", async () => {
    const r = rig(1);
    const a = scheduler(r, "A");
    const ticking = a.scheduler.tick(); // runs up to its lock attempt
    a.scheduler.stop();
    expect(await ticking).toEqual({ kind: "stopped" });
    expect(r.server.holder).toBeNull();
    expect(r.chain.calls.length).toBe(0);
    expect(await scheduler(r, "B").scheduler.tick()).toMatchObject({ kind: "acted", tookOver: true });
  });

  it("scheduler-hung: a tick blocked on a call that never returns exits non-zero within the bound; the standby takes over with a full pass", async () => {
    const r = rig(2);
    r.chain.hang = true;
    r.store.webhookOwner = "scheduler";
    r.store.evidence = { lastBellAt: r.store.now + 100 * TICK, lastEchoAt: null, deafSince: null };
    let clock = 0;
    let lastProgressAt: number | null = null;
    const a = scheduler(r, "A", { progress: () => void (lastProgressAt = clock), now: () => clock, doorbellSecret: true });
    const b = scheduler(r, "B", { doorbellSecret: true });
    // A watchdog on a clock this test drives: the checks run when the test says.
    const intervals: (() => void)[] = [];
    const timeouts: { at: number; run: () => void }[] = [];
    const timers: WatchdogTimers = {
      setInterval: (run) => intervals.push(run),
      clearInterval: () => intervals.splice(0),
      setTimeout: (run, ms) => timeouts.push({ at: clock + ms, run }),
    };
    let exited: number | null = null;
    let exitedAt: number | null = null;
    startWatchdog({
      health: () => decideFleetHealth({ role: "scheduler", now: clock, startedAt: 0, lastProgressAt, intervalMs: TICK }),
      beforeExit: () => a.lock.release(),
      exit: (code) => {
        exited = code;
        exitedAt = clock;
      },
      timers,
    });
    void a.scheduler.tick(); // blocks inside the chain snapshot, forever
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(r.server.holder).toBe("A");
    const bound = Math.max(3 * TICK, 10 * 60_000);
    for (clock = 30_000; clock <= bound + 60_000 && exited === null; clock += 30_000) {
      for (const run of [...intervals]) run();
      for (const t of timeouts.splice(0)) if (t.at <= clock) t.run(); else timeouts.push(t);
      // THE SKIPPED TICKS OF THE HUNG PROCESS MOVE NOTHING.
      await a.scheduler.tick();
    }
    expect(exited).toBe(WATCHDOG_EXIT_CODE);
    expect(exitedAt!).toBeLessThanOrEqual(bound + 30_000 + 3_000);
    expect(r.server.holder).toBeNull();
    r.chain.hang = false;
    const took = await b.scheduler.tick();
    expect(took).toMatchObject({ kind: "acted", tookOver: true, fullReason: expect.stringMatching(/took the lock/) });
  });

  it("pages crank-low for the fleet's crank, critical below 0.005 SOL", async () => {
    const r = rig(1);
    const s = scheduler(r, "A");
    r.chain.crankLamports = 10_000_000n;
    await s.scheduler.tick();
    expect(s.alerter.firing.get("crank-low")?.severity).toBe("warn");
    r.chain.crankLamports = 1_000_000n;
    await s.scheduler.tick();
    expect(s.alerter.firing.get("crank-low")?.severity).toBe("critical");
    r.chain.crankLamports = 100_000_000n;
    await s.scheduler.tick();
    expect(s.alerter.firing.has("crank-low")).toBe(false);
  });
});
