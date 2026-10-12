// The invest-batch cut's batch read and its rules (src/invest-snapshot.ts),
// over the ceiling bench's chain stub through a real @solana/web3.js
// Connection — the same bytes and the same wire the bench boots the keeper
// against, so web3.js validates every answer before the reader sees it.
//
// The whole-turn proofs — the snapshot decides exactly what fresh reads decide
// and sends nothing, an acting turn re-reads fresh and sends the same bytes, a
// manual deposit is still bought — are in test/accounts.test.ts under "the
// invest-batch cut". The census, 19 → 7 calls a sweep on today's fleet, is in
// test/bench-chain-stub.test.ts.

import * as anchor from "@coral-xyz/anchor";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_EPOCH_SCHEDULE_PUBKEY, type AccountInfo } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeInvestmentPolicy, investmentPolicyAddress, readInvestmentPolicy, readVaults } from "../src/accounts.js";
import { BenchChain } from "../src/bench/chain-stub.js";
import { benchKey, buildFleet, rentExempt } from "../src/bench/fleet.js";
import { idl } from "../src/idl.js";
import { USDC_MINT } from "../src/invest-decision.js";
import {
  SWEEP_STATE_CHUNK,
  cachedRentFloor,
  investLeavesSnapshotTrue,
  readSweepState,
  settleLeavesSnapshotTrue,
  tokenAmountOf,
} from "../src/invest-snapshot.js";
import type { InvestOutcome } from "../src/invest-tick.js";
import { PYTH_SOL_USD_FEED, PYTH_USDC_USD_FEED } from "../src/pyth.js";
import type { SettleOutcome } from "../src/settle-decision.js";

const programId = new PublicKey(idl.address);
const crank = benchKey("crank");

interface Account {
  data: Buffer;
  owner: PublicKey;
  lamports: number;
  executable: boolean;
}

/** The stub, a Connection over it, every getMultipleAccounts request it served, and its account map. */
function bench(links: number) {
  const chain = new BenchChain({ programId, crank });
  const fleet = buildFleet({ links, hotRatio: 0, hotTxCount: 0, programId, seed: 3 });
  chain.setFleet(fleet);
  const accounts = (chain as unknown as { accounts: Map<string, Account> }).accounts;
  const requests: { method: string; keys: string[] }[] = [];
  const transport = async (_input: unknown, init?: { readonly body?: unknown }): Promise<Response> => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { id?: unknown; method?: string; params?: unknown[] };
    const params = Array.isArray(payload.params) ? payload.params : [];
    requests.push({ method: String(payload.method), keys: payload.method === "getMultipleAccounts" ? (params[0] as string[]) : [] });
    const result = chain.handle(String(payload.method), params);
    const body = result.error === undefined ? { jsonrpc: "2.0", id: payload.id ?? null, result: result.result ?? null } : { jsonrpc: "2.0", id: payload.id ?? null, error: result.error };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const connection = new Connection("http://127.0.0.1:1", { commitment: "confirmed", fetch: transport as never });
  const refuse = async (): Promise<never> => {
    throw new Error("signs nothing");
  };
  const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(connection, { publicKey: crank, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }));
  return { chain, fleet, accounts, connection, program, requests };
}

/** An SPL Token account (mint, owner, amount at 64), 165 bytes, owned by `programOwner`. */
function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, programOwner = TOKEN_PROGRAM_ID): Account {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return { data, owner: programOwner, lamports: rentExempt(165), executable: false };
}

