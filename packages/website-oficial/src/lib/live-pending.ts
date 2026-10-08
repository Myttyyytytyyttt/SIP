/**
 * WHAT THE KEEPER IS ABOUT TO DO WITH THIS VAULT'S MONEY — pure, from what the
 * live dashboard already reads (owner, 2026-10-08: "Wrapped SOL for investing
 * $2.22" was the newest row, Next investment said $0.00, and nothing on the
 * screen said a conversion and a buy were on their way).
 *
 * THE MONEY'S ROAD, as the keeper walks it each sweep (packages/solana-keeper
 * src/invest-tick.ts): a settlement lands SOL in the vault; a turn wraps the
 * free SOL and converts the wSOL to USDC; once the USDC buys every leg at the
 * policy's minimum, a turn buys the basket by its weights. The two steps this
 * module can see from the chain are the last two — SOL on its way to USDC, and
 * USDC ready to buy. Trades not yet settled cannot be seen from here: the
 * snapshot does not read the trading wallets' own signatures.
 *
 * ACTIVE OR WAITING, NEVER A LOADER THAT LIES. A step is "active" — drawn with
 * a loader — only while nothing the screen can read stops it and the chain last
 * moved toward it less than PENDING_STALL_MS ago. A step the keeper skips for a
 * reason on screen (the vault paused, buying switched off, the 30-day limit) is
 * "waiting" with that reason. A step still undone a few sweeps after the chain
 * last moved toward it is "waiting" as "slow": the keeper can rest for reasons
 * this page cannot read (a thin market, an oracle that is late), and a spinner
 * there would claim progress nobody measured.
 *
 * NOTHING BELOW A MINIMUM IS PENDING. Below the keeper's dust lines nothing is
 * wrapped or converted, and USDC that cannot buy every leg waits for more; the
 * Next investment bar already shows that progress, so no row says it again. No
 * policy, or one that could not be read, says nothing at all: the "first
 * savings" card asks for the approval, and keeping SOL as SOL is a choice.
 */

import { formatSolAtMost, formatUsd, usdcRawForLamports, rawFrom } from "@/lib/amounts";
import { clockLabel } from "@/lib/format";
import { PENDING_COPY } from "@/lib/live-copy";
import type { LiveDashboard, LiveRow } from "@/lib/live-types";

/**
 * The keeper's own dust lines (packages/solana-keeper/src/invest-decision.ts
 * WRAP_DUST_LAMPORTS and CONVERT_DUST_LAMPORTS): free SOL under the first is not
 * wrapped, wSOL under the second is not converted unless a wrap just added to it.
 * Held to the keeper's by the KEEPER_DUST vector in
 * packages/solana-core/test/fixtures/keeper-policy.ts, asserted from both sides.
 */
export const WRAP_DUST_LAMPORTS = 5_000_000n;
export const CONVERT_DUST_LAMPORTS = 5_000_000n;

/**
 * How long after the chain last moved toward a step its loader may run: five
 * of the keeper's sweeps (about a minute each). Past it the row stays, without
 * the loader, and says since when.
 */
export const PENDING_STALL_MS = 5 * 60_000;

/** u64::MAX: a policy's "no 30-day limit". */
const U64_MAX = (1n << 64n) - 1n;

export type PendingKind = "converting" | "buying";

/** Why a due step rests. "slow" is the one the screen cannot explain. */
export type PendingRest = "buying_off" | "paused" | "protocol_paused" | "month_cap" | "conversion_off" | "slow";

export interface PendingStep {
  readonly kind: PendingKind;
  readonly state: "active" | "waiting";
  /** Null exactly when the state is "active". */
  readonly rest: PendingRest | null;
  /** Converting: the lamports on their way to USDC. Buying: the USDC the next buy spends, raw. */
  readonly amountRaw: bigint;
  /** In USDC raw: the SOL at the price this snapshot read, or the USDC itself. Null without a price. */
  readonly valueUsdcRaw: bigint | null;
  /** Buying: the basket's symbols, in the policy's order. Empty for converting. */
  readonly symbols: readonly string[];
  /** Milliseconds: when the loaded history last moved toward this step. Null when it holds no such row. */
  readonly since: number | null;
}

/** The rows that move money toward each step, newest of which starts its clock. */
const MOVES_TOWARD: Readonly<Record<PendingKind, ReadonlySet<LiveRow["event"]["kind"]>>> = {
  // SOL arriving or being wrapped, a convert that left some behind, or a policy
  // or rule that just unblocked the turn.
  converting: new Set(["settled", "received_sol", "wrapped", "converted", "policy_signed", "rule_changed"]),
  // USDC arriving, a buy that left some behind (one call's cap), or a policy or rule that just unblocked it.
  buying: new Set(["converted", "invested", "policy_signed", "rule_changed"]),
};

