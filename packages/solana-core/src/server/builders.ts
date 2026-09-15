// Unsigned V2 transactions for the owner-facing instructions. The server never
// signs: each builder returns the unsigned transaction, the message every signer
// signs, and the signers in order (the owner, who pays, first).
//
// Ported from Nuvem solana-tx.ts, with everything that made it V1 removed: no
// sha256 of names (Nuvem hashed create_vault and set_policy, which SIP does not
// have), no hand-listed account metas and no hand-packed Borsh. Data is
// encodeArgs over the IDL; account metas are the IDL's accounts, in IDL order,
// with the IDL's signer and writable flags; fixed addresses (system program,
// ATA program, instructions sysvar) come from the IDL too. test/builders.test.ts
// checks the bytes against Anchor's own instruction coder built from the same IDL.
//
// VALIDATED BEFORE BUILDING with client/rules.ts — the program's rules — so a
// bad policy is a BuildError with words, not a signed transaction that bounces.
//
// LINKING IS TWO CALLS. link_wallet needs the trading wallet's off-chain consent
// (client/link-consent.ts) in an Ed25519SigVerify instruction immediately before
// it, and only the wallet can produce that signature. So prepareLinkWalletConsent
// hands out the bytes to sign, and buildLinkWallet takes the signature back,
// verifies it, and only then compiles the transaction both keys sign.
//
// THE COMPUTE BUDGET IS OPTIONAL AND GOES FIRST. With `computeBudget` every
// builder puts SetComputeUnitLimit and SetComputeUnitPrice ahead of everything
// else, so a wallet that adds a priority fee only to a transaction without one
// (Phantom) leaves the message alone. Without it the bytes are exactly what they
// were before the option existed. The SIP instruction stays last either way.

import { Transaction, TransactionInstruction, type PublicKey } from "@solana/web3.js";

import { COMPUTE_BUDGET_PROGRAM, ED25519_PROGRAM, RAYDIUM_CLMM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT } from "../client/addresses";
import { isBase58OfLength } from "../client/base58";
import { base64Encode, tryBase64Decode } from "../client/base64";
import { BorshError, encodeArgs } from "../client/borsh";
import { SIP_PROGRAM_ID, idlInstruction, type OwnerInstructionName } from "../client/idl";
import { linkConsentMessage } from "../client/link-consent";
import { encodeSetComputeUnitLimit, encodeSetComputeUnitPrice } from "../client/message";
import type { ComputeBudget } from "../client/product";
import { U64_MAX, investPolicyProblems, vaultPolicyProblems, type InvestLegInput, type VaultPolicyInput } from "../client/rules";
import { ED25519_SIGNATURE_BYTES, ed25519SignatureValid, encodeEd25519Verify } from "./ed25519";
import { InvalidKeyError, SIP_PROGRAM_KEY, deriveAta, deriveConfigPda, deriveInvestPda, deriveLinkPda, deriveVaultPda, toPublicKey, type KeyLike } from "./pda";
import { MAX_COMPUTE_UNIT_LIMIT, MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS } from "./verify-tx";

export class BuildError extends Error {
  override readonly name: string = "BuildError";
  constructor(readonly problems: readonly string[]) {
    super(problems.join("; "));
  }
}

/** link_wallet with wallet === owner: the program refuses it (WalletIsOwner, 6035), so it is refused here first, with words. */
export class WalletIsOwnerError extends BuildError {
  override readonly name = "WalletIsOwnerError";
  constructor() {
    super(["the trading wallet cannot be the owner's own key: the program refuses to link a wallet to a vault it owns"]);
  }
}

/** A link consent signature that is missing, malformed, or not the wallet's signature over this link's SIP_LINK_V1 bytes. */
export class LinkConsentError extends BuildError {
  override readonly name = "LinkConsentError";
}

export interface RecentBlockhash {
  /** base58, from getLatestBlockhash. */
  readonly blockhash: string;
  /** From the same getLatestBlockhash answer. Echoed back for client/confirm.ts; it does not change the bytes. */
  readonly lastValidBlockHeight?: number;
}

