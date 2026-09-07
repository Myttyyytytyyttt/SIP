// Public API: given a wallet and a block window, decide whether the window can
// be attested, and if so with what numbers.
//
// Four independent conditions must all hold. Refusing is the normal, healthy
// outcome for a badly chosen window — there is deliberately no override.

import { cashAt, erc20BalanceAt, normalize, toL1Block } from "./chain.js";
import { classifyWindow, summariseFlows, type ClassifiedTx } from "./classify.js";
import { TokenInventory } from "./inventory.js";
import {
  ledgerRootV2,
  legacyLedgerRoot,
  positionsRoot as computePositionsRoot,
  type Hex32,
} from "./ledger-root.js";
import { calculateRealizedProfit, reconcileCash, type CashReconciliation } from "./profit.js";
import type { RpcClient } from "./rpc.js";
import { scanWindow } from "./window.js";

export type Verdict = "ATTESTABLE" | "REFUSED";

export type RefusalReason =
  | "NOT_RECONCILED"
  | "NOT_DELTA_FLAT"
  | "ZERO_BASIS_REALIZED"
  | "INCOMPLETE_SCAN"
  | "UNKNOWN_TRANSACTION"
  | "REPLAY_TOO_SHORT";

export interface PositionDelta {
  readonly token: string;
  readonly balanceStart: bigint;
  readonly balanceEnd: bigint;
}

export interface SessionReport {
  readonly wallet: string;
  readonly startBlockL2: bigint;
  readonly endBlockL2: bigint;
  readonly startBlockL1: bigint;
  readonly endBlockL1: bigint;
  readonly cashStart: bigint;
  readonly cashEnd: bigint;
  readonly externalDeposits: bigint;
  readonly externalWithdrawals: bigint;
  readonly realizedProfit: bigint;
  /** What a naive cashEnd - cashStart would have said. Kept to make the delta visible. */
  readonly naiveDelta: bigint;
  readonly gasPaid: bigint;
  readonly zeroBasisRealized: bigint;
  readonly reconciliation: CashReconciliation;
  readonly transactions: readonly ClassifiedTx[];
  readonly positionDeltas: readonly PositionDelta[];
  readonly verdict: Verdict;
  readonly reasons: readonly RefusalReason[];
  /** The encoding mainnet already accepted. Kept so history stays reproducible. */
  readonly ledgerRootLegacy: Hex32;
  /** Commits positions, zero-basis realisation, the verdict and replay coverage. */
  readonly ledgerRootV2: Hex32;
  readonly positionsRoot: Hex32;
  readonly replayStartBlockL2: bigint;
  /**
   * False once trades route through UserOperations: the airdrop test compares
   * receipt.from against the wallet, and under ERC-4337 that is the bundler.
   */
  readonly senderHeuristicValid: boolean;
}

export interface BuildSessionOptions {
  readonly rpc: RpcClient;
  readonly wallet: string;
  /** cashStart is measured at the END of this block; the window is (start, end]. */
  readonly startBlockL2: bigint;
  readonly endBlockL2: bigint;
  /** Acquisitions before this height are unknown, so disposals of them refuse. */
  readonly replayStartBlockL2: bigint;
  /** Prior history, needed to know whether disposed units had cash basis. */
  readonly priorAcquisitions?: readonly { token: string; amount: bigint; basis: "CASH_BASIS" | "ZERO_BASIS"; blockNumber: bigint }[];
}