describe("readSweepState", () => {
  it("reads every turned vault, its policy and its two ATAs, and the four shared accounts, in ONE request", async () => {
    const { fleet, connection, program, requests } = bench(3);
    const state = await readSweepState(connection, program, fleet.map((link) => link.vault));
    expect(state.requests).toBe(1);
    expect(requests.map((r) => r.method)).toEqual(["getMultipleAccounts"]);
    const expected = [
      ...fleet.flatMap((link) => [
        link.vault,
        investmentPolicyAddress(programId, link.vault),
        getAssociatedTokenAddressSync(NATIVE_MINT, link.vault, true, TOKEN_PROGRAM_ID),
        getAssociatedTokenAddressSync(USDC_MINT, link.vault, true, TOKEN_PROGRAM_ID),
      ]),
      SYSVAR_CLOCK_PUBKEY,
      PYTH_SOL_USD_FEED,
      PYTH_USDC_USD_FEED,
      SYSVAR_EPOCH_SCHEDULE_PUBKEY,
    ].map((key) => key.toBase58());
    expect(requests[0]!.keys).toEqual(expected);
  });

  it("answers the vault map readVaults answers — same vaults, same decode, null where the chain has none", async () => {
    const { fleet, accounts, connection, program, requests } = bench(3);
    const gone = benchKey("a vault that was closed");
    const asked = [...fleet.map((link) => link.vault), gone, fleet[0]!.vault];
    accounts.delete(fleet[2]!.vault.toBase58());
    const state = await readSweepState(connection, program, asked);
    const today = await readVaults(program, asked);
    expect([...state.vaults.keys()]).toEqual([...today.keys()]);
    expect(state.vaults).toEqual(today);
    expect(state.vaults.get(gone.toBase58())).toBeNull();
    // ASKED TWICE, READ ONCE: the de-duplication readVaults has — four vaults
    // in the request, not five, and each named once.
    expect(state.invest.size).toBe(4);
    const batch = requests.find((r) => r.method === "getMultipleAccounts")!;
    expect(batch.keys).toHaveLength(4 * 4 + 4);
    expect(new Set(batch.keys).size).toBe(batch.keys.length);
  });

  it("throws on a vault that does not decode, exactly as readVaults does, so the sweep takes today's degraded path", async () => {
    const { fleet, accounts, connection, program } = bench(2);
    accounts.get(fleet[1]!.vault.toBase58())!.data.fill(7, 0, 8);
    await expect(readVaults(program, fleet.map((link) => link.vault))).rejects.toThrow();
    await expect(readSweepState(connection, program, fleet.map((link) => link.vault))).rejects.toThrow(/discriminator/);
  });

  it("splits into requests of at most 100 accounts: one for 24 vaults, two for 25, none for none", async () => {
    expect(SWEEP_STATE_CHUNK).toBe(100);
    for (const [vaults, expected] of [[24, 1], [25, 2], [49, 2], [50, 3]] as const) {
      const { fleet, connection, program, requests } = bench(vaults);
      const state = await readSweepState(connection, program, fleet.map((link) => link.vault));
      expect(state.requests, `${vaults} vaults`).toBe(expected);
      expect(requests.every((r) => r.keys.length <= 100)).toBe(true);
      expect(requests.reduce((n, r) => n + r.keys.length, 0)).toBe(4 * vaults + 4);
      expect(state.invest.size).toBe(vaults);
    }
    const { connection, program, requests } = bench(0);
    expect((await readSweepState(connection, program, [])).requests).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("hands each vault the shared Clock, feeds and schedule, its own policy bytes, and its balances as balanceOf would read them", async () => {
    const { fleet, accounts, connection, program } = bench(2);
    const [a, b] = fleet;
    const usdcA = getAssociatedTokenAddressSync(USDC_MINT, a!.vault, true, TOKEN_PROGRAM_ID);
    const wsolB = getAssociatedTokenAddressSync(NATIVE_MINT, b!.vault, true, TOKEN_PROGRAM_ID);
    accounts.set(usdcA.toBase58(), tokenAccount(USDC_MINT, a!.vault, 7_500_000n));
    accounts.set(wsolB.toBase58(), tokenAccount(NATIVE_MINT, b!.vault, 42n));
    const state = await readSweepState(connection, program, [a!.vault, b!.vault]);
    const snapA = state.invest.get(a!.vault.toBase58())!;
    const snapB = state.invest.get(b!.vault.toBase58())!;
    expect(snapA).toMatchObject({ usdcHeld: 7_500_000n, wsolHeld: 0n });
    expect(snapB).toMatchObject({ usdcHeld: 0n, wsolHeld: 42n });
    expect(snapA.vaultAddress.equals(a!.vault)).toBe(true);
    expect(snapA.clock).not.toBeNull();
    expect(snapA.clock).toBe(snapB.clock);
    // THE POLICY AS BYTES, decoded by the turn into what readInvestmentPolicy reads.
    expect(decodeInvestmentPolicy(program, snapA.policyAddress, snapA.policy?.data ?? null)).toEqual(await readInvestmentPolicy(program, a!.vault));
  });
});

describe("a token account's balance from its bytes", () => {
  const info = (over: Partial<AccountInfo<Buffer>>): AccountInfo<Buffer> => ({
    data: tokenAccount(USDC_MINT, PublicKey.default, 99n).data,
    owner: TOKEN_PROGRAM_ID,
    lamports: 1,
    executable: false,
    rentEpoch: 0,
    ...over,
  });

  it("is the u64 at 64 of a 165-byte classic Token account, and 0 for anything getTokenAccountBalance would have refused", () => {
    expect(tokenAmountOf(info({}))).toBe(99n);
    expect(tokenAmountOf(null)).toBe(0n);
    expect(tokenAmountOf(undefined)).toBe(0n);
    expect(tokenAmountOf(info({ owner: programId }))).toBe(0n);
    // The two ATAs here are the classic program's; a Token-2022 account at that address is not one of them.
    expect(tokenAmountOf(info({ owner: TOKEN_2022_PROGRAM_ID }))).toBe(0n);
    expect(tokenAmountOf(info({ data: Buffer.alloc(82) }))).toBe(0n);
  });
});

describe("the policy from bytes in hand", () => {
  it("is null for no account and for an empty one — Anchor's fetchNullable rule — and THROWS on bytes that are not a policy", async () => {
    const { fleet, accounts, program } = bench(1);
    const address = investmentPolicyAddress(programId, fleet[0]!.vault);
    expect(decodeInvestmentPolicy(program, address, null)).toBeNull();
    expect(decodeInvestmentPolicy(program, address, Buffer.alloc(0))).toBeNull();
    const bytes = Buffer.from(accounts.get(address.toBase58())!.data);
    bytes.fill(0, 0, 8);
    // A MALFORMED POLICY IS NEVER "NO BASKET": both readers refuse it.
    expect(() => decodeInvestmentPolicy(program, address, bytes)).toThrow();
    accounts.get(address.toBase58())!.data.fill(0, 0, 8);
    await expect(readInvestmentPolicy(program, fleet[0]!.vault)).rejects.toThrow();
  });
});

describe("C2, the rent floor cached per connection and size", () => {
  it("asks once per size, and asks again after a failure", async () => {
    const asked: number[] = [];
    let fail = true;
    const connection = {
      getMinimumBalanceForRentExemption: async (size: number) => {
        asked.push(size);
        if (fail) {
          fail = false;
          throw new Error("rent blipped");
        }
        return size * 10;
      },
    } as unknown as Connection;
    await expect(cachedRentFloor(connection, 125)).rejects.toThrow("rent blipped");
    expect(await cachedRentFloor(connection, 125)).toBe(1_250);
    expect(await cachedRentFloor(connection, 125)).toBe(1_250);
    expect(await cachedRentFloor(connection, 970)).toBe(9_700);
    expect(asked).toEqual([125, 125, 970]);
    // ANOTHER CONNECTION IS ANOTHER CACHE: a pool's endpoints are not assumed to agree.
    const other = { getMinimumBalanceForRentExemption: async () => 1 } as unknown as Connection;
    expect(await cachedRentFloor(other, 125)).toBe(1);
  });
});

describe("which outcomes leave the snapshot of their vault true", () => {
  it("every settle outcome that sends nothing, and none that may have sent — an unknown one included", () => {
    const table: Record<SettleOutcome, boolean> = {
      IDLE: true,
      PENDING_FINALITY: true,
      SETTLED: false,
      NO_PROFIT: true,
      INCOMPLETE: true,
      NO_SIGNER: true,
      UNSUPPORTED_MODE: true,
      PAUSED: true,
      BELOW_RESERVE: true,
      RETRY: false,
      FAILED: false,
    };
    for (const [outcome, fresh] of Object.entries(table)) expect(settleLeavesSnapshotTrue(outcome as SettleOutcome), outcome).toBe(fresh);
    expect(settleLeavesSnapshotTrue("SOMETHING_NEWER" as SettleOutcome)).toBe(false);
  });

  it("every invest outcome that rested or was deferred, and none that may have sent", () => {
    const table: Record<InvestOutcome, boolean> = {
      IDLE: true,
      NO_POLICY: true,
      PAUSED: true,
      DEFERRED: true,
      INVESTED: false,
      REFUSED: false,
      FAILED: false,
    };
    for (const [outcome, fresh] of Object.entries(table)) expect(investLeavesSnapshotTrue(outcome as InvestOutcome), outcome).toBe(fresh);
  });
});
