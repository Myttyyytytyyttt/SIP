// Builds UNSIGNED solana-lab transactions, server-side. The browser signs them
// with the user's Privy Solana wallets and hands them back for broadcast.
//
// WHY THE SERVER BUILDS. The instruction encoding needs the Anchor
// discriminators and PDA derivation; doing that in the browser would push
// @solana/web3.js into the client bundle and a second copy of the layout into
// code no guard covers. Here it sits next to the decoder that IS covered, and
// the discriminators are COMPUTED from the instruction names at module load —
// this project has been bitten twice by transcribed selectors, so none are
// transcribed.
//
// The web still imports NOTHING from packages/solana-lab-old: the program id
// arrives via NUVEM_SOLANA_PROGRAM_ID, the layouts are mirrored here and
// pinned by scripts/check-solana-decode.mts.

import { createHash } from "node:crypto";

import { SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./solana";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

/** sha256("global:<name>")[0..8] — Anchor's instruction discriminator rule. */
const discriminator = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const CREATE_VAULT = discriminator("create_vault");
const LINK_WALLET = discriminator("link_wallet");
const SET_INVEST_POLICY = discriminator("set_invest_policy");
const WITHDRAW = discriminator("withdraw");
const WITHDRAW_TOKEN = discriminator("withdraw_token");
const UNLINK_WALLET = discriminator("unlink_wallet");
const SET_POLICY = discriminator("set_policy");

/**
 * The two token programs a vault can hold, as PublicKeys — DERIVED from the
 * canonical strings in solana.ts rather than written again. Two constants with
 * the same name and different types is how an address ends up right in one file
 * and wrong in the other.
 */
export const TOKEN_PROGRAM = new PublicKey(SPL_TOKEN_PROGRAM);
export const TOKEN_2022_PROGRAM_KEY = new PublicKey(TOKEN_2022_PROGRAM);
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** The ATA address for (owner, mint) under a given token program. */
export function deriveAta(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

/**
 * Raydium CLMM — the ONLY venue invest() may CPI, pinned into every policy
 * this builder writes. The address matches the fixture's venueProgram, i.e.
 * the venue the drill's real mainnet purchase went through.
 */
export const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

export interface BuiltTx {
  /** base64 of the serialized message, requiring the listed signers. */
  readonly txBase64: string;
  readonly signers: readonly string[];
  readonly vault: string;
  readonly tradingLink?: string;
}

export function deriveVaultPda(programId: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], programId)[0];
}

export function deriveLinkPda(programId: PublicKey, wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.toBuffer()], programId)[0];
}

export function deriveInvestPda(programId: PublicKey, vault: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("invest"), vault.toBuffer()], programId)[0];
}

/** create_vault(skim_bps): owner signs, pays, owns. */
export function buildCreateVault(
  programId: PublicKey,
  owner: PublicKey,
  skimBps: number,
  recentBlockhash: string,
): BuiltTx {
  const vault = deriveVaultPda(programId, owner);
  const data = Buffer.alloc(10);
  CREATE_VAULT.copy(data, 0);
  data.writeUInt16LE(skimBps, 8);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction({ feePayer: owner, recentBlockhash }).add(instruction);
  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    signers: [owner.toBase58()],
    vault: vault.toBase58(),
  };
}

/**
 * link_wallet: ONE transaction, TWO signers — the owner consents to the link,
 * the trading wallet consents to being linked. The EVM invite/accept dance,
 * collapsed exactly as the program's tests exercise it.
 */
export function buildLinkWallet(
  programId: PublicKey,
  owner: PublicKey,
  wallet: PublicKey,
  recentBlockhash: string,
): BuiltTx {
  const vault = deriveVaultPda(programId, owner);
  const tradingLink = deriveLinkPda(programId, wallet);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: tradingLink, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(LINK_WALLET),
  });
  const tx = new Transaction({ feePayer: owner, recentBlockhash }).add(instruction);
  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    signers: [owner.toBase58(), wallet.toBase58()],
    vault: vault.toBase58(),
    tradingLink: tradingLink.toBase58(),
  };
}

export interface InvestLegInput {
  readonly mint: PublicKey;
  /** Share of each investment, basis points. All legs must sum to exactly 10,000. */
  readonly weightBps: number;
  /** WAD floor per leg: min out-raw per in-raw. Must be > 0 (the program refuses a zero floor). */
  readonly minOutRateWad: bigint;
}

