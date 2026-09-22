// Server-side readers over a stub pool: the ownership gate, tri-state results, history.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MINT,
  ANTHROPIC_USDC_POOL,
  PYTH_PUSH_PROGRAM,
  PYTH_RECEIVER_PROGRAM,
  PYTH_SOL_USD_FEED,
  PYTH_USDC_USD_FEED,
  RAYDIUM_CLMM,
  SOL_USDC_POOL,
  SPYX_MINT,
  SPYX_USDC_POOL,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
} from "../src/client/addresses";
import {
  ANTHROPIC_SQRT_PRICE,
  LEG_POOLS,
  SOL_POOL_USDC_RESERVE,
  SOL_POOL_USDC_VAULT,
  SOL_POOL_VAULT_0,
  SOL_SQRT_PRICE,
  SPYX_SQRT_PRICE,
  clmmPoolAccount,
  localRent,
  parsedTokenAccount,
  policyAccount,
  poolVaultAccount,
  tokenAccountData,
} from "./chain-fixtures";
import { base58Encode } from "../src/client/base58";
import { base64Encode } from "../src/client/base64";
import { encodeArgs, encodeStruct } from "../src/client/borsh";
import { SIP_ACCOUNT_SPACE } from "../src/client/decoders";
import { SIP_PROGRAM_ID, accountDiscriminator, eventDiscriminator, instructionDiscriminator } from "../src/client/idl";
import { deriveAta, deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "../src/server/pda";
import {
  MAX_LIVE_SNAPSHOT_ADDRESSES,
  MAX_WALLET_LINKS,
  PRICED_POOL_IN_VAULTS,
  PRICED_POOL_PAIRS,
  PRICED_POOLS,
  PYTH_SNAPSHOT_ADDRESSES,
  listVaultActivity,
  listVaultSignatures,
  readLiveSnapshot,
  readVaultTransactions,
  listVaultHoldings,
  listVaultLinks,
  readBuildBatch,
  deriveClmmPoolVault,
  poolReservesFromAccounts,
  readOwnerAccounts,
  readPoolDepth,
  readPoolPrices,
  readProtocolConfig,
  readVault,
  readVaultTokenAccounts,
  readWalletLinks,
  readWithdrawTokenSource,
  settledEventsFromLogs,
  tokenAccountFromSnapshot,
  tokenAccountStatus,
  vaultTokenAccountTargets,
  type AccountSnapshot,
} from "../src/server/readers";
import {
  PYTH_FIXTURE_OWNER,
  PYTH_FIXTURE_POSTED_SLOT,
  PYTH_FIXTURE_PUBLISH_TIME,
  PYTH_SOL_USD_ACCOUNT,
  PYTH_USDC_USD_ACCOUNT,
} from "./fixtures/pyth-accounts";
import { createRpcPool } from "../src/server/rpc-pool";
import { BLOCKHASH, SECRET_QUERY, UPSTREAM_1, accountInfo, fakeFetch, jsonResponse, keypair, rpcResult, type UpstreamCall } from "./helpers";

const key = (): string => keypair().publicKey.toBase58();
const SIGNATURE = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => i + 11));

function account(name: "Vault" | "TradingLink" | "ProtocolConfig", fields: Record<string, unknown>): Uint8Array {
  const body = encodeStruct(name, fields);
  const bytes = new Uint8Array(SIP_ACCOUNT_SPACE[name]);
  bytes.set(accountDiscriminator(name), 0);
  bytes.set(body, 8);
  return bytes;
}

const vaultBytes = (owner: string): Uint8Array =>
  account("Vault", {
    owner,
    bump: 255,
    version: 1,
    paused: false,
    skim_bps: 2_000,
    lifetime_saved: 0n,
    created_at: 1n,
    skim_mode: 1,
    volume_bps: 10,
    policy_nonce: 0n,
    max_contribution: 1_000n,
    wallet_reserve: 0n,
    _reserved: new Array(37).fill(0),
  });

const linkBytes = (wallet: string, vault: string): Uint8Array =>
  account("TradingLink", { wallet, vault, epoch: 1n, settlement_nonce: 0n, frontier_slot: 0n, bump: 254, _reserved: new Array(32).fill(0) });

const configBytes = (paused: boolean): Uint8Array =>
  account("ProtocolConfig", { authority: key(), attester: key(), bump: 253, keeper: key(), pending_authority: "11111111111111111111111111111111", paused, version: 2, _reserved: new Array(64).fill(0) });

const batchOf = (call: UpstreamCall): { id: number; method: string; params: unknown[] }[] => call.body as never;
const pool = (respond: (call: UpstreamCall) => Response) => {
  const upstream = fakeFetch(respond);
  return { pool: createRpcPool([UPSTREAM_1], { fetch: upstream.fetch }), upstream };
};

describe("readVault", () => {
  it("decodes a SIP-owned vault and subtracts the rent floor it read", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const { pool: p } = pool((call) =>
      jsonResponse([
        { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: accountInfo(SIP_PROGRAM_ID, vaultBytes(owner), 5_000_000) } },
        { jsonrpc: "2.0", id: 2, result: 1_760_880 },
      ]),
    );
    const read = await readVault(p, vault);
    expect(read.kind).toBe("exists");
    if (read.kind !== "exists") return;
    expect(read.value.state.owner).toBe(owner);
    expect(read.value.rentFloor).toBe(1_760_880n);
    expect(read.value.withdrawableLamports).toBe(5_000_000n - 1_760_880n);
  });

  it("refuses to decode an account another program owns, and says missing only when the chain says so", async () => {
    const owner = key();
    const forged = pool(() => jsonResponse([{ jsonrpc: "2.0", id: 1, result: { value: accountInfo(key(), vaultBytes(owner)) } }, { jsonrpc: "2.0", id: 2, result: 1 }]));
    const read = await readVault(forged.pool, key());
    expect(read).toMatchObject({ kind: "unreadable" });
    expect(read.kind === "unreadable" && read.error).toContain("refusing to decode");

    const absent = pool(() => jsonResponse([{ jsonrpc: "2.0", id: 1, result: { value: null } }, { jsonrpc: "2.0", id: 2, result: 1 }]));
    expect(await readVault(absent.pool, key())).toEqual({ kind: "missing" });

    const down = pool(() => {
      throw new Error(`boom ${UPSTREAM_1}`);
    });
    const failed = await readVault(down.pool, key());
    expect(failed.kind).toBe("unreadable");
    expect(JSON.stringify(failed)).not.toContain(SECRET_QUERY);
  });
});

describe("readOwnerAccounts and readProtocolConfig", () => {
  it("reads vault, policy and config in one round trip, each with its own outcome", async () => {
    const owner = key();
    const { pool: p, upstream } = pool((call) => {
      const [first] = batchOf(call);
      expect(first!.params[0]).toEqual([deriveVaultPda(owner).toBase58(), deriveInvestPda(deriveVaultPda(owner)).toBase58(), deriveConfigPda().toBase58()]);
      return jsonResponse([
        { jsonrpc: "2.0", id: 1, result: { value: [accountInfo(SIP_PROGRAM_ID, vaultBytes(owner)), null, accountInfo(SIP_PROGRAM_ID, configBytes(true))] } },
        { jsonrpc: "2.0", id: 2, result: 1_000_000 },
      ]);
    });
    const read = await readOwnerAccounts(p, owner);
    expect(upstream.calls).toHaveLength(1);
    expect(read.vault.kind).toBe("exists");
    expect(read.policy).toEqual({ kind: "missing" });
    expect(read.config.kind === "exists" && read.config.value.state.paused).toBe(true);
  });

  it("reads the protocol config at ['config']", async () => {
    const { pool: p, upstream } = pool((call) => rpcResult(call, { value: accountInfo(SIP_PROGRAM_ID, configBytes(false)) }));
    const read = await readProtocolConfig(p);
    expect(read.kind === "exists" && read.value.address).toBe(deriveConfigPda().toBase58());
    expect((upstream.calls[0]!.body as { params: unknown[] }).params[0]).toBe(deriveConfigPda().toBase58());
  });
});

describe("listVaultLinks", () => {
  it("filters by size and the vault field at byte 40, then re-checks what it decoded", async () => {
    const vault = key();
    const good = key();
    const { pool: p, upstream } = pool((call) =>
      rpcResult(call, [
        { pubkey: key(), account: accountInfo(SIP_PROGRAM_ID, linkBytes(good, vault)) },
        { pubkey: key(), account: accountInfo(SIP_PROGRAM_ID, linkBytes(key(), key())) },
        { pubkey: key(), account: accountInfo(key(), linkBytes(key(), vault)) },
      ]),
    );
    const read = await listVaultLinks(p, vault);
    expect(read.kind === "exists" && read.value.map((link) => link.state.wallet)).toEqual([good]);
    expect((upstream.calls[0]!.body as { params: unknown[] }).params).toEqual([
      SIP_PROGRAM_ID,
      { encoding: "base64", commitment: "confirmed", filters: [{ dataSize: 129 }, { memcmp: { offset: 40, bytes: vault } }] },
    ]);
  });
});

