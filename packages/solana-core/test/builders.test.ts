// Builder bytes, checked against Anchor's own instruction coder from the IDL.

import { createRequire } from "node:module";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Ed25519Program, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  ATA_PROGRAM,
  ED25519_PROGRAM,
  INSTRUCTIONS_SYSVAR,
  RAYDIUM_CLMM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  USDC_MINT,
} from "../src/client/addresses";
import { base58Encode } from "../src/client/base58";
import { base64Encode } from "../src/client/base64";
import { SIP_PROGRAM_ID, idlInstruction, toHex, type OwnerInstructionName } from "../src/client/idl";
import { linkConsentMessage } from "../src/client/link-consent";
import { DEFAULT_RATES } from "../src/client/rules";
import {
  BuildError,
  LinkConsentError,
  WalletIsOwnerError,
  buildCreateVaultV2,
  buildLinkWallet,
  buildSetInvestPolicy,
  buildSetPolicyV2,
  buildUnlinkWallet,
  buildWithdraw,
  buildWithdrawToken,
  prepareLinkWalletConsent,
  sipInstruction,
  type BuiltTransaction,
} from "../src/server/builders";
import { BLOCKHASH, fromB64, keypair, signBytes } from "./helpers";

const require = createRequire(import.meta.url);
const rawIdl = require("@sip/solana-program/idl") as anchor.Idl;
const anchorCoder = new anchor.BorshInstructionCoder(rawIdl);
// Anchor's own account resolution from the IDL (PDAs, fixed addresses, flags).
// It needs a provider object and no network: nothing here is fetched or sent.
const anchorProgram = new anchor.Program(rawIdl, { connection: new Connection("http://127.0.0.1:9") } as unknown as anchor.Provider);
const BN = anchor.BN;
const PROGRAM = new PublicKey(SIP_PROGRAM_ID);
const text = new TextEncoder();

const pda = (...seeds: Uint8Array[]): string => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0].toBase58();
const ata = (owner: PublicKey, mint: PublicKey, program: string): string =>
  PublicKey.findProgramAddressSync([owner.toBytes(), new PublicKey(program).toBytes(), mint.toBytes()], new PublicKey(ATA_PROGRAM))[0].toBase58();

interface Decoded {
  /** Every top-level instruction's program, in order. */
  readonly programs: string[];
  /** The SIP instruction (always the last one). */
  readonly data: Uint8Array;
  readonly accounts: string[];
  readonly signers: string[];
  readonly signerFlags: boolean[];
  readonly writableFlags: boolean[];
  /** The Ed25519SigVerify instruction in front of link_wallet, when there is one. */
  readonly ed25519: { readonly data: Uint8Array; readonly accounts: number } | null;
}

