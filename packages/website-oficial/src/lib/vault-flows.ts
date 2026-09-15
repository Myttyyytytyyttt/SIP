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
 */

import { DEFAULT_VAULT_POLICY, SIP_PROGRAM_ID, base64Encode, bytesEqual, confirmSignature, linkConsentMessage, solscanTx, tryBase64Decode, type ConfirmOutcome } from "@sip/solana-core/client";

import { privyFailure } from "@/lib/privy-failure";
import { SigningError, isSignerRefusal, type PensionSigner, type SignerRefusal, type TradingSigners } from "@/lib/signing-wallets";
import { IntentError, checkBuiltIntent, checkSignedIntent, mergeCoSignature, type OwnerIntent, type ReadTransaction } from "@/lib/tx-intent";
import { transactionErrorWords, vaultFailureWords, type ApiFailure, type ApiResult, type BuiltTransactionJson, type LinkConsentJson, type SendResponseJson, type VaultApi } from "@/lib/vault-api";
import { FAILURE_COPY, LINK_COPY, PROGRESS_COPY } from "@/lib/vault-copy";
import { deriveConfigAddress, deriveLinkAddress, deriveVaultAddress } from "@/lib/vault-pda";

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
  /** Default: confirmSignature through api.rpc (getSignatureStatuses, getBlockHeight). */
  readonly confirm?: (signature: string, lastValidBlockHeight: number) => Promise<ConfirmOutcome>;
}

/** The link transaction is built at most this many times: once, and once more after Solana's approval window passes. */
export const LINK_MAX_BUILDS = 2;

const refused = (message: string, code?: string): FlowResult => (code === undefined ? { ok: false, kind: "refused", message } : { ok: false, kind: "refused", message, code });

function fromFailure(failure: ApiFailure): FlowResult {
  if (failure.status === 429 || failure.code === "rate_limited") {
    return { ok: false, kind: "rate_limited", message: vaultFailureWords(failure), retryAfterSeconds: failure.retryAfterSeconds };
  }
  if (failure.status === 0 || failure.code === "unreadable" || failure.code === "upstream_unavailable" || failure.code === "unavailable") {
    return { ok: false, kind: "unreadable", message: vaultFailureWords(failure) };
  }
  if (failure.code === "simulation_failed" && failure.body.err === "BlockhashNotFound") return { ok: false, kind: "expired", message: PROGRESS_COPY.tookTooLongDetail };
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

async function confirmed(deps: FlowDeps, signature: string, lastValidBlockHeight: number, unitsConsumed: number | null): Promise<FlowResult> {
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
  if (outcome.status === "failed") return refused(transactionErrorWords(outcome.err, []));
  return { ok: false, kind: "expired", message: PROGRESS_COPY.tookTooLongDetail };
}

type Landing = FlowResult | { readonly rebuild: true };

/** What the send route's answer means: confirm a sent signature (200, or 502 with one), rebuild on an expired blockhash, or words. */
async function landing(deps: FlowDeps, sent: ApiResult<SendResponseJson>, lastValidBlockHeight: number): Promise<Landing> {
  if (sent.ok) {
    deps.onStep?.("confirming");
    return confirmed(deps, sent.body.signature, lastValidBlockHeight, sent.body.unitsConsumed);
  }
  if (sent.code === "simulation_failed" && sent.body.err === "BlockhashNotFound") return { rebuild: true };
  const signature = typeof sent.body.signature === "string" ? sent.body.signature : null;
  if ((sent.code === "send_unconfirmed" || sent.code === "send_failed") && signature !== null) {
    // It may land: confirm this signature before anyone is asked to sign again.
    deps.onStep?.("confirming");
    return confirmed(deps, signature, lastValidBlockHeight, null);
  }
  return fromFailure(sent);
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

// ── create_vault_v2 ──────────────────────────────────────────────────────────

export interface CreateVaultDeps extends FlowDeps {
  readonly signers: PensionSigner | SignerRefusal;
}

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
  if (isSignerRefusal(deps.signers)) return refused(deps.signers.refusal);
  const signers = deps.signers;
  deps.onStep?.("preparing");
  const request: Record<string, unknown> = { action: "createVault", owner: input.pensionKey, mode: input.mode };
  if (input.maxContribution !== undefined) request.maxContribution = input.maxContribution.toString();
  if (input.walletReserve !== undefined) request.walletReserve = input.walletReserve.toString();
  const built = await deps.api.build<BuiltTransactionJson>(request);
  if (!built.ok) return fromFailure(built);
  const unsigned = builtBytes(built.body);
  if (unsigned === null) return refused(FAILURE_COPY.unreadableBuilt);

  const intent: OwnerIntent = {
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
  };
  let checked: ReadTransaction;
  try {
    checked = checkBuiltIntent(unsigned.bytes, intent);
  } catch (error) {
    return intentFailure(error);
  }

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
  const landed = await landing(deps, await deps.api.send(signed), unsigned.lastValidBlockHeight);
  return "rebuild" in landed ? { ok: false, kind: "expired", message: PROGRESS_COPY.tookTooLongDetail } : landed;
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
