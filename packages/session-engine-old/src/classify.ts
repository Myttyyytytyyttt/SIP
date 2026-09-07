// Assigns every transaction in a window exactly one kind.
//
// The unit is the transaction, not the transfer: a GMGN buy is "cash out AND
// token in" in one atomic act, and splitting it into two transfers loses the
// only thing that distinguishes it from an external withdrawal plus an airdrop.
//
// Anything the rules cannot place is UNKNOWN, and one UNKNOWN refuses the whole
// window. Guessing here would be indistinguishable from fabricating profit.

import { WETH, ZERO_ADDRESS, classifySettlementCall, isKnownSettlementExecutor, normalize } from "./chain.js";
import type { RawTx } from "./window.js";

export type TxKind =
  | "TRADE_BUY"
  | "TRADE_SELL"
  | "CASH_INTERNAL"
  | "EXTERNAL_DEPOSIT"
  | "EXTERNAL_WITHDRAWAL"
  | "AIRDROP_IN"
  | "SETTLEMENT"
  | "APPROVE_OR_NOOP"
  | "UNKNOWN";

export interface TokenDelta {
  readonly token: string;
  readonly delta: bigint;
}

export interface ClassifiedTx {
  readonly hash: string;
  readonly blockNumber: bigint;
  readonly kind: TxKind;
  readonly cashIn: bigint;
  readonly cashOut: bigint;
  readonly gasPaid: bigint;
  readonly tokenDeltas: readonly TokenDelta[];
  /** True when the wallet itself sent the transaction and paid its gas. */
  readonly selfSent: boolean;
  readonly note: string;
}

function isCashToken(token: string): boolean {
  return token === WETH;
}