export interface SetInvestPolicyArgs {
  /**
   * The basket, 1..8 legs. The program enforces every rule again on chain
   * (count, unique mints, weights summing to 10,000, positive floors); the
   * builder checks the same things first so a bad basket dies as an explained
   * 400 rather than a wallet-signed refusal.
   */
  readonly legs: readonly InvestLegInput[];
  /** WAD floor for the SOL→USDC conversion. */
  readonly minConvertRateWad: bigint;
  /** USDC raw (6 decimals). Program demands 0 < min ≤ perCall ≤ rolling. */
  readonly minInvestment: bigint;
  readonly maxPerCall: bigint;
  readonly maxRolling30d: bigint;
  readonly enabled: boolean;
}

const u64le = (value: bigint): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
};

const u128le = (value: bigint): Buffer => {
  const buffer = Buffer.alloc(16);
  buffer.writeBigUInt64LE(value & 0xffffffffffffffffn, 0);
  buffer.writeBigUInt64LE(value >> 64n, 8);
  return buffer;
};

/**
 * set_invest_policy: OWNER signs — the floors and caps are the user's own
 * protection against the keeper, so only the withdrawal key may write them.
 * init_if_needed on chain, so the same transaction creates or updates.
 *
 * Borsh, hand-rolled like everything here, in the handler's argument order:
 * Vec<InvestmentLeg>(u32 len + [mint(32) weight u16 floor u128]) venue(32)
 * convert u128, then min/perCall/rolling u64, enabled u8. The encoding is
 * pinned by check-solana-decode's builder check against the program's own
 * client, so a drifted field order fails the build, not the signature.
 */
export function buildSetInvestPolicy(
  programId: PublicKey,
  owner: PublicKey,
  args: SetInvestPolicyArgs,
  recentBlockhash: string,
): BuiltTx & { readonly policy: string } {
  const vault = deriveVaultPda(programId, owner);
  const policy = deriveInvestPda(programId, vault);

  // The same rules the program enforces, refused here with words instead of a
  // signed transaction that bounces. Sum EXACTLY 10,000: the program will not
  // scale weights for anyone.
  if (args.legs.length === 0 || args.legs.length > 8) {
    throw new Error("a basket has between 1 and 8 legs");
  }
  if (new Set(args.legs.map((leg) => leg.mint.toBase58())).size !== args.legs.length) {
    throw new Error("a basket cannot repeat a mint");
  }
  const totalBps = args.legs.reduce((sum, leg) => sum + leg.weightBps, 0);
  if (totalBps !== 10_000) {
    throw new Error(`basket weights must sum to exactly 10000 bps, got ${totalBps}`);
  }
  for (const leg of args.legs) {
    if (!Number.isInteger(leg.weightBps) || leg.weightBps <= 0) throw new Error("every leg needs a positive integer weight");
    if (leg.minOutRateWad <= 0n) throw new Error("every leg needs a positive min-out floor");
  }

  // Borsh Vec<InvestmentLeg>: u32 count, then each leg as mint(32) +
  // weight_bps(u16 LE) + min_out_rate_wad(u128 LE). A 1-leg basket encodes
  // BYTE-IDENTICALLY to the old single-stock builder — check-solana-decode
  // pins that against the instruction the mainnet drill actually broadcast.
  const legCount = Buffer.alloc(4);
  legCount.writeUInt32LE(args.legs.length);
  const legBuffers = args.legs.map((leg) => {
    const weight = Buffer.alloc(2);
    weight.writeUInt16LE(leg.weightBps);
    return Buffer.concat([leg.mint.toBuffer(), weight, u128le(leg.minOutRateWad)]);
  });

  const data = Buffer.concat([
    SET_INVEST_POLICY,
    legCount,
    ...legBuffers,
    RAYDIUM_CLMM.toBuffer(),
    u128le(args.minConvertRateWad),
    u64le(args.minInvestment),
    u64le(args.maxPerCall),
    u64le(args.maxRolling30d),
    Buffer.from([args.enabled ? 1 : 0]),
  ]);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: policy, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction({ feePayer: owner, recentBlockhash }).add(instruction);
  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    signers: [owner.toBase58()],
    vault: vault.toBase58(),
    policy: policy.toBase58(),
  };
}

