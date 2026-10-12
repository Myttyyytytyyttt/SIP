// What the keeper asks of its RPC provider and what that costs (src/rpc-usage.ts),
// counted where every request passes (src/rpc-pool.ts).
//
// THROUGH THE REAL POOL, OVER A FAKE TRANSPORT. The global fetch is stubbed with
// one that answers in-process, so the bodies counted are the bodies web3.js's
// Connection really writes — a batch included — and every endpoint is a
// throwaway URL whose "key" is checked never to reach a report. No network.
//
// WHAT MUST HOLD, IN ORDER OF HOW BADLY IT COULD GO WRONG:
//   * the meter cannot change a request: a meter that throws leaves the answer
//     the caller gets byte-identical, and so does every wrapper below;
//   * one request is one count, whatever the failover did, and the endpoints'
//     own answers are counted beside it;
//   * the credit table prices what Helius's pages price, with archival at the
//     configured 1 or 10, and both readings are served;
//   * credit-burn is off until a budget is set, quiet for the first hour, warns
//     at 80 %, pages at 100 % and clears below 80 %.

import { Secret } from "@sip/solana-log";
import { Connection, Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endpointLabel, poolFetch } from "../src/rpc-pool.js";
import { DAY_MS, MIN_OBSERVED_FOR_ESTIMATE_MS } from "../src/rolling-counts.js";
import {
  CREDIT_BURN_ALERT_KEY,
  CREDIT_BURN_MIN_OBSERVED_MS,
  DEFAULT_ARCHIVAL_CREDITS,
  UNREADABLE_METHOD,
  countConfirmations,
  createRpcUsage,
  creditBurnAlert,
  creditClassOf,
  creditPrice,
  heliusRestFetch,
  jsonRpcCalls,
  type RpcUsage,
  type RpcUsageOptions,
} from "../src/rpc-usage.js";

const FIRST = "https://rpc.example.test/?api-key=FirstKeyNeverCounted";
const SECOND = "https://rpc2.example.test/?api-key=SecondKeyNeverCounted";
const urls = [new Secret(FIRST, "rpcUrl:0"), new Secret(SECOND, "rpcUrl:1")];

const T0 = 1_760_000_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A meter on a hand-wound clock. */
function meter(over: Partial<RpcUsageOptions> = {}): { usage: RpcUsage; clock: { now: number } } {
  const clock = { now: T0 };
  const usage = createRpcUsage({
    archivalCredits: DEFAULT_ARCHIVAL_CREDITS,
    archivalCreditsSource: "default",
    budgetPerDay: null,
    startedAt: T0,
    now: () => clock.now,
    ...over,
  });
  return { usage, clock };
}

/** A JSON-RPC answer for whatever was asked: one result per item, so a batch is answered as a batch. */
function rpcAnswer(body: string, result: (method: string) => unknown): Response {
  const parsed = JSON.parse(body) as { id: unknown; method: string } | { id: unknown; method: string }[];
  const answer = (item: { id: unknown; method: string }) => ({ jsonrpc: "2.0", id: item.id, result: result(item.method) });
  return new Response(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** What web3.js expects back for the few methods these tests call. */
const results = (method: string): unknown => {
  switch (method) {
    case "getSlot":
      return 300_000_000;
    case "getSignaturesForAddress":
      return [];
    case "getBalance":
      return { context: { slot: 1 }, value: 5 };
    case "getSignatureStatuses":
      return { context: { slot: 1 }, value: [null] };
    default:
      return null;
  }
};

describe("the credit table", () => {
  it("prices getProgramAccounts at 10, its V2 at 1, a standard call at 1 and an archival one at the configured price", () => {
    expect(creditPrice(creditClassOf("getProgramAccounts", []), 1)).toBe(10);
    expect(creditPrice(creditClassOf("getProgramAccountsV2", []), 10)).toBe(1);
    expect(creditPrice(creditClassOf("getMultipleAccounts", []), 10)).toBe(1);
    expect(creditPrice(creditClassOf("sendTransaction", []), 10)).toBe(1);
    for (const archival of ["getSignaturesForAddress", "getTransaction", "getBlock", "getBlockTime"]) {
      expect(creditPrice(creditClassOf(archival, []), 1), archival).toBe(1);
      expect(creditPrice(creditClassOf(archival, []), 10), archival).toBe(10);
    }
  });

  it("prices getSignatureStatuses as archival exactly when it searches the history, as the settle's landing poll does", () => {
    expect(creditClassOf("getSignatureStatuses", [["sig"], { searchTransactionHistory: true }])).toBe("archival");
    expect(creditClassOf("getSignatureStatuses", [["sig"]])).toBe("standard");
    expect(creditClassOf("getSignatureStatuses", [["sig"], { searchTransactionHistory: false }])).toBe("standard");
  });

  it("prices a webhook edit at 100, a delivered event at 1, and the calls no page prices at 0", () => {
    expect(creditPrice("webhookWrite", 1)).toBe(100);
    expect(creditPrice("webhookEvent", 10)).toBe(1);
    expect(creditPrice("webhookUnpriced", 10)).toBe(0);
  });

  it("defaults the archival price to the billing page's 1", () => {
    expect(DEFAULT_ARCHIVAL_CREDITS).toBe(1);
  });
});

describe("reading a request body", () => {
  it("finds one call in a call and one per item in a batch", () => {
    expect(jsonRpcCalls(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] })).map((c) => c.method)).toEqual(["getSlot"]);
    expect(
      jsonRpcCalls(JSON.stringify([{ method: "getTransaction" }, { method: "getTransaction" }, { method: "getBlockTime" }])).map((c) => c.method),
    ).toEqual(["getTransaction", "getTransaction", "getBlockTime"]);
  });

  it("counts a body it cannot read as one unreadable call, and never repeats a name that is not shaped like a method", () => {
    for (const body of [undefined, "not json", "[]", JSON.stringify({ id: 1 }), JSON.stringify({ method: "https://x.example.test/?api-key=Leak123" })]) {
      expect(jsonRpcCalls(body).map((c) => c.method), String(body)).toEqual([UNREADABLE_METHOD]);
    }
  });
});