describe("listVaultHoldings", () => {
  it("lists non-zero balances under both token programs with their token accounts", async () => {
    const vault = key();
    const [usdcAccount, stockAccount, mintA, mintB] = [key(), key(), key(), key()];
    const parsed = (pubkey: string, mint: string, amount: string) => ({
      pubkey,
      account: { data: { parsed: { info: { mint, owner: vault, tokenAmount: { amount, decimals: 6, uiAmountString: "1.5" } } } } },
    });
    const { pool: p } = pool((call) => {
      const calls = batchOf(call);
      expect(calls.map((entry) => (entry.params[1] as { programId: string }).programId)).toEqual([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
      return jsonResponse([
        { jsonrpc: "2.0", id: 1, result: { value: [parsed(usdcAccount, mintA, "1500000"), parsed(key(), key(), "0")] } },
        { jsonrpc: "2.0", id: 2, result: { value: [parsed(stockAccount, mintB, "42")] } },
      ]);
    });
    const read = await listVaultHoldings(p, vault);
    expect(read.kind === "exists" && read.value).toEqual([
      { tokenAccount: usdcAccount, mint: mintA, amountRaw: 1_500_000n, decimals: 6, uiAmount: "1.5", tokenProgram: TOKEN_PROGRAM },
      { tokenAccount: stockAccount, mint: mintB, amountRaw: 42n, decimals: 6, uiAmount: "1.5", tokenProgram: TOKEN_2022_PROGRAM },
    ]);
  });
});

function settledLine(vault: string, wallet: string, paid: bigint): string {
  const body = encodeStruct("Settled", {
    vault,
    wallet,
    mode: 1,
    base_lamports: 100n,
    bps: 10,
    owed: paid,
    paid,
    settlement_nonce: 1n,
    session_end_slot: 2n,
    link_epoch: 3n,
    session_start_slot: 1n,
    policy_nonce: 4n,
  });
  const bytes = new Uint8Array(8 + body.length);
  bytes.set(eventDiscriminator("Settled"), 0);
  bytes.set(body, 8);
  return `Program data: ${base64Encode(bytes)}`;
}

describe("settledEventsFromLogs", () => {
  it("accepts Settled data only while the SIP program is executing", () => {
    const vault = key();
    const wallet = key();
    const other = key();
    const logs = [
      `Program ${SIP_PROGRAM_ID} invoke [1]`,
      "Program log: Instruction: SettleV2",
      `Program 11111111111111111111111111111111 invoke [2]`,
      settledLine(vault, wallet, 1n),
      `Program 11111111111111111111111111111111 success`,
      settledLine(vault, wallet, 7n),
      `Program ${SIP_PROGRAM_ID} success`,
      `Program ${other} invoke [1]`,
      settledLine(vault, wallet, 9n),
      `Program ${other} success`,
    ];
    const events = settledEventsFromLogs(logs);
    expect(events.map((event) => event.paid)).toEqual([7n]);
    expect(events[0]!.vault).toBe(vault);
    expect([events[0]!.linkEpoch, events[0]!.sessionStartSlot, events[0]!.policyNonce]).toEqual([3n, 1n, 4n]);
  });
});

describe("listVaultActivity", () => {
  it("pages signatures and names SIP instructions by discriminator, with the vault's balance change", async () => {
    const vault = key();
    const wallet = key();
    const signature = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
    const { pool: p, upstream } = pool((call) => {
      if (!Array.isArray(call.body)) return rpcResult(call, [{ signature, slot: 10, blockTime: 1_700_000_000, err: null }]);
      return jsonResponse([
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 10,
            blockTime: 1_700_000_000,
            meta: {
              err: null,
              fee: 5_000,
              preBalances: [10_000_000, 1_000_000, 1],
              postBalances: [9_000_000, 2_000_000, 1],
              logMessages: [`Program ${SIP_PROGRAM_ID} invoke [1]`, settledLine(vault, wallet, 1_000_000n), `Program ${SIP_PROGRAM_ID} success`],
              loadedAddresses: { writable: [], readonly: [] },
            },
            transaction: {
              message: {
                accountKeys: [wallet, vault, SIP_PROGRAM_ID],
                instructions: [{ programIdIndex: 2, accounts: [0, 1], data: base58Encode(instructionDiscriminator("settle_v2")) }],
              },
            },
          },
        },
      ]);
    });
    const read = await listVaultActivity(p, vault, { limit: 1 });
    expect(read.kind).toBe("exists");
    if (read.kind !== "exists") return;
    expect(read.value.nextBefore).toBe(signature);
    expect(read.value.entries).toHaveLength(1);
    const entry = read.value.entries[0]!;
    expect(entry.sipInstructions).toEqual(["settle_v2"]);
    expect(entry.vaultLamportsDelta).toBe(1_000_000n);
    expect(entry.fee).toBe(5_000n);
    expect(entry.settled.map((event) => event.paid)).toEqual([1_000_000n]);
    const [history] = upstream.calls;
    expect((history!.body as { params: unknown[] }).params).toEqual([vault, { limit: 1, commitment: "confirmed" }]);
    expect((batchOf(upstream.calls[1]!)[0]!.params[1] as Record<string, unknown>).maxSupportedTransactionVersion).toBe(0);
  });

  it("bounds the page size", async () => {
    const { pool: p } = pool((call) => rpcResult(call, []));
    await expect(listVaultActivity(p, key(), { limit: 26 })).rejects.toThrow(RangeError);
    expect(await listVaultActivity(p, key())).toEqual({ kind: "exists", value: { entries: [], nextBefore: null } });
  });
});

describe("readPoolPrices", () => {
  const solPool = (owner = RAYDIUM_CLMM, mints: [string, string] = [WSOL_MINT, USDC_MINT]) =>
    accountInfo(owner, clmmPoolAccount(mints[0], mints[1], SOL_SQRT_PRICE, [9, 6], [SOL_POOL_VAULT_0, SOL_POOL_USDC_VAULT]));
  /** Offered leg `index`'s pool, spoilable by owner or by mint order exactly as the SOL pool is. */
  const legPool = (index: number, owner = RAYDIUM_CLMM, mints?: readonly [string, string]) => {
    const leg = LEG_POOLS[index]!;
    const [mint0, mint1] = mints ?? [leg.mint, USDC_MINT];
    return accountInfo(owner, clmmPoolAccount(mint0, mint1, leg.sqrtPriceX64, [leg.decimals, 6], [leg.vault0, leg.usdcVault]));
  };
  /** Every priced pool as the chain really holds it, in PRICED_POOLS' order. */
  const allPools = () => [solPool(), ...LEG_POOLS.map((_, index) => legPool(index))];
  /** Every priced pool's IN-SIDE vault, in the same order: the second half of the one answer. */
  const allVaults = () => [
    poolVaultAccount(SOL_USDC_POOL, USDC_MINT, SOL_POOL_USDC_RESERVE),
    ...LEG_POOLS.map((leg) => poolVaultAccount(leg.pool, USDC_MINT, leg.usdcReserve)),
  ];

  it("reads every pinned pool in ONE call, and each rate is its own golden", async () => {
    const { pool: p, upstream } = pool((call) => rpcResult(call, { context: { slot: 99 }, value: [...allPools(), ...allVaults()] }));
    expect(await readPoolPrices(p)).toEqual({
      kind: "exists",
      value: {
        slot: 99,
        convertWad: 100_038_711_555_492_562n,
        // Written out, not read from LEG_POOLS: this is the one place the decoder's
        // arithmetic is pinned, so it must not compare the fixture against itself.
        legWads: { [SPYX_MINT]: 131_283_650_130_637_569n, [ANTHROPIC_MINT]: 5_555_555_555_555_555_556n },
      },
    });
    expect(upstream.calls).toHaveLength(1);
    // STILL ONE CALL, three addresses longer: each pool's in-side vault is a PDA
    // of the pool and USDC, so it is known before the answer comes back and does
    // not cost the round trip the keeper has to pay for the same figures.
    expect((upstream.calls[0]!.body as { params: unknown[] }).params).toEqual([
      [SOL_USDC_POOL, SPYX_USDC_POOL, ANTHROPIC_USDC_POOL, SOL_POOL_USDC_VAULT, LEG_POOLS[0]!.usdcVault, LEG_POOLS[1]!.usdcVault],
      { encoding: "base64", commitment: "confirmed" },
    ]);
  });

  // EVERY POOL IS SPOILED BOTH WAYS. With two legs there is one way to spoil a
  // pool per leg left over from the three-leg list, so the FIGUREAI cases move
  // onto ANTHROPIC rather than being dropped: a PreStocks pool under the wrong
  // owner and one with its mints swapped are different bugs, and both are fatal.
  it.each([
    ["the SOL pool owned by another program", () => [solPool(key()), legPool(0), legPool(1)]],
    ["the SOL pool with its mints swapped", () => [solPool(RAYDIUM_CLMM, [USDC_MINT, WSOL_MINT]), legPool(0), legPool(1)]],
    ["the SPYx pool with its mints swapped", () => [solPool(), legPool(0, RAYDIUM_CLMM, [USDC_MINT, SPYX_MINT]), legPool(1)]],
    ["the SPYx pool owned by another program", () => [solPool(), legPool(0, key()), legPool(1)]],
    ["the ANTHROPIC pool owned by another program", () => [solPool(), legPool(0), legPool(1, key())]],
    ["the ANTHROPIC pool with its mints swapped", () => [solPool(), legPool(0), legPool(1, RAYDIUM_CLMM, [USDC_MINT, ANTHROPIC_MINT])]],
    ["a pool that does not exist", () => [solPool(), legPool(0), null]],
    ["two accounts where three were asked", () => [solPool(), legPool(0)]],
  ])("%s is unreadable, never a price", async (_, accounts) => {
    // The vaults are appended to every case so that the spoiled POOL is the only
    // thing wrong with the answer: a case that came back short would be
    // unreadable for a reason that has nothing to do with what it spoils.
    const { pool: p } = pool((call) => rpcResult(call, { context: { slot: 1 }, value: [...accounts(), ...allVaults()] }));
    expect((await readPoolPrices(p)).kind).toBe("unreadable");
  });

  it("an RPC that does not answer is unreadable, and the endpoint is not quoted", async () => {
    const { pool: p } = pool(() => {
      throw new Error(`boom ${UPSTREAM_1}`);
    });
    const read = await readPoolPrices(p);
    expect(read.kind).toBe("unreadable");
    expect(JSON.stringify(read)).not.toContain(SECRET_QUERY);
  });

  it("readPoolDepth answers the rates AND the reserves out of that same one call", async () => {
    const { pool: p, upstream } = pool((call) => rpcResult(call, { context: { slot: 99 }, value: [...allPools(), ...allVaults()] }));
    const depth = await readPoolDepth(p);
    expect(upstream.calls).toHaveLength(1);
    expect(depth.prices).toEqual(await readPoolPrices(pool((call) => rpcResult(call, { context: { slot: 99 }, value: [...allPools(), ...allVaults()] })).pool));
    expect(depth.reserves.kind === "exists" && depth.reserves.value.items.map((item) => item.amountRaw)).toEqual([
      SOL_POOL_USDC_RESERVE,
      LEG_POOLS[0]!.usdcReserve,
      LEG_POOLS[1]!.usdcReserve,
    ]);
  });

  it("A VAULT THAT CANNOT BE READ CHANGES THE RESERVES AND NOTHING ELSE", async () => {
    // The mutation this pair exists for: break the new read, and the rates the
    // forms and the floors are built from must come back exactly as they were.
    const answer = (value: unknown[]) => pool((call) => rpcResult(call, { context: { slot: 99 }, value })).pool;
    const whole = await readPoolDepth(answer([...allPools(), ...allVaults()]));
    const broken = await readPoolDepth(answer([...allPools(), null, ...allVaults().slice(1)]));
    expect(broken.prices).toEqual(whole.prices);
    expect(broken.prices.kind).toBe("exists");
    const items = broken.reserves.kind === "exists" ? broken.reserves.value.items : [];
    expect(items[0]!.amountRaw).toBeNull();
    expect(items[0]!.unreadable).toMatch(/in-side vault was not read/);
    // And only that one pool: the other two keep their figures.
    expect(items.slice(1).map((item) => item.amountRaw)).toEqual([LEG_POOLS[0]!.usdcReserve, LEG_POOLS[1]!.usdcReserve]);
  });
});

