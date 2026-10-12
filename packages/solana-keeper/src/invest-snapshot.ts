// The `invest-batch` cut (C5, with C2 inside): the invest turn's at-rest reads,
// folded into the sweep's one vault batch (ADR §2.3.3; CUTS §3.3; PLAN §3.2 P2).
//
// WHAT IT REMOVES. Today every profit-keeper turn runs runInvestTick once per
// link, and before it can say "nothing to do" it reads the policy PDA, a
// getMultipleAccountsInfo of [vault, Clock, Pyth SOL, Pyth USDC, EpochSchedule],
// the vault's rent floor (uncached) and the wSOL and USDC balances — five
// requests for a basket link, one for a link with no policy, every sweep, for
// users who did nothing (MEASURED: the census's 19 calls a sweep on today's
// fleet are 14 of exactly that). The sweep has already read every turned vault
// in one batch. This reads, in that same batch, everything the at-rest decision
// needs: per turned vault [vault, policy, wSOL ATA, USDC ATA], and once per sweep
// the Clock, the two Pyth feeds and the EpochSchedule — ⌈(4V + 4) / 100⌉
// requests in place of one, so 19 → 7 on today's fleet.
//
// THE RULE THAT KEEPS IT OFF THE MONEY PATH: THE SNAPSHOT MAY ONLY DECIDE A TURN
// THAT SENDS NOTHING. NO_POLICY, a disabled policy, the in-mint refusal, either
// pause, the 30-day cap, below the minimum, a dry run's "would invest" — the
// outcomes today's code reaches before its first live act. Every other answer —
// a turn that would wrap, convert or buy, and every FAILED — is thrown away and
// the turn is run AGAIN with today's fresh reads (runInvestTick), so every byte
// of every transaction is built from what is on chain at the moment of the
// buy, exactly as before. A buying turn therefore pays +5 reads, which the cost
// model counts.
//
// AND IT NEVER DECIDES FROM THE SETTLE. A vault that settled, or sent anything,
// earlier in the same sweep is "dirty" (bin/keeper.mts) and gets no snapshot:
// the batch was read before that SOL arrived. Invest decides from the vault's
// OWN balances every turn — a manual deposit with no settle at all is bought
// as today (memory: keeper-user-ceiling-measured, the manual-deposit trap) —
// because the snapshot holds the vault's own ATA balances, not a verdict about
// the settle.
//
// AND A REST DECIDED FROM IT IS DATED BY THE BATCH, NOT BY THE TURN (review,
// 2026-10-12). The doorbell lets a resting turn answer a bell only when the turn
// BEGAN BELL_ANSWER_MARGIN_MS after it rang (src/doorbell.ts), on the premise
// that its reads came after its start. A snapshot's did not: they were taken
// when the sweep's batch was, before the turn loop began. A deposit that rang
// between the batch and the turn was then "answered" by an IDLE that could not
// have seen it, the link rested, and the deposit waited for the safety lane — up
// to SAFETY_PASS_MS instead of one sweep. So a turn whose invest half was decided
// from the snapshot tells the doorbell the batch's time (restVerdictReadAt): the
// bell it could not have seen keeps ringing, and the next sweep turns the link
// on fresh reads.
//
// RENT (C2) is the one read the batch cannot carry: it is not an account. It is
// asked once per (connection, size) and remembered, the same pattern as
// settle-tick.ts's rentExemptZero, and only on the snapshot path — the fresh
// path a buying turn takes still reads it, so a buy reads what it always read.

