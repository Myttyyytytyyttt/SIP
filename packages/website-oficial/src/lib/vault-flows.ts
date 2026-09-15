/**
 * THE VAULT WRITES, AS PURE ASYNC FLOWS with injected signers: the UI wires
 * Privy into them (src/hooks/use-vault-actions.ts) and the local proof wires
 * throwaway keys into the very same functions.
 *
 * THE SKELETON, for every write: POST /api/solana-build → the page's own check of
 * the unsigned bytes (src/lib/tx-intent.ts) → Phantom signs → the page's check of
 * the bytes Phantom returned → POST /api/solana-tx → confirm through
 * /api/solana-rpc, bounded by the build's lastValidBlockHeight → Solscan.
 *
 * WHAT A FAILURE BECOMES. "expired" when Solana's approval window passed (a
 * simulation's BlockhashNotFound, or a confirmation past the last valid block):
 * nothing moved, and building again is safe. "unconfirmed" when the send route
 * answered 502 with a signature and confirming it could not finish: the page
 * offers Check again on that signature and never re-signing first, or a second
 * write could land. "rate_limited" carries when to retry; "unreadable" means
 * nothing was offered to sign; "refused" carries words.
 *
 * LINKING, IN ORDER. The consent (the trading wallet's signMessage over
 * SIP_LINK_V1, rebuilt and compared here first) carries no blockhash, so it is
 * signed once, before the transaction, and survives a rebuild. Then the link
 * transaction: Phantom signs FIRST, so any rewrite of the fee happens before the
 * second signature exists; the trading wallet co-signs the bytes Phantom
 * RETURNED, at once and headless; its signature is spliced into Phantom's bytes.
 * Two calls, never one variadic signTransaction. If the blockhash is no longer
 * valid, or the simulation says BlockhashNotFound, the transaction is built again
 * with the same consent: at most LINK_MAX_BUILDS builds.
 *
 * AN INVESTMENT POLICY'S FLOORS ARE READ BY THE SERVER, AND CHECKED HERE. The
 * build answers the rates it read and the floors under them; the page requires
 * each floor to be SIP's margin under its rate and never zero, the basket to be
 * SIP's, the caps and on/off to be what the person chose, and every token
 * account created ahead of the policy to be the vault's own, at an address the
 * page derived itself. The floors are shown again while Phantom asks (onBuilt).
 *
 * A WITHDRAWAL signs the amount asked and nothing else: SOL to the pension key,
 * or a token from the vault account the screen showed to the pension key's own
 * associated account.
 */

import {
  CONVERT_FLOOR_MARGIN_BPS,
  DEFAULT_INVEST_CAPS,
  DEFAULT_VAULT_POLICY,
  LEG_FLOOR_MARGIN_BPS,
  OFFERED_LEGS,
  RAYDIUM_CLMM,
  SIP_PROGRAM_ID,
  TOKEN_PROGRAM,
  USDC_MINT,
  WSOL_MINT,
  base64Encode,
  basketWeightsBps,
  bytesEqual,
  confirmSignature,
  defaultInvestPolicy,
  floorWad,
  linkConsentMessage,
  solscanTx,
  tryBase64Decode,
  type ConfirmOutcome,
} from "@sip/solana-core/client";

import { rawFrom } from "@/lib/amounts";
import { privyFailure } from "@/lib/privy-failure";
import { SigningError, isSignerRefusal, type PensionSigner, type SignerRefusal, type TradingSigners } from "@/lib/signing-wallets";
import { IntentError, checkBuiltIntent, checkSignedIntent, mergeCoSignature, type OwnerIntent, type ReadTransaction, type TokenAccountCreateIntent } from "@/lib/tx-intent";
import {
  customCode,
  transactionErrorWords,
  vaultFailureWords,
  type ApiFailure,
  type ApiResult,
  type BuiltTransactionJson,
  type InvestPolicyBuildJson,
  type InvestmentPolicyJson,
  type LinkConsentJson,
  type PolicyFloorsJson,
  type SendResponseJson,
  type VaultApi,
  type WithdrawBuildJson,
  type WithdrawTokenBuildJson,
} from "@/lib/vault-api";
import { FAILURE_COPY, LINK_COPY, PROGRESS_COPY, WITHDRAW_COPY } from "@/lib/vault-copy";
import { deriveAtaAddress, deriveConfigAddress, deriveInvestAddress, deriveLinkAddress, deriveVaultAddress } from "@/lib/vault-pda";

