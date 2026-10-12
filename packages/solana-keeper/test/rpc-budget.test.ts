// One dispatcher process's RPC bucket on its own (src/rpc-budget.ts): which
// lane goes first, how hot and rest share what is left, what a 429 does to the
// rate and how it comes back, and the context that carries the lane.
//
// THE CLOCK AND THE TIMERS ARE THE TEST'S. The budget takes `now` and
// `setTimer`, so seconds of pacing run in microseconds and every grant is
// counted at an exact instant. The pool's half — the Retry-After wait on the
// same endpoint, the lane reaching the transport through a real Connection — is
// in test/rpc-pool-budget.test.ts; the proof that a pool WITHOUT a budget is
// unchanged is test/rpc-budget-parity.test.ts.

import { describe, expect, it } from "vitest";
import {
  LANE_WEIGHTS,
  MIN_RATE_MULTIPLIER,
  RATE_CUT_HOLD_MS,
  RpcBudget,
  currentRpcContext,
  retryAfterMs,
  withRpcLane,
  type RpcLane,
  type RpcPermit,
  type RpcUsageSink,
} from "../src/rpc-budget.js";
import { manualClock } from "./manual-clock.js";

function budgetOn(clock: ReturnType<typeof manualClock>, ratePerSecond: number, usage?: RpcUsageSink, defaultLane: RpcLane = "hot") {
  return new RpcBudget({ ratePerSecond, defaultLane, now: clock.now, setTimer: clock.setTimer, ...(usage === undefined ? {} : { usage }) });
}

/** Takes every token the bucket holds, so what follows waits. */
async function drain(budget: RpcBudget): Promise<void> {
  const capacity = budget.status().capacity;
  for (let i = 0; i < capacity; i++) await budget.acquire("hot", 1);
  expect(budget.status().tokens).toBeLessThan(1);
}

/** Queues `n` one-token requests on `lane`, recording the lane of each grant in `order`. */
function queue(budget: RpcBudget, lane: RpcLane, n: number, order: string[]): Promise<RpcPermit>[] {
  return Array.from({ length: n }, (_, i) =>
    budget.acquire(lane, 1).then((permit) => {
      order.push(`${lane}${n > 1 ? `#${i}` : ""}`);
      return permit;
    }),
  );
}

const lanesOf = (order: readonly string[]): string[] => order.map((entry) => entry.replace(/#\d+$/, ""));
const count = (order: readonly string[], lane: string): number => lanesOf(order).filter((entry) => entry === lane).length;

describe("the lanes: send first, then hot and rest 80 : 20", () => {
  it("serves a send before every hot and rest request already waiting", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    await drain(budget);
    const order: string[] = [];
    queue(budget, "hot", 20, order);
    queue(budget, "rest", 20, order);
    await clock.advance(500);
    const before = order.length;
    expect(before).toBe(5);
    // A SEND ARRIVES BEHIND 35 WAITING REQUESTS, and is the very next grant.
    queue(budget, "send", 1, order);
    await clock.advance(100);
    expect(order[before]).toBe("send");
    expect(budget.status().maxWaitMs.send).toBeLessThanOrEqual(100);
  });

  it("shares what send leaves 80 : 20 between hot and rest while both wait", async () => {
    expect(LANE_WEIGHTS.hot / (LANE_WEIGHTS.hot + LANE_WEIGHTS.rest)).toBeCloseTo(0.8, 9);
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    await drain(budget);
    const order: string[] = [];
    queue(budget, "hot", 60, order);
    queue(budget, "rest", 60, order);
    await clock.advance(2_500);
    expect(order).toHaveLength(25);
    expect(count(order, "hot")).toBe(20);
    expect(count(order, "rest")).toBe(5);
    await clock.advance(2_500);
    expect(order).toHaveLength(50);
    expect(count(order, "hot")).toBe(40);
    expect(count(order, "rest")).toBe(10);
  });

  it("never starves the safety rotation behind a flood of hot work: a rest request is in the first five grants", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    await drain(budget);
    const order: string[] = [];
    queue(budget, "hot", 500, order);
    queue(budget, "rest", 1, order);
    await clock.advance(500);
    expect(lanesOf(order).slice(0, 5)).toContain("rest");
  });

  it("gives a lane that was idle no banked share: it rejoins at the current pass", async () => {
    // Hot runs alone for 100 grants; then rest arrives. Were rest's pass still 0
    // it would take the next 25 grants in a row.
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    await drain(budget);
    const order: string[] = [];
    queue(budget, "hot", 200, order);
    await clock.advance(10_000);
    expect(order).toHaveLength(100);
    queue(budget, "rest", 20, order);
    await clock.advance(1_000);
    const last10 = lanesOf(order).slice(100, 110);
    expect(last10.filter((lane) => lane === "rest").length).toBeLessThanOrEqual(3);
    expect(last10.filter((lane) => lane === "hot").length).toBeGreaterThanOrEqual(7);
  });

  it("admits each lane's own requests in the order they asked", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    await drain(budget);
    const order: string[] = [];
    queue(budget, "hot", 8, order);
    queue(budget, "rest", 8, order);
    await clock.advance(2_000);
    expect(order.filter((entry) => entry.startsWith("hot"))).toEqual(Array.from({ length: 8 }, (_, i) => `hot#${i}`));
    expect(order.filter((entry) => entry.startsWith("rest"))).toEqual(Array.from({ length: 8 }, (_, i) => `rest#${i}`));
  });

  it("paces to the quota: ten a second, one second's burst at boot", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    const order: string[] = [];
    queue(budget, "hot", 40, order);
    await clock.settle();
    // THE BURST: a full bucket at boot is one second of the rate.
    expect(order).toHaveLength(10);
    await clock.advance(1_000);
    expect(order).toHaveLength(20);
    await clock.advance(1_000);
    expect(order).toHaveLength(30);
  });

  it("admits a batch larger than the bucket when the bucket is full, and the requests after it wait out the debt", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    const big = await budget.acquire("hot", 25);
    expect(big.tokens).toBe(25);
    expect(budget.status().tokens).toBe(-15);
    const order: string[] = [];
    queue(budget, "hot", 1, order);
    await clock.advance(1_500);
    expect(order).toEqual([]);
    await clock.advance(100);
    expect(order).toEqual(["hot"]);
  });

  it("takes a new quota from now on, and refuses one that is not a positive number", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    await drain(budget);
    expect(budget.setQuota(0)).toBe(false);
    expect(budget.setQuota(Number.NaN)).toBe(false);
    expect(budget.setQuota(-3)).toBe(false);
    expect(budget.quotaPerSecond).toBe(10);
    expect(budget.setQuota(2)).toBe(true);
    const order: string[] = [];
    queue(budget, "hot", 10, order);
    await clock.advance(1_000);
    expect(order).toHaveLength(2);
    expect(() => budgetOn(clock, 0)).toThrow(/positive/);
  });
});

