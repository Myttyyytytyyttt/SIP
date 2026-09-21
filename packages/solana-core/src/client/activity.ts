// What each transaction in a vault's history actually DID, in the program's own
// terms. Browser-safe and pure: the dashboard labels a row from this, never from
// log text and never from a lamport delta alone.
//
// THE ONE RULE HERE IS THAT A SETTLEMENT IS NEVER INFERRED. A vault's SOL going
// up is a transfer until a Settled event says otherwise, because "Saved 0.06 SOL
// from Trading wallet 1" over what was actually a plain deposit is a lie about
// where someone's money came from. So `settled` comes only from the event the
// program emitted, `received_sol` is labelled as the transfer it is, and a
// settle_v2 whose event did not parse is `other`, never a settlement with
// guessed numbers.
//
// AMOUNTS COME FROM THE VAULT'S OWN TOKEN BALANCES, never from an instruction's
// min_out: min_out is a floor the swap had to clear, not what it returned.
// Where a balance is missing the amount is null and the row says less, rather
// than saying something untrue.
//
// Display amounts (uiAmount) are the RPC's strings, subtracted as decimals:
// SPYx is a Token-2022 scaledUiAmount mint, so its display amount is NOT
// amountRaw / 10^decimals and must never be recomputed from raw units.

import { USDC_MINT, WSOL_MINT } from "./addresses";
import type { SettledEvent } from "./decoders";
import { OFFERED_LEGS } from "./product";

/** One top-level SIP instruction of a transaction, named and decoded by the IDL. */
export interface SipInstructionCall {
  /** The IDL instruction name, or "unknown" when no discriminator matched. */
  readonly name: string;
  /**
   * Its arguments by IDL name (snake_case), pubkeys as base58 and `bytes`
   * arguments dropped; null when the data did not decode.
   */
  readonly args: Readonly<Record<string, unknown>> | null;
  /** Its accounts by IDL name. */
  readonly accounts: Readonly<Record<string, string>>;
}

/** A token balance of an account the VAULT owns, before and after one transaction. */
export interface VaultTokenDelta {
  readonly account: string;
  readonly mint: string;
  readonly decimals: number;
  /** Raw units, as decimal strings. "0" for a side the transaction did not carry. */
  readonly preRaw: string;
  readonly postRaw: string;
  /** The RPC's display amounts. Never derived from the raw units. */
  readonly preUi: string;
  readonly postUi: string;
}

/** What classifyVaultEntry reads. readers.ts's VaultActivityEntry satisfies it. */
export interface ClassifiableEntry {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  /** False when the transaction failed on chain. */
  readonly ok: boolean;
  /**
   * Whether the transaction itself could be read. False means the signature is
   * known and its body is not: everything below is empty because nothing was
   * read, NOT because nothing happened.
   */
  readonly readable: boolean;
  readonly instructions: readonly SipInstructionCall[];
  /** The vault's SOL balance change; null when it could not be read. */
  readonly vaultLamportsDelta: bigint | null;
  readonly vaultTokenDeltas: readonly VaultTokenDelta[];
  readonly settled: readonly SettledEvent[];
}