/** TxProgress's steps, in order. "trading_signing" is the link's co-signature only. */
export type FlowStep = "preparing" | "approve_pension" | "trading_signing" | "sending" | "confirming" | "done";

export type FlowResult =
  | { readonly ok: true; readonly signature: string; readonly explorerUrl: string | null; readonly slot: number | null; readonly unitsConsumed: number | null }
  | { readonly ok: false; readonly kind: "refused"; readonly message: string; readonly code?: string }
  | { readonly ok: false; readonly kind: "expired"; readonly message: string }
  | {
      readonly ok: false;
      readonly kind: "unconfirmed";
      readonly message: string;
      readonly signature: string;
      readonly explorerUrl: string | null;
      readonly lastValidBlockHeight: number;
    }
  | { readonly ok: false; readonly kind: "rate_limited"; readonly message: string; readonly retryAfterSeconds: number | null }
  | { readonly ok: false; readonly kind: "unreadable"; readonly message: string };

export interface FlowDeps {
  readonly api: VaultApi;
  readonly onStep?: (step: FlowStep) => void;
  /** The build route's answer once the page has checked it, just before Phantom is asked: what the screen shows while it waits. */
  readonly onBuilt?: (body: BuiltTransactionJson) => void;
  /** Default: confirmSignature through api.rpc (getSignatureStatuses, getBlockHeight). */
  readonly confirm?: (signature: string, lastValidBlockHeight: number) => Promise<ConfirmOutcome>;
}

/** The link transaction is built at most this many times: once, and once more after Solana's approval window passes. */
export const LINK_MAX_BUILDS = 2;

const refused = (message: string, code?: string): FlowResult => (code === undefined ? { ok: false, kind: "refused", message } : { ok: false, kind: "refused", message, code });

/** A flow's own words for a transaction the chain refused, by its error, with a code the screen acts on; null for the general words. */
type Explain = (err: unknown) => { readonly message: string; readonly code: string } | null;

function fromFailure(failure: ApiFailure, explain?: Explain): FlowResult {
  if (failure.status === 429 || failure.code === "rate_limited") {
    return { ok: false, kind: "rate_limited", message: vaultFailureWords(failure), retryAfterSeconds: failure.retryAfterSeconds };
  }
  if (failure.status === 0 || failure.code === "unreadable" || failure.code === "upstream_unavailable" || failure.code === "unavailable") {
    return { ok: false, kind: "unreadable", message: vaultFailureWords(failure) };
  }
  if (failure.code === "simulation_failed" && failure.body.err === "BlockhashNotFound") return { ok: false, kind: "expired", message: PROGRESS_COPY.tookTooLongDetail };
  const own = failure.code === "simulation_failed" ? (explain?.(failure.body.err) ?? null) : null;
  if (own !== null) return refused(own.message, own.code);
  const words = vaultFailureWords(failure);
  // An account that already exists is a state to re-read, not a mistake.
  return refused(words, words === FAILURE_COPY.alreadyExists ? "already_exists" : failure.code);
}

function intentFailure(error: unknown): FlowResult {
  if (error instanceof IntentError) return refused(error.message);
  throw error;
}

function signingFailure(error: unknown, who: "phantom" | "trading"): FlowResult {
  if (error instanceof SigningError) return refused(error.message);
  const declined = who === "phantom" ? FAILURE_COPY.phantomDeclined : FAILURE_COPY.tradingDeclined;
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/reject|denied|declin|cancel|closed/i.test(raw)) return refused(declined);
  const described = privyFailure(error);
  return refused(described.kind === "exited" ? declined : described.message);
}