export function classifyTx(tx: RawTx, wallet: string): ClassifiedTx {
  const account = normalize(wallet);
  const selfSent = tx.sender === account;

  let cashIn = 0n;
  let cashOut = 0n;
  const tokens = new Map<string, bigint>();
  let wethTouched = false;

  for (const move of tx.nativeMoves) {
    if (move.to === account) cashIn += move.value;
    if (move.from === account) cashOut += move.value;
  }

  for (const move of tx.tokenMoves) {
    if (isCashToken(move.token)) {
      wethTouched = true;
      if (move.to === account) cashIn += move.value;
      if (move.from === account) cashOut += move.value;
      continue;
    }
    const signed = (move.to === account ? move.value : 0n) - (move.from === account ? move.value : 0n);
    tokens.set(move.token, (tokens.get(move.token) ?? 0n) + signed);
  }

  const tokenDeltas: TokenDelta[] = [...tokens.entries()]
    .filter(([, delta]) => delta !== 0n)
    .map(([token, delta]) => ({ token, delta }))
    .sort((a, b) => a.token.localeCompare(b.token));

  const gained = tokenDeltas.filter((d) => d.delta > 0n);
  const lost = tokenDeltas.filter((d) => d.delta < 0n);
  const base = { hash: tx.hash, blockNumber: tx.blockNumber, cashIn, cashOut, gasPaid: tx.gasPaid, tokenDeltas, selfSent };

  if (!tx.success) {
    // A reverted transaction moved nothing but still burned gas.
    return { ...base, kind: "APPROVE_OR_NOOP", note: "reverted; gas only" };
  }

  // The settlement outflow is the protocol paying itself. It is emphatically not
  // a trading loss, and treating it as one would understate every later window.
  //
  // A settle-shaped call to an address we do not know is NOT given that
  // treatment. It refuses the window and says why. The alternative — falling
  // through to the generic rules — ends at "cash left via a contract call that
  // returned nothing", which is also a refusal but names nothing, and is exactly
  // what a stale executor address or a stale selector would look like after a
  // redeploy.
  const settlement = classifySettlementCall(tx.to, tx.input);
  if (settlement.kind === "SETTLEMENT") {
    return { ...base, kind: "SETTLEMENT", note: "contribution routed to the vault" };
  }

  // The same settlement, recognised by WHERE THE CASH WENT rather than by who
  // broadcast it.
  //
  // `classifySettlementCall` reads the TOP-LEVEL `to`, which is only the executor
  // when the trading wallet itself sent the transaction. Under every path that
  // frees the wallet from sending — an EIP-7702 delegate forwarding the call, a
  // relayer, a bundler — the top-level `to` is the wallet or an EntryPoint, the
  // check above misses, and the transaction falls all the way through to
  // "cash left via a contract call that returned nothing". That is an UNKNOWN,
  // one UNKNOWN refuses the window, and the refusal is permanent: every later
  // window containing a settlement inherits it.
  //
  // Matching the destination instead is sound because `settle` is the ONLY
  // payable entry on the executor — no `receive`, no `fallback`
  // (SettlementExecutor.sol:80) — so native value reaching a known executor from
  // this wallet cannot be anything else. The trust anchor is unchanged: it is
  // still the SETTLEMENT_EXECUTORS allowlist, never the selector alone.
  const contributionOut = tx.nativeMoves.some(
    (move) => move.from === account && isKnownSettlementExecutor(move.to),
  );
  if (contributionOut) {
    return { ...base, kind: "SETTLEMENT", note: "contribution routed to the vault (relayed or delegated)" };
  }
  if (settlement.kind === "UNRECOGNISED_EXECUTOR") {
    return {
      ...base,
      kind: "UNKNOWN",
      note:
        `settle() selector ${settlement.selector} sent to ${String(tx.to)}, which is not a known ` +
        "SettlementExecutor; add it to SETTLEMENT_EXECUTORS in chain.ts if the protocol redeployed",
    };
  }

  if (gained.length > 0 && lost.length > 0) {
    return { ...base, kind: "UNKNOWN", note: "token-for-token swap; cost basis is not derivable from cash" };
  }

  if (cashOut > 0n && gained.length > 0) {
    // One payment delivering several tokens gives no way to split the cost
    // between them. Stamping the full basis on each would let a later sale of
    // one report profit it never earned, and stamping a share requires a price
    // we do not have. Refuse rather than pick.
    if (gained.length > 1) {
      return { ...base, kind: "UNKNOWN", note: "one payment, several tokens received; cost basis is not divisible" };
    }
    return { ...base, kind: "TRADE_BUY", note: "cash out, position in" };
  }

  if (cashIn > 0n && lost.length > 0) {
    return { ...base, kind: "TRADE_SELL", note: "position out, cash in" };
  }

  if (gained.length > 0 && cashOut === 0n) {
    // The wallet neither initiated nor paid: nothing was given up for this.
    return {
      ...base,
      kind: selfSent ? "UNKNOWN" : "AIRDROP_IN",
      note: selfSent
        ? "wallet acquired a position without spending cash; basis unknown"
        : "unsolicited inbound token, zero cost basis",
    };
  }

  if (tokenDeltas.length === 0) {
    if (wethTouched && cashIn > 0n && cashOut > 0n) {
      return { ...base, kind: "CASH_INTERNAL", note: "WETH wrap/unwrap; nets to zero within cash" };
    }
    if (cashIn > 0n && cashOut === 0n) {
      return selfSent
        ? { ...base, kind: "UNKNOWN", note: "self-sent cash inflow with no counterparty movement" }
        : { ...base, kind: "EXTERNAL_DEPOSIT", note: "inbound cash from outside the session" };
    }
    if (cashOut > 0n && cashIn === 0n) {
      const plain = tx.input === "0x" || tx.input === "";
      return plain || tx.to === ZERO_ADDRESS
        ? { ...base, kind: "EXTERNAL_WITHDRAWAL", note: "cash sent out of the session" }
        : { ...base, kind: "UNKNOWN", note: "cash left via a contract call that returned nothing" };
    }
    if (cashIn === 0n && cashOut === 0n) {
      return { ...base, kind: "APPROVE_OR_NOOP", note: "no value moved; gas only" };
    }
  }

  return { ...base, kind: "UNKNOWN", note: "movement pattern not recognised" };
}

export function classifyWindow(txs: readonly RawTx[], wallet: string): ClassifiedTx[] {
  return txs.map((tx) => classifyTx(tx, wallet));
}

/** External flows as SettlementExecutor.calculateRealizedProfit expects them. */
export function summariseFlows(classified: readonly ClassifiedTx[]): {
  externalDeposits: bigint;
  externalWithdrawals: bigint;
  unknown: readonly ClassifiedTx[];
} {
  let externalDeposits = 0n;
  let externalWithdrawals = 0n;
  for (const tx of classified) {
    if (tx.kind === "EXTERNAL_DEPOSIT") externalDeposits += tx.cashIn;
    // A settlement is cash that left for the user's own vault. It is declared as
    // an external withdrawal so it is added back and does not read as a loss.
    if (tx.kind === "EXTERNAL_WITHDRAWAL" || tx.kind === "SETTLEMENT") externalWithdrawals += tx.cashOut;
  }
  return { externalDeposits, externalWithdrawals, unknown: classified.filter((tx) => tx.kind === "UNKNOWN") };
}
