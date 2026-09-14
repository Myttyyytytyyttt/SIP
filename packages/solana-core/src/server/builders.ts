// Unsigned V2 transactions for the owner-facing instructions. The server never
// signs: each builder returns the unsigned transaction, the message every signer
// signs, and the signers in order (the owner, who pays, first).
//
// Ported from Nuvem solana-tx.ts, with everything that made it V1 removed: no
// sha256 of names (Nuvem hashed create_vault and set_policy, which SIP does not
// have), no hand-listed account metas and no hand-packed Borsh. Data is
// encodeArgs over the IDL; account metas are the IDL's accounts, in IDL order,
// with the IDL's signer and writable flags; fixed addresses (system program,
// ATA program) come from the IDL too. test/builders.test.ts checks the bytes
// against Anchor's own instruction coder built from the same IDL.
//
// VALIDATED BEFORE BUILDING with client/rules.ts — the program's rules — so a
// bad policy is a BuildError with words, not a signed transaction that bounces.

import { Transaction, TransactionInstruction, type PublicKey } from "@solana/web3.js";

import { RAYDIUM_CLMM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "../client/addresses";
import { isBase58OfLength } from "../client/base58";
import { base64Encode } from "../client/base64";
import { BorshError, encodeArgs } from "../client/borsh";
import { idlInstruction, type OwnerInstructionName } from "../client/idl";
import { U64_MAX, investPolicyProblems, vaultPolicyProblems, type InvestLegInput, type VaultPolicyInput } from "../client/rules";
import { InvalidKeyError, SIP_PROGRAM_KEY, deriveAta, deriveInvestPda, deriveLinkPda, deriveVaultPda, toPublicKey, type KeyLike } from "./pda";

export class BuildError extends Error {
  override readonly name: string = "BuildError";
  constructor(readonly problems: readonly string[]) {
    super(problems.join("; "));
  }
}

/** link_wallet with wallet === owner: SIP refuses it although link_wallet.rs does not. */
export class WalletIsOwnerError extends BuildError {
  override readonly name = "WalletIsOwnerError";
  constructor() {
    super(["the trading wallet cannot be the owner's own key: settle would pull from the pension key"]);
  }
}

export interface BuiltTransaction {
  readonly instruction: OwnerInstructionName;
  /** Unsigned legacy transaction (zeroed signature slots), base64. */
  readonly txBase64: string;
  /** The message bytes each signer signs, base64. */
  readonly messageBase64: string;
  /** Required signers in signature order; the fee payer (the owner) first. */
  readonly signers: readonly string[];
  readonly feePayer: string;
  readonly recentBlockhash: string;
  readonly vault: string;
  /** IDL account name → address, as placed in the instruction. */
  readonly accounts: Readonly<Record<string, string>>;
}

function key(value: KeyLike, what: string): PublicKey {
  try {
    return toPublicKey(value, what);
  } catch (error) {
    throw new BuildError([error instanceof InvalidKeyError ? error.message : `${what} is not a public key`]);
  }
}

function requireProblems(problems: readonly string[]): void {
  if (problems.length > 0) throw new BuildError(problems);
}

function positiveU64(value: unknown, what: string): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > U64_MAX) throw new BuildError([`${what} must be a u64 greater than zero (a bigint)`]);
  return value;
}

/** One SIP instruction with metas taken from the IDL. `accounts` names every IDL account without a fixed address. */
export function sipInstruction(name: OwnerInstructionName, accounts: Readonly<Record<string, KeyLike>>, args: Record<string, unknown>): TransactionInstruction {
  const idl = idlInstruction(name);
  const known = new Set(idl.accounts.map((account) => account.name));
  const extra = Object.keys(accounts).filter((account) => !known.has(account));
  if (extra.length > 0) throw new BuildError([`${name} has no account(s) ${extra.join(", ")}`]);
  const keys = idl.accounts.map((account) => {
    const given = accounts[account.name];
    if (account.address !== undefined) {
      if (given !== undefined && key(given, account.name).toBase58() !== account.address) {
        throw new BuildError([`${name}.${account.name} is fixed to ${account.address} by the IDL`]);
      }
      return { pubkey: key(account.address, account.name), isSigner: account.signer === true, isWritable: account.writable === true };
    }
    if (given === undefined) throw new BuildError([`${name} needs the ${account.name} account`]);
    return { pubkey: key(given, account.name), isSigner: account.signer === true, isWritable: account.writable === true };
  });
  let data: Uint8Array;
  try {
    data = encodeArgs(name, args);
  } catch (error) {
    throw new BuildError([error instanceof BorshError ? error.message : `${name}: the arguments do not encode`]);
  }
  return new TransactionInstruction({ programId: SIP_PROGRAM_KEY, keys, data: Buffer.from(data) });
}