export interface OwnerTxOptions extends RecentBlockhash {
  /**
   * SetComputeUnitLimit and SetComputeUnitPrice, in that order, ahead of every
   * other instruction. Bounded by the verifier's caps. Absent: no compute-budget
   * instruction, and the bytes are unchanged.
   */
  readonly computeBudget?: ComputeBudget;
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
  /** As given with the blockhash, or null. */
  readonly lastValidBlockHeight: number | null;
  readonly vault: string;
  /** IDL account name → address, as placed in the SIP instruction. */
  readonly accounts: Readonly<Record<string, string>>;
  /** The compute budget the transaction carries, or null when it carries none. */
  readonly computeBudget: ComputeBudget | null;
}

const ED25519_PROGRAM_KEY = toPublicKey(ED25519_PROGRAM, "the Ed25519 program");
const COMPUTE_BUDGET_PROGRAM_KEY = toPublicKey(COMPUTE_BUDGET_PROGRAM, "the ComputeBudget program");

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

function blockHeight(value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BuildError(["lastValidBlockHeight must be a non-negative integer, from the same getLatestBlockhash answer as the blockhash"]);
  }
  return value;
}

/** The two compute-budget instructions for `budget`, or none. Refuses a budget the verifier would. */
function computeBudgetInstructions(budget: unknown): { readonly instructions: TransactionInstruction[]; readonly budget: ComputeBudget | null } {
  if (budget === undefined) return { instructions: [], budget: null };
  const { unitLimit, microLamports } = (budget ?? {}) as Partial<ComputeBudget>;
  const problems: string[] = [];
  if (typeof unitLimit !== "number" || !Number.isSafeInteger(unitLimit) || unitLimit < 1 || unitLimit > MAX_COMPUTE_UNIT_LIMIT) {
    problems.push(`computeBudget.unitLimit must be an integer from 1 to ${MAX_COMPUTE_UNIT_LIMIT}`);
  }
  if (typeof microLamports !== "bigint" || microLamports < 0n || microLamports > MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS) {
    problems.push(`computeBudget.microLamports must be a bigint from 0 to ${MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS}`);
  }
  requireProblems(problems);
  const checked = { unitLimit: unitLimit as number, microLamports: microLamports as bigint };
  return {
    budget: checked,
    instructions: [
      new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_KEY, keys: [], data: Buffer.from(encodeSetComputeUnitLimit(checked.unitLimit)) }),
      new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_KEY, keys: [], data: Buffer.from(encodeSetComputeUnitPrice(checked.microLamports)) }),
    ],
  };
}

/**
 * Compiles `instructions` (the SIP instruction last, anything it needs before
 * it) into an unsigned legacy transaction, behind the compute budget when one is
 * given, and checks the signer order.
 */