async function confirmed(deps: FlowDeps, signature: string, lastValidBlockHeight: number, unitsConsumed: number | null, explain?: Explain): Promise<FlowResult> {
  const confirm = deps.confirm ?? ((sig: string, height: number) => confirmSignature({ rpc: (method, params) => deps.api.rpc(method, params), signature: sig, lastValidBlockHeight: height }));
  let outcome: ConfirmOutcome;
  try {
    outcome = await confirm(signature, lastValidBlockHeight);
  } catch {
    return { ok: false, kind: "unconfirmed", message: PROGRESS_COPY.notConfirmedDetail, signature, explorerUrl: solscanTx(signature), lastValidBlockHeight };
  }
  if (outcome.status === "confirmed" || outcome.status === "finalized") {
    deps.onStep?.("done");
    return { ok: true, signature, explorerUrl: solscanTx(signature), slot: outcome.slot, unitsConsumed };
  }
  if (outcome.status === "failed") {
    const own = explain?.(outcome.err) ?? null;
    return own === null ? refused(transactionErrorWords(outcome.err, [])) : refused(own.message, own.code);
  }
  return { ok: false, kind: "expired", message: PROGRESS_COPY.tookTooLongDetail };
}

type Landing = FlowResult | { readonly rebuild: true };

/** What the send route's answer means: confirm a sent signature (200, or 502 with one), rebuild on an expired blockhash, or words. */
async function landing(deps: FlowDeps, sent: ApiResult<SendResponseJson>, lastValidBlockHeight: number, explain?: Explain): Promise<Landing> {
  if (sent.ok) {
    deps.onStep?.("confirming");
    return confirmed(deps, sent.body.signature, lastValidBlockHeight, sent.body.unitsConsumed, explain);
  }
  if (sent.code === "simulation_failed" && sent.body.err === "BlockhashNotFound") return { rebuild: true };
  const signature = typeof sent.body.signature === "string" ? sent.body.signature : null;
  if ((sent.code === "send_unconfirmed" || sent.code === "send_failed") && signature !== null) {
    // It may land: confirm this signature before anyone is asked to sign again.
    deps.onStep?.("confirming");
    return confirmed(deps, signature, lastValidBlockHeight, null, explain);
  }
  return fromFailure(sent, explain);
}

/** Confirms a signature the send route already took ("Check again"): never builds or signs. */
export async function checkAgainFlow(deps: FlowDeps, input: { readonly signature: string; readonly lastValidBlockHeight: number }): Promise<FlowResult> {
  deps.onStep?.("confirming");
  return confirmed(deps, input.signature, input.lastValidBlockHeight, null);
}

function builtBytes(body: BuiltTransactionJson): { readonly bytes: Uint8Array; readonly lastValidBlockHeight: number } | null {
  const bytes = tryBase64Decode(body.txBase64);
  const lastValidBlockHeight = body.lastValidBlockHeight;
  return bytes === null || typeof lastValidBlockHeight !== "number" ? null : { bytes, lastValidBlockHeight };
}

// ── the writes the pension key signs alone ───────────────────────────────────

export interface PensionFlowDeps extends FlowDeps {
  readonly signers: PensionSigner | SignerRefusal;
}

/**
 * Build `request`, check the unsigned bytes against the intent the page derives
 * from the answer, have Phantom sign, check what it returned, send, confirm.
 * `intentOf` throws IntentError when the answer is not what the person asked for.
 */
async function pensionWrite<T extends BuiltTransactionJson>(
  deps: PensionFlowDeps,
  request: Readonly<Record<string, unknown>>,
  intentOf: (body: T) => Promise<OwnerIntent>,
  explain?: Explain,
): Promise<FlowResult> {
  if (isSignerRefusal(deps.signers)) return refused(deps.signers.refusal);
  const signers = deps.signers;
  deps.onStep?.("preparing");
  const built = await deps.api.build<T>(request);
  if (!built.ok) return fromFailure(built);
  const unsigned = builtBytes(built.body);
  if (unsigned === null) return refused(FAILURE_COPY.unreadableBuilt);

  let intent: OwnerIntent;
  let checked: ReadTransaction;
  try {
    intent = await intentOf(built.body);
    checked = checkBuiltIntent(unsigned.bytes, intent);
  } catch (error) {
    return intentFailure(error);
  }

  deps.onBuilt?.(built.body);
  deps.onStep?.("approve_pension");
  let signed: Uint8Array;
  try {
    signed = await signers.signWithPension(unsigned.bytes);
  } catch (error) {
    return signingFailure(error, "phantom");
  }
  try {
    checkSignedIntent(signed, checked, intent);
  } catch (error) {
    return intentFailure(error);
  }

  deps.onStep?.("sending");
  const landed = await landing(deps, await deps.api.send(signed), unsigned.lastValidBlockHeight, explain);
  return "rebuild" in landed ? { ok: false, kind: "expired", message: PROGRESS_COPY.tookTooLongDetail } : landed;
}