export type VaultEvent =
  /** One Settled event the program emitted. The only thing ever labelled "saved". */
  | {
      readonly kind: "settled";
      readonly wallet: string;
      /** 0 profit, 1 volume. */
      readonly mode: number;
      readonly baseLamports: bigint;
      readonly bps: number;
      /** What the attested base and rate came to. */
      readonly owed: bigint;
      /** What actually moved, after max_contribution. */
      readonly paid: bigint;
      /** paid < owed: the rest is not carried over. */
      readonly capped: boolean;
      readonly settlementNonce: bigint;
      readonly linkEpoch: bigint;
      readonly sessionStartSlot: bigint;
      readonly sessionEndSlot: bigint;
    }
  | { readonly kind: "wrapped"; readonly lamports: bigint | null }
  | { readonly kind: "converted"; readonly lamportsSpent: bigint | null; readonly usdcReceivedRaw: bigint | null }
  | {
      readonly kind: "invested";
      readonly mint: string | null;
      readonly symbol: string | null;
      readonly usdcSpentRaw: bigint | null;
      readonly receivedRaw: bigint | null;
      /** The RPC's display amount gained, as a decimal string. */
      readonly receivedUi: string | null;
    }
  | { readonly kind: "withdrew_sol"; readonly lamports: bigint | null }
  | { readonly kind: "withdrew_token"; readonly mint: string | null; readonly amountRaw: bigint | null; readonly uiAmount: string | null }
  | {
      readonly kind: "vault_created";
      readonly mode: number | null;
      readonly skimBps: number | null;
      readonly volumeBps: number | null;
      readonly maxContribution: bigint | null;
      readonly walletReserve: bigint | null;
    }
  | {
      readonly kind: "rule_changed";
      readonly mode: number | null;
      readonly skimBps: number | null;
      readonly volumeBps: number | null;
      readonly paused: boolean | null;
      readonly maxContribution: bigint | null;
      readonly walletReserve: bigint | null;
    }
  | {
      readonly kind: "policy_signed";
      readonly enabled: boolean | null;
      readonly minInvestment: bigint | null;
      readonly maxPerCall: bigint | null;
      readonly maxRolling30d: bigint | null;
    }
  /** unlink_wallet does not name the wallet among its accounts, so its `wallet` is null. */
  | { readonly kind: "linked"; readonly wallet: string | null }
  | { readonly kind: "unlinked"; readonly wallet: string | null }
  /** SOL arrived with no SIP instruction: a plain transfer, never counted as saved. */
  | { readonly kind: "received_sol"; readonly lamports: bigint }
  /** Something happened that this classifier will not name. Never guessed at. */
  | { readonly kind: "other"; readonly instructions: readonly string[] }
  /** An account-keeping transaction that moved nothing of the vault's. */
  | { readonly kind: "upkeep" }
  | { readonly kind: "failed"; readonly instructions: readonly string[] }
  | { readonly kind: "unreadable" };

export type VaultEventKind = VaultEvent["kind"];

// ── reading decoded arguments, never trusting their type ─────────────────────

const bigintOf = (value: unknown): bigint | null => (typeof value === "bigint" ? value : null);
const numberOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const boolOf = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const arg = (call: SipInstructionCall, name: string): unknown => call.args?.[name];
const account = (call: SipInstructionCall, name: string): string | null => call.accounts[name] ?? null;

// ── decimal strings, subtracted as decimals ──────────────────────────────────

const DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;

function scaled(text: string): { readonly value: bigint; readonly places: number } | null {
  if (typeof text !== "string" || !DECIMAL.test(text)) return null;
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const point = body.indexOf(".");
  const whole = point < 0 ? body : body.slice(0, point);
  const fraction = point < 0 ? "" : body.slice(point + 1);
  const value = BigInt(whole + fraction);
  return { value: negative ? -value : value, places: fraction.length };
}