describe("the meter inside the pool, over web3.js's own requests", () => {
  it("counts every call by method, for the sweep and for the day", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => rpcAnswer(String(init.body), results)),
    );
    const { usage } = meter();
    const connection = new Connection(FIRST, { commitment: "confirmed", fetch: poolFetch(urls, undefined, undefined, undefined, usage) });
    const wallet = Keypair.generate().publicKey;

    usage.startSweep();
    await connection.getSlot();
    await connection.getSignaturesForAddress(wallet, { limit: 1 });
    await connection.getSignaturesForAddress(wallet, { limit: 1 });
    await connection.getBalance(wallet);
    usage.endSweep();

    const report = usage.report(T0 + 60_000);
    expect(report.callsLastSweep).toBe(4);
    expect(report.byMethodLastSweep).toEqual({ getBalance: 1, getSignaturesForAddress: 2, getSlot: 1 });
    // At archival 1: four calls, four credits.
    expect(report.creditsLastSweep).toBe(4);
    expect(report.callsPerDay).toBe(4);
    expect(report.byMethodPerDay).toEqual({ getBalance: 1, getSignaturesForAddress: 2, getSlot: 1 });
    expect(report.byCreditClassPerDay).toEqual({ archival: 2, standard: 2 });
    expect(report.byEndpointPerDay).toEqual({ [endpointLabel(0, 2)]: { answered: 4, http429: 0, httpOther: 0, unreachable: 0 } });
  });

  it("counts a batch per item: Helius limits batches per item and nothing says it bills them otherwise", () => {
    const { usage } = meter();
    usage.startSweep();
    usage.request(JSON.stringify([{ method: "getTransaction", params: ["a"] }, { method: "getTransaction", params: ["b"] }]));
    usage.endSweep();
    expect(usage.report(T0 + 1).byMethodLastSweep).toEqual({ getTransaction: 2 });
  });

  it("counts a request that failed over ONCE, and says where each attempt went", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) =>
      url === FIRST ? new Response("max usage reached", { status: 429 }) : rpcAnswer(String(init.body), results),
    );
    vi.stubGlobal("fetch", fetch);
    const { usage, clock } = meter();
    const connection = new Connection(FIRST, { commitment: "confirmed", fetch: poolFetch(urls, () => undefined, undefined, undefined, usage) });

    await connection.getSlot();
    clock.now = T0 + 120_000;
    // The first endpoint is cooling down, so this one goes straight to the second.
    await connection.getSlot();

    expect(fetch).toHaveBeenCalledTimes(3);
    const report = usage.report(T0 + 180_000);
    expect(report.callsPerDay).toBe(2);
    expect(report.http429).toBe(1);
    expect(report.http429PerDay).toBe(1);
    expect(report.byEndpointPerDay).toEqual({
      [endpointLabel(0, 2)]: { answered: 0, http429: 1, httpOther: 0, unreachable: 0 },
      [endpointLabel(1, 2)]: { answered: 2, http429: 0, httpOther: 0, unreachable: 0 },
    });
    // Answering since the first answer, at T0: three minutes.
    expect(report.endpointSinceMs).toBe(180_000);
    // AND NO URL, NO KEY, ANYWHERE IN WHAT IT SERVES.
    const served = JSON.stringify(report);
    for (const secret of ["FirstKeyNeverCounted", "SecondKeyNeverCounted", "example.test"]) expect(served).not.toContain(secret);
  });

  it("counts an endpoint that never answered as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === FIRST) throw new TypeError("fetch failed");
        return rpcAnswer(String(init.body), results);
      }),
    );
    const { usage } = meter();
    await poolFetch(urls, () => undefined, undefined, undefined, usage)("ignored", { body: JSON.stringify({ method: "getSlot" }) });
    expect(usage.report(T0 + 1).byEndpointPerDay[endpointLabel(0, 2)]).toEqual({ answered: 0, http429: 0, httpOther: 0, unreachable: 1 });
  });

  it("CANNOT CHANGE A REQUEST: a meter that throws at every report leaves the answer exactly as it was", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => rpcAnswer(String(init.body), results)));
    const exploding = {
      request: () => {
        throw new Error("meter broke");
      },
      attempt: () => {
        throw new Error("meter broke");
      },
    };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "getSlot", params: [] });
    const metered = await poolFetch(urls, undefined, undefined, undefined, exploding)("ignored", { body });
    const plain = await poolFetch(urls)("ignored", { body });
    expect(metered.status).toBe(plain.status);
    expect(await metered.text()).toBe(await plain.text());
  });

  it("forgets what is older than a day, and says how much of the day it has seen", () => {
    const { usage } = meter();
    usage.request(JSON.stringify({ method: "getSlot" }));
    expect(usage.report(T0 + 3_600_000).observedMs).toBe(3_600_000);
    expect(usage.report(T0 + 3_600_000).callsPerDay).toBe(1);
    expect(usage.report(T0 + DAY_MS + 600_000).callsPerDay).toBe(0);
  });
});

