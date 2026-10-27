// One worker process's loop (src/worker-loop.ts): slots and the claim loop, the
// heartbeat on its own timer, the job ceiling, and the SIGTERM drain — over the
// in-memory model of the store, with jobs the test writes. What a job does is
// test/worker-job.test.ts's.

import { afterEach, describe, expect, it } from "vitest";
import type { ClaimedVault, Completion } from "../src/dispatch-store.js";
import type { CrankSender } from "../src/explicit-send.js";
import type { JobEnd, JobReport } from "../src/worker-job.js";
import { WorkerLoop, type JobControl, type JobRunner } from "../src/worker-loop.js";
import { MemoryDb, MemoryDispatchStore } from "./memory-dispatch-store.js";

const report = (claimed: ClaimedVault): JobReport => ({
  vault: claimed.vault,
  fence: claimed.fence,
  world: "live",
  live: true,
  mode: 0,
  module: "PROFIT",
  settles: [],
  invest: null,
  intents: 0,
  resolvedAtTakeover: 0,
});

const done: Completion = { rests: true, lane: "safety", streaks: {}, outcome: "DONE", detail: null, dueInSeconds: 1_800 };
const complete = (claimed: ClaimedVault): JobEnd => ({ kind: "complete", completion: done, report: report(claimed) });

const until = async (condition: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/** Every loop a test started, stopped after it whatever it asserted: a loop left running holds the process open. */
const loops: WorkerLoop[] = [];
afterEach(async () => {
  await Promise.all(loops.splice(0).map((loop) => loop.stop()));
});

function setup(vaults: number, runJob: JobRunner, over: Partial<ConstructorParameters<typeof WorkerLoop>[0]> = {}) {
  const db = new MemoryDb();
  for (let i = 0; i < vaults; i++) db.addVault(`vault-${i}`);
  const store = new MemoryDispatchStore(db, "worker-a");
  const logs: string[] = [];
  const loop = new WorkerLoop({ store, slots: 2, runJob, log: (_level, message) => void logs.push(message), claimIdleMs: 5, heartbeatMs: 60_000, ...over });
  loops.push(loop);
  return { db, store, loop, logs };
}

describe("the claim loop", () => {
  it("claims no more than its free slots, runs a job per vault, completes each, and claims again as slots free", async () => {
    let running = 0;
    let peak = 0;
    const seen: string[] = [];
    const { db, loop } = setup(5, async (claimed) => {
      running += 1;
      peak = Math.max(peak, running);
      seen.push(claimed.vault);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return complete(claimed);
    });
    const started = loop.start();
    await until(() => seen.length === 5 && loop.busy === 0);
    await loop.stop();
    await started;
    expect(peak).toBe(2);
    expect([...seen].sort()).toEqual(["vault-0", "vault-1", "vault-2", "vault-3", "vault-4"]);
    for (const row of db.vaults.values()) expect(row).toMatchObject({ holder: null, lastOutcome: "DONE", rests: true });
    expect(loop.stats().jobsLast10Min).toBe(5);
  });

  it("survives a claim that throws (the database away), and claims once it is back", async () => {
    const seen: string[] = [];
    const { db, loop, logs } = setup(1, async (claimed) => (seen.push(claimed.vault), complete(claimed)));
    db.down = true;
    const started = loop.start();
    await until(() => logs.includes("the claim failed; trying again shortly"));
    db.down = false;
    await until(() => seen.length === 1);
    await loop.stop();
    await started;
  });
});

describe("the heartbeat", () => {
  it("renews every lease this process holds while its job awaits, on a timer of its own", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { db, loop } = setup(1, async (claimed) => (await gate, complete(claimed)), { heartbeatMs: 5 });
    const started = loop.start();
    await until(() => loop.busy === 1);
    const before = db.vaults.get("vault-0")!.leaseUntil!;
    db.advance(20_000);
    await until(() => db.vaults.get("vault-0")!.leaseUntil! > before);
    release();
    await until(() => loop.busy === 0);
    await loop.stop();
    await started;
  });

  it("stops a job whose lease it can no longer renew — mayAct says why — counts the loss, and hands back nothing it does not hold", async () => {
    let control!: JobControl;
    const { db, loop } = setup(1, (claimed, c) => {
      control = c;
      return new Promise<JobEnd>((resolve) => {
        const poll = setInterval(() => {
          const why = c.mayAct();
          if (why !== null) {
            clearInterval(poll);
            resolve({ kind: "stop", reason: why, report: report(claimed) });
          }
        }, 1);
      });
    });
    const started = loop.start();
    await until(() => loop.busy === 1);
    // ANOTHER WORKER TOOK THE VAULT (this one's lease ran out under it).
    const row = db.vaults.get("vault-0")!;
    row.holder = "worker-b";
    row.fence += 1n;
    await loop.beatOnce();
    await until(() => loop.busy === 0);
    expect(control.mayAct()).toContain("no longer renews this vault's lease");
    expect(loop.stats().leaseLosses).toBe(1);
    expect(row).toMatchObject({ holder: "worker-b", fence: 2n });
    await loop.stop();
    await started;
  });
});

