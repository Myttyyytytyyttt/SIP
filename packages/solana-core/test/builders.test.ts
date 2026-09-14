// Builder bytes, checked against Anchor's own instruction coder from the IDL.

import { createRequire } from "node:module";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { ATA_PROGRAM, RAYDIUM_CLMM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "../src/client/addresses";
import { base58Encode } from "../src/client/base58";
import { SIP_PROGRAM_ID, idlInstruction, toHex, type OwnerInstructionName } from "../src/client/idl";
import {
  BuildError,
  WalletIsOwnerError,
  buildCreateVaultV2,
  buildLinkWallet,
  buildSetInvestPolicy,
  buildSetPolicyV2,
  buildUnlinkWallet,
  buildWithdraw,
  buildWithdrawToken,
  sipInstruction,
  type BuiltTransaction,
} from "../src/server/builders";
import { BLOCKHASH, fromB64, keypair } from "./helpers";

const require = createRequire(import.meta.url);
const rawIdl = require("@sip/solana-program/idl") as anchor.Idl;
const anchorCoder = new anchor.BorshInstructionCoder(rawIdl);
const BN = anchor.BN;
const PROGRAM = new PublicKey(SIP_PROGRAM_ID);
const text = new TextEncoder();

const pda = (...seeds: Uint8Array[]): string => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0].toBase58();
const ata = (owner: PublicKey, mint: PublicKey, program: string): string =>
  PublicKey.findProgramAddressSync([owner.toBytes(), new PublicKey(program).toBytes(), mint.toBytes()], new PublicKey(ATA_PROGRAM))[0].toBase58();