describe("the pools' in-side reserves", () => {
  const snap = (owner: string, data: Uint8Array | null): AccountSnapshot => ({ owner, lamports: 1n, data });
  const poolSnap = (mints: readonly [string, string], vaults: readonly [string, string], sqrtPriceX64 = SOL_SQRT_PRICE, owner = RAYDIUM_CLMM) =>
    snap(owner, clmmPoolAccount(mints[0], mints[1], sqrtPriceX64, [9, 6], vaults));
  /** A pool's vault: SPL Token, holding `mint`, owned by the pool itself — which is what mainnet's three record at byte 32. */
  const vaultSnap = (holder: string, mint: string, amount: bigint, owner = TOKEN_PROGRAM) => snap(owner, tokenAccountData({ mint, owner: holder, amount }));

  /** Every priced pool as mainnet holds it, in PRICED_POOLS' order. */
  const pools = (): (AccountSnapshot | null)[] => [
    poolSnap([WSOL_MINT, USDC_MINT], [SOL_POOL_VAULT_0, SOL_POOL_USDC_VAULT], SOL_SQRT_PRICE),
    ...LEG_POOLS.map((leg) => poolSnap([leg.mint, USDC_MINT], [leg.vault0, leg.usdcVault], leg.sqrtPriceX64)),
  ];
  /** Each of those pools' USDC vault, holding what mainnet's own vault held. */
  const vaults = (): (AccountSnapshot | null)[] => [
    vaultSnap(SOL_USDC_POOL, USDC_MINT, SOL_POOL_USDC_RESERVE),
    ...LEG_POOLS.map((leg) => vaultSnap(leg.pool, USDC_MINT, leg.usdcReserve)),
  ];
  const reserveOf = (index: number, change: { pool?: AccountSnapshot | null; vault?: AccountSnapshot | null }) => {
    const [ps, vs] = [pools(), vaults()];
    if ("pool" in change) ps[index] = change.pool!;
    if ("vault" in change) vs[index] = change.vault!;
    return poolReservesFromAccounts(ps, vs, 7).items[index]!;
  };

  it("is one entry per priced pool, in PRICED_POOLS' own order, each holding what its USDC vault holds", () => {
    expect(PRICED_POOL_PAIRS.map((pair) => pair.pool)).toEqual([...PRICED_POOLS]);
    // The reserves are matched to pools BY INDEX, so the two lists being one list
    // is the invariant the whole read rests on.
    expect(PRICED_POOL_IN_VAULTS).toEqual(PRICED_POOL_PAIRS.map((pair) => pair.inVault));

    const read = poolReservesFromAccounts(pools(), vaults(), 448_882_962);
    expect(read.slot).toBe(448_882_962);
    expect(read.items.map((item) => [item.pool, item.otherMint, item.amountRaw, item.unreadable])).toEqual([
      [SOL_USDC_POOL, WSOL_MINT, SOL_POOL_USDC_RESERVE, null],
      [SPYX_USDC_POOL, SPYX_MINT, LEG_POOLS[0]!.usdcReserve, null],
      [ANTHROPIC_USDC_POOL, ANTHROPIC_MINT, LEG_POOLS[1]!.usdcReserve, null],
    ]);
    // THE FIGURE THE FROZEN LITERAL WAS CUT FROM, still moving: 9,541,652,779 raw
    // on 2026-09-20, 9,575,440,815 two days later. A ceiling divided out of the
    // first is wrong by the second, which is the whole reason this is read.
    expect(read.items[2]!.amountRaw).toBe(9_575_440_815n);
    expect(read.items.every((item) => item.inMint === USDC_MINT)).toBe(true);
  });

  it("derives each vault as a PDA of its pool and the mint, and mainnet's own pools name exactly those addresses", () => {
    // The literals come off the chain (chain-fixtures.ts, slot 448882962); the
    // addresses come out of ["pool_vault", pool, mint]. Holding them equal pins
    // the rule to what Raydium actually did, not to itself.
    expect([...PRICED_POOL_IN_VAULTS]).toEqual([SOL_POOL_USDC_VAULT, LEG_POOLS[0]!.usdcVault, LEG_POOLS[1]!.usdcVault]);
    expect(deriveClmmPoolVault(SOL_USDC_POOL, WSOL_MINT)).toBe(SOL_POOL_VAULT_0);
    expect(LEG_POOLS.map((leg) => deriveClmmPoolVault(leg.pool, leg.mint))).toEqual(LEG_POOLS.map((leg) => leg.vault0));
  });

  it("measures the IN side, whichever side of the pair it is on", () => {
    const leg = LEG_POOLS[0]!;
    // USDC as mint0: the in-side vault is now the one at 137, and the read must
    // follow the MINT and not the offset. The address it lands on is still the
    // USDC vault, so the reserve is still the reserve.
    const swapped = reserveOf(1, { pool: poolSnap([USDC_MINT, leg.mint], [leg.usdcVault, leg.vault0], leg.sqrtPriceX64) });
    expect([swapped.vault, swapped.amountRaw, swapped.unreadable]).toEqual([leg.usdcVault, leg.usdcReserve, null]);

    // AND THE CONTROL: a pool that names the STOCK vault where the USDC vault
    // belongs. Reading the wrong side would report the leg's own balance as the
    // depth a USDC buy has to fit into — the number the keeper never measures.
    const wrongSide = reserveOf(1, { pool: poolSnap([leg.mint, USDC_MINT], [leg.usdcVault, leg.vault0], leg.sqrtPriceX64) });
    expect(wrongSide.amountRaw).toBeNull();
    expect(wrongSide.unreadable).toContain(`names ${leg.vault0} as its ${USDC_MINT} vault`);
  });

  it("matches the keeper's own gate: the same four offsets, and the same side of the pair", () => {
    // Read as text, never imported: solana-core does not depend on the keeper.
    // If the two measured different sides, this panel would promise exactly what
    // the keeper's legDepthDecision then refuses.
    //
    // THE FILE MOVED ON 2026-09-21 AND THE OFFSETS DID NOT. The keeper's depth
    // gate became venue-agnostic — it judges a census of token accounts, which
    // is the only layout a CLOB and a DLMM share — and the Raydium pool decode
    // moved out of invest-decision.ts into venue-depth.ts, which holds one
    // adapter per venue. This panel still reads a Raydium pool, so it is still
    // the Raydium adapter it has to agree with.
    const keeper = readFileSync(fileURLToPath(new URL("../../solana-keeper/src/venue-depth.ts", import.meta.url)), "utf8");
    const offsetOf = (name: string): string | undefined => new RegExp(`const POOL_${name} = (\\d+);`).exec(keeper)?.[1];
    expect([offsetOf("TOKEN_MINT_0"), offsetOf("TOKEN_MINT_1"), offsetOf("TOKEN_VAULT_0"), offsetOf("TOKEN_VAULT_1")]).toEqual(["73", "105", "137", "169"]);
    // The choice itself: in_mint at mint0 means the in-side vault is vault0.
    expect(keeper).toContain("? { ok: true, inVault: pair.vault0, outVault: pair.vault1 }");
    expect(keeper).toContain("const inIsZero = pair.mint0.equals(input.inMint) && pair.mint1.equals(input.targetMint);");

    const readers = readFileSync(fileURLToPath(new URL("../src/server/readers.ts", import.meta.url)), "utf8");
    const ourOffset = (name: string): string | undefined => new RegExp(`const POOL_${name}_AT = (\\d+);`).exec(readers)?.[1];
    expect([ourOffset("TOKEN_MINT_0"), ourOffset("TOKEN_MINT_1"), ourOffset("TOKEN_VAULT_0"), ourOffset("TOKEN_VAULT_1")]).toEqual(["73", "105", "137", "169"]);
    expect(readers).toContain("const inIsZero = mint0 === pair.inMint && mint1 === pair.otherMint;");
  });

  it("a vault that is genuinely EMPTY reads zero, and nothing is wrong with it", () => {
    // The one reading that must NOT become null: a drained pool is a fact the
    // owner needs, and hiding it behind "unknown" is the mirror of the bug below.
    const empty = reserveOf(2, { vault: vaultSnap(ANTHROPIC_USDC_POOL, USDC_MINT, 0n) });
    expect([empty.amountRaw, empty.unreadable]).toEqual([0n, null]);
  });

  it.each<[string, { pool?: AccountSnapshot | null; vault?: AccountSnapshot | null }, RegExp]>([
    ["no pool account at all", { pool: null }, /pool account was not read/],
    ["a pool owned by another program", { pool: poolSnap([ANTHROPIC_MINT, USDC_MINT], [LEG_POOLS[1]!.vault0, LEG_POOLS[1]!.usdcVault], ANTHROPIC_SQRT_PRICE, SYSTEM_PROGRAM) }, /owned by 11111111111111111111111111111111, not Raydium CLMM/],
    ["a pool whose data is not base64", { pool: { owner: RAYDIUM_CLMM, lamports: 1n, data: null } }, /not base64/],
    ["a pool too short to reach its vaults", { pool: { owner: RAYDIUM_CLMM, lamports: 1n, data: new Uint8Array(200) } }, /at least 201 bytes to reach its vaults; this account is 200 bytes/],
    ["a pool that trades another pair", { pool: poolSnap([SPYX_MINT, USDC_MINT], [LEG_POOLS[0]!.vault0, LEG_POOLS[0]!.usdcVault], SPYX_SQRT_PRICE) }, /the pool trades .* against .*, not /],
    ["no vault account at all", { vault: null }, /in-side vault was not read, and an unread reserve is not an empty one/],
    ["a vault owned by no token program", { vault: vaultSnap(ANTHROPIC_USDC_POOL, USDC_MINT, 1n, SYSTEM_PROGRAM) }, /not a token program/],
    ["a vault whose data is not base64", { vault: { owner: TOKEN_PROGRAM, lamports: 1n, data: null } }, /not base64/],
    ["a vault too short to reach its amount", { vault: { owner: TOKEN_PROGRAM, lamports: 1n, data: new Uint8Array(64) } }, /at least 72 bytes to reach its amount; this account is 64 bytes/],
    ["a vault holding another mint", { vault: vaultSnap(ANTHROPIC_USDC_POOL, SPYX_MINT, 1n) }, new RegExp(`holds ${SPYX_MINT}, not ${USDC_MINT}`)],
  ])("%s is unknown and NEVER zero, and costs the other pools nothing", (_, change, why) => {
    const [ps, vs] = [pools(), vaults()];
    if ("pool" in change) ps[2] = change.pool!;
    if ("vault" in change) vs[2] = change.vault!;
    const read = poolReservesFromAccounts(ps, vs, 7);
    const spoiled = read.items[2]!;
    // NULL, NOT 0n. A zero reserve tells the owner their basket is dead; this one
    // was only unread, and the panel must be able to tell the difference.
    expect(spoiled.amountRaw).toBeNull();
    expect(spoiled.amountRaw).not.toBe(0n);
    expect(spoiled.unreadable).toMatch(why);
    // The pool that was spoiled is the only one that lost its figure.
    expect(read.items.slice(0, 2).map((item) => item.amountRaw)).toEqual([SOL_POOL_USDC_RESERVE, LEG_POOLS[0]!.usdcReserve]);
  });

  it("an answer that is short is unknown for every pool, and zero for none of them", () => {
    const read = poolReservesFromAccounts(pools(), vaults().slice(0, 2), null);
    expect(read.items).toHaveLength(PRICED_POOL_PAIRS.length);
    expect(read.items.map((item) => item.amountRaw)).toEqual([null, null, null]);
    expect(read.items.every((item) => item.unreadable === "the read did not answer every priced pool and its vault")).toBe(true);
  });
});