describe("a wall clock that steps", () => {
  it("keeps earning when the wall clock steps back a minute: a send waits one token's time, not the minute", async () => {
    // THE REVIEW'S PROBE: ten a second, drained, then an NTP step or a VM
    // migration puts Date.now 60 s back. Node's timers keep their own clock.
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    await drain(budget);
    clock.jump(-60_000);
    let sent = false;
    void budget.acquire("send", 1).then(() => {
      sent = true;
    });
    await clock.advance(150);
    expect(sent, "a send held while the wall clock catches up").toBe(true);
    expect(budget.status().waiting.send).toBe(0);
    // AND IT PACES AT ITS RATE FROM THERE: ten more in about a second.
    const order: string[] = [];
    queue(budget, "hot", 10, order);
    await clock.advance(1_000);
    expect(order).toHaveLength(10);
  });

  it("keeps a 429's hold its length across a backward step, instead of stretching it by the step", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    const permit = await budget.acquire("hot", 1);
    budget.answered(permit, 429);
    expect(budget.status().multiplier).toBe(0.5);
    await clock.advance(10_000);
    // REQUESTS FLOWING ON EITHER SIDE OF THE STEP (each reads the clock), as they do while a hold matters.
    budget.status();
    clock.jump(-60_000);
    budget.status();
    // 20 s OF THE 30 s HOLD LEFT, whatever the wall clock now says.
    await clock.advance(19_000);
    expect(budget.status().multiplier).toBe(0.5);
    await clock.advance(1_000);
    expect(budget.status().multiplier).toBeGreaterThan(0.5);
  });
});

