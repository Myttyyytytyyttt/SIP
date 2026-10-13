// ONE WORKER JOB (src/worker-job.ts), whole: the takeover, the plan floor, the
// fresh read, each link's settle through its module, one invest, the outbox and
// the COMPLETE — on a stub chain, over the in-memory model of the store.
//
// THE SETTLE IS THE REAL TURN (runSettleTick over test/settle-world.ts's chain),
// so its gate is the real seam in settle-tick.ts. THE INVEST IS A STAND-IN that
// sends real crank transactions — a wrap and a leg built by invest-tick.ts's own
// builders — through the CrankSender the job hands it, so every byte it sends
// passes the job's fence; the real invest turn under the same sender is
// test/accounts.test.ts's ("the fenced sender").

import { Keypair, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { JobChain } from "../src/job-chain.js";
import { tradeNotional } from "../src/measure-volume.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";
import { runSettleTick, type SettleDeps, type SettleResult } from "../src/settle-tick.js";
import { SAFETY_PASS_STEPS_MS } from "../src/credit-governor.js";
import { JOB_LOG_DETAIL_CHARS, REST_DUE_SECONDS, completionFor, jobLogFields, readStreaks, runVaultJob } from "../src/worker-job.js";
import { secondsUntilFinalizedPasses } from "../src/worker-takeover.js";
import { MemoryDb, MemoryDispatchStore } from "./memory-dispatch-store.js";
import { SettleWorld, vaultOf } from "./settle-world.js";
import { buyingInvest, config, deps, history, jobChain, keysFor, queued } from "./worker-world.js";

const claimOne = async (store: MemoryDispatchStore) => (await store.claim(1))[0]!;

describe("a job settles and invests with the fence, on a stub chain", () => {
  it("gates every send before it leaves — the settle with its carry, the wrap, the leg — writes the history, then completes", async () => {
    const world = new SettleWorld();
    world.losingBacklog();
    const db = new MemoryDb();
    const vault = queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-a");
    const { chain, intentsAtSend } = jobChain([world], () => db.intents.length);
    const h = history();
    const buy = buyingInvest(chain.program);
    const claimed = await claimOne(store);
    const end = await runVaultJob(claimed, deps(store, chain, { keys: keysFor([world]), history: h.writer, invest: buy.invest }));

    expect(end.kind).toBe("complete");
    expect(end.report).toMatchObject({ live: true, module: "PROFIT", mode: MODE_PROFIT, intents: 3, settles: [{ outcome: "SETTLED" }], invest: { outcome: "INVESTED" } });
    // EACH OF THE THREE SENDS LEFT WITH ITS OWN INTENT ALREADY COMMITTED: 1, then 2, then 3.
    expect(world.sent).toHaveLength(3);
    expect(intentsAtSend).toEqual([1, 2, 3]);
    expect(db.intents.map((row) => [row.kind, row.state, row.fence])).toEqual([
      ["settle", "landed", 1n],
      ["wrap", "landed", 1n],
      ["invest", "landed", 1n],
    ]);
    // THE PROFIT ZERO SETTLE'S CARRY WAS WRITTEN IN ITS GATE (S-4), stamped with the fence and the intent.
    expect(db.carries).toEqual([expect.objectContaining({ link: world.link.linkAddress.toBase58(), fence: 1n, intentId: 1n, lossLamports: 500_000_000n })]);
    expect(db.gateCalls.map((call) => call.form)).toEqual(["transaction", "one-statement", "one-statement"]);
    // THE OUTBOX: the leg's history row, and only then its intent resolved.
    expect(h.investments).toHaveLength(1);
    expect(h.investments[0]!.txRef).toBe(db.intents[2]!.signature);
    expect(h.settlements).toHaveLength(1);
    expect(db.boardDirty).toBe(1);
    expect(await store.overlapAudit()).toEqual([]);
    // INVEST ONCE, LIVE, WITH THE JOB'S FENCED SENDER — never the legacy quiet period.
    expect(buy.seen).toHaveLength(1);
    expect(buy.seen[0]!.live).toBe(true);
    if (end.kind !== "complete") return;
    expect(end.completion).toMatchObject({ rests: false, lane: "busy", dueInSeconds: 60 });
    expect(await store.complete(claimed, end.completion)).toBe(true);
    expect(db.vaults.get(vault)!.lastOutcome).toBe("settle SETTLED · invest INVESTED");
  });

  it("sends nothing more once the lease is gone: a vault taken over mid-job gets no wrap and no leg, and the job stops", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const db = new MemoryDb();
    const vault = queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-a");
    const { chain } = jobChain([world], () => db.intents.length);
    const claimed = await claimOne(store);
    // AFTER THE SETTLE, BEFORE THE INVEST: another worker takes the vault (its lease ran out and it claimed).
    const settle = async (settleDeps: SettleDeps): Promise<SettleResult> => {
      const result = await runSettleTick(settleDeps);
      const row = db.vaults.get(vault)!;
      row.holder = "worker-b";
      row.fence += 1n;
      return result;
    };
    const buy = buyingInvest(chain.program);
    const end = await runVaultJob(claimed, deps(store, chain, { keys: keysFor([world]), settle, invest: buy.invest }));
    // THE SETTLE WENT; THE WRAP WAS SIGNED, REFUSED AT THE GATE AND DROPPED; NOTHING AFTER IT WAS EVEN BUILT.
    expect(world.sent).toHaveLength(1);
    expect(db.intents.map((row) => row.kind)).toEqual(["settle"]);
    expect(db.gateCalls.map((call) => [call.draft.kind, call.answer])).toEqual([
      ["settle", "gated"],
      ["wrap", "refused"],
    ]);
    expect(end).toMatchObject({ kind: "stop", report: { invest: { outcome: "THREW" } } });
    // AND THE LOOP'S RELEASE CHANGES NOTHING: the vault is worker-b's now.
    expect(await store.release(claimed, "stopped")).toBe(false);
    expect(db.vaults.get(vault)!.holder).toBe("worker-b");
  });
});