// ── create_vault_v2 ──────────────────────────────────────────────────────────

export type CreateVaultDeps = PensionFlowDeps;

export interface CreateVaultInput {
  readonly pensionKey: string;
  /** 0 PROFIT, 1 VOLUME (the server refuses 1 while it is not offered). */
  readonly mode: number;
  /** Lamports; the product's default when absent. */
  readonly maxContribution?: bigint;
  /** Lamports; the product's default when absent. */
  readonly walletReserve?: bigint;
}

/** Creates the pension key's vault: one build, Phantom's one signature, one send. */
export async function createVaultFlow(deps: CreateVaultDeps, input: CreateVaultInput): Promise<FlowResult> {
  const request: Record<string, unknown> = { action: "createVault", owner: input.pensionKey, mode: input.mode };
  if (input.maxContribution !== undefined) request.maxContribution = input.maxContribution.toString();
  if (input.walletReserve !== undefined) request.walletReserve = input.walletReserve.toString();
  return pensionWrite<BuiltTransactionJson>(deps, request, async () => ({
    instruction: "create_vault_v2",
    signers: [input.pensionKey],
    accounts: { owner: input.pensionKey, vault: await deriveVaultAddress(input.pensionKey) },
    args: {
      mode: input.mode,
      skim_bps: DEFAULT_VAULT_POLICY.skimBps,
      volume_bps: DEFAULT_VAULT_POLICY.volumeBps,
      max_contribution: input.maxContribution ?? DEFAULT_VAULT_POLICY.maxContribution,
      wallet_reserve: input.walletReserve ?? DEFAULT_VAULT_POLICY.walletReserve,
    },
  }));
}

// ── set_invest_policy ────────────────────────────────────────────────────────

export interface InvestPolicyInput {
  readonly pensionKey: string;
  /** USDC raw units; the product's default when absent. */
  readonly maxPerCall?: bigint;
  /** USDC raw units; the product's default when absent. */
  readonly maxRolling30d?: bigint;
  /** Default true. */
  readonly enabled?: boolean;
}

/** Why the floors a build answered are not SIP's margins under the rates it read, for SIP's basket; null when they are. */
function floorsProblem(floors: PolicyFloorsJson | undefined): string | null {
  const margin = (wad: bigint | null, bps: number): bigint | null => {
    try {
      return wad === null ? null : floorWad(wad, bps);
    } catch {
      return null;
    }
  };
  if (floors === undefined || floors === null) return "it carries no price floors";
  if (floors.marginBps?.convert !== CONVERT_FLOOR_MARGIN_BPS || floors.marginBps?.leg !== LEG_FLOOR_MARGIN_BPS) return "its price margins are not SIP's";
  const convert = rawFrom(floors.convertWad);
  if (convert === null || convert === 0n || convert !== margin(rawFrom(floors.liveConvertWad), CONVERT_FLOOR_MARGIN_BPS)) {
    return "its SOL floor is not 90 % of the price it read";
  }
  if (!Array.isArray(floors.legs) || floors.legs.length !== OFFERED_LEGS.length) return "its basket is not SIP's";
  for (const [index, leg] of OFFERED_LEGS.entries()) {
    const entry = floors.legs[index];
    const wad = rawFrom(entry?.wad);
    if (entry?.mint !== leg.mint || wad === null || wad === 0n || wad !== margin(rawFrom(entry.liveWad), LEG_FLOOR_MARGIN_BPS)) {
      return `its ${leg.symbol} floor is not 95 % of the rate it read`;
    }
  }
  return null;
}

/** The token accounts a policy build says it creates, bound to the vault's own associated addresses as this page derives them. */
async function tokenAccountCreates(pensionKey: string, vault: string, listed: InvestPolicyBuildJson["vaultTokenAccounts"] | undefined): Promise<TokenAccountCreateIntent[]> {
  const targets = [
    { mint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM },
    { mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM },
    ...OFFERED_LEGS.map((leg) => ({ mint: leg.mint, tokenProgram: leg.tokenProgram })),
  ];
  const matches =
    Array.isArray(listed) &&
    listed.length === targets.length &&
    listed.every((entry, index) => entry?.mint === targets[index]!.mint && entry.tokenProgram === targets[index]!.tokenProgram && typeof entry.create === "boolean");
  if (!matches) throw new IntentError(FAILURE_COPY.builtMismatch("its list of your vault's token accounts is not SIP's"));
  const creates: TokenAccountCreateIntent[] = [];
  for (const [index, target] of targets.entries()) {
    if (listed[index]!.create !== true) continue;
    creates.push({ funder: pensionKey, account: await deriveAtaAddress(vault, target.mint, target.tokenProgram), wallet: vault, mint: target.mint, tokenProgram: target.tokenProgram });
  }
  return creates;
}

