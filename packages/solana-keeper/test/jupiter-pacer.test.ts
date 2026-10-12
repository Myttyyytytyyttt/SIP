// The jupiter-key cut's pieces on their own (src/jupiter-pacer.ts): what a
// buying turn reserves, when it is deferred, how its calls are spaced, what a
// 429 does to the turns after it, and the settings that switch it on.
//
// THE CLOCK IS THE TEST'S. The pacer takes `now` and `sleep`, so a minute of
// spacing runs in microseconds and every instant asserted below is exact. The
// whole-turn proofs — the measured unpaced replay that met its 429 on call 6,
// deferred instead of failed — are in test/accounts.test.ts, under "the
// jupiter-key cut", where a real invest turn runs over stubbed chain bytes.

import { Redactor } from "@sip/solana-log";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../src/config.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import {
  JUPITER_BACKOFF_BASE_MS,
  JUPITER_BACKOFF_MAX_MS,
  JUPITER_CALLS_PER_LEG_MEASUREMENT,
  JUPITER_FREE_KEY_CALLS_PER_MINUTE,
  JupiterBackoffError,
  JupiterPacer,
  buyingTurnJupiterCalls,
  jupiterApiForTurn,
  minGapMsFor,
  readJupiterKeySettings,
  type JupiterReservation,
} from "../src/jupiter-pacer.js";
import { KEYED_API, LITE_API } from "../src/program-scripts.js";
import { JUPITER_KEYLESS_CALLS_PER_MINUTE, createJupiterCallCounter } from "../src/sweep-cost.js";
import { Secret } from "@sip/solana-log";