describe("the takeover: a job waits out what an earlier holder may still land", () => {
  async function abandoned(lastValidBlockHeight: bigint) {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const db = new MemoryDb();
    const vault = queued(db, [world]);
    const old = new MemoryDispatchStore(db, "worker-old");
    const [first] = await old.claim(1);
    await old.gateOneStatement({ vault, fence: first!.fence, kind: "wrap", link: null, blockhash: "bh", lastValidBlockHeight, planClearedHeight: null, signature: null, idempotencyKey: null, amountRaw: 9n });
    db.advance(46_000); // the old holder died: its lease ran out
    return { world, db, vault, store: new MemoryDispatchStore(db, "worker-new") };
  }

  const never = async (): Promise<never> => {
    throw new Error("nothing may be settled or bought while an earlier send can still land");
  };

  it("completes UNCHANGED, due once the finalized height should have passed it, and settles and buys nothing meanwhile", async () => {
    const { world, db, store } = await abandoned(5_100n);
    const { chain } = jobChain([world], () => db.intents.length, { finalized: 5_100n, confirmed: 5_080n });
    const claimed = await claimOne(store);
    const end = await runVaultJob(claimed, deps(store, chain, { keys: keysFor([world]), settle: never, invest: never }));
    expect(end.kind).toBe("complete");
    if (end.kind !== "complete") return;
    expect(end.completion).toMatchObject({ outcome: "WAITING_INTENT", rests: false, lane: "retry", dueInSeconds: secondsUntilFinalizedPasses(5_100n, 5_080n) });
    expect(world.sent).toHaveLength(0);
    expect(db.intents[0]).toMatchObject({ state: "intent", resolvedAt: null });
  });

  it("once the finalized height has passed it: expires it, plans ABOVE it, reads from the slot the wait cleared at, and only then acts", async () => {
    const { world, db, store } = await abandoned(5_100n);
    const { chain, required } = jobChain([world], () => db.intents.length, { finalized: 5_101n, confirmed: 5_130n });
    const claimed = await claimOne(store);
    const buy = buyingInvest(chain.program);
    const end = await runVaultJob(claimed, deps(store, chain, { keys: keysFor([world]), invest: buy.invest }));
    expect(end.kind).toBe("complete");
    expect(end.report.resolvedAtTakeover).toBe(1);
    expect(db.intents[0]).toMatchObject({ state: "expired", resolvedHeight: 5_100n });
    // minContextSlot ≥ the slot the wait cleared at (the stub's finalized slot), on every read after it.
    expect(required).toEqual([5_101n + 20_000_000n]);
    // EVERY LATER INTENT PLANNED ABOVE THE FLOOR: the audit has nothing to say.
    expect(db.intents.slice(1).every((row) => row.planClearedHeight === 5_101n)).toBe(true);
    expect(await store.overlapAudit()).toEqual([]);
    expect(world.sent.length).toBeGreaterThan(0);
  });

  it("waits for finality behind a send that LANDED a moment ago: polls until the finalized height is above it", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const db = new MemoryDb();
    const vault = queued(db, [world]);
    const first = new MemoryDispatchStore(db, "worker-a");
    const [claim1] = await first.claim(1);
    const gated = await first.gateOneStatement({ vault, fence: claim1!.fence, kind: "wrap", link: null, blockhash: "bh", lastValidBlockHeight: 5_200n, planClearedHeight: null, signature: null, idempotencyKey: null, amountRaw: 1n });
    if (gated.kind !== "gated") throw new Error("setup");
    await first.resolveIntent(gated.intentId, "landed", 5_050n);
    await first.complete(claim1!, { rests: false, lane: "busy", streaks: {}, outcome: "x", detail: null, dueInSeconds: 0 });
    const { chain, state } = jobChain([world], () => db.intents.length, { finalized: 5_040n, confirmed: 5_060n });
    const sleeps: number[] = [];
    const claimed = await claimOne(first);
    const end = await runVaultJob(claimed, deps(first, chain, {
      sleep: async (ms) => {
        sleeps.push(ms);
        state.finalized += 6n;
      },
    }));
    expect(end.kind).toBe("complete");
    // 5_040 → 5_046 → 5_052: two polls, then above 5_050.
    expect(sleeps).toEqual([2_000, 2_000]);
    expect(db.intents.slice(1).every((row) => row.planClearedHeight === 5_052n)).toBe(true);
    expect(await first.overlapAudit()).toEqual([]);
  });
});

