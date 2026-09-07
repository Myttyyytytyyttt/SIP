// One turn of the investment loop, for one vault.
//
// This is the piece that makes the vault buy BY ITSELF. Everything under it was
// already written and tested — `decideInvestment` on chain state, `quote.ts` on
// live pools, `planInvestment` on the basket, `submitInvestment` on the wire —
// and none of it was ever called by anything. A savings product whose owner has
// to run a command to invest is not the product.
//
// NOT BUYING TWICE IS THE WHOLE PROBLEM, and the chain solves it better than a
// journal can. A purchase that was broadcast but whose receipt never arrived may
// still be mined; retrying it spends the rolling cap twice on one decision. So
// the tick does not ask its own records what happened — it asks the vault:
// `aggregateLifetimeInvested` is a monotonic counter that only `invest()`
// increases, so comparing it against what was seen before the attempt says
// whether the purchase landed, with no state of ours to get out of sync.
//
// THE TICK IS ALLOWED TO DO NOTHING, LOUDLY. Most turns there is nothing to buy,
// and that has to be distinguishable from a vault that believes it is investing
// and is not. `decideInvestment` already names those states apart; this carries
// the distinction out to the caller so the supervisor can alert on one and stay
// quiet about the other.

import type { Address } from "viem";

import { decideInvestment, isActionableProblem, type InvestmentDecision } from "./investment.js";
import {
  readPreviewDeposit,
  hasInvestmentPath,
  readAdapterRegistry,
  readAdapterStatus,
  readBasketLegs,
  readInvestmentConfiguration,
  readPoolState,
  poolId,
  type InvestmentChainAccess,
} from "./investment-chain.js";
import { decodeLifetimeInvested, INVESTMENT_SLOT, orderPair, slotHex } from "./investment-state.js";
import { describePlan, planInvestment, type LegRoute } from "./investment-plan.js";
import { quoteExactInSingle, splitAcrossLegs } from "./quote.js";
import { submitInvestment, type InvestChainAccess, type InvestSigner } from "./investment-submit.js";
import type { Logger } from "./log.js";

/**
 * How long to wait for a receipt when RESOLVING an outstanding purchase.
 *
 * Short on purpose, and nothing like the 90s the SUBMIT path waits. That one is
 * watching a transaction it just broadcast and wants an answer; this one is
 * asking a question about the past — "has it landed yet?" — once per tick, with
 * another tick a minute away. A long wait here would hold the whole sweep for an
 * account that is, by definition, doing nothing.
 */
const RESOLVE_RECEIPT_MS = 5_000;

export type InvestmentTickOutcome =
  /** The implementation predates the investment path. Nothing to do, ever. */
  | "NOT_SUPPORTED"
  /** `decideInvestment` said wait. Ordinary and quiet. */
  | "IDLE"
  /** A human has to fix something. The vault believes it is investing. */
  | "NEEDS_ATTENTION"
  /** A previous attempt landed after we stopped watching. Resolved, not retried. */
  | "RECONCILED"
  | "BOUGHT"
  | "DRY_RUN"
  /** Refused before spending: the vault or the pools would not accept the call. */
  | "REFUSED"
  | "FAILED";

/**
 * Whether an outcome needs a human, and how loudly.
 *
 * IT IS A `switch` OVER THE UNION WITH NO `default`, AND THAT IS THE POINT. The
 * bug this replaces was not a wrong severity, it was an outcome that matched
 * NEITHER branch of an if/else and therefore produced no alert and no log:
 * `REFUSED` — a purchase planned and then blocked, by a missing signer or an
 * estimate that reverted — left nothing behind but the `investing` line that
 * preceded it. Exhaustiveness makes the compiler refuse a new outcome until
 * somebody decides what it means, which an if/else chain can never do.
 *
 * It lives here rather than in the supervisor because the supervisor is a binary
 * with no tests, and this table is the difference between a failed purchase
 * paging someone and disappearing.
 */