function formatScaled(value: bigint, places: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = places === 0 ? "" : digits.slice(digits.length - places).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * `minuend` − `subtrahend`, both decimal strings, exactly: the RPC's display
 * amounts are subtracted as written, never through a float.
 */
export function subtractDecimals(minuend: string, subtrahend: string): string | null {
  const a = scaled(minuend);
  const b = scaled(subtrahend);
  if (a === null || b === null) return null;
  const places = Math.max(a.places, b.places);
  const lift = (part: { value: bigint; places: number }): bigint => part.value * 10n ** BigInt(places - part.places);
  return formatScaled(lift(a) - lift(b), places);
}

const rawOf = (text: string): bigint | null => (typeof text === "string" && /^[0-9]+$/.test(text) ? BigInt(text) : null);

interface MintChange {
  /** post − pre, in raw units: positive when the vault gained. */
  readonly rawGain: bigint;
  /** post − pre as the RPC's display amounts; null when either side was not a decimal. */
  readonly uiGain: string | null;
}

/** Every balance of `mint` the vault owns, summed. Null when it holds no account of it in this transaction. */
function changeOf(entry: ClassifiableEntry, mint: string | null): MintChange | null {
  if (mint === null) return null;
  const deltas = entry.vaultTokenDeltas.filter((delta) => delta.mint === mint);
  if (deltas.length === 0) return null;
  let rawGain = 0n;
  for (const delta of deltas) {
    const pre = rawOf(delta.preRaw);
    const post = rawOf(delta.postRaw);
    if (pre === null || post === null) return null;
    rawGain += post - pre;
  }
  // One account is the ordinary case, and the only one a display amount is meaningful for.
  const uiGain = deltas.length === 1 ? subtractDecimals(deltas[0]!.postUi, deltas[0]!.preUi) : null;
  return { rawGain, uiGain };
}

const positive = (value: bigint | null): bigint | null => (value === null ? null : value > 0n ? value : null);

const legSymbol = (mint: string | null): string | null => OFFERED_LEGS.find((leg) => leg.mint === mint)?.symbol ?? null;

// ── one SIP instruction, named ───────────────────────────────────────────────

/**
 * The event for one SIP instruction, or null when this classifier will not name
 * it (a settle_v2 whose event did not parse, or an instruction it does not know).
 * `settlements` is consumed in order, so two Settled events in one transaction
 * become two rows.
 */
function eventOf(call: SipInstructionCall, entry: ClassifiableEntry, settlements: SettledEvent[]): VaultEvent | null {
  switch (call.name) {
    case "settle_v2": {
      const event = settlements.shift();
      // No event, no settlement: the amounts would have to be invented.
      if (event === undefined) return null;
      return {
        kind: "settled",
        wallet: event.wallet,
        mode: event.mode,
        baseLamports: event.baseLamports,
        bps: event.bps,
        owed: event.owed,
        paid: event.paid,
        capped: event.paid < event.owed,
        settlementNonce: event.settlementNonce,
        linkEpoch: event.linkEpoch,
        sessionStartSlot: event.sessionStartSlot,
        sessionEndSlot: event.sessionEndSlot,
      };
    }
    case "wrap_sol":
      return { kind: "wrapped", lamports: bigintOf(arg(call, "amount")) };
    case "convert": {
      const wsol = changeOf(entry, WSOL_MINT);
      const usdc = changeOf(entry, USDC_MINT);
      return {
        kind: "converted",
        lamportsSpent: wsol === null ? null : positive(-wsol.rawGain),
        usdcReceivedRaw: usdc === null ? null : positive(usdc.rawGain),
      };
    }
    case "invest": {
      const mint = account(call, "target_mint");
      const target = changeOf(entry, mint);
      const usdc = changeOf(entry, USDC_MINT);
      return {
        kind: "invested",
        mint,
        symbol: legSymbol(mint),
        usdcSpentRaw: usdc === null ? null : positive(-usdc.rawGain),
        receivedRaw: target === null ? null : positive(target.rawGain),
        receivedUi: target?.uiGain ?? null,
      };
    }
    case "withdraw":
      return { kind: "withdrew_sol", lamports: bigintOf(arg(call, "amount")) };
    case "withdraw_token": {
      const mint = account(call, "token_mint");
      const change = changeOf(entry, mint);
      const uiGain = change?.uiGain ?? null;
      return {
        kind: "withdrew_token",
        mint,
        amountRaw: bigintOf(arg(call, "amount")),
        // The vault's balance went DOWN, so what left it is the gain negated.
        uiAmount: uiGain === null ? null : subtractDecimals("0", uiGain),
      };
    }
    case "create_vault_v2":
      return {
        kind: "vault_created",
        mode: numberOf(arg(call, "mode")),
        skimBps: numberOf(arg(call, "skim_bps")),
        volumeBps: numberOf(arg(call, "volume_bps")),
        maxContribution: bigintOf(arg(call, "max_contribution")),
        walletReserve: bigintOf(arg(call, "wallet_reserve")),
      };
    case "set_policy_v2":
      return {
        kind: "rule_changed",
        mode: numberOf(arg(call, "mode")),
        skimBps: numberOf(arg(call, "skim_bps")),
        volumeBps: numberOf(arg(call, "volume_bps")),
        paused: boolOf(arg(call, "paused")),
        maxContribution: bigintOf(arg(call, "max_contribution")),
        walletReserve: bigintOf(arg(call, "wallet_reserve")),
      };
    case "set_invest_policy":
      return {
        kind: "policy_signed",
        enabled: boolOf(arg(call, "enabled")),
        minInvestment: bigintOf(arg(call, "min_investment")),
        maxPerCall: bigintOf(arg(call, "max_per_call")),
        maxRolling30d: bigintOf(arg(call, "max_rolling_30d")),
      };
    case "link_wallet":
      return { kind: "linked", wallet: account(call, "wallet") };
    case "unlink_wallet":
      // unlink_wallet's accounts are authority, owner, vault and trading_link:
      // the wallet itself is not among them, so it cannot be named here.
      return { kind: "unlinked", wallet: account(call, "wallet") };
    default:
      return null;
  }
}

/**
 * Every event one transaction of a vault's history holds, in instruction order.
 *
 * Precedence: a failed transaction, then one that could not be read, then one
 * event per SIP instruction, and only when there is no SIP instruction at all
 * does a lamport change become `received_sol` — a plain transfer, never a
 * settlement.
 */
export function classifyVaultEntry(entry: ClassifiableEntry): VaultEvent[] {
  const names = entry.instructions.map((call) => call.name);
  if (!entry.ok) return [{ kind: "failed", instructions: names }];
  if (!entry.readable) return [{ kind: "unreadable" }];

  if (entry.instructions.length > 0) {
    const settlements = [...entry.settled];
    const events: VaultEvent[] = [];
    const unnamed: string[] = [];
    for (const call of entry.instructions) {
      const event = eventOf(call, entry, settlements);
      if (event === null) unnamed.push(call.name);
      else events.push(event);
    }
    // An instruction this classifier will not name is said once, as itself.
    if (unnamed.length > 0) events.push({ kind: "other", instructions: unnamed });
    return events;
  }

  const delta = entry.vaultLamportsDelta;
  if (delta !== null && delta > 0n) return [{ kind: "received_sol", lamports: delta }];
  // A token balance moved with no SIP instruction of the vault's: named, not guessed.
  if (entry.vaultTokenDeltas.some((token) => (changeOf(entry, token.mint)?.rawGain ?? 0n) !== 0n)) {
    return [{ kind: "other", instructions: names }];
  }
  return [{ kind: "upkeep" }];
}

/**
 * ONE ENTRY, SCOPED TO ONE VAULT BY WHAT THE PROGRAM ITSELF WROTE — or null
 * when nothing in it is this vault's.
 *
 * WHY THIS EXISTS. `settled` comes from the transaction's LOGS, which are
 * scoped to the SIP program and to nothing else. A page listed for the VAULT
 * PDA is safe without any of this, because the listing itself proved every
 * transaction touched that vault. A page listed for a WALLET's link PDA has no
 * such proof: a link is keyed by the wallet alone (seeds ["link", wallet]) and
 * unlink_wallet closes it, so one wallet's stream can span two vaults' lives.
 * Presenting another owner's Settled event as this owner's savings is the one
 * lie this codebase must not tell.
 *
 * TWO PROOFS, BOTH THE PROGRAM'S OWN WORDS, neither inferred: Settled's first
 * field IS the vault (events.rs emits `vault: vault_key`), and settle_v2,
 * link_wallet and unlink_wallet each name `vault` among their accounts, which
 * namedAccounts keys by IDL name.
 *
 * WHAT IS DELIBERATELY NOT USED. `vaultLamportsDelta !== null` tests nothing:
 * it is null when the vault is absent from the keys AND when the balances were
 * not read AND when the transaction was unreadable. And the vault merely
 * APPEARING among the account keys proves nothing either — any transaction may
 * name any account read-only.
 *
 * THE INSTRUCTION IS WHAT DECIDES, and a kept entry keeps only the settlements
 * of the instructions that survived. eventOf emits a `settled` event ONLY from
 * a settle_v2 call, shifting one event off the list per call, so an entry kept
 * on its logs alone could never show them — and dropping its instructions while
 * keeping its logs would push it into classifyVaultEntry's no-instruction
 * branch and print `received_sol` over somebody else's settlement.
 */
export function scopeEntryToVault<T extends ClassifiableEntry>(entry: T, vault: string): T | null {
  const instructions = entry.instructions.filter((call) => call.accounts.vault === vault);
  if (instructions.length === 0) return null;
  return { ...entry, instructions, settled: entry.settled.filter((event) => event.vault === vault) };
}