describe("the shadow world: intents written, nothing sent", () => {
  it("gates the would-be settle and the would-be wrap, convert and leg as 'shadow' rows, sends nothing, and the audit stays empty", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const db = new MemoryDb();
    queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-shadow", "shadow");
    const { chain } = jobChain([world], () => db.intents.length);
    const buy = buyingInvest(chain.program);
    const claimed = await claimOne(store);
    const end = await runVaultJob(claimed, deps(store, chain, { invest: buy.invest }));
    expect(end.kind).toBe("complete");
    expect(end.report).toMatchObject({ world: "shadow", live: false, settles: [{ outcome: "SETTLED" }], invest: { outcome: "INVESTED" } });
    expect(end.report.settles[0]!.detail).toContain("DRY RUN — would settle");
    expect(world.sent).toHaveLength(0);
    expect(db.intents.map((row) => [row.kind, row.state])).toEqual([
      ["settle", "shadow"],
      ["wrap", "shadow"],
      ["convert", "shadow"],
      ["invest", "shadow"],
    ]);
    expect(db.intents.every((row) => row.resolvedAt !== null)).toBe(true);
    expect(db.carries).toEqual([]);
    expect(buy.seen[0]!.live).toBe(false);
    expect(buy.seen[0]!.sender).toBeUndefined();
    expect(await store.overlapAudit()).toEqual([]);
  });

  it("logs each wallet's settle by its address, with its detail, and the vault's one invest: the row the local shadow sets beside production's /status", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const db = new MemoryDb();
    queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-shadow", "shadow");
    const { chain } = jobChain([world], () => db.intents.length);
    const end = await runVaultJob(await claimOne(store), deps(store, chain, { invest: buyingInvest(chain.program).invest }));
    const fields = jobLogFields(end);
    expect(fields).toMatchObject({
      world: "shadow",
      live: false,
      module: "PROFIT",
      settles: ["SETTLED"],
      wallets: [{ wallet: world.wallet.toBase58(), settle: "SETTLED", detail: expect.stringContaining("DRY RUN — would settle") }],
      invest: "INVESTED",
      investDetail: expect.any(String),
      intents: 4,
      outcome: expect.stringMatching(/^settle SETTLED · invest INVESTED$/),
    });
    // A DETAIL IS CUT, never the line: a long one keeps its first JOB_LOG_DETAIL_CHARS characters.
    const long = { ...end, report: { ...end.report, settles: [{ ...end.report.settles[0]!, detail: "x".repeat(1_000) }] } } as typeof end;
    expect((jobLogFields(long)["wallets"] as { detail: string }[])[0]!.detail).toHaveLength(JOB_LOG_DETAIL_CHARS);
    // A STOPPED JOB SAYS WHY instead of an outcome.
    const stopped = jobLogFields({ kind: "stop", reason: "its lease was lost", report: end.report });
    expect(stopped).toMatchObject({ reason: "its lease was lost" });
    expect(stopped).not.toHaveProperty("outcome");
  });

  it("makes the NEXT shadow job wait out finality behind those rows, exactly as behind real sends", async () => {
    const world = new SettleWorld();
    world.trade(400_000_000);
    world.finalizeTo(world.tip);
    const db = new MemoryDb();
    queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-shadow", "shadow");
    const { chain, state } = jobChain([world], () => db.intents.length, { finalized: 5_000n, confirmed: 5_020n });
    const first = await claimOne(store);
    const end = await runVaultJob(first, deps(store, chain, { invest: buyingInvest(chain.program).invest }));
    if (end.kind !== "complete") throw new Error("first job");
    await store.complete(first, { ...end.completion, dueInSeconds: 0 });
    const polls: number[] = [];
    const second = await claimOne(store);
    await runVaultJob(second, deps(store, chain, {
      invest: buyingInvest(chain.program).invest,
      sleep: async (ms) => {
        polls.push(ms);
        state.finalized += 10n;
      },
    }));
    // THE ROWS WERE RESOLVED AT THE CONFIRMED HEIGHT 5_020: the second job planned only once the finalized height passed it.
    expect(polls.length).toBeGreaterThan(0);
    const later = db.intents.filter((row) => row.fence === second.fence);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((row) => (row.planClearedHeight ?? 0n) > 5_020n)).toBe(true);
    expect(await store.overlapAudit()).toEqual([]);
    expect(world.sent).toHaveLength(0);
  });
});