describe("readBuildBatch", () => {
  it("asks the blockhash, the accounts and the rents in ONE batch, in order, and answers null for an account the chain lacks", async () => {
    const [present, absent] = [key(), key()];
    const { pool: p, upstream } = pool((call) => {
      expect(batchOf(call).map((entry) => entry.method)).toEqual(["getLatestBlockhash", "getMultipleAccounts", "getMinimumBalanceForRentExemption", "getMinimumBalanceForRentExemption"]);
      expect(batchOf(call)[1]!.params[0]).toEqual([present, absent]);
      return jsonResponse([
        { jsonrpc: "2.0", id: 1, result: { context: { slot: 54 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 77 } } },
        { jsonrpc: "2.0", id: 2, result: { context: { slot: 55 }, value: [accountInfo(TOKEN_PROGRAM, new Uint8Array(165), 9), null] } },
        { jsonrpc: "2.0", id: 3, result: 111 },
        { jsonrpc: "2.0", id: 4, result: 222 },
      ]);
    });
    const read = await readBuildBatch(p, { addresses: [present, absent], sizes: [165, 970] });
    expect(upstream.calls).toHaveLength(1);
    if (read.kind !== "exists") throw new Error(read.kind);
    expect(read.value.recent).toEqual({ blockhash: BLOCKHASH, lastValidBlockHeight: 77 });
    expect(read.value.rents).toEqual([111n, 222n]);
    expect(read.value.slot).toBe(55);
    expect(read.value.accounts[0]).toMatchObject({ owner: TOKEN_PROGRAM, lamports: 9n });
    expect(read.value.accounts[0]!.data).toHaveLength(165);
    expect(read.value.accounts[1]).toBeNull();
  });

  it("a blockhash alone is one member; a member that fails, accounts short of what was asked, or a bad blockhash is unreadable, and never quotes the endpoint", async () => {
    const alone = pool((call) => {
      expect(batchOf(call).map((entry) => entry.method)).toEqual(["getLatestBlockhash"]);
      return jsonResponse([{ jsonrpc: "2.0", id: 1, result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } } }]);
    });
    expect((await readBuildBatch(alone.pool, { addresses: [], sizes: [] })).kind).toBe("exists");

    const short = pool(() =>
      jsonResponse([
        { jsonrpc: "2.0", id: 1, result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } } },
        { jsonrpc: "2.0", id: 2, result: { value: [null] } },
      ]),
    );
    expect((await readBuildBatch(short.pool, { addresses: [key(), key()], sizes: [] })).kind).toBe("unreadable");

    const failedRent = pool(() =>
      jsonResponse([
        { jsonrpc: "2.0", id: 1, result: { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } } },
        { jsonrpc: "2.0", id: 3, error: { code: -32000, message: `boom ${UPSTREAM_1}` } },
      ]),
    );
    const failed = await readBuildBatch(failedRent.pool, { addresses: [], sizes: [165] });
    expect(failed.kind).toBe("unreadable");
    expect(JSON.stringify(failed)).not.toContain(SECRET_QUERY);

    const badHash = pool(() => jsonResponse([{ jsonrpc: "2.0", id: 1, result: { value: { blockhash: "nope", lastValidBlockHeight: 1 } } }]));
    expect((await readBuildBatch(badHash.pool, { addresses: [], sizes: [] })).kind).toBe("unreadable");
  });
});

describe("the vault's token accounts", () => {
  it("wSOL and USDC under SPL Token at 165 bytes, then each leg under Token-2022 at its own size — SPYx 179, both PreStocks 191 — each at the vault's associated address", () => {
    const vault = key();
    expect(vaultTokenAccountTargets(vault)).toEqual([
      { mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM, bytes: 165, address: deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58() },
      { mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM, bytes: 165, address: deriveAta(vault, USDC_MINT, TOKEN_PROGRAM).toBase58() },
      { mint: SPYX_MINT, tokenProgram: TOKEN_2022_PROGRAM, bytes: 179, address: deriveAta(vault, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58() },
      { mint: ANTHROPIC_MINT, tokenProgram: TOKEN_2022_PROGRAM, bytes: 191, address: deriveAta(vault, ANTHROPIC_MINT, TOKEN_2022_PROGRAM).toBase58() },
    ]);
    // Two classic accounts and one per offered leg, and no more: a target that
    // appeared without a leg behind it would be rent quoted for nothing.
    expect(vaultTokenAccountTargets(vault)).toHaveLength(2 + 2);
  });

  it("held by its token program exists; absent, or only lamports sent to the address, is missing; anything else is unreadable", () => {
    const snap = (owner: string, data: Uint8Array | null = new Uint8Array(165)) => ({ owner, lamports: 1n, data });
    expect(tokenAccountStatus(snap(TOKEN_2022_PROGRAM, new Uint8Array(179)), TOKEN_2022_PROGRAM)).toBe("exists");
    expect(tokenAccountStatus(null, TOKEN_PROGRAM)).toBe("missing");
    expect(tokenAccountStatus(snap(SYSTEM_PROGRAM, new Uint8Array(0)), TOKEN_PROGRAM)).toBe("missing");
    expect(tokenAccountStatus(snap(TOKEN_PROGRAM), TOKEN_2022_PROGRAM)).toBe("unreadable");
    expect(tokenAccountStatus(snap(SYSTEM_PROGRAM, new Uint8Array(8)), TOKEN_PROGRAM)).toBe("unreadable");
    expect(tokenAccountStatus(undefined, TOKEN_PROGRAM)).toBe("unreadable");
  });

  it("reads all of them in one getMultipleAccounts; a read that fails is unreadable as a whole", async () => {
    const vault = key();
    const { pool: p, upstream } = pool((call) =>
      rpcResult(call, {
        value: [accountInfo(TOKEN_PROGRAM, new Uint8Array(165)), null, accountInfo(key(), new Uint8Array(179)), accountInfo(TOKEN_2022_PROGRAM, new Uint8Array(191))],
      }),
    );
    const read = await readVaultTokenAccounts(p, vault);
    expect(upstream.calls).toHaveLength(1);
    // All three statuses still appear, on the same kinds of account they did at
    // three legs: a classic account that is there, an address with nothing at it,
    // one held by the wrong program, and a 191-byte Token-2022 account that is there.
    expect(read.kind === "exists" && read.value.map((entry) => [entry.mint, entry.status])).toEqual([
      [WSOL_MINT, "exists"],
      [USDC_MINT, "missing"],
      [SPYX_MINT, "unreadable"],
      [ANTHROPIC_MINT, "exists"],
    ]);
    const down = pool(() => {
      throw new Error(`boom ${UPSTREAM_1}`);
    });
    const failed = await readVaultTokenAccounts(down.pool, vault);
    expect(failed.kind).toBe("unreadable");
    expect(JSON.stringify(failed)).not.toContain(SECRET_QUERY);
  });

  it("asks jsonParsed, and carries what each holds only when the RPC parsed it as the vault's own account of that mint", async () => {
    const vault = key();
    const { pool: p, upstream } = pool((call) =>
      rpcResult(call, {
        value: [
          parsedTokenAccount({ tokenProgram: TOKEN_PROGRAM, mint: WSOL_MINT, owner: vault, amount: "100000000", decimals: 9, uiAmountString: "0.1" }),
          parsedTokenAccount({ tokenProgram: TOKEN_PROGRAM, mint: USDC_MINT, owner: key(), amount: "5", decimals: 6, uiAmountString: "0.000005" }),
          parsedTokenAccount({ tokenProgram: TOKEN_2022_PROGRAM, mint: SPYX_MINT, owner: vault, amount: "12345678", decimals: 8, uiAmountString: "0.1241643", bytes: 179 }),
          // The zero-amount case rides on ANTHROPIC now that FIGUREAI carried it
          // out of the catalogue: it is still a 191-byte Token-2022 account, and
          // it is still the case that distinguishes "read, and empty" from "not read".
          parsedTokenAccount({ tokenProgram: TOKEN_2022_PROGRAM, mint: ANTHROPIC_MINT, owner: vault, amount: "0", decimals: 9, uiAmountString: "0", bytes: 191 }),
        ],
      }),
    );
    const read = await readVaultTokenAccounts(p, vault);
    expect((upstream.calls[0]!.body as { params: unknown[] }).params[1]).toEqual({ encoding: "jsonParsed", commitment: "confirmed" });
    expect(read.kind === "exists" && read.value.map((entry) => [entry.mint, entry.status, entry.amountRaw, entry.decimals, entry.uiAmount])).toEqual([
      [WSOL_MINT, "exists", 100_000_000n, 9, "0.1"],
      [USDC_MINT, "exists", null, null, null],
      [SPYX_MINT, "exists", 12_345_678n, 8, "0.1241643"],
      // An account that exists and holds nothing is 0n, never null: null is "nobody read it".
      [ANTHROPIC_MINT, "exists", 0n, 9, "0"],
    ]);
  });
});

describe("a token withdrawal's source, read by address", () => {
  const snap = (owner: string, data: Uint8Array | null) => ({ owner, lamports: 1n, data });

  it("decodes an initialized SPL Token or Token-2022 account from its bytes, and nothing else", () => {
    const [mint, owner, address] = [key(), key(), key()];
    const classic = tokenAccountData({ mint, owner, amount: 18_446_744_073_709_551_615n });
    expect(tokenAccountFromSnapshot(address, snap(TOKEN_PROGRAM, classic))).toEqual({ address, tokenProgram: TOKEN_PROGRAM, mint, owner, amountRaw: 18_446_744_073_709_551_615n, frozen: false });
    expect(tokenAccountFromSnapshot(address, snap(TOKEN_2022_PROGRAM, tokenAccountData({ mint, owner, amount: 5n, state: 2, bytes: 179 })))).toEqual({
      address,
      tokenProgram: TOKEN_2022_PROGRAM,
      mint,
      owner,
      amountRaw: 5n,
      frozen: true,
    });
    const mintWithExtensions = tokenAccountData({ mint, owner, amount: 1n, bytes: 179 });
    mintWithExtensions[165] = 1;
    const multisig = new Uint8Array(355);
    multisig[108] = 1;
    multisig[165] = 2;
    const notAccounts: readonly (readonly [string, Uint8Array | null])[] = [
      [SYSTEM_PROGRAM, classic],
      [key(), classic],
      [TOKEN_PROGRAM, tokenAccountData({ mint, owner, amount: 1n, bytes: 179 })],
      [TOKEN_2022_PROGRAM, mintWithExtensions],
      [TOKEN_2022_PROGRAM, multisig],
      [TOKEN_PROGRAM, tokenAccountData({ mint, owner, amount: 1n, state: 0 })],
      [TOKEN_2022_PROGRAM, new Uint8Array(82)],
      [TOKEN_PROGRAM, null],
    ];
    for (const [program, data] of notAccounts) expect(tokenAccountFromSnapshot(address, snap(program, data))).toBeNull();
    expect(tokenAccountFromSnapshot(address, null)).toBeNull();
  });

  it("reads the vault and the named account in ONE base64 getMultipleAccounts; an account that is gone, one that is not a token account and a failed read keep their own outcomes", async () => {
    const owner = key();
    const vault = deriveVaultPda(owner).toBase58();
    const [source, mint] = [key(), key()];
    const answers: unknown[][] = [
      [accountInfo(SIP_PROGRAM_ID, vaultBytes(owner)), accountInfo(TOKEN_PROGRAM, tokenAccountData({ mint, owner: vault, amount: 42n }))],
      [accountInfo(SIP_PROGRAM_ID, vaultBytes(owner)), null],
      [null, accountInfo(SYSTEM_PROGRAM, new Uint8Array(0))],
    ];
    const { pool: p, upstream } = pool((call) => rpcResult(call, { value: answers.shift() }));
    const read = await readWithdrawTokenSource(p, owner, source);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.body).toMatchObject({ method: "getMultipleAccounts", params: [[vault, source], { encoding: "base64", commitment: "confirmed" }] });
    expect([read.vaultAddress, read.vault.kind]).toEqual([vault, "exists"]);
    expect(read.source).toEqual({ kind: "exists", value: { address: source, tokenProgram: TOKEN_PROGRAM, mint, owner: vault, amountRaw: 42n, frozen: false } });
    expect((await readWithdrawTokenSource(p, owner, source)).source).toEqual({ kind: "missing" });
    const notToken = await readWithdrawTokenSource(p, owner, source);
    expect([notToken.vault.kind, notToken.source]).toEqual(["missing", { kind: "exists", value: null }]);

    const down = pool(() => {
      throw new Error(`boom ${UPSTREAM_1}`);
    });
    const failed = await readWithdrawTokenSource(down.pool, owner, source);
    expect([failed.vault.kind, failed.source.kind]).toEqual(["unreadable", "unreadable"]);
    expect(JSON.stringify(failed)).not.toContain(SECRET_QUERY);
  });
});