/**
 * Signs the vault's investment policy: SIP's basket at the floors the build read,
 * the caps and on/off the person chose, and the vault token accounts it lacks,
 * paid by the pension key.
 */
export async function investPolicyFlow(deps: PensionFlowDeps, input: InvestPolicyInput): Promise<FlowResult> {
  const request: Record<string, unknown> = { action: "investPolicy", owner: input.pensionKey };
  if (input.maxPerCall !== undefined) request.maxPerCall = input.maxPerCall.toString();
  if (input.maxRolling30d !== undefined) request.maxRolling30d = input.maxRolling30d.toString();
  if (input.enabled !== undefined) request.enabled = input.enabled;
  return pensionWrite<InvestPolicyBuildJson>(deps, request, async (body) => {
    const problem = floorsProblem(body.floors);
    if (problem !== null) throw new IntentError(FAILURE_COPY.builtMismatch(problem));
    const vault = await deriveVaultAddress(input.pensionKey);
    const weights = basketWeightsBps(OFFERED_LEGS.length);
    return {
      instruction: "set_invest_policy",
      signers: [input.pensionKey],
      accounts: { owner: input.pensionKey, vault, policy: await deriveInvestAddress(vault) },
      args: {
        legs: OFFERED_LEGS.map((leg, index) => ({ mint: leg.mint, weight_bps: weights[index]!, min_out_rate_wad: BigInt(body.floors.legs[index]!.wad) })),
        venue_program: RAYDIUM_CLMM,
        in_mint: USDC_MINT,
        min_convert_rate_wad: BigInt(body.floors.convertWad),
        min_investment: defaultInvestPolicy(OFFERED_LEGS.length).minInvestment,
        max_per_call: input.maxPerCall ?? DEFAULT_INVEST_CAPS.maxPerCall,
        max_rolling_30d: input.maxRolling30d ?? DEFAULT_INVEST_CAPS.maxRolling30d,
        enabled: input.enabled ?? true,
      },
      tokenAccountCreates: await tokenAccountCreates(input.pensionKey, vault, body.vaultTokenAccounts),
    };
  });
}

export interface PauseInvestingInput {
  readonly pensionKey: string;
  /** The policy the screen shows. The transaction must re-sign exactly it, with investing off. */
  readonly policy: InvestmentPolicyJson;
}

/**
 * Pauses investing: set_invest_policy re-signing the stored policy the screen
 * shows, every leg, floor, venue, in-mint and cap as they are, with enabled
 * false. The build reads no pool, so a pause works when today's prices cannot be
 * read; the page holds the bytes to the policy it shows, not to any price.
 */
export async function pauseInvestingFlow(deps: PensionFlowDeps, input: PauseInvestingInput): Promise<FlowResult> {
  return pensionWrite<BuiltTransactionJson>(deps, { action: "pauseInvesting", owner: input.pensionKey }, async () => {
    const { policy } = input;
    const shown = FAILURE_COPY.builtMismatch("the policy on screen could not be read");
    const amount = (text: string | undefined): bigint => {
      const value = rawFrom(text);
      if (value === null) throw new IntentError(shown);
      return value;
    };
    const vault = await deriveVaultAddress(input.pensionKey);
    if (policy.vault !== vault || !Array.isArray(policy.legs)) throw new IntentError(shown);
    return {
      instruction: "set_invest_policy",
      signers: [input.pensionKey],
      accounts: { owner: input.pensionKey, vault, policy: await deriveInvestAddress(vault) },
      args: {
        legs: policy.legs.map((leg) => ({ mint: leg.mint, weight_bps: leg.weightBps, min_out_rate_wad: amount(leg.minOutRateWad) })),
        venue_program: policy.venueProgram,
        in_mint: policy.inMint,
        min_convert_rate_wad: amount(policy.minConvertRateWad),
        min_investment: amount(policy.minInvestment),
        max_per_call: amount(policy.maxPerCall),
        max_rolling_30d: amount(policy.maxRolling30d),
        enabled: false,
      },
    };
  });
}