function compile(
  name: OwnerInstructionName,
  instruction: TransactionInstruction,
  feePayer: PublicKey,
  expectedSigners: readonly PublicKey[],
  blockhash: string,
  vault: PublicKey,
): BuiltTransaction {
  if (!isBase58OfLength(blockhash, 32)) throw new BuildError(["the recent blockhash must be base58 of 32 bytes"]);
  const tx = new Transaction({ feePayer, recentBlockhash: blockhash }).add(instruction);
  const message = tx.compileMessage();
  const signers = message.accountKeys.slice(0, message.header.numRequiredSignatures).map((signer) => signer.toBase58());
  const expected = expectedSigners.map((signer) => signer.toBase58());
  if (signers.length !== expected.length || signers.some((signer, index) => signer !== expected[index])) {
    // A builder bug, not a user error: the compiled signer order is what the
    // verifier binds, so a mismatch must never reach a wallet.
    throw new Error(`${name}: compiled signers [${signers.join(", ")}] are not the expected [${expected.join(", ")}]`);
  }
  const accounts: Record<string, string> = {};
  idlInstruction(name).accounts.forEach((account, index) => {
    accounts[account.name] = instruction.keys[index]!.pubkey.toBase58();
  });
  return {
    instruction: name,
    txBase64: base64Encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
    messageBase64: base64Encode(message.serialize()),
    signers,
    feePayer: feePayer.toBase58(),
    recentBlockhash: blockhash,
    vault: vault.toBase58(),
    accounts,
  };
}

function vaultPolicyArgs(input: VaultPolicyInput): Record<string, unknown> {
  requireProblems(vaultPolicyProblems(input));
  return {
    mode: input.mode,
    skim_bps: input.skimBps,
    volume_bps: input.volumeBps,
    max_contribution: input.maxContribution,
    wallet_reserve: input.walletReserve,
  };
}

export interface CreateVaultV2Input extends VaultPolicyInput {
  readonly owner: KeyLike;
  readonly blockhash: string;
}

/** create_vault_v2(mode, skim_bps, volume_bps, max_contribution, wallet_reserve): the owner signs and pays. */
export function buildCreateVaultV2(input: CreateVaultV2Input): BuiltTransaction {
  const owner = key(input.owner, "owner");
  const vault = deriveVaultPda(owner);
  const instruction = sipInstruction("create_vault_v2", { owner, vault }, vaultPolicyArgs(input));
  return compile("create_vault_v2", instruction, owner, [owner], input.blockhash, vault);
}

export interface SetPolicyV2Input extends VaultPolicyInput {
  readonly owner: KeyLike;
  readonly paused: boolean;
  readonly blockhash: string;
}

/** set_policy_v2(mode, skim_bps, volume_bps, paused, max_contribution, wallet_reserve). Every field travels: the instruction writes them all. */
export function buildSetPolicyV2(input: SetPolicyV2Input): BuiltTransaction {
  const owner = key(input.owner, "owner");
  if (typeof input.paused !== "boolean") throw new BuildError(["paused must be a boolean"]);
  const base = vaultPolicyArgs(input);
  const vault = deriveVaultPda(owner);
  const args = {
    mode: base.mode,
    skim_bps: base.skim_bps,
    volume_bps: base.volume_bps,
    paused: input.paused,
    max_contribution: base.max_contribution,
    wallet_reserve: base.wallet_reserve,
  };
  const instruction = sipInstruction("set_policy_v2", { owner, vault }, args);
  return compile("set_policy_v2", instruction, owner, [owner], input.blockhash, vault);
}

export interface LinkWalletInput {
  readonly owner: KeyLike;
  readonly wallet: KeyLike;
  readonly blockhash: string;
}

/**
 * link_wallet: ONE transaction, TWO signers, owner first. The owner's wallet
 * signs first and the trading wallet second, over the same message, so a wallet
 * that rewrites the message before signing (adding a priority fee) is the first
 * signer and the co-signature still verifies.
 */
export function buildLinkWallet(input: LinkWalletInput): BuiltTransaction & { readonly tradingLink: string } {
  const owner = key(input.owner, "owner");
  const wallet = key(input.wallet, "wallet");
  if (owner.equals(wallet)) throw new WalletIsOwnerError();
  const vault = deriveVaultPda(owner);
  const tradingLink = deriveLinkPda(wallet);
  const instruction = sipInstruction("link_wallet", { owner, wallet, vault, trading_link: tradingLink }, {});
  return { ...compile("link_wallet", instruction, owner, [owner, wallet], input.blockhash, vault), tradingLink: tradingLink.toBase58() };
}

export interface UnlinkWalletInput {
  readonly owner: KeyLike;
  readonly wallet: KeyLike;
  readonly blockhash: string;
  /** Who is the authority: the owner cutting the wallet loose (default), or the wallet removing itself. The owner pays either way. */
  readonly by?: "owner" | "wallet";
}

