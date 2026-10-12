// ZERO CHANGE WHEN OFF: the budget exists only for the dispatcher, and a keeper
// that does not pass one makes the same requests, in the same order, with no
// await added before any of them (PLAN §2 rule 2; the branch rule that every
// new thing is dark).
//
// THREE PROOFS, FROM THE NARROWEST UP.
//   1. No legacy caller CAN pass a budget: every poolFetch call outside the
//      pool itself hands it at most five arguments, and nothing under bin/
//      imports the budget, the quota follower or the governor.
//   2. Without a budget the pool calls fetch IN THE SAME TICK it is called —
//      before its caller's next line runs, as it did before the budget existed.
//      An await slipped in front of the request (a budget check that resolves
//      at once, say) is still a reordering hazard for concurrent callers, and
//      this is where it shows.
//   3. A whole dry sweep over the bench chain stub — the chain snapshot, the
//      listing, the vault batch, a settle turn and an invest turn per link, a
//      hot wallet's walk included — asks for exactly the same JSON-RPC requests
//      in exactly the same order through the bare transport, through the pool
//      without a budget, and through the pool WITH one, ample or tight: the
//      budget changes when a request leaves, never which or in what order.
//
// The out-of-suite twin is the dry-run harness against the bench stub over HTTP
// with bin/keeper.mts itself, base commit against this one, both roles; its
// result is in the commit message.

import * as anchor from "@coral-xyz/anchor";
import { Secret } from "@sip/solana-log";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readVaults } from "../src/accounts.js";
import { BenchChain } from "../src/bench/chain-stub.js";
import { benchKey, buildFleet } from "../src/bench/fleet.js";
import { readChainSnapshot } from "../src/chain-state.js";
import { discoverLinks } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { runInvestTick } from "../src/invest-tick.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";
import { RpcBudget } from "../src/rpc-budget.js";
import { poolFetch } from "../src/rpc-pool.js";
import type { CarryBook } from "../src/settle-decision.js";
import { runSettleTick } from "../src/settle-tick.js";

const KEEPER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const programId = new PublicKey(idl.address);
const crank = benchKey("crank");
const URL = "https://rpc.example.test/?api-key=NeverServed";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every `poolFetch(` call in a source, with how many arguments it passes (top-level commas, a trailing one ignored). */
function poolFetchCalls(source: string): number[] {
  const out: number[] = [];
  const pattern = /(?<![\w.])poolFetch\(/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (/function\s+$/.test(source.slice(Math.max(0, match.index - 20), match.index))) continue;
    let depth = 0;
    let args = 0;
    let sawToken = false;
    let lastSignificant = "";
    for (let i = match.index + "poolFetch(".length; i < source.length; i++) {
      const c = source[i]!;
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) {
          if (sawToken && lastSignificant !== ",") args += 1;
          break;
        }
        depth -= 1;
      } else if (c === "," && depth === 0) {
        args += 1;
        lastSignificant = ",";
        continue;
      }
      if (!/\s/.test(c)) {
        sawToken = true;
        lastSignificant = c;
      }
    }
    out.push(args);
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(resolve(KEEPER, dir))
    .filter((name) => /\.(ts|mts)$/.test(name))
    .map((name) => resolve(KEEPER, dir, name));
}

describe("no legacy caller can pass a budget", () => {
  it("hands poolFetch at most five arguments at every call outside the pool itself, and bin/keeper.mts exactly five", () => {
    const counted = poolFetchCalls("x(poolFetch(a, (m, f) => { g(m, f); }, undefined, (at) => { h = at; }, meter,\n));");
    expect(counted).toEqual([5]);
    expect(poolFetchCalls("poolFetch(urls)")).toEqual([1]);
    let calls = 0;
    for (const file of [...sources("bin"), ...sources("src")]) {
      if (file.endsWith("rpc-pool.ts")) continue;
      for (const args of poolFetchCalls(readFileSync(file, "utf8"))) {
        calls += 1;
        expect(args, file).toBeLessThanOrEqual(5);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(poolFetchCalls(readFileSync(resolve(KEEPER, "bin/keeper.mts"), "utf8"))).toEqual([5]);
  });

  it("imports none of the dispatcher's budget modules from any entry point production starts", () => {
    for (const file of sources("bin")) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/rpc-budget|rpc-quota|credit-governor/);
    }
  });
});

describe("without a budget the pool adds no await before a request", () => {
  it("calls fetch in the same tick it is called, and a budgeted pool — the contrast — does not", async () => {
    const answered = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", answered);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" });
    const plain = poolFetch([new Secret(URL, "rpcUrl:0")])("ignored", { body });
    expect(answered).toHaveBeenCalledTimes(1);
    await plain;
    const budgeted = poolFetch([new Secret(URL, "rpcUrl:0")], undefined, undefined, undefined, undefined, new RpcBudget({ ratePerSecond: 100, defaultLane: "hot" }))(
      "ignored",
      { body },
    );
    expect(answered).toHaveBeenCalledTimes(1);
    await budgeted;
    expect(answered).toHaveBeenCalledTimes(2);
  });
});