describe("module selection by the vault's own skim_mode", () => {
  async function captured(mode: number) {
    const world = new SettleWorld();
    const db = new MemoryDb();
    queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-shadow", "shadow");
    const { chain } = jobChain([world], () => db.intents.length, { vault: vaultOf(mode) });
    const seen: SettleDeps[] = [];
    const settle = async (settleDeps: SettleDeps) => (seen.push(settleDeps), runSettleTick(settleDeps));
    const end = await runVaultJob(await claimOne(store), deps(store, chain, { settle, invest: buyingInvest(chain.program).invest }));
    return { end, deps: seen[0]! };
  }

  it("PROFIT: settles only byte 0, measured by the balance chain, its carry read through from Postgres", async () => {
    const { end, deps: d } = await captured(MODE_PROFIT);
    expect(end.report.module).toBe("PROFIT");
    expect(d.settles).toEqual([MODE_PROFIT]);
    expect(d.volumeProbe).toBeUndefined();
    expect(d.volumeBase).toBeUndefined();
    expect(d.carryStore).toBeDefined();
    expect(d.fence).toBeDefined();
  });

  it("VOLUME: settles only byte 1, with the trade-notional probe and a volume base", async () => {
    const { end, deps: d } = await captured(MODE_VOLUME);
    expect(end.report.module).toBe("VOLUME");
    expect(d.settles).toEqual([MODE_VOLUME]);
    expect(d.volumeProbe).toBe(tradeNotional);
    expect(typeof d.volumeBase).toBe("function");
  });

  it("a byte with no module: no byte to settle, so UNSUPPORTED_MODE before the settle reads anything", async () => {
    const { end, deps: d } = await captured(9);
    expect(end.report.module).toBeNull();
    expect(d.settles).toEqual([]);
    expect(end.report.settles[0]!.outcome).toBe("UNSUPPORTED_MODE");
  });
});

