// The endpoint pool WITH a budget (src/rpc-pool.ts, budgetedPoolFetch): every
// attempt waits for its tokens, a short Retry-After is waited out on the same
// endpoint, a 429 halves the rate, the lane reaches the transport through a
// real web3.js Connection, and a job's signal ends a request without blaming
// the endpoint.
//
// AND THE POOL WITHOUT ONE, beside it, answering the same 429 the way it always
// has — the dispatcher's behaviour must not leak into the legacy keepers'
// (test/rpc-budget-parity.test.ts holds the whole-sweep proof).

import { Secret } from "@sip/solana-log";
import { Connection, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcBudget, withRpcLane, type RpcLane } from "../src/rpc-budget.js";
import { endpointLabel, poolFetch } from "../src/rpc-pool.js";
import type { RpcMeter } from "../src/rpc-usage.js";
import { manualClock } from "./manual-clock.js";

const FIRST = "https://rpc.example.test/?api-key=FirstKeyNeverServed";
const SECOND = "https://rpc2.example.test/?api-key=SecondKeyNeverServed";
const urls = [new Secret(FIRST, "rpcUrl:0"), new Secret(SECOND, "rpcUrl:1")];
const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" });

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (): Response => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), { status: 200 });
const refused = (retryAfter?: string): Response =>
  new Response("Too Many Requests", { status: 429, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } });

/** A fetch that answers each URL from its own script, in order, and records every URL it was asked. */
function scripted(script: Record<string, (() => Response)[]>): { readonly asked: string[] } {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      const next = script[url]?.shift();
      if (next === undefined) throw new Error(`no scripted answer left for ${url === FIRST ? "FIRST" : "SECOND"}`);
      return next();
    }),
  );
  return { asked };
}

function recordingMeter(): RpcMeter & { readonly attempts: string[]; readonly requests: number[] } {
  const attempts: string[] = [];
  const requests: number[] = [];
  return {
    attempts,
    requests,
    request: () => requests.push(1),
    attempt: (at, result) => attempts.push(`${at} ${result}`),
  };
}

function pool(rate: number, defaultLane: RpcLane = "hot") {
  const clock = manualClock();
  const budget = new RpcBudget({ ratePerSecond: rate, defaultLane, now: clock.now, setTimer: clock.setTimer });
  const failovers: string[] = [];
  const answered: string[] = [];
  const meter = recordingMeter();
  const fetcher = poolFetch(urls, (_message, fields) => failovers.push(String(fields.at)), undefined, (at) => answered.push(at), meter, budget);
  return { clock, budget, failovers, answered, meter, fetcher };
}

describe("a 429 under a budget: Retry-After up to 2 s is waited out on the same endpoint, once", () => {
  it("retries the same endpoint after the wait, halves the rate, and sets nothing aside", async () => {
    const { asked } = scripted({ [FIRST]: [() => refused("1"), ok] });
    const { clock, budget, failovers, answered, meter, fetcher } = pool(10);
    const reply = fetcher("ignored", { body: BODY });
    await clock.advance(999);
    // STILL WAITING OUT THE SECOND IT WAS ASKED TO.
    expect(asked).toEqual([FIRST]);
    await clock.advance(5_000);
    await expect(reply).resolves.toBeInstanceOf(Response);
    expect(asked).toEqual([FIRST, FIRST]);
    expect(failovers).toEqual([]);
    expect(answered).toEqual([endpointLabel(0, 2)]);
    expect(meter.requests).toHaveLength(1);
    expect(meter.attempts).toEqual([`${endpointLabel(0, 2)} 429`, `${endpointLabel(0, 2)} 200`]);
    expect(budget.status()).toMatchObject({ retryAfterHonoured: 1, cuts: 1, http429: 1, ratePerSecond: 5 });
  });

  it("sets the endpoint aside exactly as without a budget when the wait is longer than 2 s", async () => {
    const { asked } = scripted({ [FIRST]: [() => refused("5")], [SECOND]: [ok] });
    const { clock, budget, failovers, answered, fetcher } = pool(10);
    const reply = fetcher("ignored", { body: BODY });
    await clock.advance(1_000);
    await expect(reply).resolves.toBeInstanceOf(Response);
    expect(asked).toEqual([FIRST, SECOND]);
    expect(failovers).toEqual([endpointLabel(0, 2)]);
    expect(answered).toEqual([endpointLabel(1, 2)]);
    expect(budget.status().retryAfterHonoured).toBe(0);
    expect(budget.status().cuts).toBe(1);
  });

  it("sets it aside when the 429 names no wait at all, or one it cannot read", async () => {
    for (const header of [undefined, "later", "2.5"]) {
      const { asked } = scripted({ [FIRST]: [() => refused(header)], [SECOND]: [ok] });
      const { clock, failovers, fetcher } = pool(10);
      const reply = fetcher("ignored", { body: BODY });
      await clock.advance(1_000);
      await expect(reply).resolves.toBeInstanceOf(Response);
      expect(asked).toEqual([FIRST, SECOND]);
      expect(failovers).toEqual([endpointLabel(0, 2)]);
    }
  });

  it("honours it once per endpoint: a second 429 there is a failover, not a loop", async () => {
    const { asked } = scripted({ [FIRST]: [() => refused("1"), () => refused("1")], [SECOND]: [ok] });
    const { clock, failovers, fetcher } = pool(10);
    const reply = fetcher("ignored", { body: BODY });
    await clock.advance(5_000);
    await expect(reply).resolves.toBeInstanceOf(Response);
    expect(asked).toEqual([FIRST, FIRST, SECOND]);
    expect(failovers).toEqual([endpointLabel(0, 2)]);
  });

  it("is the budget's alone: the pool without one sets the endpoint aside at once, as it always has", async () => {
    const { asked } = scripted({ [FIRST]: [() => refused("1")], [SECOND]: [ok] });
    const failovers: string[] = [];
    const fetcher = poolFetch(urls, (_message, fields) => failovers.push(String(fields.at)));
    await expect(fetcher("ignored", { body: BODY })).resolves.toBeInstanceOf(Response);
    expect(asked).toEqual([FIRST, SECOND]);
    expect(failovers).toEqual([endpointLabel(0, 2)]);
  });
});