// ── withdraw and withdraw_token ──────────────────────────────────────────────

export interface WithdrawInput {
  readonly pensionKey: string;
  readonly lamports: bigint;
}

/** The program's InsufficientVaultBalance: the withdrawal would leave the vault below its rent floor. */
const INSUFFICIENT_VAULT_BALANCE = 6004;

/**
 * Takes SOL out of the vault to the pension key: exactly the lamports asked.
 *
 * The build route only builds an amount the vault could release when it read it,
 * so a 6004 afterwards means the vault's SOL moved in between: with investing on,
 * an armed keeper wraps and converts free SOL at its next sweep. That is said, not
 * a rent reserve the person never touched, and the screen reads the vault again.
 */
export async function withdrawFlow(deps: PensionFlowDeps, input: WithdrawInput): Promise<FlowResult> {
  return pensionWrite<WithdrawBuildJson>(
    deps,
    { action: "withdraw", owner: input.pensionKey, lamports: input.lamports.toString() },
    async () => ({
      instruction: "withdraw",
      signers: [input.pensionKey],
      accounts: { owner: input.pensionKey, vault: await deriveVaultAddress(input.pensionKey) },
      args: { amount: input.lamports },
    }),
    (err) => (customCode(err) === INSUFFICIENT_VAULT_BALANCE ? { message: WITHDRAW_COPY.balanceMoved, code: "balance_moved" } : null),
  );
}

export interface WithdrawTokenInput {
  readonly pensionKey: string;
  readonly mint: string;
  /** Raw units: what moves. */
  readonly amountRaw: bigint;
  /** The vault's token account the screen showed this holding in: the build must take it from exactly there. */
  readonly vaultTokenAccount: string;
  /** Its token program, as the screen read it. */
  readonly tokenProgram: string;
}

/**
 * Takes a token out of the vault account the screen showed, into the pension key's own associated account for that
 * mint. The request names that account, and the build route reads it by address before it builds.
 */
export async function withdrawTokenFlow(deps: PensionFlowDeps, input: WithdrawTokenInput): Promise<FlowResult> {
  const request = { action: "withdrawToken", owner: input.pensionKey, mint: input.mint, amountRaw: input.amountRaw.toString(), vaultToken: input.vaultTokenAccount };
  return pensionWrite<WithdrawTokenBuildJson>(deps, request, async () => ({
    instruction: "withdraw_token",
    signers: [input.pensionKey],
    accounts: {
      owner: input.pensionKey,
      vault: await deriveVaultAddress(input.pensionKey),
      token_mint: input.mint,
      vault_token: input.vaultTokenAccount,
      owner_token: await deriveAtaAddress(input.pensionKey, input.mint, input.tokenProgram),
      token_program: input.tokenProgram,
    },
    args: { amount: input.amountRaw },
  }));
}

// ── link_wallet ──────────────────────────────────────────────────────────────

export interface LinkWalletDeps extends FlowDeps {
  readonly pension: PensionSigner | SignerRefusal;
  readonly trading: TradingSigners | SignerRefusal;
  /** Default: isBlockhashValid through api.rpc. An answer that cannot be read counts as valid: the simulation decides. */
  readonly isBlockhashValid?: (blockhash: string) => Promise<boolean>;
}

export interface LinkWalletInput {
  readonly pensionKey: string;
  readonly tradingAddress: string;
  /** A consent this trading wallet already signed for this link in this session, kept in memory only. */
  readonly consentSignature?: Uint8Array | null;
}

/** A link's result, with the consent signature to reuse when the link did not land (null once it landed, or when the server refused the consent). */
export type LinkWalletResult = FlowResult & { readonly consentSignature: Uint8Array | null };

async function blockhashStillValid(deps: LinkWalletDeps, blockhash: string): Promise<boolean> {
  try {
    if (deps.isBlockhashValid !== undefined) return await deps.isBlockhashValid(blockhash);
    const answer = await deps.api.rpc<{ value?: unknown }>("isBlockhashValid", [blockhash, { commitment: "confirmed" }]);
    return answer?.value !== false;
  } catch {
    return true;
  }
}

