// Measures a wallet's cash profit over ONE BOUNDED WINDOW: strictly after a
// frontier slot, up to now.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/measure-window.ts),
// unchanged in behaviour. The settle marker is now sip-vault's program id.
//
// The drill's measure-session.ts walks a fixed count of recent transactions,
// which is right for a one-shot demo and wrong for a keeper: a tester trading
// on Axiom keeps trading, so every tick must look at the UNSETTLED span only.
// This walks backwards from the newest signature and stops at the frontier,
// which is also what keeps the RPC cost proportional to new activity rather
// than to account age.
//
// The formula is RH's, unchanged: profit = cashΔ − deposits + withdrawals, in
// lamports. Pure System/ComputeBudget transfers are external flows; everything
// else (Jupiter, pump.fun, Raydium, anything) is trading and counts.

import { Connection, PublicKey } from "@solana/web3.js";

// Programs whose presence NEVER means trading: the System/ComputeBudget pair,
// plus the Ed25519 precompile that a settle carries for its attestation. A
// transaction touching ONLY these (optionally plus our own program) moved the
// wallet's lamports for a reason that is not a trade.
const NON_TRADING = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
]);

/**
 * EXCLUSIVITY, not presence. A transaction is an external flow only when EVERY
 * program it touches is non-trading (optionally our own settle program).
 *
 * Keying on the mere PRESENCE of our program id was a laundering hole: a wallet
 * exported to Axiom could append a 1-lamport wrap_sol to a real Jupiter trade
 * and have the WHOLE transaction reclassified as flow — erasing a loss from
 * P&L, or a win from the skim. A real settle is {Ed25519, sip-vault, System}; a
 * trade bundled with a sip-vault instruction still carries Jupiter/Raydium/Token
 * in its program set, so exclusivity keeps it trading. Asserted at image-build
 * time (keeper --preflight), so a regression fails the Docker build.
 */
export function isExternalFlowTx(programs: Iterable<string>, settleProgramId?: string): boolean {
  for (const p of programs) {
    if (!NON_TRADING.has(p) && p !== settleProgramId) return false;
  }
  return true;
}

/** How many signatures to walk before giving up on reaching the frontier. */
export const MAX_SIGNATURES = 300;

export interface WindowMeasurement {
  readonly txCount: number;
  readonly chainBreaks: number;
  /**
   * Transactions the RPC would not return. NOT the same as a chain break: a
   * break says the chain has a hole, this says WE could not see. Any non-zero
   * value makes the measurement unusable, and saying which it is decides
   * whether an operator looks at the user's wallet or at their RPC plan.
   */
  readonly unfetchable: number;
  readonly cashDelta: bigint;
  readonly deposits: bigint;
  readonly withdrawals: bigint;
  readonly profitLamports: bigint;
  readonly firstSlot: bigint;
  readonly lastSlot: bigint;
  /** True when the walk hit MAX_SIGNATURES before reaching the frontier. */
  readonly truncated: boolean;
}