describe("a dry sweep over the bench chain asks for the same requests in the same order, with or without a budget", () => {
  const BOTH_MODES: readonly number[] = [MODE_PROFIT, MODE_VOLUME];

  /** The chain as a fetch: records each call's method and params, in order, and answers it. */
  function chainTransport(chain: BenchChain, log: string[]): typeof fetch {
    return (async (_input: unknown, init?: RequestInit): Promise<Response> => {
      const payload: unknown = JSON.parse(String(init?.body ?? "{}"));
      const answer = (one: unknown): unknown => {
        const call = one as { id?: unknown; method?: unknown; params?: unknown };
        const params = Array.isArray(call.params) ? call.params : [];
        log.push(`${String(call.method)} ${JSON.stringify(params)}`);
        const result = chain.handle(String(call.method), params);
        return result.error === undefined ? { jsonrpc: "2.0", id: call.id ?? null, result: result.result ?? null } : { jsonrpc: "2.0", id: call.id ?? null, error: result.error };
      };
      return new Response(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  }

  type Variant = "bare transport" | "pool, no budget" | "pool, ample budget" | "pool, tight budget";

  async function sweepLog(variant: Variant): Promise<{ readonly log: string[]; readonly budget: RpcBudget | undefined }> {
    const chain = new BenchChain({ programId, crank });
    chain.setFleet(buildFleet({ links: 4, hotRatio: 0.5, hotTxCount: 3, programId, seed: 7 }));
    const log: string[] = [];
    const transport = chainTransport(chain, log);
    let fetcher: typeof fetch;
    let budget: RpcBudget | undefined;
    if (variant === "bare transport") fetcher = transport;
    else {
      vi.stubGlobal("fetch", transport);
      if (variant === "pool, ample budget") budget = new RpcBudget({ ratePerSecond: 10_000, defaultLane: "hot" });
      if (variant === "pool, tight budget") {
        // FIVE A SECOND ON A VIRTUAL CLOCK: every wait is real to the budget and instant to the test.
        let now = 0;
        budget = new RpcBudget({
          ratePerSecond: 5,
          defaultLane: "hot",
          now: () => now,
          setTimer: (fn, ms) => {
            const handle = setImmediate(() => {
              now += ms;
              fn();
            });
            return () => clearImmediate(handle);
          },
        });
      }
      fetcher = poolFetch([new Secret(URL, "rpcUrl:0")], undefined, undefined, undefined, undefined, budget);
    }
    const connection = new Connection("http://127.0.0.1:1", { commitment: "confirmed", fetch: fetcher as never });
    const refuse = async (): Promise<never> => {
      throw new Error("the parity sweep signs nothing");
    };
    const program = new anchor.Program(
      idl as anchor.Idl,
      new anchor.AnchorProvider(connection, { publicKey: crank, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }),
    );
    for (let sweep = 0; sweep < 2; sweep++) {
      const snapshot = await readChainSnapshot(connection, program);
      const links = await discoverLinks(connection, programId, accountDiscriminator("TradingLink"));
      const vaults = await readVaults(program, links.map((link) => link.vault));
      for (const link of links) {
        await runSettleTick({
          settles: BOTH_MODES,
          connection,
          program,
          link,
          vault: vaults.get(link.vault.toBase58()) ?? null,
          attester: null,
          walletSigner: null,
          live: false,
          protocolPaused: false,
          carries: new Map() as CarryBook,
        });
        await runInvestTick({ connection, program, vault: link.vault, crank: null, crankLamports: snapshot.crankLamports, live: false, protocolPaused: false });
      }
    }
    return { log, budget };
  }

  it("matches the bare transport request for request, a hot wallet's walk included", async () => {
    const { log: bare } = await sweepLog("bare transport");
    expect(bare.length).toBeGreaterThan(40);
    expect(bare.some((call) => call.startsWith("getTransaction "))).toBe(true);
    for (const variant of ["pool, no budget", "pool, ample budget", "pool, tight budget"] as const) {
      const { log, budget } = await sweepLog(variant);
      expect(log, variant).toEqual(bare);
      if (variant === "pool, tight budget") {
        // THE TIGHT BUDGET REALLY HELD REQUESTS BACK — every one of them waited in order, none was reordered.
        expect(budget!.status().granted.hot).toBe(bare.length);
        expect(budget!.status().maxWaitMs.hot).toBeGreaterThanOrEqual(190);
      }
    }
  });
});
