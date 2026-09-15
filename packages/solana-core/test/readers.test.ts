// Server-side readers over a stub pool: the ownership gate, tri-state results, history.

import { describe, expect, it } from "vitest";

import { RAYDIUM_CLMM, SOL_USDC_POOL, SPYX_MINT, SPYX_USDC_POOL, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from "../src/client/addresses";
import { SOL_SQRT_PRICE, SPYX_SQRT_PRICE, clmmPoolAccount } from "./chain-fixtures";
import { base58Encode } from "../src/client/base58";
import { base64Encode } from "../src/client/base64";
import { encodeStruct } from "../src/client/borsh";
import { SIP_ACCOUNT_SPACE } from "../src/client/decoders";
import { SIP_PROGRAM_ID, accountDiscriminator, eventDiscriminator, instructionDiscriminator } from "../src/client/idl";
import { deriveAta, deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda } from "../src/server/pda";
import {
  MAX_WALLET_LINKS,
  listVaultActivity,
  listVaultHoldings,
  listVaultLinks,
  readBuildBatch,
  readOwnerAccounts,
  readPoolPrices,
  readProtocolConfig,
  readVault,
  readVaultTokenAccounts,
  readWalletLinks,
  settledEventsFromLogs,
  tokenAccountStatus,
  vaultTokenAccountTargets,
} from "../src/server/readers";
import { createRpcPool } from "../src/server/rpc-pool";
import { BLOCKHASH, SECRET_QUERY, UPSTREAM_1, accountInfo, fakeFetch, jsonResponse, keypair, rpcResult, type UpstreamCall } from "./helpers";

const key = (): string => keypair().publicKey.toBase58();

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
  const solPool = (owner = RAYDIUM_CLMM, mints: [string, string] = [WSOL_MINT, USDC_MINT]) => accountInfo(owner, clmmPoolAccount(mints[0], mints[1], SOL_SQRT_PRICE));
  const spyxPool = (owner = RAYDIUM_CLMM, mints: [string, string] = [SPYX_MINT, USDC_MINT]) => accountInfo(owner, clmmPoolAccount(mints[0], mints[1], SPYX_SQRT_PRICE, [8, 6]));

  it("reads both pinned pools in one call, and their rates are the mainnet goldens", async () => {
    const { pool: p, upstream } = pool((call) => rpcResult(call, { context: { slot: 99 }, value: [solPool(), spyxPool()] }));
    expect(await readPoolPrices(p)).toEqual({ kind: "exists", value: { slot: 99, convertWad: 100_038_711_555_492_562n, legWads: { [SPYX_MINT]: 131_283_650_130_637_569n } } });
    expect(upstream.calls).toHaveLength(1);
    expect((upstream.calls[0]!.body as { params: unknown[] }).params).toEqual([[SOL_USDC_POOL, SPYX_USDC_POOL], { encoding: "base64", commitment: "confirmed" }]);
  });

  it.each([
    ["the SOL pool owned by another program", () => [solPool(key()), spyxPool()]],
    ["the SOL pool with its mints swapped", () => [solPool(RAYDIUM_CLMM, [USDC_MINT, WSOL_MINT]), spyxPool()]],
    ["the SPYx pool with its mints swapped", () => [solPool(), spyxPool(RAYDIUM_CLMM, [USDC_MINT, SPYX_MINT])]],
    ["a pool that does not exist", () => [solPool(), null]],
    ["one account where two were asked", () => [solPool()]],
  ])("%s is unreadable, never a price", async (_, accounts) => {
    const { pool: p } = pool((call) => rpcResult(call, { context: { slot: 1 }, value: accounts() }));
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
  it("wSOL and USDC under SPL Token at 165 bytes, then SPYx under Token-2022 at 179, each at the vault's associated address", () => {
    const vault = key();
    expect(vaultTokenAccountTargets(vault)).toEqual([
      { mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM, bytes: 165, address: deriveAta(vault, WSOL_MINT, TOKEN_PROGRAM).toBase58() },
      { mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM, bytes: 165, address: deriveAta(vault, USDC_MINT, TOKEN_PROGRAM).toBase58() },
      { mint: SPYX_MINT, tokenProgram: TOKEN_2022_PROGRAM, bytes: 179, address: deriveAta(vault, SPYX_MINT, TOKEN_2022_PROGRAM).toBase58() },
    ]);
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
    const { pool: p, upstream } = pool((call) => rpcResult(call, { value: [accountInfo(TOKEN_PROGRAM, new Uint8Array(165)), null, accountInfo(key(), new Uint8Array(179))] }));
    const read = await readVaultTokenAccounts(p, vault);
    expect(upstream.calls).toHaveLength(1);
    expect(read.kind === "exists" && read.value.map((entry) => [entry.mint, entry.status])).toEqual([
      [WSOL_MINT, "exists"],
      [USDC_MINT, "missing"],
      [SPYX_MINT, "unreadable"],
    ]);
    const down = pool(() => {
      throw new Error(`boom ${UPSTREAM_1}`);
    });
    const failed = await readVaultTokenAccounts(down.pool, vault);
    expect(failed.kind).toBe("unreadable");
    expect(JSON.stringify(failed)).not.toContain(SECRET_QUERY);
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