export async function buildSessionReport(options: BuildSessionOptions): Promise<SessionReport> {
  const { rpc, startBlockL2, endBlockL2, replayStartBlockL2 } = options;
  const wallet = normalize(options.wallet);

  const [cashStartValue, cashEndValue, startBlockL1, endBlockL1, scan] = await Promise.all([
    cashAt(rpc, wallet, startBlockL2),
    cashAt(rpc, wallet, endBlockL2),
    toL1Block(rpc, startBlockL2),
    toL1Block(rpc, endBlockL2),
    scanWindow(rpc, wallet, startBlockL2, endBlockL2),
  ]);

  const cashStart = cashStartValue.total;
  const cashEnd = cashEndValue.total;
  const transactions = classifyWindow(scan.txs, wallet);
  const { externalDeposits, externalWithdrawals, unknown } = summariseFlows(transactions);
  const reconciliation = reconcileCash(scan.txs, wallet, cashStart, cashEnd);

  // Position delta: every non-cash token the window touched, measured at both
  // boundaries. A constant balance contributes nothing to the cash delta and is
  // harmless; a changed one means the window is not self-contained.
  //
  // Tokens that only ever arrived unsolicited, and were never disposed of, are
  // excluded. Otherwise anyone could veto any settlement, permanently and for
  // free, by sending one wei of a junk token into the window — the balance would
  // change, delta-flat would fail, and the user could never settle again. Such a
  // token is safe to ignore precisely because it moved no cash: nothing was paid
  // for it and nothing was received. The moment any of it is SOLD it stops being
  // inbound-only, re-enters this test, and is caught again by zeroBasisRealized.
  const disposed = new Set(
    transactions.flatMap((tx) => tx.tokenDeltas.filter((d) => d.delta < 0n).map((d) => d.token)),
  );
  const airdropOnly = new Set(
    transactions
      .filter((tx) => tx.kind === "AIRDROP_IN")
      .flatMap((tx) => tx.tokenDeltas.map((d) => d.token))
      .filter((token) => !disposed.has(token)),
  );
  const touched = [...new Set(transactions.flatMap((tx) => tx.tokenDeltas.map((d) => d.token)))]
    .filter((token) => !airdropOnly.has(token))
    .sort();
  const positionDeltas: PositionDelta[] = await Promise.all(
    touched.map(async (token) => ({
      token,
      balanceStart: await erc20BalanceAt(rpc, token, wallet, startBlockL2),
      balanceEnd: await erc20BalanceAt(rpc, token, wallet, endBlockL2),
    })),
  );

  // Replay prior history so disposals inside the window can be attributed.
  const inventory = new TokenInventory();
  for (const lot of options.priorAcquisitions ?? []) inventory.acquire(lot);

  let zeroBasisRealized = 0n;
  let uncovered = 0n;
  for (const tx of transactions) {
    for (const delta of tx.tokenDeltas) {
      if (delta.delta > 0n) {
        inventory.acquire({
          token: delta.token,
          amount: delta.delta,
          basis: tx.kind === "TRADE_BUY" ? "CASH_BASIS" : "ZERO_BASIS",
          blockNumber: tx.blockNumber,
        });
      } else {
        const outcome = inventory.dispose({ token: delta.token, amount: -delta.delta, blockNumber: tx.blockNumber });
        zeroBasisRealized += outcome.fromZeroBasis;
        uncovered += outcome.uncovered;
      }
    }
  }

  const reasons: RefusalReason[] = [];
  if (!reconciliation.reconciled) reasons.push("NOT_RECONCILED");
  if (scan.observedSentCount !== scan.expectedSentCount) reasons.push("INCOMPLETE_SCAN");
  if (unknown.length > 0) reasons.push("UNKNOWN_TRANSACTION");
  if (positionDeltas.some((p) => p.balanceStart !== p.balanceEnd)) reasons.push("NOT_DELTA_FLAT");
  if (zeroBasisRealized > 0n) reasons.push("ZERO_BASIS_REALIZED");
  if (uncovered > 0n || replayStartBlockL2 > startBlockL2) reasons.push("REPLAY_TOO_SHORT");

  const realizedProfit = calculateRealizedProfit(cashStart, cashEnd, externalDeposits, externalWithdrawals);

  const ledgerInput = {
    startBlockL2,
    endBlockL2,
    cashStart,
    cashEnd,
    externalDeposits,
    externalWithdrawals,
    positions: positionDeltas,
    zeroBasisRealized,
    reasons,
    replayStartBlockL2,
  };

  return {
    ledgerRootLegacy: legacyLedgerRoot(startBlockL2, endBlockL2, cashStart, cashEnd),
    ledgerRootV2: ledgerRootV2(ledgerInput),
    positionsRoot: computePositionsRoot(positionDeltas),
    replayStartBlockL2,
    wallet,
    startBlockL2,
    endBlockL2,
    startBlockL1,
    endBlockL1,
    cashStart,
    cashEnd,
    externalDeposits,
    externalWithdrawals,
    realizedProfit,
    naiveDelta: cashEnd - cashStart,
    gasPaid: reconciliation.gasPaid,
    zeroBasisRealized,
    reconciliation,
    transactions,
    positionDeltas,
    verdict: reasons.length === 0 ? "ATTESTABLE" : "REFUSED",
    reasons,
    senderHeuristicValid: true,
  };
}