/** Links a trading wallet to the pension key's vault: the consent, then one transaction both keys sign, Phantom first. */
export async function linkWalletFlow(deps: LinkWalletDeps, input: LinkWalletInput): Promise<LinkWalletResult> {
  const { pensionKey, tradingAddress } = input;
  const result = (outcome: FlowResult, consentSignature: Uint8Array | null): LinkWalletResult => ({ ...outcome, consentSignature });
  // Before any request and any wallet: the program refuses it, and so does everything between.
  if (tradingAddress === pensionKey) return result(refused(LINK_COPY.walletIsPension), null);
  if (isSignerRefusal(deps.pension)) return result(refused(deps.pension.refusal), null);
  if (isSignerRefusal(deps.trading)) return result(refused(deps.trading.refusal), null);
  const pension = deps.pension;
  const trading = deps.trading;

  deps.onStep?.("preparing");
  const prepared = await deps.api.build<LinkConsentJson>({ action: "prepareLink", owner: pensionKey, wallet: tradingAddress });
  if (!prepared.ok) return result(fromFailure(prepared), null);
  const [vault, tradingLink, config] = await Promise.all([deriveVaultAddress(pensionKey), deriveLinkAddress(tradingAddress), deriveConfigAddress()]);
  const expected = linkConsentMessage({ programId: SIP_PROGRAM_ID, wallet: tradingAddress, vault, owner: pensionKey });
  const offered = tryBase64Decode(prepared.body.consentMessageBase64);
  if (
    prepared.body.programId !== SIP_PROGRAM_ID ||
    prepared.body.owner !== pensionKey ||
    prepared.body.wallet !== tradingAddress ||
    prepared.body.vault !== vault ||
    offered === null ||
    !bytesEqual(offered, expected)
  ) {
    return result(refused(LINK_COPY.consentMismatch), null);
  }

  let consent = input.consentSignature ?? null;
  if (consent === null) {
    try {
      consent = await trading.signMessageWithTrading(expected);
    } catch (error) {
      return result(signingFailure(error, "trading"), null);
    }
  }
  const intent: OwnerIntent = {
    instruction: "link_wallet",
    signers: [pensionKey, tradingAddress],
    accounts: { owner: pensionKey, wallet: tradingAddress, vault, trading_link: tradingLink, config },
    args: {},
    consent: { wallet: tradingAddress, message: expected, signature: consent },
  };

  for (let build = 1; build <= LINK_MAX_BUILDS; build++) {
    if (build > 1) deps.onStep?.("preparing");
    const built = await deps.api.build<BuiltTransactionJson>({ action: "link", owner: pensionKey, wallet: tradingAddress, consentSignature: base64Encode(consent) });
    if (!built.ok) return result(fromFailure(built), built.code === "link_consent_invalid" ? null : consent);
    const unsigned = builtBytes(built.body);
    if (unsigned === null) return result(refused(FAILURE_COPY.unreadableBuilt), consent);
    let checked: ReadTransaction;
    try {
      checked = checkBuiltIntent(unsigned.bytes, intent);
    } catch (error) {
      return result(intentFailure(error), consent);
    }

    deps.onStep?.("approve_pension");
    let phantomBytes: Uint8Array;
    try {
      phantomBytes = await pension.signWithPension(unsigned.bytes);
    } catch (error) {
      return result(signingFailure(error, "phantom"), consent);
    }
    try {
      checkSignedIntent(phantomBytes, checked, intent);
    } catch (error) {
      return result(intentFailure(error), consent);
    }

    deps.onStep?.("trading_signing");
    let merged: Uint8Array;
    try {
      merged = mergeCoSignature(phantomBytes, await trading.signWithTrading(phantomBytes));
    } catch (error) {
      if (error instanceof IntentError) return result(refused(error.message), consent);
      return result(signingFailure(error, "trading"), consent);
    }

    if (!(await blockhashStillValid(deps, checked.parsed.recentBlockhash))) continue;
    deps.onStep?.("sending");
    const landed = await landing(deps, await deps.api.send(merged), unsigned.lastValidBlockHeight);
    if ("rebuild" in landed) continue;
    return result(landed, landed.ok ? null : consent);
  }
  return result({ ok: false, kind: "expired", message: LINK_COPY.approvalPassedTwice }, consent);
}