describe("the credit estimate", () => {
  /** The profit keeper's fixed part of a sweep: one getProgramAccounts, three standard reads, two probes. */
  function oneSweep(usage: RpcUsage): void {
    usage.request(JSON.stringify({ method: "getProgramAccounts" }));
    for (const method of ["getAccountInfo", "getMultipleAccounts", "getBalance"]) usage.request(JSON.stringify({ method }));
    usage.request(JSON.stringify({ method: "getSignaturesForAddress" }));
    usage.request(JSON.stringify({ method: "getSignaturesForAddress" }));
  }

  it("scales an hour to a day, at the configured price and at both readings of the archival one", () => {
    const { usage } = meter();
    oneSweep(usage);
    const report = usage.report(T0 + 3_600_000);
    // 10 + 3 + 2 × 1 = 15 at P1; 10 + 3 + 2 × 10 = 33 at P2; an hour scaled by 24.
    expect(report.creditsPerDayEstimateP1).toBe(15 * 24);
    expect(report.creditsPerDayEstimateP2).toBe(33 * 24);
    expect(report.creditsPerDayEstimate).toBe(report.creditsPerDayEstimateP1);
    expect(report.archivalCredits).toBe(1);
    expect(report.archivalCreditsSource).toBe("default");
  });

  it("estimates at 10 when archival is configured at 10", () => {
    const { usage } = meter({ archivalCredits: 10, archivalCreditsSource: "env" });
    oneSweep(usage);
    const report = usage.report(T0 + 3_600_000);
    expect(report.creditsPerDayEstimate).toBe(33 * 24);
    expect(report.archivalCreditsSource).toBe("env");
  });

  it("serves no estimate before ten minutes have been watched — only the raw credits of what was", () => {
    // Measured on a keeper booted against the bench stub: 132 ms after boot the
    // first sweep, scaled to a day, read 48 million credits.
    const { usage } = meter({ budgetPerDay: 1_000 });
    oneSweep(usage);
    for (const at of [T0, T0 + 132, T0 + MIN_OBSERVED_FOR_ESTIMATE_MS - 1]) {
      const early = usage.report(at);
      expect(early.creditsPerDayEstimate).toBeNull();
      expect(early.creditsPerDayEstimateP1).toBeNull();
      expect(early.creditsPerDayEstimateP2).toBeNull();
      expect(early.projectedMonthPct).toBeNull();
      expect(early.creditsObserved).toBe(15);
    }
    expect(usage.report(T0 + MIN_OBSERVED_FOR_ESTIMATE_MS).creditsPerDayEstimate).toBe(15 * 144);
  });

  it("adds the websocket confirmations, the webhook's REST calls and its delivered events to the bill", async () => {
    const { usage } = meter();
    usage.webSocketConfirmation();
    // The doorbell's running total: 3 at the first reading, 5 at the next, then a restarted count of 2.
    usage.webhookEventsSeen(3);
    usage.webhookEventsSeen(5);
    usage.webhookEventsSeen(2);
    const answered: string[] = [];
    const counted = heliusRestFetch(usage, async (_input, init) => {
      answered.push(String(init?.method));
      return new Response("[]", { status: 200 });
    });
    await counted("https://api.example.test/v0/webhooks?api-key=HeliusKeyNeverCounted", { method: "GET" });
    await counted("https://api.example.test/v0/webhooks/abc?api-key=HeliusKeyNeverCounted", { method: "PUT", body: "{}" });
    expect(answered).toEqual(["GET", "PUT"]);

    const report = usage.report(T0 + 3_600_000);
    expect(report.webSocketConfirmationsPerDay).toBe(1);
    expect(report.webhookEventsPerDay).toBe(7);
    expect(report.heliusRestPerDay).toEqual({ GET: 1, PUT: 1 });
    expect(report.byCreditClassPerDay).toEqual({ webSocketConfirmation: 1, webhookEvent: 7, webhookUnpriced: 1, webhookWrite: 1 });
    // None of these is a JSON-RPC call.
    expect(report.callsPerDay).toBe(0);
    expect(JSON.stringify(report)).not.toContain("HeliusKeyNeverCounted");
  });

  it("serves the estimate as a share of the budget", () => {
    const { usage } = meter({ budgetPerDay: 720 });
    oneSweep(usage);
    // 360 a day against 720: half.
    expect(usage.report(T0 + 3_600_000).projectedMonthPct).toBe(50);
    expect(meter().usage.report(T0 + 3_600_000).projectedMonthPct).toBeNull();
  });
});