describe("readLiveSnapshot", () => {
  const owner = key();
  const vault = deriveVaultPda(owner).toBase58();
  const policyAddress = deriveInvestPda(vault).toBase58();
  const configAddress = deriveConfigPda().toBase58();

  const sipVault = () => accountInfo(SIP_PROGRAM_ID, vaultBytes(owner), 250_000_000);
  const solPool = (owned = RAYDIUM_CLMM, mints: [string, string] = [WSOL_MINT, USDC_MINT]) =>
    accountInfo(owned, clmmPoolAccount(mints[0], mints[1], SOL_SQRT_PRICE, [9, 6], [SOL_POOL_VAULT_0, SOL_POOL_USDC_VAULT]));
  const legPool = (index: number, owned = RAYDIUM_CLMM) => {
    const leg = LEG_POOLS[index]!;
    return accountInfo(owned, clmmPoolAccount(leg.mint, USDC_MINT, leg.sqrtPriceX64, [leg.decimals, 6], [leg.vault0, leg.usdcVault]));
  };
  /** Every offered leg's pool, in OFFERED_LEGS' order: the batch asks for them right after the SOL pool. */
  const legPools = () => LEG_POOLS.map((_, index) => legPool(index));
  /** A link with values that are not zero, so it is visible whether they survive the read. */
  const richLink = (wallet: string, savesInto = vault) =>
    account("TradingLink", { wallet, vault: savesInto, epoch: 12n, settlement_nonce: 5n, frontier_slot: 999n, bump: 254, _reserved: new Array(32).fill(0) });

  // ── the oracle at the tail ──────────────────────────────────────────────────
  // Mainnet's own two price accounts (fixtures/pyth-accounts.ts) under the
  // RECEIVER that owns them, and a chain clock chosen so every age asserted below
  // is a subtraction anyone can redo: 30 seconds after the captured publish.
  const CHAIN_NOW = PYTH_FIXTURE_PUBLISH_TIME + 30n;
  /** The sysvar's real owner. Nothing here checks it — the account is the runtime's own — but a fixture should not lie about it. */
  const SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
  const clockAccount = (unixSeconds = CHAIN_NOW, bytes = 40) => {
    const data = new Uint8Array(bytes);
    let left = BigInt.asUintN(64, unixSeconds);
    // unix_timestamp is the FIFTH field: an i64 LE at byte 32, after slot, epoch_start_timestamp, epoch and leader_schedule_epoch.
    for (let i = 0; i < 8 && 32 + i < bytes; i++) {
      data[32 + i] = Number(left & 0xffn);
      left >>= 8n;
    }
    return accountInfo(SYSVAR_OWNER, data, 1_169_280);
  };
  const feedAccount = (data: Uint8Array, owner = PYTH_FIXTURE_OWNER) => accountInfo(owner, data, 5_117_760);
  /** The three addresses appended after the wallets, all healthy. */
  const pythTail = (): unknown[] => [clockAccount(), feedAccount(PYTH_SOL_USD_ACCOUNT), feedAccount(PYTH_USDC_USD_ACCOUNT)];

  // ── the reserves at the very tail ───────────────────────────────────────────
  // One token account per priced pool, in PRICED_POOLS' order, each holding what
  // mainnet's own vault held. They come after the oracle for the same reason the
  // oracle came after the wallets: an index nothing else counts from.
  /** The three vault accounts appended after the oracle, all healthy. */
  const reserveTail = (): unknown[] => [
    poolVaultAccount(SOL_USDC_POOL, USDC_MINT, SOL_POOL_USDC_RESERVE),
    ...LEG_POOLS.map((leg) => poolVaultAccount(leg.pool, USDC_MINT, leg.usdcReserve)),
  ];

  type Member = { readonly rpcError: string } | { readonly result: unknown };
  const answered = (result: unknown): Member => ({ result });
  const broke = (message: string): Member => ({ rpcError: message });

  /**
   * The five members readLiveSnapshot asks for, each answerable or breakable on
   * its own. `values` is everything up to the wallets; the oracle's three
   * accounts and then the pools' three vaults are appended here, the way the
   * reader appends their addresses, so every case above stays about what it was
   * about and `pyth` and `reserves` can each be spoiled alone.
   */
  function livePool(
    values: readonly unknown[],
    plan: { accounts?: Member; tokens?: Member; rentVault?: Member; rentZero?: Member; links?: Member; pyth?: readonly unknown[]; reserves?: readonly unknown[] } = {},
    slot = 91,
  ) {
    const byId = new Map<number, Member>([
      [1, plan.accounts ?? answered({ context: { slot }, value: [...values, ...(plan.pyth ?? pythTail()), ...(plan.reserves ?? reserveTail())] })],
      // One null per target, so the default stub answers the whole ask rather than
      // a short list the reader must call unreadable. The addresses themselves are
      // pinned below, against vaultTokenAccountTargets.
      [2, plan.tokens ?? answered({ value: vaultTokenAccountTargets(vault).map(() => null) })],
      [3, plan.rentVault ?? answered(localRent(125))],
      [4, plan.rentZero ?? answered(localRent(0))],
      [5, plan.links ?? answered([])],
    ]);
    return pool((call) =>
      jsonResponse(
        batchOf(call).map((entry) => {
          const member = byId.get(Number(entry.id))!;
          return "rpcError" in member
            ? { jsonrpc: "2.0", id: entry.id, error: { code: -32000, message: member.rpcError } }
            : { jsonrpc: "2.0", id: entry.id, result: member.result };
        }),
      ),
    );
  }

  it("is ONE batch: the accounts in order, the vault's five token accounts, two rents, and getProgramAccounts only with discover", async () => {
    const [walletA, walletB] = [key(), key()];
    const { pool: p, upstream } = livePool([sipVault(), null, null, solPool(), ...legPools(), null, null, null, null]);
    await readLiveSnapshot(p, { owner, wallets: [walletA, walletB], discover: true });

    expect(upstream.calls).toHaveLength(1);
    const members = batchOf(upstream.calls[0]!);
    expect(members.map((member) => member.method)).toEqual([
      "getMultipleAccounts",
      "getMultipleAccounts",
      "getMinimumBalanceForRentExemption",
      "getMinimumBalanceForRentExemption",
      "getProgramAccounts",
    ]);
    expect(members[0]!.params[0]).toEqual([
      vault,
      policyAddress,
      configAddress,
      SOL_USDC_POOL,
      SPYX_USDC_POOL,
      ANTHROPIC_USDC_POOL,
      deriveLinkPda(walletA).toBase58(),
      deriveLinkPda(walletB).toBase58(),
      walletA,
      walletB,
      // THE TAIL, after everything: the chain's clock and the two feeds. The
      // pools are read from a fixed slice and the wallets from offsets counted
      // off it, so nothing here can be handed to the Raydium decoder.
      "SysvarC1ock11111111111111111111111111111111",
      PYTH_SOL_USD_FEED,
      PYTH_USDC_USD_FEED,
      // AND BEHIND THE ORACLE, one in-side vault per priced pool: the depth the
      // keeper's gate measures, in the batch that was being sent anyway. Written
      // out rather than spread from PRICED_POOL_IN_VAULTS, so a pool gained or
      // lost has to move these literals too.
      SOL_POOL_USDC_VAULT,
      LEG_POOLS[0]!.usdcVault,
      LEG_POOLS[1]!.usdcVault,
    ]);
    // The digit 1 in C1ock, and the receiver-owned feeds in order.
    expect(PYTH_SNAPSHOT_ADDRESSES).toEqual(["SysvarC1ock11111111111111111111111111111111", PYTH_SOL_USD_FEED, PYTH_USDC_USD_FEED]);
    // The documented cap still covers the widest ask: ten wallets, ten links, every
    // pool, the tail. Every count here is WRITTEN OUT and not read from
    // PRICED_POOLS, which is what the cap is derived from: three SIP accounts,
    // three priced pools (wSOL/USDC and one per offered leg), two per wallet,
    // the oracle's three, and one in-side vault per priced pool. A leg gained or lost has to move these literals.
    expect(MAX_LIVE_SNAPSHOT_ADDRESSES).toBe(3 + 3 + 2 * MAX_WALLET_LINKS + 3 + 3);
    expect(members[0]!.params[0]).toHaveLength(3 + 3 + 2 * 2 + 3 + 3);
    expect(members[0]!.params[1]).toEqual({ encoding: "base64", commitment: "confirmed" });
    // Read BY ADDRESS, never listed: no number of accounts anyone opens for the vault can make this unreadable.
    expect(members[1]!.params[0]).toEqual(vaultTokenAccountTargets(vault).map((target) => target.address));
    expect(members[1]!.params[1]).toEqual({ encoding: "jsonParsed", commitment: "confirmed" });
    expect(members[2]!.params).toEqual([SIP_ACCOUNT_SPACE.Vault]);
    expect(members[3]!.params).toEqual([0]);
    expect(members[4]!.params[1]).toMatchObject({ filters: [{ dataSize: SIP_ACCOUNT_SPACE.TradingLink }, { memcmp: { offset: 40, bytes: vault } }] });
  });

  it("without discover it asks four members and reports no link listing at all", async () => {
    const { pool: p, upstream } = livePool([sipVault(), null, null, solPool(), ...legPools()]);
    const read = await readLiveSnapshot(p, { owner, wallets: [], discover: false });
    expect(batchOf(upstream.calls[0]!).map((member) => member.method)).not.toContain("getProgramAccounts");
    expect(read.links).toBeNull();
    expect([read.slot, read.rents.vault, read.rents.walletFloor]).toEqual([91, BigInt(localRent(125)), BigInt(localRent(0))]);
  });

  it("a member that fails takes down ONLY its own part", async () => {
    const values = [sipVault(), null, null, solPool(), ...legPools()];
    const tokens = await readLiveSnapshot(livePool(values, { tokens: broke("no") }).pool, { owner, wallets: [], discover: false });
    expect([tokens.vault.kind, tokens.prices.kind, tokens.tokenAccounts.kind]).toEqual(["exists", "exists", "unreadable"]);

    const links = await readLiveSnapshot(livePool(values, { links: broke("no") }).pool, { owner, wallets: [], discover: true });
    expect([links.vault.kind, links.prices.kind, links.links?.kind]).toEqual(["exists", "exists", "unreadable"]);

    // The vault's rent is read, never derived, so a vault without one is unreadable rather than wrongly withdrawable.
    const rent = await readLiveSnapshot(livePool(values, { rentVault: broke("no") }).pool, { owner, wallets: [], discover: false });
    expect([rent.vault.kind, rent.prices.kind, rent.rents.vault]).toEqual(["unreadable", "exists", null]);
  });

  it("a failed batch makes EVERY part unreadable, never missing, and never quotes the endpoint", async () => {
    const wallet = key();
    const { pool: p } = pool(() => {
      throw new Error(`boom ${UPSTREAM_1}`);
    });
    const read = await readLiveSnapshot(p, { owner, wallets: [wallet], discover: true });
    expect([read.vault.kind, read.policy.kind, read.config.kind, read.prices.kind, read.tokenAccounts.kind, read.links?.kind]).toEqual([
      "unreadable",
      "unreadable",
      "unreadable",
      "unreadable",
      "unreadable",
      "unreadable",
    ]);
    // A balance nobody read is null; "0" would be a claim that the wallet is empty.
    expect(read.wallets).toEqual([{ wallet, lamports: null, link: { address: deriveLinkPda(wallet).toBase58(), status: "unreadable", vault: null, state: null } }]);
    expect(read.rents).toEqual({ vault: null, walletFloor: null });
    expect(JSON.stringify(read)).not.toContain(SECRET_QUERY);
  });

  it.each([
    ["the SOL pool owned by another program", () => [sipVault(), null, null, solPool(key()), ...legPools()]],
    ["the SOL pool with its mints swapped", () => [sipVault(), null, null, solPool(RAYDIUM_CLMM, [USDC_MINT, WSOL_MINT]), ...legPools()]],
    ["the SOL pool missing", () => [sipVault(), null, null, null, ...legPools()]],
    // Each spoiled pool is spoiled ALONE, with every other pool where it should be:
    // a leg's pool must be able to fail this on its own account. Both POSITIONS
    // in the pools' slice are spoiled, first and last, so neither an off-by-one
    // at the head of the slice nor one at its tail could pass this.
    ["a leg's pool owned by another program", () => [sipVault(), null, null, solPool(), legPool(0), legPool(1, key())]],
    ["the first leg's pool missing", () => [sipVault(), null, null, solPool(), null, legPool(1)]],
    ["the last leg's pool missing", () => [sipVault(), null, null, solPool(), legPool(0), null]],
  ])("%s gives NO price rather than a wrong one, and the vault is still read", async (_, values) => {
    const read = await readLiveSnapshot(livePool(values()).pool, { owner, wallets: [], discover: false });
    expect(read.prices.kind).toBe("unreadable");
    expect(read.vault.kind).toBe("exists");
  });


  describe("the oracle at the tail", () => {
    /** Everything up to the wallets, all of it healthy: livePool appends the oracle's three. */
    const upToWallets = () => [sipVault(), null, null, solPool(), ...legPools()];
    const readWith = (pyth?: readonly unknown[]) =>
      readLiveSnapshot(livePool(upToWallets(), pyth === undefined ? {} : { pyth }).pool, { owner, wallets: [], discover: false });
    const bothFeeds = () => [feedAccount(PYTH_SOL_USD_ACCOUNT), feedAccount(PYTH_USDC_USD_ACCOUNT)];

    it("reads both feeds in the same batch, and dates them by the CHAIN's clock", async () => {
      const read = await readWith();
      expect(read.pyth.kind).toBe("exists");
      if (read.pyth.kind !== "exists") return;
      // The rate pyth-price.test.ts pins over these very accounts, in the unit
      // prices.convertWad is already in: USDC raw per lamport x 1e18.
      expect(read.pyth.value.wad).toBe(102_606_509_293_604_451n);
      // 30 seconds after the captured publish, because that is what the CLOCK
      // ACCOUNT says — no clock of this host's enters the subtraction.
      expect([read.pyth.value.chainUnixSeconds, read.pyth.value.ageSeconds]).toEqual([CHAIN_NOW, 30n]);
      expect(read.pyth.value.sol).toMatchObject({
        price: 10_259_321_149n,
        conf: 1_384_501n,
        expo: -8,
        publishTime: PYTH_FIXTURE_PUBLISH_TIME,
        postedSlot: PYTH_FIXTURE_POSTED_SLOT,
      });
      expect(read.pyth.value.usdc).toMatchObject({ price: 99_987_040n, conf: 87_960n, expo: -8, publishTime: PYTH_FIXTURE_PUBLISH_TIME });
    });

    it("a different clock is a different age, ahead of the publish or behind it", async () => {
      const four = await readWith([clockAccount(PYTH_FIXTURE_PUBLISH_TIME + 4n), ...bothFeeds()]);
      expect(four.pyth.kind === "exists" && four.pyth.value.ageSeconds).toBe(4n);
      // A chain clock BEHIND the publish is reported as it is, not clamped to zero.
      const behind = await readWith([clockAccount(PYTH_FIXTURE_PUBLISH_TIME - 9n), ...bothFeeds()]);
      expect(behind.pyth.kind === "exists" && behind.pyth.value.ageSeconds).toBe(-9n);
    });

    it("finds the tail whatever the wallet count, because its offset is counted off both the pools and the wallets", async () => {
      const [a, b] = [key(), key()];
      const read = await readLiveSnapshot(livePool([...upToWallets(), null, null, null, null]).pool, { owner, wallets: [a, b], discover: false });
      expect(read.pyth.kind === "exists" && read.pyth.value.ageSeconds).toBe(30n);
      expect(read.wallets.map((wallet) => wallet.link.status)).toEqual(["missing", "missing"]);
    });

    it.each([
      ["a feed owned by a stranger", () => [clockAccount(), feedAccount(PYTH_SOL_USD_ACCOUNT, key()), feedAccount(PYTH_USDC_USD_ACCOUNT)]],
      // The exact confusion addresses.ts warns about: the address DERIVES under
      // the push program, so a feed it owned would pass every check but this one.
      ["a feed owned by the PUSH program its address derives under", () => [clockAccount(), feedAccount(PYTH_SOL_USD_ACCOUNT), feedAccount(PYTH_USDC_USD_ACCOUNT, PYTH_PUSH_PROGRAM)]],
      ["a feed missing entirely", () => [clockAccount(), null, feedAccount(PYTH_USDC_USD_ACCOUNT)]],
      ["both feeds missing", () => [clockAccount(), null, null]],
      ["the two feeds swapped, so each carries the id the other was asked for", () => [clockAccount(), feedAccount(PYTH_USDC_USD_ACCOUNT), feedAccount(PYTH_SOL_USD_ACCOUNT)]],
      ["the clock missing", () => [null, ...bothFeeds()]],
      ["a clock too short to hold a timestamp", () => [clockAccount(CHAIN_NOW, 32), ...bothFeeds()]],
    ])("%s gives NO oracle, and leaves the prices panel untouched", async (_, pyth) => {
      const good = await readWith();
      const read = await readWith(pyth());
      expect(read.pyth.kind).toBe("unreadable");
      // Not merely still readable: the SAME answer a healthy read gives, to the
      // last bigint. A dead feed may cost the dashboard its oracle and nothing else.
      expect(read.prices).toEqual(good.prices);
      expect(good.prices.kind).toBe("exists");
      expect([read.vault.kind, read.tokenAccounts.kind, read.rents.vault !== null]).toEqual(["exists", "exists", true]);
    });

    it("says why a wrong owner was refused, naming both the stranger and the receiver that must own it", async () => {
      const stranger = key();
      const read = await readWith([clockAccount(), feedAccount(PYTH_SOL_USD_ACCOUNT, stranger), feedAccount(PYTH_USDC_USD_ACCOUNT)]);
      const error = read.pyth.kind === "unreadable" ? read.pyth.error : "";
      expect(error).toContain(stranger);
      expect(error).toContain(PYTH_RECEIVER_PROGRAM);
      expect(error).toContain(PYTH_SOL_USD_FEED);
    });

    it("and the other way round: a pool SaverFi does not pin leaves the oracle standing", async () => {
      const read = await readLiveSnapshot(livePool([sipVault(), null, null, solPool(key()), ...legPools()]).pool, { owner, wallets: [], discover: false });
      expect(read.prices.kind).toBe("unreadable");
      expect(read.pyth.kind === "exists" && read.pyth.value.wad).toBe(102_606_509_293_604_451n);
    });

    it("a failed batch takes the oracle down with everything else, rather than reporting a price nobody read", async () => {
      const { pool: p } = pool(() => {
        throw new Error(`boom ${UPSTREAM_1}`);
      });
      const read = await readLiveSnapshot(p, { owner, wallets: [], discover: false });
      expect([read.prices.kind, read.pyth.kind]).toEqual(["unreadable", "unreadable"]);
      expect(JSON.stringify(read)).not.toContain(SECRET_QUERY);
    });
  });

  describe("the reserves behind the oracle", () => {
    /** Everything up to the wallets, all of it healthy: livePool appends the oracle's three and then the pools' three vaults. */
    const upToWallets = () => [sipVault(), null, null, solPool(), ...legPools()];
    const readWith = (reserves?: readonly unknown[]) =>
      readLiveSnapshot(livePool(upToWallets(), reserves === undefined ? {} : { reserves }).pool, { owner, wallets: [], discover: false });
    const amountsOf = (read: Awaited<ReturnType<typeof readWith>>) =>
      read.reserves.kind === "exists" ? read.reserves.value.items.map((item) => item.amountRaw) : null;

    it("reads each priced pool's IN-SIDE vault in the same batch, at the same slot as the prices", async () => {
      const read = await readWith();
      expect(read.reserves.kind).toBe("exists");
      if (read.reserves.kind !== "exists") return;
      expect(read.reserves.value.slot).toBe(91);
      expect(read.reserves.value.items.map((item) => [item.pool, item.vault, item.amountRaw])).toEqual([
        [SOL_USDC_POOL, SOL_POOL_USDC_VAULT, SOL_POOL_USDC_RESERVE],
        [SPYX_USDC_POOL, LEG_POOLS[0]!.usdcVault, LEG_POOLS[0]!.usdcReserve],
        [ANTHROPIC_USDC_POOL, LEG_POOLS[1]!.usdcVault, LEG_POOLS[1]!.usdcReserve],
      ]);
      // The same one batch the snapshot always was: four members, no fifth read
      // for the vaults the keeper has to fetch separately.
      expect(read.prices.kind).toBe("exists");
    });

    it("finds its vaults whatever the wallet count, because they sit behind the oracle at the very end", async () => {
      const [a, b] = [key(), key()];
      const read = await readLiveSnapshot(livePool([...upToWallets(), null, null, null, null]).pool, { owner, wallets: [a, b], discover: false });
      expect(amountsOf(read)).toEqual([SOL_POOL_USDC_RESERVE, LEG_POOLS[0]!.usdcReserve, LEG_POOLS[1]!.usdcReserve]);
      expect(read.pyth.kind === "exists" && read.pyth.value.ageSeconds).toBe(30n);
    });

    it.each([
      ["a vault missing entirely", () => [null, poolVaultAccount(SPYX_USDC_POOL, USDC_MINT, LEG_POOLS[0]!.usdcReserve), poolVaultAccount(ANTHROPIC_USDC_POOL, USDC_MINT, LEG_POOLS[1]!.usdcReserve)]],
      [
        "a vault holding the wrong mint",
        () => [
          poolVaultAccount(SOL_USDC_POOL, WSOL_MINT, SOL_POOL_USDC_RESERVE),
          poolVaultAccount(SPYX_USDC_POOL, USDC_MINT, LEG_POOLS[0]!.usdcReserve),
          poolVaultAccount(ANTHROPIC_USDC_POOL, USDC_MINT, LEG_POOLS[1]!.usdcReserve),
        ],
      ],
      ["every vault missing", () => [null, null, null]],
    ])("%s gives NO reserve for that pool, and leaves the prices and the oracle untouched", async (_, reserves) => {
      const good = await readWith();
      const read = await readWith(reserves());
      // Not merely still readable: the SAME answer a healthy read gives, to the
      // last bigint. A vault nobody could read costs the panel its ceiling and
      // nothing else.
      expect(read.prices).toEqual(good.prices);
      expect(read.pyth).toEqual(good.pyth);
      expect(good.prices.kind).toBe("exists");
      expect(amountsOf(read)![0]).toBeNull();
      // NULL, NOT ZERO: a reserve of nothing would have the panel tell the owner
      // their basket is dead when it was only unread.
      expect(amountsOf(read)![0]).not.toBe(0n);
      expect([read.vault.kind, read.tokenAccounts.kind]).toEqual(["exists", "exists"]);
    });

    it("and the other way round: a pool SaverFi does not pin leaves the reserves standing", async () => {
      const read = await readLiveSnapshot(livePool([sipVault(), null, null, solPool(key()), ...legPools()]).pool, { owner, wallets: [], discover: false });
      expect(read.prices.kind).toBe("unreadable");
      // The pool is still Raydium's bytes under the wrong owner, so its OWN
      // reserve is refused; the two legs' are not.
      expect(amountsOf(read)).toEqual([null, LEG_POOLS[0]!.usdcReserve, LEG_POOLS[1]!.usdcReserve]);
    });

    it("a failed batch leaves the reserves UNREADABLE, never a list of zeros", async () => {
      const { pool: p } = pool(() => {
        throw new Error(`boom ${UPSTREAM_1}`);
      });
      const read = await readLiveSnapshot(p, { owner, wallets: [], discover: false });
      expect(read.reserves.kind).toBe("unreadable");
      expect(JSON.stringify(read)).not.toContain(SECRET_QUERY);
    });
  });

  it("a link another program owns, or one naming another wallet, is unreadable — never this wallet's", async () => {
    const [mine, forged, impostor, absent] = [key(), key(), key(), key()];
    const values = [
      sipVault(),
      null,
      null,
      solPool(),
      ...legPools(),
      accountInfo(SIP_PROGRAM_ID, richLink(mine)),
      accountInfo(key(), richLink(forged)),
      accountInfo(SIP_PROGRAM_ID, richLink(key())),
      null,
      null,
      null,
      null,
      null,
    ];
    const read = await readLiveSnapshot(livePool(values).pool, { owner, wallets: [mine, forged, impostor, absent], discover: false });
    expect(read.wallets.map((wallet) => wallet.link.status)).toEqual(["this_vault", "unreadable", "unreadable", "missing"]);
    expect(read.wallets[1]!.link.state).toBeNull();
  });

  it("a wallet the chain answers null for holds 0, and a link that WAS read keeps its epoch, nonce and frontier", async () => {
    const wallet = key();
    const other = key();
    const values = [
      sipVault(),
      null,
      null,
      solPool(),
      ...legPools(),
      accountInfo(SIP_PROGRAM_ID, richLink(wallet)),
      accountInfo(SIP_PROGRAM_ID, richLink(other, deriveVaultPda(key()).toBase58())),
      null,
      accountInfo(SYSTEM_PROGRAM, new Uint8Array(0), 420_000_000),
    ];
    const read = await readLiveSnapshot(livePool(values).pool, { owner, wallets: [wallet, other], discover: false });
    expect(read.wallets[0]).toMatchObject({ wallet, lamports: 0n, link: { status: "this_vault", vault } });
    expect(read.wallets[0]!.link.state).toMatchObject({ epoch: 12n, settlementNonce: 5n, frontierSlot: 999n });
    expect(read.wallets[1]).toMatchObject({ wallet: other, lamports: 420_000_000n, link: { status: "other_vault" } });
  });

  it("discover re-reads the vault field of every link the RPC filtered, because the RPC is not the trust boundary", async () => {
    const [mine, theirs] = [key(), key()];
    const listed = [
      { pubkey: deriveLinkPda(mine).toBase58(), account: accountInfo(SIP_PROGRAM_ID, richLink(mine)) },
      { pubkey: deriveLinkPda(theirs).toBase58(), account: accountInfo(SIP_PROGRAM_ID, richLink(theirs, deriveVaultPda(key()).toBase58())) },
      { pubkey: deriveLinkPda(key()).toBase58(), account: accountInfo(key(), richLink(key())) },
    ];
    const read = await readLiveSnapshot(livePool([sipVault(), null, null, solPool(), ...legPools()], { links: answered(listed) }).pool, { owner, wallets: [], discover: true });
    expect(read.links?.kind).toBe("exists");
    expect(read.links?.kind === "exists" && read.links.value.map((link) => link.state.wallet)).toEqual([mine]);
  });

  it("refuses more than the limit, a repeated wallet, a wallet that is not a key, and the owner among its own trading wallets", async () => {
    const { pool: p, upstream } = livePool([]);
    const repeated = key();
    await expect(readLiveSnapshot(p, { owner, wallets: Array.from({ length: MAX_WALLET_LINKS + 1 }, key), discover: false })).rejects.toThrow(RangeError);
    await expect(readLiveSnapshot(p, { owner, wallets: [repeated, repeated], discover: false })).rejects.toThrow(RangeError);
    await expect(readLiveSnapshot(p, { owner, wallets: ["nope"], discover: false })).rejects.toThrow(RangeError);
    await expect(readLiveSnapshot(p, { owner, wallets: [owner], discover: false })).rejects.toThrow(RangeError);
    await expect(readLiveSnapshot(p, { owner: "nope", wallets: [], discover: false })).rejects.toThrow(RangeError);
    expect(upstream.calls).toHaveLength(0);
  });
});

