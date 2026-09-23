// The ceiling bench's stubbed chain, driven by the keeper's OWN readers and
// ticks — not by a reimplementation of them.
//
// THIS IS THE FILE THAT MAKES THE BENCH HONEST. scripts/ceiling-bench.mts boots
// bin/keeper.mts against this stub over HTTP; what it measures is worth nothing
// unless the stub answers the shapes the real readers decode and the real ticks
// take the real branches over them. So every assertion below runs
// src/discovery.ts, src/accounts.ts, src/settle-tick.ts and src/invest-tick.ts
// against the stub through a real @solana/web3.js Connection whose transport is
// the stub — the same path the bench's HTTP server serves, one hop shorter.
//
// AND IT PINS THE MEASURED FACT THE WHOLE EXERCISE STARTED FROM: an IDLE user
// costs SIX round trips per sweep and not one. The cheap probe answers IDLE and
// the settle turn stops — and then runInvestTick runs UNCONDITIONALLY and reads
// the policy, the vault-and-clock-and-two-oracles batch, the rent floor and the
// two token accounts. If that ever becomes five, or eleven, the ceiling moves
// and this test is where it is noticed.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { readInvestmentPolicy, readVaults } from "../src/accounts.js";
import { BenchChain, WRITE_PATH_REFUSAL } from "../src/bench/chain-stub.js";
import { benchKey, buildFleet, buildHistory } from "../src/bench/fleet.js";
import { discoverLinks } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { USDC_MINT } from "../src/invest-decision.js";
import { runInvestTick } from "../src/invest-tick.js";
import type { CarryBook } from "../src/settle-decision.js";
import { runSettleTick } from "../src/settle-tick.js";

const programId = new PublicKey(idl.address);
const crank = benchKey("crank");

interface RpcCall {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/**
 * A real Connection whose transport is the stub.
 *
 * OVER THE WIRE FORMAT, DELIBERATELY. The stub answers JSON-RPC, and web3.js
 * validates every reply against its own structs before the keeper sees a byte
 * of it: a `data` field that is not [base64, "base64"], a signature page missing
 * `err`, a transaction whose `version` it does not know — each of those throws
 * inside Connection. Handing the ticks a hand-built object instead would skip
 * the only check that the bench's chain is shaped like the real one.
 */
function stubConnection(chain: BenchChain): Connection {
  const fetch = async (_input: unknown, init?: { readonly body?: unknown }): Promise<Response> => {
    const payload: unknown = JSON.parse(String(init?.body ?? "{}"));
    const answer = (call: RpcCall): unknown => {
      const result = chain.handle(String(call.method), Array.isArray(call.params) ? call.params : []);
      return result.error === undefined
        ? { jsonrpc: "2.0", id: call.id ?? null, result: result.result ?? null }
        : { jsonrpc: "2.0", id: call.id ?? null, error: result.error };
    };
    const body = Array.isArray(payload) ? payload.map((one) => answer(one as RpcCall)) : answer(payload as RpcCall);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return new Connection("http://127.0.0.1:1", { commitment: "confirmed", fetch: fetch as never });
}

function stubProgram(connection: Connection): anchor.Program {
  const refuse = async (): Promise<never> => {
    throw new Error("the ceiling bench signs nothing");
  };
  const wallet = { publicKey: crank, signTransaction: refuse, signAllTransactions: refuse };
  return new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));
}

function chainWith(links: number, hotRatio: number, hotTxCount = 8): { chain: BenchChain; connection: Connection; program: anchor.Program } {
  const chain = new BenchChain({ programId, crank });
  chain.setFleet(buildFleet({ links, hotRatio, hotTxCount, programId, seed: 1 }));
  const connection = stubConnection(chain);
  return { chain, connection, program: stubProgram(connection) };
}