describe("the job ceiling", () => {
  it("abandons a job hung past its ceiling: its signal fires, mayAct says why, the vault is RELEASED due now, and the slot frees", async () => {
    let control!: JobControl;
    const later: string[] = [];
    let hung = false;
    const { db, store, loop } = setup(2, (claimed, c) => {
      if (claimed.vault === "vault-0" && !hung) {
        hung = true;
        control = c;
        return new Promise<JobEnd>(() => undefined); // hangs forever, whatever it was awaiting
      }
      later.push(claimed.vault);
      return Promise.resolve(complete(claimed));
    }, { slots: 1, ceilingMs: 30 });
    const releases: { vault: string; fence: bigint; reason: string; released: boolean; dueAt: number; now: number }[] = [];
    const release = store.release.bind(store);
    store.release = async (claimed, reason) => {
      const released = await release(claimed, reason);
      releases.push({ vault: claimed.vault, fence: claimed.fence, reason, released, dueAt: db.vaults.get(claimed.vault)!.dueAt, now: db.now });
      return released;
    };
    const started = loop.start();
    await until(() => later.includes("vault-1"));
    expect(releases).toEqual([{ vault: "vault-0", fence: 1n, reason: expect.stringContaining("ceiling"), released: true, dueAt: db.now, now: db.now }]);
    expect(control.signal.aborted).toBe(true);
    expect(control.mayAct()).toContain("ceiling");
    // RELEASED DUE NOW — and so claimed again at once, by this worker's own affinity, before vault-1.
    expect(later).toEqual(["vault-0", "vault-1"]);
    expect(db.vaults.get("vault-0")).toMatchObject({ holder: null, fence: 2n });
    expect(loop.stats().releasedOnSigterm).toBe(0);
    await loop.stop();
    await started;
  });

  it("completes a job that THREW as THREW, due in a minute — never handed back due now, to throw again in a loop", async () => {
    let runs = 0;
    const { db, loop, logs } = setup(1, async () => {
      runs += 1;
      throw new Error("a bug in the job");
    });
    const started = loop.start();
    await until(() => db.vaults.get("vault-0")!.lastOutcome === "THREW");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toBe(1);
    expect(db.vaults.get("vault-0")).toMatchObject({ holder: null, lane: "retry", rests: false, dueAt: db.now + 60_000 });
    expect(db.vaults.get("vault-0")!.lastDetail).toContain("a bug in the job");
    expect(logs).toContain("a worker job threw; its vault is due again in a minute");
    await loop.stop();
    await started;
  });
});