export async function measureSince(
  connection: Connection,
  wallet: PublicKey,
  /**
   * The watermark to measure from. ZERO IS NOT "the beginning of time": a
   * freshly linked wallet has frontier_slot 0, and walking a real trader's
   * whole history from there both truncates at MAX_SIGNATURES (which reports
   * INCOMPLETE forever, the same deadlock) and would take a skim on profit
   * earned BEFORE they joined. Callers pass the link's `epoch` — the slot the
   * link was created — in that case; see settle-decision.ts.
   */
  frontierSlot: bigint,
  /**
   * The sip-vault program id. A transaction that invokes it from this wallet
   * is OUR OWN SETTLE — the wallet pushing savings to the vault — and savings
   * are not trading losses. Without this, every settle sits in the next window
   * as a phantom loss the user's next profit must overcome first, so the
   * keeper systematically under-settles by 20% of the previous settle,
   * forever. Classified as an EXTERNAL FLOW (like deposits/withdrawals) rather
   * than skipped, because skipping would break the balance-chain oracle: the
   * settle really did change the balance, and the chain must show it.
   */
  settleProgram?: PublicKey,
): Promise<WindowMeasurement> {
  // Collect signatures newest-first until we pass the frontier.
  const collected: { signature: string; slot: number }[] = [];
  let before: string | undefined;
  let truncated = false;

  outer: while (collected.length < MAX_SIGNATURES) {
    const batch = await connection.getSignaturesForAddress(wallet, { limit: 100, before }, "confirmed");
    if (batch.length === 0) break;
    for (const info of batch) {
      if (BigInt(info.slot) <= frontierSlot) break outer;
      // FAILED TRANSACTIONS ARE WALKED, NOT SKIPPED — and this is the single
      // most consequential line in the file.
      //
      // A failed Solana transaction still charges its fee payer, and a trading
      // wallet IS the fee payer for its own swaps. Skipping them left a balance
      // drop the walk never saw, so the next successful transaction's preBalance
      // no longer matched the previous postBalance, the completeness oracle
      // recorded a break, and settle refused to attest. Because only a
      // successful settle advances the frontier, that failed transaction stayed
      // inside the window forever: the wallet became permanently unsettleable.
      //
      // Failures are ROUTINE here, not exceptional: 38 of 100 recent Raydium
      // CLMM transactions on mainnet failed when this was measured. Every real
      // trading wallet reaches that state within a day. The scripted drill that
      // validated this system produced no failures, which is exactly why it
      // never surfaced.
      //
      // Walking them keeps the chain intact and puts their fee where it belongs:
      // inside cashDelta, as a cost of trading, which is what it is.
      collected.push({ signature: info.signature, slot: info.slot });
    }
    before = batch[batch.length - 1]!.signature;
    if (collected.length >= MAX_SIGNATURES) truncated = true;
  }

  collected.reverse(); // oldest first

  let unfetchable = 0;
  let firstPre: bigint | null = null;
  let lastPost = 0n;
  let prevPost: bigint | null = null;
  let chainBreaks = 0;
  let deposits = 0n;
  let withdrawals = 0n;
  let txCount = 0;
  let firstSlot = 0n;
  let lastSlot = frontierSlot;

  for (const entry of collected) {
    const tx = await connection.getTransaction(entry.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) {
      // A NULL IS NOT AN ABSENCE. live-route.ts documents the same hazard in
      // its own error text: a throttling RPC returns null WITHOUT erroring. So
      // skipping here silently dropped a real balance-changing transaction from
      // the walk, the chain registered a break, and the keeper reported
      // INCOMPLETE — a claim about the USER'S TRADING when the truth was that
      // its own RPC was rate limited. Counted and surfaced instead, so the
      // caller can tell "we could not read" from "the chain has a hole".
      unfetchable += 1;
      continue;
    }
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined,
    });
    let index = -1;
    for (let i = 0; i < keys.length; i++) {
      if (keys.get(i)!.equals(wallet)) {
        index = i;
        break;
      }
    }
    if (index < 0) continue;

    const pre = BigInt(tx.meta.preBalances[index]!);
    const post = BigInt(tx.meta.postBalances[index]!);
    if (prevPost !== null && pre !== prevPost) chainBreaks += 1;
    prevPost = post;
    if (firstPre === null) {
      firstPre = pre;
      firstSlot = BigInt(tx.slot);
    }
    lastPost = post;
    lastSlot = BigInt(tx.slot);
    txCount += 1;

    const programs = new Set<string>();
    for (const ix of tx.transaction.message.compiledInstructions) {
      programs.add(keys.get(ix.programIdIndex)!.toBase58());
    }
    for (const inner of tx.meta.innerInstructions ?? []) {
      for (const ix of inner.instructions) programs.add(keys.get(ix.programIdIndex)!.toBase58());
    }
    const isExternalFlow = isExternalFlowTx(programs, settleProgram?.toBase58());
    if (isExternalFlow) {
      const delta = post - pre;
      if (delta > 0n) deposits += delta;
      else withdrawals += -delta;
    }
  }

  const cashDelta = firstPre === null ? 0n : lastPost - firstPre;
  return {
    txCount,
    chainBreaks,
    unfetchable,
    cashDelta,
    deposits,
    withdrawals,
    profitLamports: cashDelta - deposits + withdrawals,
    firstSlot,
    lastSlot,
    truncated,
  };
}