/** The single SIP instruction of an unsigned built transaction, with its accounts resolved. */
function decodeBuilt(built: BuiltTransaction): { data: Uint8Array; accounts: string[]; signers: string[]; signerFlags: boolean[]; writableFlags: boolean[] } {
  const tx = VersionedTransaction.deserialize(fromB64(built.txBase64));
  const message = tx.message;
  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  expect(message.compiledInstructions).toHaveLength(1);
  const instruction = message.compiledInstructions[0]!;
  expect(keys[instruction.programIdIndex]).toBe(SIP_PROGRAM_ID);
  expect(base58Encode(message.recentBlockhash ? new PublicKey(message.recentBlockhash).toBytes() : new Uint8Array())).toBe(BLOCKHASH);
  expect(tx.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
  return {
    data: Uint8Array.from(instruction.data),
    accounts: instruction.accountKeyIndexes.map((index) => keys[index]!),
    signers: keys.slice(0, message.header.numRequiredSignatures),
    signerFlags: instruction.accountKeyIndexes.map((index) => message.isAccountSigner(index)),
    writableFlags: instruction.accountKeyIndexes.map((index) => message.isAccountWritable(index)),
  };
}

function expectIdlShape(name: OwnerInstructionName, built: BuiltTransaction): void {
  const decoded = decodeBuilt(built);
  const idl = idlInstruction(name);
  expect(decoded.accounts).toEqual(idl.accounts.map((account) => built.accounts[account.name]));
  idl.accounts.forEach((account, index) => {
    // The message merges flags per key, so an IDL flag must be present; it may
    // be widened only when the same key appears twice (unlink by the owner).
    if (account.signer === true) expect(decoded.signerFlags[index]).toBe(true);
    if (account.writable === true) expect(decoded.writableFlags[index]).toBe(true);
    if (account.address !== undefined) expect(decoded.accounts[index]).toBe(account.address);
  });
  expect(decoded.signers).toEqual(built.signers);
  expect(built.feePayer).toBe(built.signers[0]);
}

describe("sipInstruction", () => {
  it("takes metas from the IDL in order, with its signer and writable flags", () => {
    const owner = keypair().publicKey;
    const wallet = keypair().publicKey;
    const ix = sipInstruction("link_wallet", { owner, wallet, vault: owner, trading_link: wallet }, {});
    const idl = idlInstruction("link_wallet");
    expect(ix.keys.map((meta) => [meta.isSigner, meta.isWritable])).toEqual(idl.accounts.map((account) => [account.signer === true, account.writable === true]));
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(() => sipInstruction("withdraw", { owner, vault: owner, stranger: owner }, { amount: 1n })).toThrow(BuildError);
    expect(() => sipInstruction("withdraw", { owner }, { amount: 1n })).toThrow(/needs the vault account/);
  });
});

describe("create_vault_v2 and set_policy_v2", () => {
  it("create_vault_v2: 29 bytes, Anchor's encoding, owner signs and pays, vault = ['vault', owner]", () => {
    const owner = keypair().publicKey;
    const built = buildCreateVaultV2({ owner, mode: 1, skimBps: 2_000, volumeBps: 10, maxContribution: 1_000_000_000n, walletReserve: 5_000_000n, blockhash: BLOCKHASH });
    const decoded = decodeBuilt(built);
    expect(decoded.data).toHaveLength(29);
    expect(toHex(decoded.data.subarray(0, 8))).toBe("95e05a32579f1fdd");
    const expected = anchorCoder.encode("create_vault_v2", { mode: 1, skim_bps: 2_000, volume_bps: 10, max_contribution: new BN(1_000_000_000), wallet_reserve: new BN(5_000_000) });
    expect(toHex(decoded.data)).toBe(toHex(expected));
    expect(built.vault).toBe(pda(text.encode("vault"), owner.toBytes()));
    expect(built.signers).toEqual([owner.toBase58()]);
    expectIdlShape("create_vault_v2", built);
  });

  it("set_policy_v2: 30 bytes with paused, Anchor's encoding", () => {
    const owner = keypair().publicKey;
    const built = buildSetPolicyV2({ owner, mode: 0, skimBps: 10_000, volumeBps: 1, paused: true, maxContribution: 1n, walletReserve: 0n, blockhash: BLOCKHASH });
    const decoded = decodeBuilt(built);
    expect(decoded.data).toHaveLength(30);
    expect(toHex(decoded.data.subarray(0, 8))).toBe("07aad030ac9e49df");
    const expected = anchorCoder.encode("set_policy_v2", { mode: 0, skim_bps: 10_000, volume_bps: 1, paused: true, max_contribution: new BN(1), wallet_reserve: new BN(0) });
    expect(toHex(decoded.data)).toBe(toHex(expected));
    expectIdlShape("set_policy_v2", built);
  });

  it.each([
    ["skim 100", { skimBps: 100 }],
    ["skim 10001", { skimBps: 10_001 }],
    ["volume 0", { volumeBps: 0 }],
    ["volume 101", { volumeBps: 101 }],
    ["mode 2", { mode: 2 }],
    ["max contribution 0", { maxContribution: 0n }],
  ] as const)("refuses %s", (_, overrides) => {
    const base = { owner: keypair().publicKey, mode: 1, skimBps: 2_000, volumeBps: 10, maxContribution: 1_000n, walletReserve: 0n, blockhash: BLOCKHASH };
    expect(() => buildCreateVaultV2({ ...base, ...overrides })).toThrow(BuildError);
    expect(() => buildSetPolicyV2({ ...base, paused: false, ...overrides })).toThrow(BuildError);
  });

  it("refuses a malformed blockhash and a malformed owner", () => {
    const base = { mode: 1, skimBps: 2_000, volumeBps: 10, maxContribution: 1_000n, walletReserve: 0n };
    expect(() => buildCreateVaultV2({ ...base, owner: keypair().publicKey, blockhash: "not-a-hash" })).toThrow(/blockhash/);
    expect(() => buildCreateVaultV2({ ...base, owner: "0OIl", blockhash: BLOCKHASH })).toThrow(BuildError);
  });
});

describe("link_wallet and unlink_wallet", () => {
  it("link_wallet: discriminator only, signers [owner, wallet], trading_link = ['link', wallet]", () => {
    const owner = keypair().publicKey;
    const wallet = keypair().publicKey;
    const built = buildLinkWallet({ owner, wallet, blockhash: BLOCKHASH });
    const decoded = decodeBuilt(built);
    expect(toHex(decoded.data)).toBe("565c1f92e433d1e6");
    expect(toHex(decoded.data)).toBe(toHex(anchorCoder.encode("link_wallet", {})));
    expect(built.signers).toEqual([owner.toBase58(), wallet.toBase58()]);
    expect(built.tradingLink).toBe(pda(text.encode("link"), wallet.toBytes()));
    expectIdlShape("link_wallet", built);
  });

  it("link_wallet refuses the owner's own key as the trading wallet", () => {
    const owner = keypair().publicKey;
    expect(() => buildLinkWallet({ owner, wallet: owner, blockhash: BLOCKHASH })).toThrow(WalletIsOwnerError);
    expect(() => buildLinkWallet({ owner: owner.toBase58(), wallet: owner.toBase58(), blockhash: BLOCKHASH })).toThrow(WalletIsOwnerError);
  });

  it("unlink_wallet by the owner: one signer, the owner is authority and rent destination", () => {
    const owner = keypair().publicKey;
    const wallet = keypair().publicKey;
    const built = buildUnlinkWallet({ owner, wallet, blockhash: BLOCKHASH });
    expect(toHex(decodeBuilt(built).data)).toBe("dc79610dc189d19f");
    expect(built.signers).toEqual([owner.toBase58()]);
    expect(built.accounts.authority).toBe(owner.toBase58());
    expect(built.accounts.owner).toBe(owner.toBase58());
    expectIdlShape("unlink_wallet", built);
  });

  it("unlink_wallet by the wallet: the owner pays, the wallet is the authority", () => {
    const owner = keypair().publicKey;
    const wallet = keypair().publicKey;
    const built = buildUnlinkWallet({ owner, wallet, blockhash: BLOCKHASH, by: "wallet" });
    expect(built.signers).toEqual([owner.toBase58(), wallet.toBase58()]);
    expect(built.accounts.authority).toBe(wallet.toBase58());
    expectIdlShape("unlink_wallet", built);
  });
});

describe("withdraw and withdraw_token", () => {
  it("withdraw: Anchor's u64 encoding and a positive amount", () => {
    const owner = keypair().publicKey;
    const built = buildWithdraw({ owner, lamports: 18_446_744_073_709_551_615n, blockhash: BLOCKHASH });
    const decoded = decodeBuilt(built);
    expect(toHex(decoded.data)).toBe(toHex(anchorCoder.encode("withdraw", { amount: new BN("18446744073709551615") })));
    expectIdlShape("withdraw", built);
    expect(() => buildWithdraw({ owner, lamports: 0n, blockhash: BLOCKHASH })).toThrow(BuildError);
  });

  it("withdraw_token: the vault's ATA by default, the owner's ATA as destination, fixed program accounts from the IDL", () => {
    const owner = keypair().publicKey;
    const mint = keypair().publicKey;
    const built = buildWithdrawToken({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM, amountRaw: 5n, blockhash: BLOCKHASH });
    const vault = new PublicKey(built.vault);
    expect(built.vaultTokenAccount).toBe(ata(vault, mint, TOKEN_2022_PROGRAM));
    expect(built.ownerTokenAccount).toBe(ata(owner, mint, TOKEN_2022_PROGRAM));
    expect(built.accounts.associated_token_program).toBe(ATA_PROGRAM);
    expect(built.accounts.system_program).toBe(SYSTEM_PROGRAM);
    expect(toHex(decodeBuilt(built).data)).toBe(toHex(anchorCoder.encode("withdraw_token", { amount: new BN(5) })));
    expectIdlShape("withdraw_token", built);
  });

  it("withdraw_token takes an explicit vault-owned source and refuses a non-token program", () => {
    const owner = keypair().publicKey;
    const mint = keypair().publicKey;
    const source = keypair().publicKey;
    const built = buildWithdrawToken({ owner, mint, tokenProgram: TOKEN_PROGRAM, amountRaw: 1n, blockhash: BLOCKHASH, vaultToken: source });
    expect(built.accounts.vault_token).toBe(source.toBase58());
    expect(() => buildWithdrawToken({ owner, mint, tokenProgram: SYSTEM_PROGRAM, amountRaw: 1n, blockhash: BLOCKHASH })).toThrow(BuildError);
  });
});

describe("set_invest_policy", () => {
  const legMint = (): string => keypair().publicKey.toBase58();

  it("encodes as Anchor does, with in_mint right after venue_program", () => {
    const owner = keypair().publicKey;
    const legs = [
      { mint: legMint(), weightBps: 6_000, minOutRateWad: 123_456_789_012_345_678_901n },
      { mint: legMint(), weightBps: 4_000, minOutRateWad: 1n },
    ];
    const built = buildSetInvestPolicy({
      owner,
      blockhash: BLOCKHASH,
      legs,
      minConvertRateWad: 99n,
      minInvestment: 1_000_000n,
      maxPerCall: 50_000_000n,
      maxRolling30d: 500_000_000n,
      enabled: true,
    });
    const decoded = decodeBuilt(built);
    const expected = anchorCoder.encode("set_invest_policy", {
      legs: legs.map((leg) => ({ mint: new PublicKey(leg.mint), weight_bps: leg.weightBps, min_out_rate_wad: new BN(leg.minOutRateWad.toString()) })),
      venue_program: new PublicKey(RAYDIUM_CLMM),
      in_mint: new PublicKey(USDC_MINT),
      min_convert_rate_wad: new BN(99),
      min_investment: new BN(1_000_000),
      max_per_call: new BN(50_000_000),
      max_rolling_30d: new BN(500_000_000),
      enabled: true,
    });
    expect(toHex(decoded.data)).toBe(toHex(expected));
    expect(toHex(decoded.data.subarray(0, 8))).toBe("3dbdfb587f676d1c");
    const venueAt = 8 + 4 + 50 * legs.length;
    expect(base58Encode(decoded.data.subarray(venueAt, venueAt + 32))).toBe(RAYDIUM_CLMM);
    expect(base58Encode(decoded.data.subarray(venueAt + 32, venueAt + 64))).toBe(USDC_MINT);
    expect(built.policy).toBe(pda(text.encode("invest"), new PublicKey(built.vault).toBytes()));
    expectIdlShape("set_invest_policy", built);
  });

  it.each([
    ["weights summing to 9999", (mint: string) => ({ legs: [{ mint, weightBps: 9_999, minOutRateWad: 1n }] })],
    ["a duplicate leg mint", (mint: string) => ({ legs: [{ mint, weightBps: 5_000, minOutRateWad: 1n }, { mint, weightBps: 5_000, minOutRateWad: 1n }] })],
    ["in_mint equal to a leg", (mint: string) => ({ inMint: mint })],
    ["enabled with a default venue", () => ({ venueProgram: SYSTEM_PROGRAM })],
    ["min above per-call", () => ({ minInvestment: 60_000_000n })],
  ] as const)("refuses %s", (_, override) => {
    const mint = legMint();
    const input = {
      owner: keypair().publicKey,
      blockhash: BLOCKHASH,
      legs: [{ mint, weightBps: 10_000, minOutRateWad: 1n }],
      minConvertRateWad: 1n,
      minInvestment: 1_000_000n,
      maxPerCall: 50_000_000n,
      maxRolling30d: 500_000_000n,
      enabled: true,
      ...override(mint),
    };
    expect(() => buildSetInvestPolicy(input)).toThrow(BuildError);
  });
});