describe("listVaultSignatures and readVaultTransactions", () => {
  const vault = key();

  it("passes before and until through, and reports a full page's cursor", async () => {
    const signature = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => i + 1));
    const until = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => i + 2));
    const { pool: p, upstream } = pool((call) => rpcResult(call, [{ signature, slot: 10, blockTime: 1_700_000_000, err: null }]));

    const page = await listVaultSignatures(p, vault, { limit: 1, until });
    expect(page.kind === "exists" && page.value.nextBefore).toBe(signature);
    expect((upstream.calls[0]!.body as { params: unknown[] }).params).toEqual([vault, { limit: 1, commitment: "confirmed", until }]);

    await listVaultSignatures(p, vault, { limit: 5, before: signature });
    expect((upstream.calls[1]!.body as { params: unknown[] }).params).toEqual([vault, { limit: 5, commitment: "confirmed", before: signature }]);

    // A page shorter than the limit is the end of the history.
    const short = await listVaultSignatures(p, vault, { limit: 5 });
    expect(short.kind === "exists" && short.value.nextBefore).toBeNull();
  });

  it("reads nothing when nothing was listed, and refuses a cursor that is not a signature", async () => {
    const { pool: p, upstream } = pool((call) => rpcResult(call, []));
    expect(await readVaultTransactions(p, vault, [])).toEqual({ kind: "exists", value: [] });
    expect(upstream.calls).toHaveLength(0);
    await expect(listVaultSignatures(p, vault, { before: "nope" })).rejects.toThrow(RangeError);
    await expect(listVaultSignatures(p, vault, { until: "nope" })).rejects.toThrow(RangeError);
    await expect(listVaultSignatures(p, vault, { limit: 26 })).rejects.toThrow(RangeError);
  });

  it("decodes each SIP instruction's arguments, DROPS venue_data, and names its accounts from the IDL", async () => {
    const [crank, config, policy, vaultWsol, vaultIn, venue] = [key(), key(), key(), key(), key(), key()];
    const data = encodeArgs("convert", { amount_in: 10_000_000n, min_out: 900_000n, venue_data: Uint8Array.from([1, 2, 3, 4]) });
    const { pool: p } = pool((call) => {
      if (!Array.isArray(call.body)) return rpcResult(call, [{ signature: SIGNATURE, slot: 10, blockTime: 1, err: null }]);
      return jsonResponse([
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 10,
            blockTime: 1,
            meta: { err: null, fee: 5_000, preBalances: [1, 1, 1, 1, 1, 1, 1, 1], postBalances: [1, 1, 1, 1, 1, 1, 1, 1], logMessages: [], loadedAddresses: { writable: [], readonly: [] } },
            transaction: {
              message: {
                accountKeys: [crank, config, vault, policy, vaultWsol, vaultIn, venue, SIP_PROGRAM_ID],
                instructions: [{ programIdIndex: 7, accounts: [0, 1, 2, 3, 4, 5, 6], data: base58Encode(data) }],
              },
            },
          },
        },
      ]);
    });
    const page = await listVaultSignatures(p, vault, { limit: 1 });
    const read = await readVaultTransactions(p, vault, page.kind === "exists" ? page.value.listed : []);
    if (read.kind !== "exists") throw new Error(read.kind);
    const [call] = read.value[0]!.instructions;
    expect(call!.name).toBe("convert");
    // venue_data is an opaque venue blob: decoded, then dropped.
    expect(call!.args).toEqual({ amount_in: 10_000_000n, min_out: 900_000n });
    expect(call!.args).not.toHaveProperty("venue_data");
    expect(call!.accounts).toEqual({ crank, config, vault, policy, vault_wsol: vaultWsol, vault_in: vaultIn, venue_program: venue });
    expect(read.value[0]!.sipInstructions).toEqual(["convert"]);
    expect(read.value[0]!.readable).toBe(true);
  });

  it("keeps only the token balances the VAULT owns, counts a missing side as 0, and finds the vault among the loaded addresses", async () => {
    const [signer, stranger, strangerAccount, vaultUsdc, vaultSpyx] = [key(), key(), key(), key(), key()];
    const balance = (accountIndex: number, mint: string, ownerOf: string, amount: string, ui: string, decimals = 6) => ({
      accountIndex,
      mint,
      owner: ownerOf,
      uiTokenAmount: { amount, decimals, uiAmountString: ui },
    });
    const { pool: p } = pool((call) => {
      if (!Array.isArray(call.body)) return rpcResult(call, [{ signature: SIGNATURE, slot: 10, blockTime: 1, err: null }]);
      return jsonResponse([
        {
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 10,
            blockTime: 1,
            meta: {
              err: null,
              fee: 5_000,
              // The vault sits at index 3, which only exists once the loaded addresses are appended.
              preBalances: [1, 1, 1, 10_000_000, 1, 1],
              postBalances: [1, 1, 1, 70_000_000, 1, 1],
              preTokenBalances: [balance(4, USDC_MINT, vault, "5000000", "5"), balance(2, SPYX_MINT, stranger, "999", "0.9", 8)],
              postTokenBalances: [balance(5, SPYX_MINT, vault, "11345678", "0.1241643", 8), balance(2, SPYX_MINT, stranger, "0", "0", 8)],
              logMessages: [],
              loadedAddresses: { writable: [vault, vaultUsdc, vaultSpyx], readonly: [] },
            },
            transaction: { message: { accountKeys: [signer, strangerAccount, strangerAccount], instructions: [] } },
          },
        },
      ]);
    });
    const page = await listVaultSignatures(p, vault, { limit: 1 });
    const read = await readVaultTransactions(p, vault, page.kind === "exists" ? page.value.listed : []);
    if (read.kind !== "exists") throw new Error(read.kind);
    const entry = read.value[0]!;
    expect(entry.vaultLamportsDelta).toBe(60_000_000n);
    // The stranger's account is not this vault's business, whatever it did.
    expect(entry.vaultTokenDeltas).toEqual([
      { account: vaultUsdc, mint: USDC_MINT, decimals: 6, preRaw: "5000000", postRaw: "0", preUi: "5", postUi: "0" },
      { account: vaultSpyx, mint: SPYX_MINT, decimals: 8, preRaw: "0", postRaw: "11345678", preUi: "0", postUi: "0.1241643" },
    ]);
  });

  it("a transaction the batch could not answer is readable false, which is not the same as an empty one", async () => {
    const { pool: p } = pool((call) => {
      if (!Array.isArray(call.body)) return rpcResult(call, [{ signature: SIGNATURE, slot: 10, blockTime: 7, err: null }]);
      return jsonResponse([{ jsonrpc: "2.0", id: 1, result: null }]);
    });
    const page = await listVaultSignatures(p, vault, { limit: 1 });
    const read = await readVaultTransactions(p, vault, page.kind === "exists" ? page.value.listed : []);
    if (read.kind !== "exists") throw new Error(read.kind);
    expect(read.value[0]).toMatchObject({ readable: false, fee: null, vaultLamportsDelta: null, blockTime: 7 });
    expect(read.value[0]!.instructions).toEqual([]);
  });
});