/** unlink_wallet: closes the link; the rent goes back to the owner. */
export function buildUnlinkWallet(input: UnlinkWalletInput): BuiltTransaction & { readonly tradingLink: string } {
  const owner = key(input.owner, "owner");
  const wallet = key(input.wallet, "wallet");
  const by = input.by ?? "owner";
  if (by !== "owner" && by !== "wallet") throw new BuildError(['by must be "owner" or "wallet"']);
  if (by === "wallet" && owner.equals(wallet)) throw new WalletIsOwnerError();
  const vault = deriveVaultPda(owner);
  const tradingLink = deriveLinkPda(wallet);
  const authority = by === "owner" ? owner : wallet;
  const instruction = sipInstruction("unlink_wallet", { authority, owner, vault, trading_link: tradingLink }, {});
  const signers = by === "owner" ? [owner] : [owner, wallet];
  return { ...compile("unlink_wallet", instruction, owner, signers, input.blockhash, vault), tradingLink: tradingLink.toBase58() };
}

export interface WithdrawInput {
  readonly owner: KeyLike;
  readonly lamports: bigint;
  readonly blockhash: string;
}

/** withdraw(amount): native SOL out of the vault. Never gated by any pause. */
export function buildWithdraw(input: WithdrawInput): BuiltTransaction {
  const owner = key(input.owner, "owner");
  const amount = positiveU64(input.lamports, "lamports");
  const vault = deriveVaultPda(owner);
  const instruction = sipInstruction("withdraw", { owner, vault }, { amount });
  return compile("withdraw", instruction, owner, [owner], input.blockhash, vault);
}

export interface WithdrawTokenInput {
  readonly owner: KeyLike;
  readonly mint: KeyLike;
  /** The mint's owning program, read from the chain: classic SPL Token or Token-2022. */
  readonly tokenProgram: KeyLike;
  readonly amountRaw: bigint;
  readonly blockhash: string;
  /** The vault-owned source account. Defaults to the vault's ATA; the program accepts any account the vault owns for the mint. */
  readonly vaultToken?: KeyLike;
}

/** withdraw_token(amount): tokens out to the owner's own ATA, which the program creates if absent. */
export function buildWithdrawToken(input: WithdrawTokenInput): BuiltTransaction & { readonly ownerTokenAccount: string; readonly vaultTokenAccount: string } {
  const owner = key(input.owner, "owner");
  const mint = key(input.mint, "mint");
  const tokenProgram = key(input.tokenProgram, "tokenProgram");
  const programName = tokenProgram.toBase58();
  if (programName !== TOKEN_PROGRAM && programName !== TOKEN_2022_PROGRAM) {
    throw new BuildError(["tokenProgram must be the SPL Token or Token-2022 program"]);
  }
  const amount = positiveU64(input.amountRaw, "amountRaw");
  const vault = deriveVaultPda(owner);
  const vaultToken = input.vaultToken === undefined ? deriveAta(vault, mint, tokenProgram) : key(input.vaultToken, "vaultToken");
  const ownerToken = deriveAta(owner, mint, tokenProgram);
  const instruction = sipInstruction(
    "withdraw_token",
    { owner, vault, token_mint: mint, vault_token: vaultToken, owner_token: ownerToken, token_program: tokenProgram },
    { amount },
  );
  return {
    ...compile("withdraw_token", instruction, owner, [owner], input.blockhash, vault),
    ownerTokenAccount: ownerToken.toBase58(),
    vaultTokenAccount: vaultToken.toBase58(),
  };
}

export interface SetInvestPolicyInput {
  readonly owner: KeyLike;
  readonly blockhash: string;
  readonly legs: readonly InvestLegInput[];
  /** Default Raydium CLMM. */
  readonly venueProgram?: string;
  /** Default USDC. */
  readonly inMint?: string;
  readonly minConvertRateWad: bigint;
  readonly minInvestment: bigint;
  readonly maxPerCall: bigint;
  readonly maxRolling30d: bigint;
  readonly enabled: boolean;
}

/** set_invest_policy(legs, venue_program, in_mint, min_convert_rate_wad, min_investment, max_per_call, max_rolling_30d, enabled). */
export function buildSetInvestPolicy(input: SetInvestPolicyInput): BuiltTransaction & { readonly policy: string } {
  const owner = key(input.owner, "owner");
  const rules = {
    legs: input.legs,
    venueProgram: input.venueProgram ?? RAYDIUM_CLMM,
    inMint: input.inMint ?? USDC_MINT,
    minConvertRateWad: input.minConvertRateWad,
    minInvestment: input.minInvestment,
    maxPerCall: input.maxPerCall,
    maxRolling30d: input.maxRolling30d,
    enabled: input.enabled,
  };
  requireProblems(investPolicyProblems(rules));
  const vault = deriveVaultPda(owner);
  const policy = deriveInvestPda(vault);
  const args = {
    legs: rules.legs.map((leg) => ({ mint: leg.mint, weight_bps: leg.weightBps, min_out_rate_wad: leg.minOutRateWad })),
    venue_program: rules.venueProgram,
    in_mint: rules.inMint,
    min_convert_rate_wad: rules.minConvertRateWad,
    min_investment: rules.minInvestment,
    max_per_call: rules.maxPerCall,
    max_rolling_30d: rules.maxRolling30d,
    enabled: rules.enabled,
  };
  const instruction = sipInstruction("set_invest_policy", { owner, vault, policy }, args);
  return { ...compile("set_invest_policy", instruction, owner, [owner], input.blockhash, vault), policy: policy.toBase58() };
}