describe("the rest of the job", () => {
  it("invests ONCE for a vault with two links, after settling both in link-address order", async () => {
    const worlds = [new SettleWorld(), new SettleWorld()];
    const db = new MemoryDb();
    queued(db, worlds);
    const store = new MemoryDispatchStore(db, "worker-shadow", "shadow");
    const { chain } = jobChain(worlds, () => db.intents.length);
    const order: string[] = [];
    const settle = async (settleDeps: SettleDeps) => (order.push(settleDeps.link.linkAddress.toBase58()), runSettleTick(settleDeps));
    const buy = buyingInvest(chain.program);
    const end = await runVaultJob(await claimOne(store), deps(store, chain, { settle, invest: buy.invest }));
    expect(order).toEqual(worlds.map((world) => world.link.linkAddress.toBase58()).sort());
    expect(buy.seen).toHaveLength(1);
    expect(end.report.settles).toHaveLength(2);
  });

  it("in the live world, settles NOTHING with a settle key the chain does not name as attester and keeper", async () => {
    const world = new SettleWorld();
    const db = new MemoryDb();
    queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-a");
    const other = { ...config(), attester: Keypair.generate().publicKey };
    const { chain } = jobChain([world], () => db.intents.length, { config: other });
    const never = async (): Promise<never> => {
      throw new Error("not reached");
    };
    const end = await runVaultJob(await claimOne(store), deps(store, chain, { keys: keysFor([world]), settle: never, invest: never }));
    expect(end.kind).toBe("complete");
    if (end.kind !== "complete") return;
    expect(end.completion).toMatchObject({ outcome: "RETRY", lane: "retry", dueInSeconds: 60 });
    expect(end.completion.detail).toContain("wrong: attester");
  });

  it("writes a landed leg's history from its receipt when the turn broke before reporting it (the outbox, S-9)", async () => {
    const world = new SettleWorld();
    const db = new MemoryDb();
    const vault = queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-a");
    const { chain } = jobChain([world], () => db.intents.length);
    const target = Keypair.generate().publicKey.toBase58();
    const receipts = new Proxy(chain.connection as object, {
      get(t, prop) {
        if (prop !== "getTransaction") return (t as Record<string | symbol, unknown>)[prop];
        return async () => ({
          slot: 777,
          meta: {
            err: null,
            preTokenBalances: [
              { accountIndex: 1, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: vault, uiTokenAmount: { amount: "9000000" } },
              { accountIndex: 2, mint: target, owner: vault, uiTokenAmount: { amount: "0" } },
            ],
            postTokenBalances: [
              { accountIndex: 1, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: vault, uiTokenAmount: { amount: "7000000" } },
              { accountIndex: 2, mint: target, owner: vault, uiTokenAmount: { amount: "42" } },
            ],
          },
        });
      },
    }) as Connection;
    const withReceipts: JobChain = { ...chain, connection: receipts, program: chain.program };
    const h = history();
    const end = await runVaultJob(await claimOne(store), deps(store, withReceipts, { keys: keysFor([world]), history: h.writer, invest: buyingInvest(chain.program, { omitPurchase: true }).invest }));
    expect(end.report.invest?.outcome).toBe("FAILED");
    expect(h.investments).toEqual([{ vaultAddr: vault, target, spentRaw: 2_000_000n, receivedRaw: 42n, txRef: db.intents.at(-1)!.signature, height: 777n }]);
    expect(db.intents.at(-1)).toMatchObject({ kind: "invest", state: "landed" });
  });

  it("stops — and leaves the loop to release — the moment it may no longer act, before any settle", async () => {
    const world = new SettleWorld();
    const db = new MemoryDb();
    queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-a");
    const { chain } = jobChain([world], () => db.intents.length);
    const end = await runVaultJob(await claimOne(store), deps(store, chain, { keys: keysFor([world]), mayAct: () => "the worker is draining after SIGTERM" }));
    expect(end).toMatchObject({ kind: "stop", reason: "the worker is draining after SIGTERM" });
    expect(world.sent).toHaveLength(0);
  });

  it("stops starting phases at its soft deadline: the vault comes back due now, not resting", async () => {
    const world = new SettleWorld();
    const db = new MemoryDb();
    queued(db, [world]);
    const store = new MemoryDispatchStore(db, "worker-shadow", "shadow");
    const { chain } = jobChain([world], () => db.intents.length);
    const end = await runVaultJob(await claimOne(store), deps(store, chain, { softDeadlineAt: 0 }));
    expect(end.kind).toBe("complete");
    if (end.kind !== "complete") return;
    expect(end.completion).toMatchObject({ rests: false, lane: "busy", dueInSeconds: 0 });
    expect(end.report.settles).toEqual([]);
  });
});