describe("how each job ended, told to the loop's owner (bin/worker.mts pages a vault whose jobs never finish)", () => {
  it("says complete for a completed job, threw for one that threw, aborted for one past its ceiling — and nothing for a SIGTERM drain", async () => {
    const ends: [string, string][] = [];
    let hung = false;
    const { loop } = setup(3, (claimed) => {
      if (claimed.vault === "vault-1") return Promise.reject(new Error("a bug in the job"));
      if (claimed.vault === "vault-2" && !hung) {
        hung = true;
        return new Promise<JobEnd>(() => undefined);
      }
      return Promise.resolve(complete(claimed));
    }, { slots: 3, ceilingMs: 30, onJobEnd: (vault, how) => void ends.push([vault, how]) });
    const started = loop.start();
    await until(() => ends.some(([, how]) => how === "aborted") && ends.some(([, how]) => how === "threw") && ends.some(([vault, how]) => vault === "vault-0" && how === "complete"));
    expect(ends).toEqual(expect.arrayContaining([["vault-0", "complete"], ["vault-1", "threw"], ["vault-2", "aborted"]]));
    await loop.stop();
    await started;
  });

  it("never lets a hook that throws change what became of the vault", async () => {
    const { db, loop } = setup(1, async (claimed) => complete(claimed), { slots: 1, onJobEnd: () => {
      throw new Error("the alerter broke");
    } });
    const started = loop.start();
    await until(() => db.vaults.get("vault-0")!.lastOutcome === "DONE");
    await loop.stop();
    await started;
  });
});

describe("SIGTERM: stop claiming, drain, release", () => {
  it("lets a job that can end do so inside the drain, aborts the one that cannot, releases both due now, and counts them", async () => {
    const senders: { drained: boolean }[] = [];
    let claims = 0;
    const { db, store, loop } = setup(3, (claimed, c) => {
      claims += 1;
      const sender = { drained: false };
      senders.push(sender);
      c.onSender({ beginDrain: () => void (sender.drained = true) } as unknown as CrankSender);
      if (claimed.vault === "vault-0") {
        // ENDS AT ITS NEXT STEP once told it may not act: its send in flight confirmed, nothing new started.
        return new Promise<JobEnd>((resolve) => {
          const poll = setInterval(() => {
            const why = c.mayAct();
            if (why !== null) {
              clearInterval(poll);
              resolve({ kind: "stop", reason: why, report: report(claimed) });
            }
          }, 1);
        });
      }
      return new Promise<JobEnd>(() => undefined); // stuck on a confirm that never comes
    }, { slots: 2, drainMs: 50 });
    const claim = store.claim.bind(store);
    let claimsAfterStop = 0;
    let stopping = false;
    store.claim = async (slots) => {
      if (stopping) claimsAfterStop += 1;
      return claim(slots);
    };
    const started = loop.start();
    await until(() => loop.busy === 2);
    stopping = true;
    const result = await loop.stop();
    await started;
    expect(result).toEqual({ drained: false, released: 2 });
    expect(loop.stats().releasedOnSigterm).toBe(2);
    expect(senders.every((sender) => sender.drained)).toBe(true);
    expect(claimsAfterStop).toBe(0);
    expect(claims).toBe(2);
    for (const vault of ["vault-0", "vault-1"]) expect(db.vaults.get(vault)).toMatchObject({ holder: null, lastOutcome: "RELEASED", dueAt: db.now });
    expect(db.vaults.get("vault-2")!.holder).toBeNull();
  });

  it("completes — not releases — a job that finished its work during the drain", async () => {
    const { db, loop } = setup(1, (claimed, c) =>
      new Promise<JobEnd>((resolve) => {
        const poll = setInterval(() => {
          if (c.mayAct() !== null) {
            clearInterval(poll);
            resolve(complete(claimed));
          }
        }, 1);
      }),
    );
    const started = loop.start();
    await until(() => loop.busy === 1);
    expect(await loop.stop()).toEqual({ drained: true, released: 0 });
    await started;
    expect(db.vaults.get("vault-0")).toMatchObject({ lastOutcome: "DONE", rests: true });
  });
});

describe("the worker's stats, for its row", () => {
  it("counts the gate's refusals — the fence doing its job — total and in the last hour", async () => {
    const { loop } = setup(1, async (claimed, c) => {
      c.onGate("wrap", { kind: "refused", reason: "lease", detail: "gone" });
      c.onGate("settle", { kind: "gated", intentId: 1n, carryWritten: false });
      c.onGate("invest", { kind: "unavailable", detail: "db" });
      return complete(claimed);
    });
    const started = loop.start();
    await until(() => loop.stats().jobsLast10Min === 1);
    await loop.stop();
    await started;
    expect(loop.stats()).toMatchObject({ fenceRejects: 1, fenceRejectsLastHour: 1 });
  });
});