function newestMove(data: LiveDashboard, kind: PendingKind): number | null {
  let newest: number | null = null;
  for (const row of [...data.rows, ...data.settlementRows]) {
    if (!row.ok || row.blockTime === null || !MOVES_TOWARD[kind].has(row.event.kind)) continue;
    // A settlement that moved nothing brought no SOL.
    if (row.event.kind === "settled" && (rawFrom(row.event.paid) ?? 0n) <= 0n) continue;
    const at = row.blockTime * 1_000;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

/** The balance at which every leg clears the minimum: the keeper's basketMinimum and core's investsAtRaw. */
function basketMinimum(minInvestment: bigint, weights: readonly number[]): bigint | null {
  if (weights.length === 0 || weights.some((weight) => weight <= 0)) return null;
  const lightest = BigInt(Math.min(...weights));
  return (minInvestment * 10_000n + lightest - 1n) / lightest;
}

/** Whether `budget`, split by weight exactly as the keeper splits it, gives every leg the minimum. */
const buysEveryLeg = (budget: bigint, weights: readonly number[], minInvestment: bigint): boolean =>
  weights.length > 0 && weights.every((weight) => (budget * BigInt(weight)) / 10_000n >= minInvestment);

/**
 * Why the keeper's turn stops before it moves anything, in its own order
 * (invest-tick.ts investTurn): investing off, either pause switch, then the
 * 30-day cap. "unknown" when a switch it reads could not be read here — then
 * nothing is said, rather than a loader for a turn that may not run.
 */
function turnRest(data: LiveDashboard): PendingRest | null | "unknown" {
  const { policy, vault } = data;
  if (policy.enabled === null) return "unknown";
  if (!policy.enabled) return "buying_off";
  if (vault.paused === null) return "unknown";
  if (vault.paused) return "paused";
  if (data.protocolPaused === true) return "protocol_paused";
  const max = policy.maxRolling30d;
  const used = policy.usedLast30d;
  const minimum = policy.minInvestment === null ? null : basketMinimum(policy.minInvestment, policy.legs.map((leg) => leg.weightBps));
  if (max !== null && used !== null && minimum !== null) {
    const headroom = max === U64_MAX ? U64_MAX : used >= max ? 0n : max - used;
    if (headroom < minimum) return "month_cap";
  }
  return null;
}

/** What is in flight, converting first. Empty when nothing is due. */
export function pendingSteps(data: LiveDashboard): PendingStep[] {
  const { vault, policy } = data;
  if (!vault.exists || policy.status !== "exists") return [];
  const rest = turnRest(data);
  if (rest === "unknown") return [];

  const perSol = rawFrom(data.prices?.usdcRawPerSol);
  const held = (kind: "wsol" | "usdc"): bigint | null =>
    data.tokensReadable ? (data.holdings.find((row) => row.kind === kind)?.amountRaw ?? 0n) : null;
  const stateOf = (kind: PendingKind, reason: PendingRest | null): Pick<PendingStep, "state" | "rest" | "since"> => {
    const since = newestMove(data, kind);
    if (reason !== null) return { state: "waiting", rest: reason, since };
    if (since !== null && data.nowMs - since > PENDING_STALL_MS) return { state: "waiting", rest: "slow", since };
    return { state: "active", rest: null, since };
  };
  const steps: PendingStep[] = [];

  // ── SOL on its way to USDC ─────────────────────────────────────────────
  // The keeper's wake rule (wrapPlan, shouldConvert): free SOL from the dust
  // line up is wrapped, and the wSOL held is converted once a wrap added to it
  // or it is over the convert's own dust line.
  const free = vault.withdrawable;
  const wsol = held("wsol");
  const wraps = free !== null && free >= WRAP_DUST_LAMPORTS;
  if (wraps || (wsol !== null && wsol >= CONVERT_DUST_LAMPORTS)) {
    const lamports = (wraps ? free : 0n) + (wsol ?? 0n);
    const conversionOff = policy.minConvertRateWad !== null && policy.minConvertRateWad <= 0n;
    steps.push({
      kind: "converting",
      ...stateOf("converting", rest ?? (conversionOff ? "conversion_off" : null)),
      amountRaw: lamports,
      valueUsdcRaw: perSol === null ? null : usdcRawForLamports(lamports, perSol),
      symbols: [],
    });
  }

  // ── USDC ready to buy the basket ───────────────────────────────────────
  // invest-tick.ts: the budget is the USDC held, under one call's cap and the
  // 30-day headroom, split by weight; every leg must clear the minimum or
  // nothing is bought.
  const usdc = held("usdc");
  const weights = policy.legs.map((leg) => leg.weightBps);
  if (usdc !== null && usdc > 0n && policy.minInvestment !== null && policy.maxPerCall !== null) {
    const perCall = usdc < policy.maxPerCall ? usdc : policy.maxPerCall;
    if (buysEveryLeg(perCall, weights, policy.minInvestment)) {
      const max = policy.maxRolling30d;
      const used = policy.usedLast30d;
      const headroom = max === null || used === null || max === U64_MAX ? null : used >= max ? 0n : max - used;
      const budget = headroom !== null && headroom < perCall ? headroom : perCall;
      // The cap leaves less than the basket needs: that is month_cap, said by turnRest.
      if (rest !== null || buysEveryLeg(budget, weights, policy.minInvestment)) {
        steps.push({
          kind: "buying",
          ...stateOf("buying", rest),
          amountRaw: rest === null ? budget : perCall,
          valueUsdcRaw: rest === null ? budget : perCall,
          symbols: policy.legs.map((leg) => leg.symbol),
        });
      }
    }
  }
  return steps;
}

/** Whether any step is drawn with a loader: the dashboard reads the chain more often while one is. */
export const anyActive = (steps: readonly PendingStep[]): boolean => steps.some((step) => step.state === "active");

/** "SPYx", "SPYx and ANTHROPIC", "SPYx, GLDx and ANTHROPIC". */
export function namesOf(symbols: readonly string[]): string {
  if (symbols.length <= 1) return symbols[0] ?? "your basket";
  return `${symbols.slice(0, -1).join(", ")} and ${symbols[symbols.length - 1]}`;
}

/** One row as the feed draws it. */
export interface PendingLine {
  readonly key: PendingKind;
  readonly kind: PendingKind;
  readonly active: boolean;
  readonly rest: PendingRest | null;
  readonly title: string;
  readonly sub: string;
  readonly amount: string;
}

const solText = (lamports: bigint): string => formatSolAtMost(lamports, 4);

/** The steps in words, for the rows over the feed. */
export function pendingLines(steps: readonly PendingStep[]): PendingLine[] {
  return steps.map((step): PendingLine => {
    const active = step.state === "active";
    const why =
      step.rest === null ? null : step.rest === "slow" ? PENDING_COPY.slow(step.since === null ? "" : clockLabel(new Date(step.since).toISOString())) : PENDING_COPY.rest[step.rest];
    if (step.kind === "converting") {
      return {
        key: "converting",
        kind: "converting",
        active,
        rest: step.rest,
        title: active ? PENDING_COPY.converting : PENDING_COPY.convertingWaiting,
        sub: why ?? PENDING_COPY.convertingSub(solText(step.amountRaw)),
        // In today's dollars like every SOL amount in the column, and in SOL when no price was read.
        amount: step.valueUsdcRaw === null ? `${solText(step.amountRaw)} SOL` : formatUsd(step.valueUsdcRaw),
      };
    }
    const names = namesOf(step.symbols);
    return {
      key: "buying",
      kind: "buying",
      active,
      rest: step.rest,
      title: active ? PENDING_COPY.buying(names) : PENDING_COPY.buyingWaiting(names),
      sub: why ?? PENDING_COPY.buyingSub,
      amount: formatUsd(step.amountRaw),
    };
  });
}

/**
 * WHAT "NEXT INVESTMENT" COUNTS, AND THE LINE THAT SAYS SO. The USDC already
 * held, plus the SOL converting to USDC — while it is on its way (active, or
 * slow), never while a switch the owner set holds it. Null `extraUsdcRaw` when
 * there is nothing to add or no price to add it at.
 */
export function nextInvestmentOf(steps: readonly PendingStep[]): { readonly extraUsdcRaw: bigint | null; readonly note: string | null } {
  const converting = steps.find((step) => step.kind === "converting" && (step.state === "active" || step.rest === "slow"));
  if (converting !== undefined) {
    return converting.valueUsdcRaw === null
      ? { extraUsdcRaw: null, note: PENDING_COPY.plusConverting(solText(converting.amountRaw)) }
      : { extraUsdcRaw: converting.valueUsdcRaw, note: PENDING_COPY.includesConverting(formatUsd(converting.valueUsdcRaw)) };
  }
  const buying = steps.find((step) => step.kind === "buying" && step.state === "active");
  return { extraUsdcRaw: null, note: buying === undefined ? null : PENDING_COPY.readyToBuy };
}