function compile(
  name: OwnerInstructionName,
  instructions: readonly TransactionInstruction[],
  feePayer: PublicKey,
  expectedSigners: readonly PublicKey[],
  options: OwnerTxOptions,
  vault: PublicKey,
): BuiltTransaction {
  const { blockhash } = options;
  if (!isBase58OfLength(blockhash, 32)) throw new BuildError(["the recent blockhash must be base58 of 32 bytes"]);
  const lastValidBlockHeight = blockHeight(options.lastValidBlockHeight);
  const budget = computeBudgetInstructions(options.computeBudget);
  const sip = instructions[instructions.length - 1]!;
  const tx = new Transaction({ feePayer, recentBlockhash: blockhash }).add(...budget.instructions, ...instructions);
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
    accounts[account.name] = sip.keys[index]!.pubkey.toBase58();
  });
  return {
    instruction: name,
    txBase64: base64Encode(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
    messageBase64: base64Encode(message.serialize()),
    signers,
    feePayer: feePayer.toBase58(),
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    vault: vault.toBase58(),
    accounts,
    computeBudget: budget.budget,
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

export interface CreateVaultV2Input extends VaultPolicyInput, OwnerTxOptions {
  readonly owner: KeyLike;
}

/** create_vault_v2(mode, skim_bps, volume_bps, max_contribution, wallet_reserve): the owner signs and pays. */
export function buildCreateVaultV2(input: CreateVaultV2Input): BuiltTransaction {
  const owner = key(input.owner, "owner");
  const vault = deriveVaultPda(owner);
  const instruction = sipInstruction("create_vault_v2", { owner, vault }, vaultPolicyArgs(input));
  return compile("create_vault_v2", [instruction], owner, [owner], input, vault);
}

export interface SetPolicyV2Input extends VaultPolicyInput, OwnerTxOptions {
  readonly owner: KeyLike;
  readonly paused: boolean;
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
  return compile("set_policy_v2", [instruction], owner, [owner], input, vault);
}

export interface LinkWalletConsentInput {
  readonly owner: KeyLike;
  readonly wallet: KeyLike;
}

export interface LinkWalletConsent {
  readonly instruction: "link_wallet";
  readonly programId: string;
  readonly owner: string;
  readonly wallet: string;
  /** ["vault", owner]: the vault the consent names. */
  readonly vault: string;
  /** ["link", wallet]: the account the link will create. */
  readonly tradingLink: string;
  /**
   * The 140 SIP_LINK_V1 bytes, base64. The trading wallet signs them with
   * signMessage (never signTransaction: a Privy seat can give that). The browser
   * may rebuild them with linkConsentMessage from @sip/solana-core/client and
   * refuse to sign anything else.
   */
  readonly consentMessageBase64: string;
}

function linkParties(input: LinkWalletConsentInput): { owner: PublicKey; wallet: PublicKey; vault: PublicKey; tradingLink: PublicKey; consent: Uint8Array } {
  const owner = key(input.owner, "owner");
  const wallet = key(input.wallet, "wallet");
  if (owner.equals(wallet)) throw new WalletIsOwnerError();
  const vault = deriveVaultPda(owner);
  const consent = linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: wallet.toBytes(), vault: vault.toBytes(), owner: owner.toBytes() });
  return { owner, wallet, vault, tradingLink: deriveLinkPda(wallet), consent };
}

/** Link, step 1: the consent the trading wallet must sign before the link transaction can be built. */
export function prepareLinkWalletConsent(input: LinkWalletConsentInput): LinkWalletConsent {
  const parties = linkParties(input);
  return {
    instruction: "link_wallet",
    programId: SIP_PROGRAM_ID,
    owner: parties.owner.toBase58(),
    wallet: parties.wallet.toBase58(),
    vault: parties.vault.toBase58(),
    tradingLink: parties.tradingLink.toBase58(),
    consentMessageBase64: base64Encode(parties.consent),
  };
}

export interface LinkWalletInput extends LinkWalletConsentInput, OwnerTxOptions {
  /** The wallet's 64-byte signMessage signature over the consent step 1 returned: bytes, or standard base64. */
  readonly consentSignature: Uint8Array | string;
}

function consentSignatureBytes(value: unknown): Uint8Array {
  const bytes = value instanceof Uint8Array ? value : typeof value === "string" ? tryBase64Decode(value) : null;
  if (bytes === null || bytes.length !== ED25519_SIGNATURE_BYTES) {
    throw new LinkConsentError([`the consent signature must be ${ED25519_SIGNATURE_BYTES} bytes, given as bytes or standard base64`]);
  }
  return bytes;
}

/**
 * Whether `consentSignature` is the wallet's signature over the SIP_LINK_V1
 * consent for linking it to `owner`'s vault. Throws LinkConsentError (or
 * WalletIsOwnerError) with words when it is not; buildLinkWallet runs the same
 * check, so the build route can refuse before it reads the chain.
 */
export function checkLinkConsent(input: Omit<LinkWalletInput, "blockhash">): void {
  const { wallet, consent } = linkParties(input);
  const signature = consentSignatureBytes(input.consentSignature);
  if (!ed25519SignatureValid(consent, signature, wallet.toBytes())) {
    throw new LinkConsentError([
      "the consent signature is not the trading wallet's signature over the SIP_LINK_V1 consent for this owner's vault: have the wallet being linked sign the bytes prepareLinkWalletConsent returned",
    ]);
  }
}