describe("the fleet the ceiling bench serves is one the keeper's own readers decode", () => {
  it("is discovered by src/discovery.ts, wallet and vault and frontier intact", async () => {
    const { chain, connection } = chainWith(3, 0);
    const links = await discoverLinks(connection, programId, accountDiscriminator("TradingLink"));
    expect(links).toHaveLength(3);
    expect(new Set(links.map((link) => link.wallet.toBase58())).size).toBe(3);
    expect(links.every((link) => link.frontierSlot === 400_000_000n)).toBe(true);
    expect(chain.callsThisSweep).toBe(1);
  });

  it("decodes through the batched vault read and the policy reader, not only through a JSON shape", async () => {
    const { connection, program } = chainWith(2, 0);
    const links = await discoverLinks(connection, programId, accountDiscriminator("TradingLink"));
    const vaults = await readVaults(program, links.map((link) => link.vault));
    expect(vaults.size).toBe(2);
    for (const vault of vaults.values()) {
      expect(vault).not.toBeNull();
      // PROFIT, because this keeper cannot measure a VOLUME notional yet.
      expect(vault!.skimMode).toBe(0);
      expect(vault!.skimBps).toBe(2_000);
    }
    const policy = await readInvestmentPolicy(program, links[0]!.vault);
    expect(policy).not.toBeNull();
    expect(policy!.enabled).toBe(true);
    expect(policy!.inMint.equals(USDC_MINT)).toBe(true);
    expect(policy!.bucketAmounts).toHaveLength(31);
  });
});

describe("what a user costs the sweep, measured against the real ticks", () => {
  it("charges an IDLE user SIX round trips and not one — the probe, then the whole invest turn", async () => {
    const { chain, connection, program } = chainWith(1, 0);
    const links = await discoverLinks(connection, programId, accountDiscriminator("TradingLink"));
    const vaults = await readVaults(program, links.map((link) => link.vault));
    chain.takeCalls();

    const settle = await runSettleTick({
      connection,
      program,
      link: links[0]!,
      vault: vaults.get(links[0]!.vault.toBase58()) ?? null,
      attester: null,
      walletSigner: null,
      live: false,
      protocolPaused: false,
      carries: new Map() as CarryBook,
    });
    expect(settle.outcome).toBe("IDLE");
    // ONE. The cheap probe (getSignaturesForAddress, limit 1) and nothing else.
    expect(chain.callsThisSweep).toBe(1);

    const invest = await runInvestTick({
      connection,
      program,
      vault: links[0]!.vault,
      crank: null,
      crankLamports: 5_000_000_000n,
      live: false,
      protocolPaused: false,
    });
    expect(invest.outcome).toBe("IDLE");
    // AND FIVE MORE, unconditionally, for a user who did nothing: the policy,
    // the vault-and-clock-and-two-oracles batch, the rent floor, and one read
    // per token account. Six is the number the ceiling divides by.
    const calls = chain.takeCalls();
    expect([...calls].sort()).toEqual([
      ["getAccountInfo", 1],
      ["getMinimumBalanceForRentExemption", 1],
      ["getMultipleAccounts", 1],
      ["getSignaturesForAddress", 1],
      ["getTokenAccountBalance", 2],
    ]);
  });

  it("walks a HOT user's window one getTransaction per transaction, and reaches a dry-run settle", async () => {
    const hotTxCount = 8;
    const { chain, connection, program } = chainWith(1, 1, hotTxCount);
    const links = await discoverLinks(connection, programId, accountDiscriminator("TradingLink"));
    const vaults = await readVaults(program, links.map((link) => link.vault));
    chain.takeCalls();

    const settle = await runSettleTick({
      connection,
      program,
      link: links[0]!,
      vault: vaults.get(links[0]!.vault.toBase58()) ?? null,
      attester: null,
      walletSigner: null,
      live: false,
      protocolPaused: false,
      carries: new Map() as CarryBook,
    });
    expect(settle.outcome).toBe("SETTLED");
    expect(settle.detail).toMatch(/^DRY RUN/);
    const calls = chain.takeCalls();
    // THE SHAPE OF THE EXPENSIVE LANE: one getTransaction for the anchor and one
    // for every transaction in the window, SEQUENTIALLY. This is the cost that
    // makes one busy wallet hold a whole sweep — at MAX_SIGNATURES = 300 and
    // 51.6 ms a call it is 15.5 seconds for one user.
    expect(calls.get("getTransaction")).toBe(hotTxCount + 1);
    // And the rest of a settling turn, which an idle one never pays for.
    expect(calls.get("getLatestBlockhash")).toBe(1);
    expect(calls.get("getFeeForMessage")).toBe(1);
    expect(calls.get("getBalance")).toBe(1);
    expect(chain.callsThisSweep).toBe(0);
  });

  it("makes a hot user cost strictly more round trips than an idle one, which is why the ratio is a parameter", async () => {
    const cost = async (hotRatio: number): Promise<number> => {
      const { chain, connection, program } = chainWith(1, hotRatio, 8);
      const links = await discoverLinks(connection, programId, accountDiscriminator("TradingLink"));
      const vaults = await readVaults(program, links.map((link) => link.vault));
      chain.takeCalls();
      await runSettleTick({
        connection,
        program,
        link: links[0]!,
        vault: vaults.get(links[0]!.vault.toBase58()) ?? null,
        attester: null,
        walletSigner: null,
        live: false,
        protocolPaused: false,
        carries: new Map() as CarryBook,
      });
      return chain.callsThisSweep;
    };
    expect(await cost(1)).toBeGreaterThan(await cost(0));
  });
});