import type * as anchor from "@coral-xyz/anchor";
import type { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { SYSVAR_CLOCK_PUBKEY, SYSVAR_EPOCH_SCHEDULE_PUBKEY } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { decodeVault, investmentPolicyAddress, type VaultState } from "./accounts.js";
import { USDC_MINT } from "./invest-decision.js";
import type { InvestOutcome, InvestResult } from "./invest-tick.js";
import { PYTH_SOL_USD_FEED, PYTH_USDC_USD_FEED } from "./pyth.js";
import type { SettleOutcome } from "./settle-decision.js";

/** Solana's getMultipleAccounts ceiling: a request names at most this many accounts. */
export const SWEEP_STATE_CHUNK = 100;

/** The SPL Token account layout: mint(32) owner(32) amount(u64 at 64) …, 165 bytes. */
const TOKEN_ACCOUNT_BYTES = 165;
const TOKEN_AMOUNT_OFFSET = 64;

/**
 * One vault's at-rest state, as the sweep's batch read it.
 *
 * THE POLICY IS KEPT AS BYTES, NOT DECODED, on purpose. A policy that does not
 * decode throws today, inside that vault's turn (readInvestmentPolicy), and the
 * wallet turn's catch reports it. Decoding here would either take the whole
 * batch — every vault's settle — down with one bad policy, or turn the throw
 * into a NO_POLICY that says nothing. The turn decodes it, and throws as today.
 */
export interface InvestSnapshot {
  /** Which vault this is: the turn checks it against its own before reading anything. */
  readonly vaultAddress: PublicKey;
  readonly vault: AccountInfo<Buffer> | null;
  readonly policyAddress: PublicKey;
  readonly policy: AccountInfo<Buffer> | null;
  readonly clock: AccountInfo<Buffer> | null;
  readonly solFeed: AccountInfo<Buffer> | null;
  readonly usdcFeed: AccountInfo<Buffer> | null;
  readonly epochSchedule: AccountInfo<Buffer> | null;
  readonly wsolAta: PublicKey;
  readonly wsolHeld: bigint;
  readonly usdcAta: PublicKey;
  readonly usdcHeld: bigint;
}

/** What one sweep's batch read: the vaults for settle (readVaults' answer, exactly) and each vault's invest snapshot. */
export interface SweepState {
  readonly vaults: ReadonlyMap<string, VaultState | null>;
  readonly invest: ReadonlyMap<string, InvestSnapshot>;
  /** How many getMultipleAccounts requests it took. */
  readonly requests: number;
}

/**
 * A token account's balance from its bytes, as balanceOf would have answered:
 * the u64 at 64 of a 165-byte account the classic Token program owns, and 0 for
 * anything else — absent, another owner, another size.
 *
 * WHY 0 AND NOT A THROW. balanceOf (invest-tick.ts) asks getTokenAccountBalance
 * and answers 0 from its catch, which is what it gets for a missing account and
 * for an account that is not a token account. The two ATAs here are the classic
 * program's (wSOL and USDC have no extensions), so a 165-byte account it owns is
 * the only shape getTokenAccountBalance would have read a number out of.
 */
export function tokenAmountOf(info: AccountInfo<Buffer> | null | undefined): bigint {
  if (info === null || info === undefined) return 0n;
  if (!info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length !== TOKEN_ACCOUNT_BYTES) return 0n;
  return info.data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}

/**
 * Every turned vault, its policy and its two ATAs, and the four accounts every
 * invest turn reads, in requests of at most SWEEP_STATE_CHUNK accounts.
 *
 * THE VAULT MAP IS readVaults' ANSWER. Same de-duplication, same order of
 * vaults, null where the chain has no account, and a THROW — the whole read —
 * for a vault account that does not decode, exactly as Anchor's fetchMultiple
 * throws inside readVaults. The sweep's degraded path then runs, with no
 * snapshot, which is today's degraded path exactly.
 *
 * SEQUENTIAL CHUNKS, in address order. A sweep over 24 vaults or fewer is one
 * request; nothing here is in a hurry, and a fixed order is what lets the
 * parity harness compare two keepers request for request.
 */
export async function readSweepState(
  connection: Connection,
  program: anchor.Program,
  addresses: readonly PublicKey[],
): Promise<SweepState> {
  const unique = [...new Map(addresses.map((address) => [address.toBase58(), address] as const)).values()];
  const vaults = new Map<string, VaultState | null>();
  const invest = new Map<string, InvestSnapshot>();
  if (unique.length === 0) return { vaults, invest, requests: 0 };
  const perVault = unique.map((vault) => ({
    vault,
    policy: investmentPolicyAddress(program.programId, vault),
    wsolAta: getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID),
    usdcAta: getAssociatedTokenAddressSync(USDC_MINT, vault, true, TOKEN_PROGRAM_ID),
  }));
  const shared = [SYSVAR_CLOCK_PUBKEY, PYTH_SOL_USD_FEED, PYTH_USDC_USD_FEED, SYSVAR_EPOCH_SCHEDULE_PUBKEY];
  const keys = [...perVault.flatMap((v) => [v.vault, v.policy, v.wsolAta, v.usdcAta]), ...shared];
  const infos: (AccountInfo<Buffer> | null)[] = [];
  let requests = 0;
  for (let start = 0; start < keys.length; start += SWEEP_STATE_CHUNK) {
    const chunk = keys.slice(start, start + SWEEP_STATE_CHUNK);
    const answer = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    requests += 1;
    if (answer.length !== chunk.length) {
      throw new Error(`asked for ${chunk.length} accounts and got ${answer.length} answers: the batched sweep read no longer lines up with its addresses`);
    }
    infos.push(...answer.map((info) => info ?? null));
  }
  const at = (index: number): AccountInfo<Buffer> | null => infos[index] ?? null;
  const base = perVault.length * 4;
  const [clock, solFeed, usdcFeed, epochSchedule] = [at(base), at(base + 1), at(base + 2), at(base + 3)];
  perVault.forEach((v, index) => {
    const vaultInfo = at(index * 4);
    // fetchMultiple's own rule: null where the chain has nothing, decode (and
    // throw on bytes that are not a Vault) everywhere else.
    vaults.set(v.vault.toBase58(), vaultInfo === null ? null : decodeVault(program, vaultInfo.data));
    const wsol = at(index * 4 + 2);
    const usdc = at(index * 4 + 3);
    invest.set(v.vault.toBase58(), {
      vaultAddress: v.vault,
      vault: vaultInfo,
      policyAddress: v.policy,
      policy: at(index * 4 + 1),
      clock,
      solFeed,
      usdcFeed,
      epochSchedule,
      wsolAta: v.wsolAta,
      wsolHeld: tokenAmountOf(wsol),
      usdcAta: v.usdcAta,
      usdcHeld: tokenAmountOf(usdc),
    });
  });
  return { vaults, invest, requests };
}