describe("every attempt waits for its tokens", () => {
  it("spaces three requests at one a second over two seconds", async () => {
    const { asked } = scripted({ [FIRST]: [ok, ok, ok] });
    const { clock, fetcher } = pool(1);
    const replies = [1, 2, 3].map(() => fetcher("ignored", { body: BODY }));
    await clock.settle();
    expect(asked).toHaveLength(1);
    await clock.advance(1_000);
    expect(asked).toHaveLength(2);
    await clock.advance(1_000);
    expect(asked).toHaveLength(3);
    await Promise.all(replies);
  });

  it("takes tokens for a failover attempt too: it is another request a provider sees", async () => {
    scripted({ [FIRST]: [() => new Response("down", { status: 503 })], [SECOND]: [ok] });
    const { clock, budget, fetcher } = pool(10);
    const reply = fetcher("ignored", { body: BODY });
    await clock.advance(1_000);
    await reply;
    expect(budget.status().granted.hot).toBe(2);
  });
});

describe("the lane, from the job to the transport", () => {
  it("reaches the pool through a real web3.js Connection: the lane the caller set is the lane the request waited in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const call = JSON.parse(String(init?.body)) as { id: unknown; method: string };
        const result = call.method === "sendTransaction" ? "5".repeat(64) : 42;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }), { status: 200 });
      }),
    );
    const { budget, fetcher } = pool(100, "hot");
    const connection = new Connection(FIRST, { commitment: "confirmed", fetch: fetcher });
    await withRpcLane("rest", () => connection.getSlot());
    await withRpcLane("send", () => connection.getLatestBlockhash().catch(() => null));
    await connection.getBalance(new PublicKey("11111111111111111111111111111111")).catch(() => null);
    // UNTAGGED, AND STILL A SEND: sendTransaction always waits in `send`.
    await connection.sendRawTransaction(Buffer.alloc(64, 1), { skipPreflight: true }).catch(() => null);
    expect(budget.status().granted).toEqual({ send: 2, hot: 1, rest: 1, sched: 0 });
  });
});

describe("a job's signal", () => {
  it("ends a request still waiting for tokens, sends nothing, and sets no endpoint aside", async () => {
    const { asked } = scripted({ [FIRST]: [ok, ok] });
    const { clock, failovers, fetcher } = pool(1);
    await fetcher("ignored", { body: BODY });
    const job = new AbortController();
    const waiting = withRpcLane("hot", () => fetcher("ignored", { body: BODY }), job.signal);
    await clock.settle();
    job.abort(new Error("job ceiling reached"));
    await expect(waiting).rejects.toThrow("job ceiling reached");
    expect(asked).toEqual([FIRST]);
    expect(failovers).toEqual([]);
  });

  it("ends a request in flight with its own reason, and the endpoint is still the first one asked next time", async () => {
    const asked: string[] = [];
    let release: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        asked.push(url);
        if (asked.length === 1) {
          return await new Promise<Response>((_, fail) => {
            init?.signal?.addEventListener("abort", () => fail(init.signal!.reason));
            release = () => fail(new Error("unreachable"));
          });
        }
        return ok();
      }),
    );
    const { clock, failovers, fetcher } = pool(10);
    const job = new AbortController();
    const inFlight = withRpcLane("hot", () => fetcher("ignored", { body: BODY }), job.signal);
    await clock.settle();
    expect(asked).toEqual([FIRST]);
    job.abort(new Error("job ceiling reached"));
    await expect(inFlight).rejects.toThrow("job ceiling reached");
    expect(failovers).toEqual([]);
    await fetcher("ignored", { body: BODY });
    expect(asked).toEqual([FIRST, FIRST]);
    expect(release).not.toBeNull();
  });
});
