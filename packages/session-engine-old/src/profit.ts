// Cash reconciliation and the TypeScript mirror of
// SettlementExecutor.calculateRealizedProfit.
//
// Reconciliation is the load-bearing check in this package. If the movements we
// discovered do not explain the balance change to the wei, we have missed
// something — most likely an internal transfer — and no number derived from that
// scan can be trusted. There is no tolerance and no override.

import { WETH, normalize } from "./chain.js";
import type { RawTx } from "./window.js";

export interface CashReconciliation {
  /** Native + WETH received, from every source including internal calls. */
  readonly inflow: bigint;
  readonly outflow: bigint;
  readonly gasPaid: bigint;
  /** Balance change the movements predict. */
  readonly predictedDelta: bigint;
  /** Balance change the chain actually shows. */
  readonly observedDelta: bigint;
  /** observed - predicted. Must be zero. */
  readonly residualWei: bigint;
  readonly reconciled: boolean;
}

/**
 * Sums every cash movement in the window.
 *
 * Cash is native + canonical WETH *aggregated*, which is what makes wrapping
 * self-cancelling: a deposit is native out plus WETH in, and both legs are
 * counted, so the net effect on cash is the gas alone. Treating the WETH leg as
 * an ordinary token transfer would fabricate a loss equal to the amount wrapped.
 */
export function reconcileCash(
  txs: readonly RawTx[],
  wallet: string,
  cashStart: bigint,
  cashEnd: bigint,
): CashReconciliation {
  const account = normalize(wallet);
  let inflow = 0n;
  let outflow = 0n;
  let gasPaid = 0n;

  for (const tx of txs) {
    gasPaid += tx.gasPaid;

    for (const move of tx.nativeMoves) {
      if (move.to === account) inflow += move.value;
      if (move.from === account) outflow += move.value;
    }

    for (const move of tx.tokenMoves) {
      if (move.token !== WETH) continue;
      if (move.to === account) inflow += move.value;
      if (move.from === account) outflow += move.value;
    }
  }

  const predictedDelta = inflow - outflow - gasPaid;
  const observedDelta = cashEnd - cashStart;
  const residualWei = observedDelta - predictedDelta;

  return {
    inflow,
    outflow,
    gasPaid,
    predictedDelta,
    observedDelta,
    residualWei,
    reconciled: residualWei === 0n,
  };
}

/**
 * Mirror of SettlementExecutor.calculateRealizedProfit (src/settlement/SettlementExecutor.sol).
 * Kept deliberately literal so a divergence is visible rather than clever.
 */
export function calculateRealizedProfit(
  cashStart: bigint,
  cashEnd: bigint,
  externalDeposits: bigint,
  externalWithdrawals: bigint,
): bigint {
  return cashEnd + externalWithdrawals - (cashStart + externalDeposits);
}