/**
 * withdraw(amount): the owner takes native SOL out.
 *
 * It has existed on chain since M1 and had no builder until now — the reader
 * card showed a "withdrawable" figure next to no way to act on it.
 */
export function buildWithdraw(
  programId: PublicKey,
  owner: PublicKey,
  amountLamports: bigint,
  recentBlockhash: string,
): BuiltTx {
  const vault = deriveVaultPda(programId, owner);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([WITHDRAW, u64le(amountLamports)]),
  });
  const tx = new Transaction({ feePayer: owner, recentBlockhash }).add(instruction);
  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    signers: [owner.toBase58()],
    vault: vault.toBase58(),
  };
}

/**
 * withdraw_token(amount): the owner takes an SPL / Token-2022 balance out —
 * the stock tokens and the USDC the keeper bought with their savings.
 *
 * The destination is the owner's OWN associated token account, which the
 * instruction creates if absent (owner pays). Account ORDER is the IDL's, and
 * the token program must match the mint's owner program: stocks are
 * Token-2022, USDC and wSOL are classic SPL. Passing the wrong one fails the
 * transfer, so the caller reads it from the chain rather than assuming.
 */
export function buildWithdrawToken(
  programId: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  amountRaw: bigint,
  recentBlockhash: string,
): BuiltTx & { readonly ownerTokenAccount: string } {
  const vault = deriveVaultPda(programId, owner);
  const vaultToken = deriveAta(vault, mint, tokenProgram);
  const ownerToken = deriveAta(owner, mint, tokenProgram);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vaultToken, isSigner: false, isWritable: true },
      { pubkey: ownerToken, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([WITHDRAW_TOKEN, u64le(amountRaw)]),
  });
  const tx = new Transaction({ feePayer: owner, recentBlockhash }).add(instruction);
  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    signers: [owner.toBase58()],
    vault: vault.toBase58(),
    ownerTokenAccount: ownerToken.toBase58(),
  };
}

/**
 * unlink_wallet: retires a trading wallet, CLOSING its link account.
 *
 * ONE SIGNER, TWO PEOPLE IT MAY BE — the program checks `authority` against
 * either vault.owner or trading_link.wallet, so the owner can cut a wallet
 * loose and a wallet can remove itself, neither held hostage by the other.
 * This builder signs as the OWNER, which is the case a savings app needs.
 *
 * The `owner` account is the rent destination and is pinned on chain to
 * vault.owner, so it is the same key in both slots here. Closing frees the
 * ["link", wallet] address, which is what lets a wallet link somewhere else —
 * the exact dead end the UI used to leave users in.
 */
export function buildUnlinkWallet(
  programId: PublicKey,
  owner: PublicKey,
  wallet: PublicKey,
  recentBlockhash: string,
): BuiltTx & { readonly tradingLink: string } {
  const vault = deriveVaultPda(programId, owner);
  const tradingLink = deriveLinkPda(programId, wallet);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: tradingLink, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(UNLINK_WALLET),
  });
  const tx = new Transaction({ feePayer: owner, recentBlockhash }).add(instruction);
  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    signers: [owner.toBase58()],
    vault: vault.toBase58(),
    tradingLink: tradingLink.toBase58(),
  };
}

/**
 * set_policy(skim_bps, paused): the owner changes how much of their profit is
 * saved, and can pause the keeper.
 *
 * BOTH FIELDS TRAVEL TOGETHER because the instruction writes both — sending
 * only one would silently reset the other, so every caller must state the full
 * intent. skim_bps is bounded 1..10000 on chain: zero is refused, because a
 * vault that is enabled and saving nothing is the silent failure the program
 * exists to prevent.
 *
 * Pausing gates settle and invest only. Withdrawing is never gated — see
 * withdraw.rs — so a paused vault still returns its owner's money.
 */
export function buildSetPolicy(
  programId: PublicKey,
  owner: PublicKey,
  skimBps: number,
  paused: boolean,
  recentBlockhash: string,
): BuiltTx {
  const vault = deriveVaultPda(programId, owner);
  const data = Buffer.alloc(11);
  SET_POLICY.copy(data, 0);
  data.writeUInt16LE(skimBps, 8);
  data.writeUInt8(paused ? 1 : 0, 10);

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
    ],
    data,
  });
  const tx = new Transaction({ feePayer: owner, recentBlockhash }).add(instruction);
  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    signers: [owner.toBase58()],
    vault: vault.toBase58(),
  };
}