export function alertFor(
  outcome: InvestmentTickOutcome,
): { readonly severity: "critical" | "warn"; readonly what: string } | null {
  switch (outcome) {
    case "FAILED":
      return { severity: "critical", what: "failed" };
    case "NEEDS_ATTENTION":
      return { severity: "warn", what: "needs attention" };
    case "REFUSED":
      return { severity: "warn", what: "was refused before sending" };
    // SILENT, each for its own reason. `IDLE` is the resting state of a working
    // vault and `NOT_SUPPORTED` is every vault until its beacon is upgraded —
    // paging on either teaches an operator to ignore the channel that also
    // carries "this vault believes it is investing and is not". The rest are the
    // loop working.
    case "IDLE":
    case "NOT_SUPPORTED":
    case "BOUGHT":
    case "RECONCILED":
    case "DRY_RUN":
      return null;
  }
}

export interface InvestmentTickResult {
  readonly outcome: InvestmentTickOutcome;
  readonly detail: string;
  readonly txHash?: `0x${string}`;
  readonly amountIn?: bigint;
  readonly decision?: InvestmentDecision;
}

export interface StockPool {
  readonly fee: number;
  readonly tickSpacing: number;
}

export interface InvestmentTickDeps {
  readonly chain: InvestmentChainAccess;
  readonly submitChain: InvestChainAccess;
  readonly logger: Logger;
  readonly vault: Address;
  /** The address the purchase is sent from — vault admin or an ACTIVE account. */
  readonly sender: Address;
  readonly weth: Address;
  readonly usdg: Address;
  readonly poolManager: Address;
  readonly chainId: number;
  readonly wethUsdgFee: number;
  readonly wethUsdgTickSpacing: number;
  /** Keyed by lowercased target asset. Must match what the adapter pins. */
  readonly stockPools: ReadonlyMap<string, StockPool>;
  /**
   * The ERC-4626 vault over USDG this deployment offers, or null.
   *
   * Its SHARE DECIMALS ARE ITS OWN and are never assumed here: spUSDG mints
   * 6-decimal shares, steakUSDG 18, over the same 6-decimal dollar. Nothing in
   * this file converts between the two — it asks the quoter.
   *
   * A MAP, NOT A SCALAR, since the perp desk arrived: the key is the basket's
   * targetAsset, the value is the contract whose previewDeposit prices it —
   * itself for a 4626 like spUSDG, the desk for a pToken sold from inventory.
   */
  readonly sharesQuoters: ReadonlyMap<string, Address>;
  readonly logsFromBlock: bigint;
  /** WETH balance of the vault. Read by the caller, which already needs it. */
  readWethBalance: () => Promise<bigint>;
  /** Null in dry-run mode, by construction. */
  readonly signer: InvestSigner | null;
  readonly live: boolean;
  /**
   * What `aggregateLifetimeInvested` read when a previous attempt was left
   * unresolved, or null when there is nothing outstanding. The caller keeps
   * this across ticks; it is one number and it is only ever compared.
   */
  readonly outstanding: { readonly lifetimeInvestedBefore: bigint; readonly txHash: `0x${string}` } | null;
  /** How long to wait for a receipt before leaving it outstanding. */
  readonly receiptTimeoutMs?: number;
  readonly toleranceBps?: number;
}

export type InvestmentTickReport = InvestmentTickResult & {
  /** Set when a purchase was sent and no receipt arrived. The caller keeps it. */
  readonly outstanding: { readonly lifetimeInvestedBefore: bigint; readonly txHash: `0x${string}` } | null;
};

async function readLifetimeInvested(chain: InvestmentChainAccess, vault: Address): Promise<bigint> {
  const raw = await chain.call(
    vault,
    `0x1e2eaeaf${slotHex(INVESTMENT_SLOT.lifetimeTotals).slice(2)}` as `0x${string}`,
  );
  return decodeLifetimeInvested(BigInt(raw));
}

/**
 * Runs one turn. Never throws for an expected condition; the caller decides what
 * to alert on from the outcome.
 */