describe("a resting vault's next turn is the scheduler's, at whatever pass the credit governor allows", () => {
  it("its due time is only a backstop, past the longest pass the governor can set, so stretching the pass saves turns", () => {
    const resting = completionFor({
      settles: [{ link: "L", wallet: "W", outcome: "IDLE", detail: "IDLE" }],
      invest: { outcome: "IDLE", detail: "" },
      wrapShort: false,
      previous: readStreaks({}),
      unfinished: false,
    });
    expect(resting.rests).toBe(true);
    for (const pass of SAFETY_PASS_STEPS_MS) expect(resting.dueInSeconds * 1_000, `pass ${pass / 60_000} min`).toBeGreaterThanOrEqual(pass);
    expect(resting.dueInSeconds).toBe(120 * 60);
  });
});

describe("completionFor: when the vault is due again (ADR §3.7)", () => {
  const previous = readStreaks({});
  const turn = (outcome: Parameters<typeof completionFor>[0]["settles"][number]["outcome"]) => ({ link: "L", wallet: "W", outcome, detail: outcome });

  it("rests for the safety rotation only when every settle and the invest rest", () => {
    expect(completionFor({ settles: [turn("IDLE")], invest: { outcome: "IDLE", detail: "" }, wrapShort: false, previous, unfinished: false })).toMatchObject({
      rests: true,
      lane: "safety",
      dueInSeconds: REST_DUE_SECONDS,
    });
    expect(completionFor({ settles: [turn("IDLE"), turn("PENDING_FINALITY")], invest: { outcome: "IDLE", detail: "" }, wrapShort: false, previous, unfinished: false })).toMatchObject({
      rests: false,
      lane: "busy",
      dueInSeconds: 15,
    });
    // A CRANK TOO SHORT TO WRAP IS NOT A REST: only refilling the crank ends it, and that rings nothing.
    expect(completionFor({ settles: [turn("IDLE")], invest: { outcome: "IDLE", detail: "" }, wrapShort: true, previous, unfinished: false }).rests).toBe(false);
  });

  it("is due soonest by the most urgent outcome, and RETRY/FAILED/THREW go in the retry lane", () => {
    expect(completionFor({ settles: [turn("NO_SIGNER")], invest: { outcome: "IDLE", detail: "" }, wrapShort: false, previous, unfinished: false })).toMatchObject({ lane: "busy", dueInSeconds: 600 });
    expect(completionFor({ settles: [turn("RETRY")], invest: { outcome: "INVESTED", detail: "" }, wrapShort: false, previous, unfinished: false })).toMatchObject({ lane: "retry", dueInSeconds: 60 });
    expect(completionFor({ settles: [turn("IDLE")], invest: { outcome: "THREW", detail: "" }, wrapShort: false, previous, unfinished: false })).toMatchObject({ lane: "retry", dueInSeconds: 60 });
  });

  it("backs a refused basket off from 5 minutes, doubling per refusal in a row, to an hour", () => {
    let streaks = previous;
    const dues: number[] = [];
    for (let i = 0; i < 6; i++) {
      const done = completionFor({ settles: [turn("IDLE")], invest: { outcome: "REFUSED", detail: "" }, wrapShort: false, previous: streaks, unfinished: false });
      dues.push(done.dueInSeconds);
      streaks = readStreaks(done.streaks);
    }
    expect(dues).toEqual([300, 600, 1_200, 2_400, 3_600, 3_600]);
    const cleared = completionFor({ settles: [turn("IDLE")], invest: { outcome: "INVESTED", detail: "" }, wrapShort: false, previous: streaks, unfinished: false });
    expect(readStreaks(cleared.streaks).investRefused).toBe(0);
  });

  it("keeps per-wallet settle retries and the invest streaks in the row, and reads a damaged row as zeros", () => {
    const done = completionFor({ settles: [turn("RETRY")], invest: { outcome: "FAILED", detail: "" }, wrapShort: false, previous: readStreaks({ settleRetries: { W: 2 }, investFailed: 1 }), unfinished: false });
    expect(readStreaks(done.streaks)).toEqual({ settleRetries: { W: 3 }, investFailed: 2, investRefused: 0, wrapShort: 0 });
    expect(readStreaks({ settleRetries: "x", investFailed: -1, wrapShort: 1.5 })).toEqual({ settleRetries: {}, investFailed: 0, investRefused: 0, wrapShort: 0 });
  });
});