/**
 * C2: the rent floor of an account of `size` bytes, asked once per connection
 * and size. A read that failed is forgotten, so the next turn asks again.
 *
 * WHY A CACHE IS EXACT HERE. The minimum balance is a function of the size and
 * the cluster's rent parameters, which no transaction changes; only a feature
 * activation does, and a stale floor there could only make a snapshot turn say
 * IDLE or "would wrap" about lamports it then re-reads fresh before acting.
 */
const rentFloors = new WeakMap<Connection, Map<number, Promise<number>>>();

export function cachedRentFloor(connection: Connection, size: number): Promise<number> {
  let bySize = rentFloors.get(connection);
  if (bySize === undefined) {
    bySize = new Map();
    rentFloors.set(connection, bySize);
  }
  const known = bySize.get(size);
  if (known !== undefined) return known;
  const read = connection.getMinimumBalanceForRentExemption(size);
  bySize.set(size, read);
  const forget = bySize;
  read.catch(() => forget.delete(size));
  return read;
}

/**
 * When the reads behind a finished turn's resting verdict were taken, for the
 * doorbell (Doorbell.recordTurn's `startedAt`): the earlier of the turn's start
 * and the batch's, when the invest half was decided from the snapshot
 * (InvestResult.reads === "snapshot"); the turn's start otherwise — a fresh
 * invest read, a dirty vault, no batch, or no invest turn at all.
 *
 * WITHOUT THE invest-batch CUT `reads` is never set, and this is `turnAt`: the
 * doorbell is told exactly what it was told before the cut existed.
 */
export function restVerdictReadAt(turnAt: number, batchReadAt: number, investReads: InvestResult["reads"]): number {
  return investReads === "snapshot" ? Math.min(turnAt, batchReadAt) : turnAt;
}

/**
 * Whether a settle outcome leaves this sweep's snapshot of its vault true.
 *
 * ONLY THE OUTCOMES THAT SEND NOTHING DO. A SETTLED moved SOL into the vault
 * after the batch read it; a RETRY or a FAILED may have sent a settle that
 * lands later; a dry run's SETTLED sends nothing, but counting it as moved only
 * costs that turn its fresh reads. Anything this switch does not name — an
 * outcome added later — is treated as having moved money: the direction that
 * reads more, never less.
 */
export function settleLeavesSnapshotTrue(outcome: SettleOutcome): boolean {
  switch (outcome) {
    case "IDLE":
    case "PENDING_FINALITY":
    case "NO_PROFIT":
    case "INCOMPLETE":
    case "NO_SIGNER":
    case "UNSUPPORTED_MODE":
    case "PAUSED":
    case "BELOW_RESERVE":
      return true;
    default:
      return false;
  }
}

/**
 * The same for an invest turn on the same vault: a turn that rested, or was
 * deferred, sent nothing; INVESTED, FAILED and REFUSED may all have sent
 * something (a REFUSED leg after the wrap carries real purchases).
 */
export function investLeavesSnapshotTrue(outcome: InvestOutcome): boolean {
  return outcome === "IDLE" || outcome === "NO_POLICY" || outcome === "PAUSED" || outcome === "DEFERRED";
}