/** An unsigned built transaction, its SIP instruction resolved. */
function decodeBuilt(built: BuiltTransaction): Decoded {
  const tx = VersionedTransaction.deserialize(fromB64(built.txBase64));
  const message = tx.message;
  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  const programs = message.compiledInstructions.map((instruction) => keys[instruction.programIdIndex]!);
  expect(programs).toEqual(built.instruction === "link_wallet" ? [ED25519_PROGRAM, SIP_PROGRAM_ID] : [SIP_PROGRAM_ID]);
  const instruction = message.compiledInstructions[programs.length - 1]!;
  const verify = built.instruction === "link_wallet" ? message.compiledInstructions[0]! : null;
  expect(base58Encode(message.recentBlockhash ? new PublicKey(message.recentBlockhash).toBytes() : new Uint8Array())).toBe(BLOCKHASH);
  expect(tx.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
  return {
    programs,
    data: Uint8Array.from(instruction.data),
    accounts: instruction.accountKeyIndexes.map((index) => keys[index]!),
    signers: keys.slice(0, message.header.numRequiredSignatures),
    signerFlags: instruction.accountKeyIndexes.map((index) => message.isAccountSigner(index)),
    writableFlags: instruction.accountKeyIndexes.map((index) => message.isAccountWritable(index)),
    ed25519: verify === null ? null : { data: Uint8Array.from(verify.data), accounts: verify.accountKeyIndexes.length },
  };
}

function expectIdlShape(name: OwnerInstructionName, built: BuiltTransaction): void {
  const decoded = decodeBuilt(built);
  const idl = idlInstruction(name);
  expect(decoded.accounts).toEqual(idl.accounts.map((account) => built.accounts[account.name]));
  idl.accounts.forEach((account, index) => {
    // The message merges flags per key, so an IDL flag must be present; it may
    // be widened only when the same key appears twice (unlink: owner and authority).
    if (account.signer === true) expect(decoded.signerFlags[index]).toBe(true);
    if (account.writable === true) expect(decoded.writableFlags[index]).toBe(true);
    if (account.address !== undefined) expect(decoded.accounts[index]).toBe(account.address);
  });
  expect(decoded.signers).toEqual(built.signers);
  expect(built.feePayer).toBe(built.signers[0]);
}

type AnchorInstruction = { readonly keys: readonly { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]; readonly data: Uint8Array };
type AnchorBuilder = {
  accounts(accounts: Record<string, PublicKey>): { instruction(): Promise<AnchorInstruction> };
  accountsStrict(accounts: Record<string, PublicKey>): { instruction(): Promise<AnchorInstruction> };
};

/**
 * The SIP instruction's metas and data against the instruction Anchor's Program
 * builds from the same IDL: same keys in the same order, same data, and the
 * same flags wherever a key appears once (a repeated key is merged by the message).
 */
async function expectAnchorInstruction(decoded: Decoded, method: string, accounts: Record<string, PublicKey>, strict = false): Promise<void> {
  const builder = (anchorProgram.methods as unknown as Record<string, () => AnchorBuilder>)[method]!();
  const ix = await (strict ? builder.accountsStrict(accounts) : builder.accounts(accounts)).instruction();
  expect(decoded.accounts).toEqual(ix.keys.map((meta) => meta.pubkey.toBase58()));
  ix.keys.forEach((meta, index) => {
    const repeated = decoded.accounts.filter((address) => address === decoded.accounts[index]).length > 1;
    if (repeated) {
      if (meta.isSigner) expect(decoded.signerFlags[index]).toBe(true);
      if (meta.isWritable) expect(decoded.writableFlags[index]).toBe(true);
    } else {
      expect([decoded.signerFlags[index], decoded.writableFlags[index]]).toEqual([meta.isSigner, meta.isWritable]);
    }
  });
  expect(toHex(decoded.data)).toBe(toHex(Uint8Array.from(ix.data)));
}

describe("sipInstruction", () => {
  it("takes metas from the IDL in order, with its signer and writable flags", () => {
    const owner = keypair().publicKey;
    const wallet = keypair().publicKey;
    const ix = sipInstruction("link_wallet", { owner, wallet, vault: owner, trading_link: wallet, config: wallet }, {});
    const idl = idlInstruction("link_wallet");
    expect(ix.keys.map((meta) => [meta.isSigner, meta.isWritable])).toEqual(idl.accounts.map((account) => [account.signer === true, account.writable === true]));
    expect(ix.keys[5]!.pubkey.toBase58()).toBe(INSTRUCTIONS_SYSVAR);
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(() => sipInstruction("link_wallet", { owner, wallet, vault: owner, trading_link: wallet, config: wallet, instructions_sysvar: owner }, {})).toThrow(/fixed to/);
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
    expect(built.lastValidBlockHeight).toBeNull();
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

  it("builds the owner's product rates, and the edges of both ranges", () => {
    const owner = keypair().publicKey;
    const base = { owner, mode: 1, maxContribution: 1_000n, walletReserve: 0n, blockhash: BLOCKHASH };
    expect(() => buildCreateVaultV2({ ...base, skimBps: DEFAULT_RATES.profitBps, volumeBps: DEFAULT_RATES.volumeBps })).not.toThrow();
    expect(() => buildSetPolicyV2({ ...base, paused: false, skimBps: 201, volumeBps: 200 })).not.toThrow();
    expect(() => buildSetPolicyV2({ ...base, paused: false, skimBps: 10_000, volumeBps: 1 })).not.toThrow();
  });

  it.each([
    ["skim 200 (the old floor's side of the new one)", { skimBps: 200 }],
    ["skim 10001", { skimBps: 10_001 }],
    ["volume 0", { volumeBps: 0 }],
    ["volume 201", { volumeBps: 201 }],
    ["mode 2", { mode: 2 }],
    ["max contribution 0", { maxContribution: 0n }],
  ] as const)("refuses %s", (_, overrides) => {
    const base = { owner: keypair().publicKey, mode: 1, skimBps: 2_000, volumeBps: 10, maxContribution: 1_000n, walletReserve: 0n, blockhash: BLOCKHASH };
    expect(() => buildCreateVaultV2({ ...base, ...overrides })).toThrow(BuildError);
    expect(() => buildSetPolicyV2({ ...base, paused: false, ...overrides })).toThrow(BuildError);
  });

  it("refuses a malformed blockhash, a malformed owner and a malformed lastValidBlockHeight; echoes a good one", () => {
    const base = { mode: 1, skimBps: 2_000, volumeBps: 10, maxContribution: 1_000n, walletReserve: 0n };
    expect(() => buildCreateVaultV2({ ...base, owner: keypair().publicKey, blockhash: "not-a-hash" })).toThrow(/blockhash/);
    expect(() => buildCreateVaultV2({ ...base, owner: "0OIl", blockhash: BLOCKHASH })).toThrow(BuildError);
    expect(() => buildCreateVaultV2({ ...base, owner: keypair().publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1.5 })).toThrow(/lastValidBlockHeight/);
    expect(buildCreateVaultV2({ ...base, owner: keypair().publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 300_000_150 }).lastValidBlockHeight).toBe(300_000_150);
  });
});

describe("link_wallet: the consent, then the transaction", () => {
  function consentFor(owner: PublicKey, wallet: ReturnType<typeof keypair>): { consent: Uint8Array; signature: Uint8Array } {
    const consent = fromB64(prepareLinkWalletConsent({ owner, wallet: wallet.publicKey }).consentMessageBase64);
    return { consent, signature: signBytes(wallet, consent) };
  }

  it("prepareLinkWalletConsent: the vault and link PDAs, and the SIP_LINK_V1 bytes that name them", () => {
    const owner = keypair().publicKey;
    const wallet = keypair().publicKey;
    const prepared = prepareLinkWalletConsent({ owner: owner.toBase58(), wallet: wallet.toBase58() });
    expect(prepared.instruction).toBe("link_wallet");
    expect(prepared.programId).toBe(SIP_PROGRAM_ID);
    expect(prepared.owner).toBe(owner.toBase58());
    expect(prepared.wallet).toBe(wallet.toBase58());
    expect(prepared.vault).toBe(pda(text.encode("vault"), owner.toBytes()));
    expect(prepared.tradingLink).toBe(pda(text.encode("link"), wallet.toBytes()));
    const consent = fromB64(prepared.consentMessageBase64);
    expect(consent).toHaveLength(140);
    expect(toHex(consent)).toBe(toHex(linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: wallet.toBase58(), vault: prepared.vault, owner: owner.toBase58() })));
  });

  it("buildLinkWallet: [Ed25519SigVerify, link_wallet]; the Ed25519 bytes web3.js writes, Anchor's metas and data, signers [owner, wallet]", async () => {
    const owner = keypair().publicKey;
    const wallet = keypair();
    const { consent, signature } = consentFor(owner, wallet);
    const built = buildLinkWallet({ owner, wallet: wallet.publicKey, consentSignature: signature, blockhash: BLOCKHASH, lastValidBlockHeight: 280_000_150 });
    const decoded = decodeBuilt(built);

    const web3 = Ed25519Program.createInstructionWithPublicKey({ publicKey: wallet.publicKey.toBytes(), message: consent, signature });
    expect(decoded.ed25519).not.toBeNull();
    expect(toHex(decoded.ed25519!.data)).toBe(toHex(Uint8Array.from(web3.data)));
    expect(decoded.ed25519!.accounts).toBe(0);
    expect(web3.keys).toEqual([]);

    expect(toHex(decoded.data)).toBe("565c1f92e433d1e6");
    expect(toHex(decoded.data)).toBe(toHex(anchorCoder.encode("link_wallet", {})));
    await expectAnchorInstruction(decoded, "linkWallet", { owner, wallet: wallet.publicKey });
    expect(built.accounts.vault).toBe(pda(text.encode("vault"), owner.toBytes()));
    expect(built.accounts.config).toBe(pda(text.encode("config")));
    expect(built.accounts.instructions_sysvar).toBe(INSTRUCTIONS_SYSVAR);
    expect(built.signers).toEqual([owner.toBase58(), wallet.publicKey.toBase58()]);
    expect(built.tradingLink).toBe(pda(text.encode("link"), wallet.publicKey.toBytes()));
    expect(built.consentMessageBase64).toBe(base64Encode(consent));
    expect(built.lastValidBlockHeight).toBe(280_000_150);
    expectIdlShape("link_wallet", built);
  });

  it("takes the consent signature as bytes or as standard base64, with the same result", () => {
    const owner = keypair().publicKey;
    const wallet = keypair();
    const { signature } = consentFor(owner, wallet);
    const base = { owner, wallet: wallet.publicKey, blockhash: BLOCKHASH };
    expect(buildLinkWallet({ ...base, consentSignature: base64Encode(signature) }).txBase64).toBe(buildLinkWallet({ ...base, consentSignature: signature }).txBase64);
  });

  it("refuses, before building, a consent signed by another key, over another owner's vault, altered, or not 64 bytes", () => {
    const owner = keypair().publicKey;
    const wallet = keypair();
    const stranger = keypair();
    const { consent, signature } = consentFor(owner, wallet);
    const base = { owner, wallet: wallet.publicKey, blockhash: BLOCKHASH };
    expect(() => buildLinkWallet({ ...base, consentSignature: signBytes(stranger, consent) })).toThrow(LinkConsentError);
    const forAnotherVault = fromB64(prepareLinkWalletConsent({ owner: keypair().publicKey, wallet: wallet.publicKey }).consentMessageBase64);
    expect(() => buildLinkWallet({ ...base, consentSignature: signBytes(wallet, forAnotherVault) })).toThrow(/not the trading wallet's signature/);
    const altered = signature.slice();
    altered[10] = altered[10]! ^ 1;
    expect(() => buildLinkWallet({ ...base, consentSignature: altered })).toThrow(LinkConsentError);
    expect(() => buildLinkWallet({ ...base, consentSignature: signature.subarray(0, 63) })).toThrow(/64 bytes/);
    expect(() => buildLinkWallet({ ...base, consentSignature: "not base64!" })).toThrow(LinkConsentError);
    expect(() => buildLinkWallet({ ...base, consentSignature: base58Encode(signature) })).toThrow(LinkConsentError);
    expect(new LinkConsentError(["x"])).toBeInstanceOf(BuildError);
  });

  it("refuses the owner's own key as the trading wallet, at both steps", () => {
    const owner = keypair().publicKey;
    expect(() => prepareLinkWalletConsent({ owner, wallet: owner })).toThrow(WalletIsOwnerError);
    expect(() => buildLinkWallet({ owner: owner.toBase58(), wallet: owner.toBase58(), consentSignature: new Uint8Array(64), blockhash: BLOCKHASH })).toThrow(WalletIsOwnerError);
  });
});

describe("unlink_wallet", () => {
  it("the owner is the authority, the rent destination, the fee payer and the one signer; Anchor's metas and data", async () => {
    const owner = keypair().publicKey;
    const wallet = keypair().publicKey;
    const built = buildUnlinkWallet({ owner, wallet, blockhash: BLOCKHASH });
    const decoded = decodeBuilt(built);
    expect(toHex(decoded.data)).toBe("dc79610dc189d19f");
    expect(toHex(decoded.data)).toBe(toHex(anchorCoder.encode("unlink_wallet", {})));
    expect(built.signers).toEqual([owner.toBase58()]);
    expect(built.accounts.authority).toBe(owner.toBase58());
    expect(built.accounts.owner).toBe(owner.toBase58());
    // Derived here, never taken from the builder under test. The program pins
    // vault to ['vault', vault.owner] and trading_link to ['link',
    // trading_link.wallet]; both seeds are account data, so Anchor cannot
    // resolve them offline, and the verifier cannot bind trading_link to a
    // wallet the transaction does not name. This is the only check on them.
    const expectedVault = pda(text.encode("vault"), owner.toBytes());
    const expectedLink = pda(text.encode("link"), wallet.toBytes());
    expect(built.vault).toBe(expectedVault);
    expect(built.accounts.vault).toBe(expectedVault);
    expect(built.tradingLink).toBe(expectedLink);
    expect(built.accounts.trading_link).toBe(expectedLink);
    await expectAnchorInstruction(decoded, "unlinkWallet", { authority: owner, owner, vault: new PublicKey(expectedVault), tradingLink: new PublicKey(expectedLink) }, true);
    expectIdlShape("unlink_wallet", built);
  });

  it("has no wallet-authority variant left, and refuses a wallet that is the owner's own key", () => {
    const owner = keypair().publicKey;
    const wallet = keypair().publicKey;
    // @ts-expect-error `by` is gone: only the owner unlinks (UnlinkUnauthorized otherwise).
    const built = buildUnlinkWallet({ owner, wallet, blockhash: BLOCKHASH, by: "wallet" });
    expect(built.signers).toEqual([owner.toBase58()]);
    expect(built.accounts.authority).toBe(owner.toBase58());
    expect(() => buildUnlinkWallet({ owner, wallet: owner, blockhash: BLOCKHASH })).toThrow(WalletIsOwnerError);
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