/**
 * Link, step 2: [Ed25519SigVerify(wallet, consent, signature), link_wallet] in
 * ONE transaction with TWO signers, owner first. The consent signature is
 * checked here, with node:crypto, before anything is compiled: a signature by
 * another key, or over another owner's consent, would only bounce on chain
 * after both people signed.
 *
 * The owner's wallet signs first and the trading wallet second, over the same
 * message, so a wallet that rewrites the message before signing (adding a
 * priority fee) is the first signer and the co-signature still verifies. The
 * Ed25519 instruction reads its own data (u16::MAX indexes), so an instruction
 * prepended in front of it does not break it.
 */
export function buildLinkWallet(input: LinkWalletInput): BuiltTransaction & { readonly tradingLink: string; readonly consentMessageBase64: string } {
  const { owner, wallet, vault, tradingLink, consent } = linkParties(input);
  checkLinkConsent(input);
  const signature = consentSignatureBytes(input.consentSignature);
  const verifyConsent = new TransactionInstruction({
    programId: ED25519_PROGRAM_KEY,
    keys: [],
    data: Buffer.from(encodeEd25519Verify({ publicKey: wallet.toBytes(), message: consent, signature })),
  });
  const link = sipInstruction("link_wallet", { owner, wallet, vault, trading_link: tradingLink, config: deriveConfigPda() }, {});
  return {
    ...compile("link_wallet", [verifyConsent, link], owner, [owner, wallet], input, vault),
    tradingLink: tradingLink.toBase58(),
    consentMessageBase64: base64Encode(consent),
  };
}

export interface UnlinkWalletInput extends OwnerTxOptions {
  readonly owner: KeyLike;
  readonly wallet: KeyLike;
}

/**
 * unlink_wallet: closes the link; the rent goes back to the owner. THE OWNER
 * ALONE is the authority and the one signer: the program refuses a wallet
 * unlinking itself (UnlinkUnauthorized), because a Privy seat signs with that
 * wallet's key and could then re-link it wherever it liked.
 */
export function buildUnlinkWallet(input: UnlinkWalletInput): BuiltTransaction & { readonly tradingLink: string } {
  const owner = key(input.owner, "owner");
  const wallet = key(input.wallet, "wallet");
  // No such link can exist: link_wallet refuses it.
  if (owner.equals(wallet)) throw new WalletIsOwnerError();
  const vault = deriveVaultPda(owner);
  const tradingLink = deriveLinkPda(wallet);
  const instruction = sipInstruction("unlink_wallet", { authority: owner, owner, vault, trading_link: tradingLink }, {});
  return { ...compile("unlink_wallet", [instruction], owner, [owner], input, vault), tradingLink: tradingLink.toBase58() };
}

export interface WithdrawInput extends OwnerTxOptions {
  readonly owner: KeyLike;
  readonly lamports: bigint;
}

/** withdraw(amount): native SOL out of the vault. Never gated by any pause. */
export function buildWithdraw(input: WithdrawInput): BuiltTransaction {
  const owner = key(input.owner, "owner");
  const amount = positiveU64(input.lamports, "lamports");
  const vault = deriveVaultPda(owner);
  const instruction = sipInstruction("withdraw", { owner, vault }, { amount });
  return compile("withdraw", [instruction], owner, [owner], input, vault);
}

export interface WithdrawTokenInput extends OwnerTxOptions {
  readonly owner: KeyLike;
  readonly mint: KeyLike;
  /** The mint's owning program, read from the chain: classic SPL Token or Token-2022. */
  readonly tokenProgram: KeyLike;
  readonly amountRaw: bigint;
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
    ...compile("withdraw_token", [instruction], owner, [owner], input, vault),
    ownerTokenAccount: ownerToken.toBase58(),
    vaultTokenAccount: vaultToken.toBase58(),
  };
}

export interface SetInvestPolicyInput extends OwnerTxOptions {
  readonly owner: KeyLike;
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
  return { ...compile("set_invest_policy", [instruction], owner, [owner], input, vault), policy: policy.toBase58() };
}
