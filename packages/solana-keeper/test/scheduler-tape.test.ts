// THE PRICE TAPE IN THE SCHEDULER (SIP_SOLANA_PRICE_TAPE; ADR §5.2.3, plan §7
// row 11): the lock holder samples Pyth's SOL/USD once a tick, from the
// snapshot's own first request; the standby samples nothing; the tape is pruned
// with the reap; /status shows it only when it is on. And off — the default —
// nothing of it runs: the snapshot is read as before (test/chain-state.test.ts
// and test/scheduler-chain-tape.test.ts hold the request itself).

import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { MemoryPriceTape, TapeSampler } from "../src/price-tape.js";
import { PYTH_RECEIVER_PROGRAM } from "../src/pyth.js";
import { readPriceTape } from "../src/scheduler-config.js";
import { Scheduler, type SchedulerOptions } from "../src/scheduler.js";
import { pythSolUsdBytes } from "./per-trade-fixtures.js";
import { FakeAlerter, FakeChain, FakeLock, LockServer, MemoryStore, fakeLink } from "./scheduler-fakes.js";

const TICK = 60_000;

function rig() {
  const chain = new FakeChain();
  chain.links.push(fakeLink(Keypair.generate().publicKey));
  return { chain, store: new MemoryStore(), server: new LockServer() };
}

function scheduler(r: ReturnType<typeof rig>, name: string, over: Partial<SchedulerOptions> = {}) {
  const warnings: string[] = [];
  const s = new Scheduler({
    id: name,
    mode: "shadow",
    tickMs: TICK,
    lock: new FakeLock(r.server, name),
    store: r.store,
    fullPass: { takeFullPass: async () => null },
    intents: { resolveIntent: async () => true },
    chain: r.chain,
    alerter: new FakeAlerter(),
    log: (level, message) => {
      if (level === "warn") warnings.push(message);
    },
    lamportsFilter: false,
    doorbellSecret: false,
    ...over,
  });
  return { scheduler: s, warnings };
}

const solUsd = (publishTime: number) => ({
  info: { data: pythSolUsdBytes({ price: 15_000_000_000n, publishTime: BigInt(publishTime) }), owner: PYTH_RECEIVER_PROGRAM, lamports: 1, executable: false, rentEpoch: 0 },
  slot: 400_000_123,
});

describe("SIP_SOLANA_PRICE_TAPE", () => {
  it("is off unless it says on, and refuses anything else", () => {
    expect(readPriceTape(undefined)).toEqual({ on: false });
    expect(readPriceTape(" ")).toEqual({ on: false });
    expect(readPriceTape("off")).toEqual({ on: false });
    expect(readPriceTape("on")).toEqual({ on: true });
    for (const raw of ["ON", "1", "true", "yes"]) expect(readPriceTape(raw)).toHaveProperty("problem");
  });
});

describe("the scheduler samples the tape", () => {
  it("once per acting tick, from the snapshot's own read, keeping each publish once; the standby samples nothing", async () => {
    const r = rig();
    const tapeA = new MemoryPriceTape();
    const tapeB = new MemoryPriceTape();
    // THE PROCESS CLOCK IS THE STORE'S HERE: the reap prunes 35 days back from it.
    const a = scheduler(r, "A", { tape: new TapeSampler(tapeA), now: () => r.store.now });
    const b = scheduler(r, "B", { tape: new TapeSampler(tapeB), now: () => r.store.now });
    const nowSeconds = () => Math.floor(r.store.now / 1_000);
    r.chain.also = solUsd(nowSeconds() - 2);
    expect((await a.scheduler.tick()).kind).toBe("acted");
    expect((await b.scheduler.tick()).kind).toBe("standby");
    // The same publish read again five seconds on: nothing new written.
    r.store.now += 5_000;
    expect((await a.scheduler.tick()).kind).toBe("acted");
    r.store.now += TICK;
    r.chain.also = solUsd(nowSeconds() - 1);
    await a.scheduler.tick();
    expect(tapeA.size).toBe(2);
    expect(tapeB.size).toBe(0);
    expect(a.scheduler.status().priceTape).toMatchObject({ sampled: 3, written: 2, repeated: 1, rejected: {} });
    expect(b.scheduler.status().priceTape).toMatchObject({ sampled: 0 });
    // The SOL/USD sample is kept at its publish time and in micro-dollars.
    expect((await tapeA.pricesAt([nowSeconds()])).get(nowSeconds())?.priceE6).toBe(150_000_000n);
  });

  it("rejects a stale read and says so once, not every tick; a failed snapshot read is counted as missing", async () => {
    const r = rig();
    const a = scheduler(r, "A", { tape: new TapeSampler(new MemoryPriceTape()) });
    r.chain.also = solUsd(Math.floor(r.store.now / 1_000) - 600);
    await a.scheduler.tick();
    r.store.now += TICK;
    await a.scheduler.tick();
    expect(a.warnings.filter((w) => w.includes("price tape"))).toHaveLength(1);
    r.chain.also = null;
    r.store.now += TICK;
    await a.scheduler.tick();
    expect(a.scheduler.status().priceTape).toMatchObject({ sampled: 3, written: 0, rejected: { stale: 2, missing: 1 } });
  });

  it("is absent from /status, and samples nothing, when it is off", async () => {
    const r = rig();
    const a = scheduler(r, "A");
    r.chain.also = solUsd(Math.floor(r.store.now / 1_000));
    await a.scheduler.tick();
    expect(a.scheduler.status()).not.toHaveProperty("priceTape");
  });

  it("prunes 35 days back with the reap", async () => {
    const r = rig();
    const cuts: number[] = [];
    const tape = new TapeSampler({ record: async () => undefined, prune: async (before) => (cuts.push(before), 0) });
    const a = scheduler(r, "A", { tape, now: () => 2_000_000_000_000 });
    await a.scheduler.tick();
    expect(cuts).toEqual([2_000_000_000 - 35 * 86_400]);
  });
});