/** A pacer on a clock the test owns: `sleep` advances it, and nothing waits for real. */
function clocked(perMinute: number, start = 1_000_000) {
  let now = start;
  const pacer = new JupiterPacer({
    perMinute,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { pacer, at: () => now, advance: (ms: number) => (now += ms) };
}

const granted = (answer: ReturnType<JupiterPacer["reserve"]>): JupiterReservation => {
  if (!answer.granted) throw new Error(`expected a reservation, got ${answer.reason}: ${answer.detail}`);
  return answer.reservation;
};

const headers = (values: Record<string, string> = {}) => ({ get: (name: string) => values[name] ?? null });

describe("what one buying turn reserves", () => {
  it("is 6(L+1) with the convert and 6L without: 18 for the owner's two-leg basket, as measured", () => {
    // MEASURED 18 for L = 2 with the convert (jupiter-turn-run3, run4): two
    // measurements per leg and per convert, three calls each.
    expect(JUPITER_CALLS_PER_LEG_MEASUREMENT).toBe(3);
    expect(buyingTurnJupiterCalls(2, true)).toBe(18);
    expect(buyingTurnJupiterCalls(2, false)).toBe(12);
    expect(buyingTurnJupiterCalls(1, true)).toBe(12);
    expect(buyingTurnJupiterCalls(8, true)).toBe(54);
  });

  it("spaces calls at the plan's rate: two seconds keyless, one with a free key", () => {
    expect(minGapMsFor(JUPITER_KEYLESS_CALLS_PER_MINUTE)).toBe(2_000);
    expect(minGapMsFor(JUPITER_FREE_KEY_CALLS_PER_MINUTE)).toBe(1_000);
    expect(minGapMsFor(600)).toBe(100);
    expect(minGapMsFor(7)).toBe(8_572);
  });
});

describe("the reservation", () => {
  it("is granted only when the WHOLE turn fits the minute, and a second turn that does not fit is deferred before it starts", () => {
    const { pacer } = clocked(30);
    const first = granted(pacer.reserve(18));
    expect(first.remaining).toBe(18);
    // 18 reserved + 18 asked > 30: deferred, and it says nothing moved.
    const second = pacer.reserve(18);
    expect(second.granted).toBe(false);
    if (second.granted) return;
    expect(second.reason).toBe("budget");
    expect(second.detail).toContain("nothing was quoted, wrapped or sent");
    expect(second.detail).toContain("needs 18 calls and 18 of this keeper's 30 a minute");
    // RESERVED, NOT YET SPENT: when only reservations stand in the way the honest bound is a minute.
    expect(second.retryInMs).toBe(60_000);
    expect(pacer.status().deferred).toEqual({ budget: 1, backoff: 0, neverFits: 0 });
  });

  it("counts calls already made in the sliding minute, and says when enough of them leave it", async () => {
    const { pacer, advance } = clocked(30);
    const turn = granted(pacer.reserve(18));
    for (let i = 0; i < 18; i++) await turn.beforeCall();
    turn.release();
    // 18 calls spaced 2 s apart: the first left at t0, the last at t0+34 s.
    advance(1_000);
    const again = pacer.reserve(18);
    expect(again.granted).toBe(false);
    if (again.granted) return;
    // 18 + 18 - 30 = 6 must leave; the 6th call left at t0+10 s, so it frees at t0+70 s, i.e. 35 s from t0+35 s.
    expect(again.retryInMs).toBe(35_000);
    advance(34_999);
    expect(pacer.reserve(18).granted).toBe(false);
    advance(1);
    expect(pacer.reserve(18).granted).toBe(true);
  });

  it("hands back what a turn did not spend, so the next turn is granted it", async () => {
    const { pacer } = clocked(30);
    const turn = granted(pacer.reserve(18));
    for (let i = 0; i < 9; i++) await turn.beforeCall();
    expect(pacer.status().reservedOutstanding).toBe(9);
    turn.release();
    expect(pacer.status().reservedOutstanding).toBe(0);
    // 9 spent in the window: 9 + 18 <= 30.
    expect(pacer.reserve(18).granted).toBe(true);
    // Released twice is still released once.
    turn.release();
    expect(pacer.status().reservedOutstanding).toBe(18);
  });

  it("refuses a basket the plan's whole minute can never cover, instead of deferring it every sweep forever", () => {
    const { pacer } = clocked(30);
    const answer = pacer.reserve(buyingTurnJupiterCalls(5, true));
    expect(answer.granted).toBe(false);
    if (answer.granted) return;
    expect(answer.reason).toBe("never-fits");
    expect(answer.retryInMs).toBeNull();
    expect(answer.detail).toContain("can never be bought at this budget");
    expect(answer.detail).toContain("SIP_SOLANA_JUPITER_CALLS_PER_MINUTE");
  });

  it("refuses a call after release, which would spend calls nobody reserved", async () => {
    const { pacer } = clocked(30);
    const turn = granted(pacer.reserve(3));
    turn.release();
    await expect(turn.beforeCall()).rejects.toThrow(/released Jupiter reservation/);
  });

  it("counts a call past the reservation as overdrawn rather than refusing it mid-basket", async () => {
    const { pacer } = clocked(30);
    const turn = granted(pacer.reserve(1));
    await turn.beforeCall();
    await turn.beforeCall();
    expect(pacer.status()).toMatchObject({ calls: 2, overdrawn: 1, reservedOutstanding: 0 });
  });
});

describe("the spacing", () => {
  it("never lets two calls leave closer than the plan's gap — the keyless gateway refuses the sixth in ten seconds", async () => {
    const { pacer, at } = clocked(30);
    const turn = granted(pacer.reserve(18));
    const times: number[] = [];
    for (let i = 0; i < 18; i++) {
      await turn.beforeCall();
      times.push(at());
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(Math.min(...gaps)).toBe(2_000);
    // THE MEASURED SHAPE (api-keyless-probe.log): five per ten seconds. Spaced,
    // no ten-second window ever holds a sixth.
    for (const t of times) expect(times.filter((u) => u > t - 10_000 && u <= t).length).toBeLessThanOrEqual(5);
    // The run3 measurement took 36 s paced at 2.1 s; this pacer's 18 calls span 34 s.
    expect(times[17]! - times[0]!).toBe(34_000);
  });
});

describe("after a 429", () => {
  it("defers new buying turns for a minute, never less than Jupiter's own reset, and sends nothing while backed off", async () => {
    const { pacer, at, advance } = clocked(60);
    const turn = granted(pacer.reserve(12));
    await turn.beforeCall();
    // Jupiter's reset says 90 s from now: longer than the base step, so it wins.
    turn.observe(429, headers({ "x-ratelimit-reset": String(Math.floor((at() + 90_000) / 1_000)) }));
    // THE SAME TURN'S NEXT CALL IS NOT SENT: it throws before any fetch.
    await expect(turn.beforeCall()).rejects.toBeInstanceOf(JupiterBackoffError);
    turn.release();
    const deferred = pacer.reserve(12);
    expect(deferred.granted).toBe(false);
    if (deferred.granted) return;
    expect(deferred.reason).toBe("backoff");
    expect(deferred.detail).toContain("429 Too Many Requests");
    expect(deferred.retryInMs).toBe(90_000);
    expect(pacer.status().http429).toBe(1);
    advance(90_000);
    expect(pacer.reserve(12).granted).toBe(true);
  });

  it("doubles the step on each further 429 up to ten minutes, and resets it after a clean turn", async () => {
    const { pacer, advance } = clocked(60);
    const steps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const turn = granted(pacer.reserve(3));
      await turn.beforeCall();
      turn.observe(429, headers());
      turn.release();
      const deferred = pacer.reserve(3);
      if (deferred.granted) throw new Error("expected a backoff");
      steps.push(deferred.retryInMs!);
      advance(deferred.retryInMs!);
    }
    expect(steps).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000].map((ms) => Math.min(ms, JUPITER_BACKOFF_MAX_MS)));
    // A turn that met no 429 resets the step.
    const clean = granted(pacer.reserve(3));
    await clean.beforeCall();
    clean.release();
    expect(pacer.status().backoffMs).toBe(JUPITER_BACKOFF_BASE_MS);
  });

  it("does not believe a reset absurdly far ahead, and ignores every status but 429", async () => {
    const { pacer, at } = clocked(60);
    const turn = granted(pacer.reserve(3));
    await turn.beforeCall();
    turn.observe(500, headers({ "x-ratelimit-reset": String(Math.floor(at() / 1_000) + 99_999) }));
    expect(pacer.status().http429).toBe(0);
    turn.observe(429, headers({ "x-ratelimit-reset": String(Math.floor(at() / 1_000) + 99_999) }));
    turn.release();
    const deferred = pacer.reserve(3);
    expect(!deferred.granted && deferred.retryInMs).toBe(JUPITER_BACKOFF_BASE_MS);
  });
});