describe("readWalletLinks", () => {
  it("names each wallet's link this vault, another vault, missing or unreadable, in one call, never conflating them", async () => {
    const vault = key();
    const [mine, theirs, fresh, forged, impostor] = [key(), key(), key(), key(), key()];
    const { pool: p, upstream } = pool((call) =>
      rpcResult(call, {
        value: [
          accountInfo(SIP_PROGRAM_ID, linkBytes(mine, vault)),
          accountInfo(SIP_PROGRAM_ID, linkBytes(theirs, key())),
          null,
          accountInfo(key(), linkBytes(forged, vault)),
          // The account at impostor's link address names another wallet.
          accountInfo(SIP_PROGRAM_ID, linkBytes(key(), vault)),
        ],
      }),
    );
    const read = await readWalletLinks(p, vault, [mine, theirs, fresh, forged, impostor]);
    expect(read.map((link) => link.status)).toEqual(["this_vault", "other_vault", "missing", "unreadable", "unreadable"]);
    expect(read.map((link) => link.link)).toEqual([mine, theirs, fresh, forged, impostor].map((wallet) => deriveLinkPda(wallet).toBase58()));
    expect(read[0]!.vault).toBe(vault);
    expect(read[1]!.vault).not.toBe(vault);
    expect([read[2]!.vault, read[3]!.vault]).toEqual([null, null]);
    expect(upstream.calls).toHaveLength(1);
  });

  it("a failed read makes every wallet unreadable; no wallets asks nothing; more than the limit is refused", async () => {
    const down = pool(() => {
      throw new Error(`boom ${UPSTREAM_1}`);
    });
    expect((await readWalletLinks(down.pool, key(), [key(), key()])).map((link) => link.status)).toEqual(["unreadable", "unreadable"]);
    const idle = pool((call) => rpcResult(call, { value: [] }));
    expect(await readWalletLinks(idle.pool, key(), [])).toEqual([]);
    expect(idle.upstream.calls).toHaveLength(0);
    await expect(readWalletLinks(idle.pool, key(), Array.from({ length: MAX_WALLET_LINKS + 1 }, key))).rejects.toThrow(RangeError);
  });
});