describe("a fleet is exactly as hot as it was asked to be", () => {
  it("rounds the ratio to a whole number of links and keeps the rest idle", () => {
    const fleet = buildFleet({ links: 200, hotRatio: 0.02, hotTxCount: 12, programId, seed: 1 });
    expect(fleet.filter((link) => link.txAbove > 0)).toHaveLength(4);
    expect(fleet.filter((link) => link.txAbove === 0)).toHaveLength(196);
  });

  it("is the same fleet for the same seed, so two runs of a grid compare", () => {
    const shape = { links: 5, hotRatio: 0.4, hotTxCount: 3, programId, seed: 9 } as const;
    expect(buildFleet(shape).map((link) => link.wallet.toBase58())).toEqual(buildFleet(shape).map((link) => link.wallet.toBase58()));
    expect(buildFleet(shape).map((link) => link.wallet.toBase58())).not.toEqual(
      buildFleet({ ...shape, seed: 10 }).map((link) => link.wallet.toBase58()),
    );
  });

  it("gives a hot wallet an unbroken, profitable balance chain — a broken one would time a sweep of refusals", () => {
    const [link] = buildFleet({ links: 1, hotRatio: 1, hotTxCount: 5, programId, seed: 1 });
    const history = buildHistory(link!);
    expect(history).toHaveLength(6); // the anchor, then five above the frontier
    expect(history[0]!.slot).toBeLessThanOrEqual(link!.frontierSlot);
    expect(history.slice(1).every((tx) => tx.slot > link!.frontierSlot)).toBe(true);
    for (let i = 1; i < history.length; i++) expect(history[i]!.pre).toBe(history[i - 1]!.post);
    expect(history[history.length - 1]!.post).toBeGreaterThan(history[0]!.pre);
  });

  it("refuses a hot ratio that is not a fraction of the fleet", () => {
    expect(() => buildFleet({ links: 1, hotRatio: 1.5, hotTxCount: 1, programId, seed: 1 })).toThrow(/hotRatio/);
    expect(() => buildFleet({ links: -1, hotRatio: 0, hotTxCount: 1, programId, seed: 1 })).toThrow(/whole number of links/);
  });
});

describe("the write path is refused, never faked", () => {
  it("answers sendTransaction with an error that SAYS the bench does not measure writes", () => {
    const chain = new BenchChain({ programId, crank });
    const sent = chain.handle("sendTransaction", ["deadbeef", {}]);
    expect(sent.result).toBeUndefined();
    expect(sent.error?.message).toBe(WRITE_PATH_REFUSAL);
    expect(chain.handle("simulateTransaction", []).error?.message).toBe(WRITE_PATH_REFUSAL);
    expect(chain.handle("getSignatureStatuses", []).error?.message).toBe(WRITE_PATH_REFUSAL);
    // A fabricated signature here would let a bench report a sweep that
    // "settled" and put the write path's cost into a number that never paid it.
    expect(chain.unmodelled.size).toBe(0);
  });

  it("records a method it has no answer for instead of inventing a plausible one", () => {
    const chain = new BenchChain({ programId, crank });
    const answer = chain.handle("getBlockProduction", []);
    expect(answer.result).toBeUndefined();
    expect(answer.error?.code).toBe(-32601);
    expect([...chain.unmodelled]).toEqual(["getBlockProduction"]);
  });

});