describe("rpc-bucket-429: rate halves, send lane served first", () => {
  it("halves the rate for 30 s, empties the bucket, and serves a send ahead of the backlog the 429 left", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    const permit = await budget.acquire("hot", 1);
    budget.answered(permit, 429);
    const cut = budget.status();
    expect(cut.ratePerSecond).toBe(5);
    expect(cut.multiplier).toBe(0.5);
    expect(cut.cuts).toBe(1);
    expect(cut.tokens).toBeLessThanOrEqual(0);
    expect(cut.cutHeldUntil).toBe(new Date(clock.now() + RATE_CUT_HOLD_MS).toISOString());

    const order: string[] = [];
    queue(budget, "hot", 200, order);
    queue(budget, "rest", 200, order);
    await clock.advance(10_000);
    // FIVE A SECOND FOR TEN SECONDS.
    expect(order).toHaveLength(50);
    const before = order.length;
    queue(budget, "send", 1, order);
    await clock.advance(200);
    expect(order[before]).toBe("send");
  });

  it("cuts once for a burst of 429s sent at the old rate, and again for one sent at the new rate", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 16);
    // FOUR REQUESTS IN FLIGHT AT THE OLD RATE all come back 429.
    const inFlight = await Promise.all([1, 2, 3, 4].map(() => budget.acquire("hot", 1)));
    for (const permit of inFlight) budget.answered(permit, 429);
    expect(budget.status().ratePerSecond).toBe(8);
    expect(budget.status().cuts).toBe(1);
    expect(budget.status().stale429).toBe(3);
    expect(budget.status().http429).toBe(4);
    // ONE SENT AFTER THE CUT is the provider still refusing at the new rate.
    const afterCut = budget.acquire("hot", 1);
    await clock.advance(1_000);
    budget.answered(await afterCut, 429);
    expect(budget.status().ratePerSecond).toBe(4);
    expect(budget.status().cuts).toBe(2);
  });

  it("climbs back a tenth of the quota every 10 s after the hold, and is whole again 70 s after one halving", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    budget.answered(await budget.acquire("hot", 1), 429);
    const seen: number[] = [];
    await clock.advance(RATE_CUT_HOLD_MS - 1);
    seen.push(budget.status().ratePerSecond);
    for (let i = 0; i < 6; i++) {
      await clock.advance(i === 0 ? 1 : 10_000);
      seen.push(Math.round(budget.status().ratePerSecond * 1_000) / 1_000);
    }
    expect(seen).toEqual([5, 6, 7, 8, 9, 10, 10]);
    expect(budget.status().multiplier).toBe(1);
    expect(budget.status().cutHeldUntil).toBeNull();
  });

  it("earns its tokens at the rate of each step it crossed, not at the rate it ends on", async () => {
    // 30 s at 5/s, then 10 s at 6/s: the bucket caps at a second's burst, so
    // the proof is in the grants a continuous backlog receives.
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    budget.answered(await budget.acquire("hot", 1), 429);
    const order: string[] = [];
    queue(budget, "hot", 1_000, order);
    await clock.advance(40_000);
    expect(order.length).toBeGreaterThanOrEqual(30 * 5 + 10 * 6 - 1);
    expect(order.length).toBeLessThanOrEqual(30 * 5 + 10 * 6 + 1);
  });

  it("integrates across a step: 100 ms at 5 a second then 100 ms at 6 is 1.1 tokens, not 1.0 or 1.2", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    budget.answered(await budget.acquire("hot", 1), 429);
    await clock.advance(RATE_CUT_HOLD_MS - 100);
    // A full bucket at the halved rate is five tokens; take them all.
    for (let i = 0; i < 5; i++) await budget.acquire("hot", 1);
    expect(budget.status().tokens).toBe(0);
    await clock.advance(200);
    expect(budget.status().tokens).toBe(1.1);
  });

  it("stops halving at a sixteenth of the quota", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 32);
    for (let i = 0; i < 8; i++) {
      const permit = budget.acquire("hot", 1);
      await clock.advance(2_000);
      budget.answered(await permit, 429);
    }
    expect(budget.status().multiplier).toBe(MIN_RATE_MULTIPLIER);
    expect(budget.status().ratePerSecond).toBe(2);
  });

  it("leaves the rate alone for every answer that is not a 429", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 10);
    for (const result of [200, 500, 503, 403, "unreachable"] as const) budget.answered(await budget.acquire("hot", 1), result);
    expect(budget.status().ratePerSecond).toBe(10);
    expect(budget.status().cuts).toBe(0);
  });
});