describe("the per-turn API", () => {
  const ok = () => new Response("{}", { status: 200 });

  it("goes to api.jup.ag with the key in an x-api-key header — never in the URL — and paces every request", async () => {
    const seen: { url: string; key: string | null; contentType: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      seen.push({ url, key: h.get("x-api-key"), contentType: h.get("content-type") });
      return ok();
    });
    try {
      const { pacer } = clocked(60);
      const turn = granted(pacer.reserve(2));
      const key = new Secret("test-jupiter-key-0001", "jupiterApiKey");
      const api = jupiterApiForTurn({ baseUrl: KEYED_API, apiKey: key, pacer }, turn);
      expect(api.baseUrl).toBe("https://api.jup.ag/swap/v1");
      const callerInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
      await api.fetch!(`${api.baseUrl}/swap-instructions`, callerInit);
      await api.fetch!(`${api.baseUrl}/quote?x=1`, {});
      expect(seen).toEqual([
        { url: "https://api.jup.ag/swap/v1/swap-instructions", key: "test-jupiter-key-0001", contentType: "application/json" },
        { url: "https://api.jup.ag/swap/v1/quote?x=1", key: "test-jupiter-key-0001", contentType: null },
      ]);
      // THE CALLER'S OBJECT IS NOT WRITTEN: the key went on a copy.
      expect(callerInit.headers).toEqual({ "Content-Type": "application/json" });
      expect(pacer.status().calls).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps today's host and adds no header at all without a key", async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      inits.push(init);
      return ok();
    });
    try {
      const { pacer } = clocked(30);
      const turn = granted(pacer.reserve(1));
      const api = jupiterApiForTurn({ baseUrl: LITE_API, apiKey: null, pacer }, turn);
      expect(api.baseUrl).toBe("https://lite-api.jup.ag/swap/v1");
      const init = { signal: AbortSignal.timeout(1_000) };
      await api.fetch!(`${api.baseUrl}/quote`, init);
      expect(inits[0]).toBe(init);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a 429 it received to the pacer", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429, headers: { "x-ratelimit-reset": "0" } }));
    try {
      const { pacer } = clocked(30);
      const turn = granted(pacer.reserve(2));
      const api = jupiterApiForTurn({ baseUrl: KEYED_API, apiKey: null, pacer }, turn);
      expect((await api.fetch!(`${api.baseUrl}/quote`, {})).status).toBe(429);
      expect(pacer.status().http429).toBe(1);
      await expect(api.fetch!(`${api.baseUrl}/quote`, {})).rejects.toBeInstanceOf(JupiterBackoffError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the settings", () => {
  const dry = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    SIP_SOLANA_RPC_URLS: "https://rpc.example.test/",
    SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
    ...over,
  });
  const refusal = (env: NodeJS.ProcessEnv): string => {
    try {
      loadConfig(env, new Redactor());
    } catch (error) {
      if (error instanceof ConfigError) return error.message;
      throw error;
    }
    throw new Error("expected a ConfigError");
  };
  const KEY = "jup-test-key-1a2b3c4d5e6f";

  it("are unused, and only warned about, without the token — so removing the token is still the whole rollback", () => {
    const config = loadConfig(dry({ SIP_SOLANA_JUPITER_API_KEY: KEY, SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: "600" }), new Redactor());
    expect(config.jupiterApiKey).toBeNull();
    expect(config.jupiterCallsPerMinute).toBe(30);
    expect(config.warnings.join(" ")).toContain("SIP_SOLANA_CUTS does not name jupiter-key");
    expect(config.warnings.join(" ")).not.toMatch(/not a variable this keeper reads/);
    // AND THE DESCRIPTION IS TODAY'S: no jupiter block at all.
    expect(describeConfig(config)).not.toHaveProperty("jupiter");
  });

  it("default to the free key's 60 with a key and the keyless 30 without, and take the plan's number when given", () => {
    expect(readJupiterKeySettings({}, true)).toMatchObject({ apiKey: null, callsPerMinute: 30, callsPerMinuteSource: "default" });
    expect(readJupiterKeySettings({ SIP_SOLANA_JUPITER_API_KEY: KEY }, true)).toMatchObject({ apiKey: KEY, callsPerMinute: 60 });
    expect(readJupiterKeySettings({ SIP_SOLANA_JUPITER_API_KEY: KEY, SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: " 600 " }, true)).toMatchObject({
      callsPerMinute: 600,
      callsPerMinuteSource: "env",
    });
    const config = loadConfig(dry({ SIP_SOLANA_CUTS: "jupiter-key", SIP_SOLANA_JUPITER_API_KEY: KEY }), new Redactor());
    expect(config.jupiterApiKey?.reveal()).toBe(KEY);
    expect(describeConfig(config)).toMatchObject({ cuts: ["jupiter-key"], jupiter: { keyed: true, callsPerMinute: 60, callsPerMinuteSource: "default" } });
  });

  it("REFUSE TO START under the token on a malformed key or budget, naming the shape and never the value", () => {
    const badKey = "has a space in it";
    const message = refusal(dry({ SIP_SOLANA_CUTS: "jupiter-key", SIP_SOLANA_JUPITER_API_KEY: badKey }));
    expect(message).toContain("SIP_SOLANA_JUPITER_API_KEY must be 8 to 256 printable characters");
    expect(message).not.toContain("space in");
    for (const bad of ["0", "-5", "1.5", "60/min", "9001"]) {
      expect(refusal(dry({ SIP_SOLANA_CUTS: "jupiter-key", SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: bad })), bad).toContain(
        "SIP_SOLANA_JUPITER_CALLS_PER_MINUTE must be a whole number of calls from 1 to 9000",
      );
    }
  });

  it("never let the key reach a description, a warning or a refusal", () => {
    const redactor = new Redactor();
    const config = loadConfig(dry({ SIP_SOLANA_CUTS: "jupiter-key", SIP_SOLANA_JUPITER_API_KEY: KEY }), redactor);
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(JSON.stringify(describeConfig(config))).not.toContain(KEY);
    expect(String(config.jupiterApiKey)).not.toContain(KEY);
    // REGISTERED: anything that does print it later is scrubbed.
    expect(redactor.scrub(`header x-api-key: ${KEY}`)).not.toContain(KEY);
    // And a refusal raised beside it does not quote it either.
    expect(refusal(dry({ SIP_SOLANA_CUTS: "jupiter-key", SIP_SOLANA_JUPITER_API_KEY: KEY, SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: KEY }))).not.toContain(KEY);
  });
});

describe("/status's per-minute view", () => {
  it("is judged against the keyless 30 until the cut sets the plan's budget", () => {
    let now = 0;
    const counter = createJupiterCallCounter({ startedAt: 0, now: () => now });
    counter.count(18);
    now = 1_000;
    expect(counter.report(now)).toMatchObject({ budgetPerMinute: 30, peakPctOfBudget: 60 });
    counter.setBudgetPerMinute(60);
    expect(counter.report(now)).toMatchObject({ budgetPerMinute: 60, peakPctOfBudget: 30 });
    counter.setBudgetPerMinute(0);
    expect(counter.report(now).budgetPerMinute).toBe(60);
  });
});
