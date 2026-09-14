// Server-side readers over a stub pool: the ownership gate, tri-state results, history.

import { describe, expect, it } from "vitest";

import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../src/client/addresses";
import { base58Encode } from "../src/client/base58";
import { base64Encode } from "../src/client/base64";
import { encodeStruct } from "../src/client/borsh";
import { SIP_ACCOUNT_SPACE } from "../src/client/decoders";
import { SIP_PROGRAM_ID, accountDiscriminator, eventDiscriminator, instructionDiscriminator } from "../src/client/idl";
import { deriveConfigPda, deriveInvestPda, deriveVaultPda } from "../src/server/pda";
import {
  listVaultActivity,
  listVaultHoldings,
  listVaultLinks,
  readOwnerAccounts,
  readProtocolConfig,
  readVault,
  settledEventsFromLogs,
} from "../src/server/readers";
import { createRpcPool } from "../src/server/rpc-pool";
import { SECRET_QUERY, UPSTREAM_1, accountInfo, fakeFetch, jsonResponse, keypair, rpcResult, type UpstreamCall } from "./helpers";

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
  const body = encodeStruct("Settled", { vault, wallet, mode: 1, base_lamports: 100n, bps: 10, owed: paid, paid, settlement_nonce: 1n, session_end_slot: 2n });
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