describe("the lane, carried on the async context", () => {
  it("puts every request made inside withRpcLane in that lane, however deep, and the default lane outside it", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 100, undefined, "sched");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" });
    const deep = async (): Promise<RpcPermit> => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return budget.admit(body);
    };
    expect((await withRpcLane("rest", deep)).lane).toBe("rest");
    expect((await withRpcLane("hot", () => withRpcLane("send", deep))).lane).toBe("send");
    expect((await budget.admit(body)).lane).toBe("sched");
    expect(currentRpcContext()).toBeUndefined();
  });

  it("sends sendTransaction in the send lane even untagged, or tagged rest", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 100);
    const send = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["AAAA", { encoding: "base64" }] });
    expect((await budget.admit(send)).lane).toBe("send");
    expect((await withRpcLane("rest", () => budget.admit(send))).lane).toBe("send");
  });

  it("keeps the outer job's signal for an inner lane that names none", () => {
    const job = new AbortController();
    withRpcLane(
      "hot",
      () => {
        withRpcLane("send", () => {
          expect(currentRpcContext()).toEqual({ lane: "send", signal: job.signal });
        });
      },
      job.signal,
    );
  });

  it("takes one token per JSON-RPC call, a batch counted per item", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 100);
    const batch = JSON.stringify([1, 2, 3].map((id) => ({ jsonrpc: "2.0", id, method: "getBalance", params: ["x"] })));
    expect((await budget.admit(batch)).tokens).toBe(3);
    expect((await budget.admit("not json")).tokens).toBe(1);
  });
});

describe("a job's signal", () => {
  it("ends the wait for tokens with the signal's reason, and the next request in the lane goes on", async () => {
    const clock = manualClock();
    const budget = budgetOn(clock, 1);
    await drain(budget);
    const job = new AbortController();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" });
    const waiting = withRpcLane("hot", () => budget.admit(body), job.signal);
    const behind = budget.acquire("hot", 1);
    job.abort(new Error("the job's 6-minute ceiling"));
    await expect(waiting).rejects.toThrow("the job's 6-minute ceiling");
    expect(budget.status().aborted).toBe(1);
    await clock.advance(1_000);
    await expect(behind).resolves.toMatchObject({ lane: "hot" });
    // AN ALREADY-FIRED SIGNAL waits for nothing.
    await expect(withRpcLane("hot", () => budget.admit(body), job.signal)).rejects.toThrow("ceiling");
  });
});

describe("what the budget tells rpc_usage", () => {
  it("counts what was asked once per request, by lane and bill line, and each failed attempt on the first call's line", async () => {
    const asked: string[] = [];
    const ended: string[] = [];
    const sink: RpcUsageSink = {
      asked: (lane, line, calls) => asked.push(`${lane}:${line}:${calls}`),
      ended: (lane, line, result) => ended.push(`${lane}:${line}:${result}`),
    };
    const clock = manualClock();
    const budget = budgetOn(clock, 100, sink);
    const body = JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: ["w", { limit: 1 }] },
      { jsonrpc: "2.0", id: 2, method: "getBalance", params: ["w"] },
      { jsonrpc: "2.0", id: 3, method: "getTransaction", params: ["s"] },
    ]);
    const first = await withRpcLane("rest", () => budget.admit(body));
    budget.answered(first, 429);
    // The 429 emptied the bucket: the retry waits for its three tokens at the halved rate.
    const retry = withRpcLane("rest", () => budget.admit(body, { first: false }));
    await clock.advance(1_000);
    const again = await retry;
    budget.answered(again, 200);
    expect(asked.sort()).toEqual(["rest:archival:2", "rest:standard:1"]);
    expect(ended).toEqual(["rest:archival:429", "rest:archival:200"]);
  });

  it("loses a count, never a request, when the sink throws", async () => {
    const clock = manualClock();
    const exploding: RpcUsageSink = {
      asked: () => {
        throw new Error("boom");
      },
      ended: () => {
        throw new Error("boom");
      },
    };
    const budget = budgetOn(clock, 10, exploding);
    const permit = await budget.admit(JSON.stringify({ method: "getSlot" }));
    expect(() => budget.answered(permit, 429)).not.toThrow();
    expect(budget.status().cuts).toBe(1);
  });
});

describe("Retry-After, as the pool reads it", () => {
  it("reads whole seconds and HTTP dates, and believes nothing else", () => {
    const now = Date.UTC(2026, 9, 12, 12, 0, 0);
    expect(retryAfterMs("1", now)).toBe(1_000);
    expect(retryAfterMs(" 2 ", now)).toBe(2_000);
    expect(retryAfterMs("0", now)).toBe(0);
    expect(retryAfterMs(new Date(now + 1_500).toUTCString(), now)).toBe(1_000); // HTTP dates carry whole seconds
    expect(retryAfterMs(new Date(now - 60_000).toUTCString(), now)).toBe(0);
    for (const junk of [null, undefined, "", "1.5", "-1", "soon", "1e3"]) expect(retryAfterMs(junk, now)).toBeNull();
  });
});