describe("the Helius REST counter", () => {
  it("hands the inner fetch exactly what it was given, and its answer or its throw back unchanged", async () => {
    const { usage } = meter();
    const answer = new Response("x", { status: 418 });
    const seen: unknown[] = [];
    const counted = heliusRestFetch(usage, async (input, init) => {
      seen.push(input, init);
      return answer;
    });
    const init = { method: "POST", body: "{}" };
    expect(await counted("https://api.example.test/v0/webhooks", init)).toBe(answer);
    expect(seen).toEqual(["https://api.example.test/v0/webhooks", init]);

    const failure = new TypeError("fetch failed");
    const failing = heliusRestFetch(usage, async () => {
      throw failure;
    });
    await expect(failing("https://api.example.test/v0/webhooks", { method: "GET" })).rejects.toBe(failure);
  });
});

describe("the websocket confirmations", () => {
  it("returns what confirmTransaction returned, with the same arguments and `this`, and counts and times it", async () => {
    const answer = { context: { slot: 1 }, value: { err: null } };
    const calls: unknown[][] = [];
    const connection = {
      marker: "the connection",
      async confirmTransaction(this: { marker: string }, ...args: unknown[]) {
        calls.push([this.marker, ...args]);
        return answer;
      },
    };
    const started: number[] = [];
    const ended: number[] = [];
    let clock = 1_000;
    countConfirmations(connection as never, { started: () => started.push(clock), ended: (ms) => ended.push(ms) }, () => {
      clock += 250;
      return clock;
    });

    expect(await connection.confirmTransaction("sig", "confirmed")).toBe(answer);
    expect(calls).toEqual([["the connection", "sig", "confirmed"]]);
    expect(started).toHaveLength(1);
    expect(ended).toEqual([250]);
  });

  it("rethrows the very error confirmTransaction threw, and still times it", async () => {
    const failure = new Error("block height exceeded");
    const connection = {
      async confirmTransaction() {
        throw failure;
      },
    };
    const ended: number[] = [];
    countConfirmations(connection as never, { started: () => undefined, ended: (ms) => ended.push(ms) });
    await expect(connection.confirmTransaction()).rejects.toBe(failure);
    expect(ended).toHaveLength(1);
  });

  it("confirms exactly as before when the counting itself throws", async () => {
    const connection = {
      async confirmTransaction() {
        return "confirmed";
      },
    };
    countConfirmations(connection as never, {
      started: () => {
        throw new Error("meter broke");
      },
      ended: () => {
        throw new Error("meter broke");
      },
    });
    await expect(connection.confirmTransaction()).resolves.toBe("confirmed");
  });
});