export async function runInvestmentTick(deps: InvestmentTickDeps): Promise<InvestmentTickReport> {
  const { chain, vault, logger } = deps;

  if (!(await hasInvestmentPath(chain, vault))) {
    return {
      outcome: "NOT_SUPPORTED",
      detail: "this vault's implementation has no invest(); the cohort beacon has not been upgraded",
      outstanding: null,
    };
  }

  // RESOLVE BEFORE DECIDING. An outstanding attempt may have been mined after we
  // stopped waiting, and deciding first would compute a new purchase on a
  // balance that is about to be wrong.
  const lifetimeInvested = await readLifetimeInvested(chain, vault);
  if (deps.outstanding !== null) {
    if (lifetimeInvested > deps.outstanding.lifetimeInvestedBefore) {
      logger.info("a previously unresolved purchase did land", {
        txHash: deps.outstanding.txHash,
        investedBefore: deps.outstanding.lifetimeInvestedBefore.toString(),
        investedNow: lifetimeInvested.toString(),
      });
      return {
        outcome: "RECONCILED",
        detail:
          `the purchase left unresolved as ${deps.outstanding.txHash} was mined — ` +
          `lifetime invested moved from ${deps.outstanding.lifetimeInvestedBefore} to ${lifetimeInvested}`,
        txHash: deps.outstanding.txHash,
        outstanding: null,
      };
    }
    // ------------------------------------------------------------------------
    // THE COUNTER DID NOT MOVE, AND THAT IS TWO SITUATIONS WEARING ONE FACE.
    //
    // Either the transaction is still pending — in which case retrying really
    // would buy twice from one decision — or it was mined and REVERTED, in which
    // case it moved nothing, will never move anything, and refusing to retry
    // strands the vault forever. This branch used to treat both as the second
    // one... by treating both as the first: NEEDS_ATTENTION, outstanding kept,
    // on every tick, until someone restarted the process and wiped the
    // in-memory record. That is the whole stall.
    //
    // A revert is not hypothetical here. The purchase carries a 90-second
    // deadline (see planInvestment below, where the number is defended against
    // adverse price movement) while the receipt wait is also 90 seconds, so a
    // transaction that uses its whole wait lands expired and reverts with
    // DeadlineExpired. The deadline is NOT the thing to change — it is the
    // slippage protection — but its consequence has to be recoverable.
    //
    // THE CHAIN CAN TELL THE TWO APART, so ask it rather than guess. Three
    // answers, three different correct responses:
    const receipt = await deps.submitChain.waitForReceipt(deps.outstanding.txHash, RESOLVE_RECEIPT_MS);

    if (receipt !== null && receipt.status === "reverted") {
      // TERMINAL AND SAFE. A reverted transaction consumed its nonce and changed
      // nothing else, so there is no second purchase to fear. Clearing the
      // record lets this same tick decide again from the real balance.
      logger.warn("the unresolved purchase reverted; clearing it and deciding again", {
        txHash: deps.outstanding.txHash,
        gasUsed: receipt.gasUsed.toString(),
      });
      // Nothing is assigned: falling out of this block IS the clearing. The
      // report this tick returns carries its own `outstanding`, and every path
      // below sets it from what this tick does rather than from what the last
      // one left behind.
    } else if (receipt !== null) {
      // MINED, SUCCEEDED, AND THE COUNTER DID NOT MOVE. That contradicts the
      // contract, so it is the one case that must NOT self-clear: something is
      // wrong with our model rather than with the transaction.
      return {
        outcome: "NEEDS_ATTENTION",
        detail:
          `${deps.outstanding.txHash} was mined successfully but aggregateLifetimeInvested did not ` +
          `move from ${deps.outstanding.lifetimeInvestedBefore}. Refusing to buy again until that is ` +
          "explained, because the two facts cannot both be true.",
        txHash: deps.outstanding.txHash,
        outstanding: deps.outstanding,
      };
    } else {
      // NO RECEIPT. Still pending, or dropped from the mempool and unknowable
      // from here. Waiting is the only safe answer: a purchase that lands after
      // a retry would buy twice.
      //
      // KNOWN GAP, STATED RATHER THAN PAPERED OVER: a transaction genuinely
      // dropped and never mined stays here forever, exactly as before. Telling
      // that apart from "pending" needs the sender's confirmed nonce compared
      // against this transaction's, which `outstanding` does not carry today.
      return {
        outcome: "NEEDS_ATTENTION",
        detail:
          `${deps.outstanding.txHash} was broadcast and has no receipt yet. ` +
          "Nothing new will be bought for this vault until it resolves, because retrying could buy twice.",
        txHash: deps.outstanding.txHash,
        outstanding: deps.outstanding,
      };
    }
  }

  const [config, registry, wethBalance] = await Promise.all([
    readInvestmentConfiguration(chain, vault),
    readAdapterRegistry(chain, vault),
    deps.readWethBalance(),
  ]);

  const adapter =
    BigInt(registry) === 0n
      ? { adapter: registry, statusEpoch: 0n, active: false }
      : await readAdapterStatus(chain, registry, config.adapterId);

  const recovery = await readBasketLegs(chain, vault, config.basketHash, deps.logsFromBlock);

  const decision = decideInvestment({
    wethBalance,
    enabled: config.enabled,
    paused: config.paused,
    basketHash: config.basketHash,
    adapterId: config.adapterId,
    minInvestmentWei: config.minInvestmentWei,
    maxPerCallWei: config.maxPerCallWei,
    // The ceiling is the honest bound until the rolling status is read; the
    // vault enforces the real cap and reverts if this is optimistic.
    capRemaining: config.maxRolling30dWei,
    adapterActive: adapter.active,
    knownBasketLegs: recovery.kind === "LEGS" ? recovery.legs.length : 0,
  });

  if (decision.kind !== "INVEST") {
    return {
      outcome: isActionableProblem(decision) ? "NEEDS_ATTENTION" : "IDLE",
      detail: decision.kind === "NO_BASKET" ? decision.detail : decision.kind,
      decision,
      outstanding: null,
    };
  }
  if (recovery.kind !== "LEGS") {
    return { outcome: "NEEDS_ATTENTION", detail: recovery.detail, decision, outstanding: null };
  }

  // Pool state, per leg, from the pools the ADAPTER pins. A leg with no
  // configured pool is refused rather than quoted against a guess: mainnet
  // carries hookless pools for these pairs charging 85% and worse.
  const pools = new Map<string, LegRoute>();
  const wu = orderPair(deps.weth, deps.usdg);
  const wethToUsdg = await readPoolState(
    chain,
    deps.poolManager,
    poolId(wu.currency0, wu.currency1, deps.wethUsdgFee, deps.wethUsdgTickSpacing),
    wu.currency0.toLowerCase() === deps.weth.toLowerCase(),
  );

  // THE SPLIT IS COMPUTED TWICE ON PURPOSE. planInvestment splits the amount
  // across the legs itself, and a yield leg's floor needs the destination's
  // previewDeposit for THAT leg's share of the money — a chain read, which
  // cannot happen inside a pure planner. Both call the same deterministic
  // function on the same inputs, so they cannot disagree.
  const legAmounts = splitAcrossLegs(
    decision.amountIn,
    recovery.legs.map((leg) => leg.weightBps),
  );

  for (const [index, leg] of recovery.legs.entries()) {
    const key = leg.targetAsset.toLowerCase();
    const legAmount = legAmounts[index] ?? 0n;

    // DOLLARS: one hop, and the vault keeps what comes out. There is no second
    // pool to pin and none to look for — a USDG/USDG pool cannot exist.
    if (key === deps.usdg.toLowerCase()) {
      pools.set(key, { kind: "DOLLARS", wethToUsdg });
      continue;
    }

    // YIELD: one hop, then a mint or a desk sale. Not a pool either — and the
    // shares are previewed at the QUOTER rather than derived from a share
    // price, because EIP-4626 forbids previewDeposit from over-promising, a
    // vault with a deposit fee would make local arithmetic optimistic, and the
    // desk's quote already carries its immutable spread. The quoter is the
    // asset itself for spUSDG and the desk for a pToken; a reverting or zero
    // preview flows through as a zero quote, which the planner REFUSES.
    const quoter = deps.sharesQuoters.get(key);
    if (quoter !== undefined) {
      const dollars = quoteExactInSingle(wethToUsdg, legAmount);
      const shares = await readPreviewDeposit(chain, quoter, dollars);
      pools.set(key, { kind: "YIELD", wethToUsdg, shares, quoter });
      continue;
    }

    const pinned = deps.stockPools.get(key);
    if (pinned === undefined) {
      return {
        outcome: "NEEDS_ATTENTION",
        detail:
          `no pool is configured for ${leg.targetAsset}, which is in this vault's basket. ` +
          "Refusing rather than guessing — the keeper must quote the same pool the adapter trades in.",
        decision,
        outstanding: null,
      };
    }
    const us = orderPair(deps.usdg, leg.targetAsset);
    pools.set(key, {
      kind: "STOCK",
      wethToUsdg,
      usdgToStock: await readPoolState(
        chain,
        deps.poolManager,
        poolId(us.currency0, us.currency1, pinned.fee, pinned.tickSpacing),
        us.currency0.toLowerCase() === deps.usdg.toLowerCase(),
      ),
    });
  }

  const planned = planInvestment({
    legs: recovery.legs,
    amountIn: decision.amountIn,
    pools,
    expectedBasketHash: config.basketHash,
    policyNonce: config.policyNonce,
    adapterStatusEpoch: adapter.statusEpoch,
    // 90 SECONDS. Measured against this route's own history, the worst adverse
    // move over 600s is 61.5 bps — wider than the tolerance, so a transaction
    // sitting that long can land outside its own floor after paying gas.
    deadline: Math.floor(Date.now() / 1000) + 90,
    toleranceBps: deps.toleranceBps,
  });

  if (planned.kind === "REFUSED") {
    return { outcome: "NEEDS_ATTENTION", detail: planned.reason, decision, outstanding: null };
  }

  logger.info("investing", { plan: describePlan(planned.call) });

  const result = await submitInvestment({
    live: deps.live,
    chain: deps.submitChain,
    vault,
    from: deps.sender,
    chainId: deps.chainId,
    call: planned.call,
    signer: deps.signer,
    receiptTimeoutMs: deps.receiptTimeoutMs,
  });

  switch (result.kind) {
    case "DRY_RUN":
      return {
        outcome: "DRY_RUN",
        detail: describePlan(planned.call),
        amountIn: decision.amountIn,
        decision,
        outstanding: null,
      };
    case "BLOCKED":
      return { outcome: "REFUSED", detail: `${result.reason}: ${result.detail}`, decision, outstanding: null };
    case "CONFIRMED":
      return {
        outcome: "BOUGHT",
        detail: `bought with ${decision.amountIn} wei, gas ${result.gasUsed}`,
        txHash: result.txHash,
        amountIn: decision.amountIn,
        decision,
        outstanding: null,
      };
    case "FAILED":
      return {
        outcome: "FAILED",
        detail: `the purchase reverted on chain: ${result.txHash}`,
        txHash: result.txHash,
        decision,
        outstanding: null,
      };
    case "UNRESOLVED":
      // CARRIED, NOT RETRIED. The next tick compares lifetime-invested against
      // the figure below and knows whether this landed.
      return {
        outcome: "NEEDS_ATTENTION",
        detail:
          `${result.txHash} was broadcast and no receipt arrived in time. It may still be mined, so ` +
          "nothing further will be bought for this vault until the next tick can tell.",
        txHash: result.txHash,
        decision,
        outstanding: { lifetimeInvestedBefore: lifetimeInvested, txHash: result.txHash },
      };
  }
}