describe("credit-burn", () => {
  /** A meter that has watched `hours` and spent `creditsPerHour` standard credits in each. */
  function burning(budgetPerDay: number | null, creditsPerHour: number, hours: number): ReturnType<RpcUsage["report"]> {
    const { usage } = meter({ budgetPerDay });
    for (let i = 0; i < creditsPerHour * hours; i++) usage.request(JSON.stringify({ method: "getSlot" }));
    return usage.report(T0 + hours * 3_600_000);
  }

  it("is OFF without a budget: nothing fires and nothing is cleared, whatever the burn", () => {
    expect(creditBurnAlert(burning(null, 10_000, 2))).toEqual({ fire: null, clear: false });
  });

  it("says nothing in the first hour after a boot, when the estimate is mostly the restart", () => {
    const report = burning(1_000, 1_000, 0.5);
    expect(report.observedMs).toBeLessThan(CREDIT_BURN_MIN_OBSERVED_MS);
    expect(creditBurnAlert(report)).toEqual({ fire: null, clear: false });
  });

  it("clears below 80 % of the budget, warns from 80 % and pages from 100 %, under one key", () => {
    // 100 credits an hour is 2,400 a day.
    expect(creditBurnAlert(burning(10_000, 100, 2))).toEqual({ fire: null, clear: true });
    const warn = creditBurnAlert(burning(3_000, 100, 2)).fire;
    expect(warn?.key).toBe(CREDIT_BURN_ALERT_KEY);
    expect(warn?.severity).toBe("warn");
    const page = creditBurnAlert(burning(2_400, 100, 2)).fire;
    expect(page?.key).toBe(CREDIT_BURN_ALERT_KEY);
    expect(page?.severity).toBe("critical");
  });

  /** A meter that has watched `hours` and made `archivalPerHour` archival calls in each, under `over`'s price. */
  function archivalBurning(over: Partial<RpcUsageOptions>, archivalPerHour: number, hours: number): ReturnType<RpcUsage["report"]> {
    const { usage } = meter(over);
    for (let i = 0; i < archivalPerHour * hours; i++) usage.request(JSON.stringify({ method: "getSignaturesForAddress" }));
    return usage.report(T0 + hours * 3_600_000);
  }

  it("compares the DEARER archival reading while the price is the unsettled default, and the configured one once set", () => {
    // 10 archival calls an hour: 240 credits a day at archival = 1, 2,400 at archival = 10.
    const unsettled = archivalBurning({ budgetPerDay: 1_000 }, 10, 2);
    expect(unsettled).toMatchObject({ archivalCreditsSource: "default", creditsPerDayEstimateP1: 240, creditsPerDayEstimateP2: 2_400 });
    expect(unsettled.creditsPerDayEstimate).toBe(240); // the /status headline stays at the default price
    const page = creditBurnAlert(unsettled).fire;
    expect(page).toMatchObject({ key: CREDIT_BURN_ALERT_KEY, severity: "critical" });
    expect(page?.detail).toContain("About 2400 credits a day against a budget of 1000 (240 %)");
    expect(page?.detail).toContain("compares the higher reading");

    // E1 ANSWERED 1, AND THE OWNER SAID SO: 24 % of the budget, cleared.
    const settled = archivalBurning({ budgetPerDay: 1_000, archivalCredits: 1, archivalCreditsSource: "env" }, 10, 2);
    expect(creditBurnAlert(settled)).toEqual({ fire: null, clear: true });
  });

  it("names both readings of the archival price and the levers, in its detail", () => {
    const detail = creditBurnAlert(burning(2_000, 100, 2)).fire?.detail ?? "";
    expect(detail).toContain("archival = 1");
    expect(detail).toContain("archival = 10");
    expect(detail).toContain("SIP_SOLANA_SWEEP_MS");
    expect(detail).toContain("doorbell");
  });
});
