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
 * USDC ready to buy. The snapshot does not read the trading wallets' own
 * signatures, so a trade not yet settled is seen only through the push
 * (src/lib/live-push.ts): a trading wallet that changed at a slot past its
 * link's frontier and past its newest settlement on screen is being checked
 * ("measuring", below). The push cannot tell a trade from a plain transfer
 * into the wallet, so the row says "your latest activity", never "your trade".
 *
 * ACTIVE OR WAITING, NEVER A LOADER THAT LIES. A step is "active" — drawn with
 * a loader — only while nothing the screen can read stops it and the LOADED
 * history shows the chain moving toward it less than PENDING_STALL_MS ago. A
 * step the keeper skips for a reason on screen (the vault paused, buying
 * switched off, the 30-day limit, a policy's old price limits, SOL under the
 * policy's safety floor) is "waiting"
 * with that reason. A step still undone a few sweeps after the chain last moved
 * toward it is "waiting" as "slow": the keeper can rest for reasons this page
 * cannot read (a thin market, an oracle that is late), and a spinner there
 * would claim progress nobody measured. So is a step the loaded history holds
 * no successful move toward — the history unread, or a first page of failed
 * transactions: with nothing to time it by, no loader is evidence of anything.
 *
 * NOTHING BELOW A MINIMUM IS A ROW, AND ALL OF IT IS COUNTED. Below the
 * keeper's dust lines nothing is wrapped or converted, and USDC that cannot buy
 * every leg waits for more — nothing moves, so no row says it. But it is the
 * next investment all the same: the Next investment bar counts the SOL and wSOL
 * under the lines at today's price (solUnderWrapLine), beside the USDC and the
 * SOL being converted, and its line names the wrap line that SOL waits for. It
 * used not to (owner, 2026-10-09: 3,911,799 lamports from a settlement under
 * the 0.005 SOL line, "Pending $0.43" in the footer and "$0.00 of $1.00" on the
 * bar). Only SOL a rest the page can read holds back — the vault paused, buying
 * or converting switched off, the 30-day limit, old price limits, the safety
 * floor — is pending without being counted. No policy, or one that could not
 * be read, says nothing at all: the "first savings" card asks for the
 * approval, and keeping SOL as SOL is a choice.
 *
 * WHAT THE PAGE CANNOT WEIGH IS SAID, NEVER GUESSED (review 2026-10-09).
 * nextInvestment makes Next investment in raw units, part by part — the USDC,
 * the SOL converting, the SOL waiting under the lines, the SOL a rest holds —
 * and adds them up to the footer's Pending exactly. A part made with an input
 * the page could not read (the vault's free SOL, today's price, a switch) is
 * null, so is every figure made from it, and the line says which input.
 */

import { formatSolAtLeast, formatSolAtMost, formatUsd, usdcRawForLamports, rawFrom } from "@/lib/amounts";
import { whenLabel } from "@/lib/format";
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
 * THE MOST BELOW ITS QUOTE THE KEEPER LETS A CONVERSION FILL (packages/
 * solana-keeper src/min-out.ts SLIPPAGE_BPS): the route's min_out is the quote
 * less 2 % — legSlippageBps of a 0 bps fee (invest-decision.ts), as neither
 * wSOL nor USDC carries one. Next investment counts SOL being converted at
 * today's price; what the keeper buys with is the USDC that conversion really
 * brings, so only SOL that clears the basket by more than this is a buy the
 * page can promise (toGoOf). Held to the keeper's by live-pending.test.ts.
 */
export const CONVERT_SLIPPAGE_BPS = 200n;

/**
 * How long after the chain last moved toward a step its loader may run: five
 * of the keeper's sweeps (about a minute each). Past it the row stays, without
 * the loader, and says since when.
 */
export const PENDING_STALL_MS = 5 * 60_000;

/** u64::MAX: a policy's "no 30-day limit". */
const U64_MAX = (1n << 64n) - 1n;

export type PendingKind = "measuring" | "converting" | "buying";

/** The two steps the keeper takes with the vault's own money. */
type InvestKind = Exclude<PendingKind, "measuring">;

/** Why a due step rests. "slow" is the one the screen cannot explain. */
export type PendingRest = "buying_off" | "paused" | "protocol_paused" | "month_cap" | "conversion_off" | "price_limits" | "safety_floor" | "slow";

/** A rest the page can read and the owner can lift: every PendingRest but "slow". */
type StatedRest = Exclude<PendingRest, "slow">;

export interface PendingStep {
  readonly kind: PendingKind;
  readonly state: "active" | "waiting";
  /** Null exactly when the state is "active". */
  readonly rest: PendingRest | null;
  /** Converting: the lamports on their way to USDC. Buying: the USDC the next buy spends, raw. */
  readonly amountRaw: bigint;
  /**
   * In USDC raw: the SOL at the price this snapshot read — the free SOL and the
   * wSOL valued apart, as their holdings rows are, so the row and the bar agree
   * with the footer's Pending to the raw unit — or the USDC itself. Null without a price.
   */
  readonly valueUsdcRaw: bigint | null;
  /** Buying: the basket's symbols, in the policy's order. Empty for converting. */
  readonly symbols: readonly string[];
  /** Milliseconds: when the loaded history last moved toward this step. Null when it holds no such row — then the step is "slow", never "active". */
  readonly since: number | null;
  /** Measuring only: the trading wallet that changed, as the page names it. */
  readonly wallet?: { readonly address: string; readonly label: string };
  /** Measuring only: the vault's mode, which decides whether a saving follows (0 profit, 1 volume). */
  readonly mode?: number | null;
}

/**
 * THE VOLUME KEEPER'S CADENCE (packages/solana-keeper/src/volume-base.ts
 * VOLUME_MIN_OWED_LAMPORTS and VOLUME_MAX_WAIT_SECONDS): a span settles once
 * it owes 0.001 SOL, or once its oldest charged trade is an hour old. Held to
 * the keeper's by live-pending.test.ts.
 */
export const VOLUME_MIN_OWED_LAMPORTS = 1_000_000n;
export const VOLUME_MAX_WAIT_MS = 60 * 60_000;

/**
 * HOW LONG A WALLET'S CHANGE KEEPS ITS LOADER, counted from the read that
 * first saw it: about two of the keeper's sweeps (packages/solana-keeper
 * DEFAULT_SWEEP_MS, one minute). The keeper decides within about one sweep;
 * a span that made no profit, or a volume span with no trade in it, rests at
 * NO_PROFIT and sends nothing (settle-decision.ts), so no chain event would
 * ever end the step. Past this the loader stops and a quiet line says no
 * saving has come yet.
 */
export const MEASURING_STALL_MS = 2 * 60_000;

/**
 * And how long its row stays at all, whatever the mode. A volume vault's
 * saving can come up to VOLUME_MAX_WAIT_MS later, but the page cannot tell a
 * trade from a plain transfer into the wallet, which owes nothing — so it does
 * not hold a line up for an hour on what may be no trade at all; the saving's
 * own row says it when it comes.
 */
export const MEASURING_HIDE_MS = 15 * 60_000;

/** The rows that move money toward each step, newest of which starts its clock. */
const MOVES_TOWARD: Readonly<Record<InvestKind, ReadonlySet<LiveRow["event"]["kind"]>>> = {
  // SOL arriving or being wrapped, a convert that left some behind, or a policy
  // or rule that just unblocked the turn.
  converting: new Set(["settled", "received_sol", "wrapped", "converted", "policy_signed", "rule_changed"]),
  // USDC arriving, a buy that left some behind (one call's cap), or a policy or rule that just unblocked it.
  buying: new Set(["converted", "invested", "policy_signed", "rule_changed"]),
};

function newestMove(data: LiveDashboard, kind: InvestKind): number | null {
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
function turnRest(data: LiveDashboard): StatedRest | null | "unknown" {
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

/**
 * The policy's own switches on the conversion, after the turn's rest, in the
 * converting step's order: converting off (a floor of 0), then old price
 * limits, then the safety floor.
 */
function conversionSwitch(policy: LiveDashboard["policy"]): StatedRest | null {
  if (policy.minConvertRateWad !== null && policy.minConvertRateWad <= 0n) return "conversion_off";
  // OLD PRICE LIMITS (a policy signed before 2026-10-08): a stock's passed
  // limit refuses the whole turn before the wrap, the SOL limit alone the
  // conversion after it (live-model.ts oldLimitsStopOf). Either way no SOL
  // reaches USDC until the owner switches to live-price buying.
  if (policy.oldLimitsStop !== null) return "price_limits";
  // THE SOL SAFETY FLOOR (a policy signed since 2026-10-09): SOL under it is
  // refused by convert.rs on every sweep, so the row rests on it — the one
  // price move that asks the owner to approve again — and never spins.
  if (policy.safetyFloorStop) return "safety_floor";
  return null;
}

/**
 * WHY THE VAULT'S SOL WOULD NOT REACH USDC: the turn's rest, then the
 * conversion's switches. The one test for the SOL being converted and for the
 * SOL under the wrap line alike, so the bar never counts SOL the row says is held.
 */
const convertRest = (data: LiveDashboard): StatedRest | null | "unknown" => turnRest(data) ?? conversionSwitch(data.policy);

/** What the vault's own token account holds, raw; 0 for one it does not have, null when the list was not read. */
const heldToken = (data: LiveDashboard, kind: "wsol" | "usdc"): bigint | null =>
  data.tokensReadable ? (data.holdings.find((row) => row.kind === kind)?.amountRaw ?? 0n) : null;

/**
 * A TRADING WALLET THE PUSH SAW CHANGE, AND NO SETTLEMENT YET FOR IT.
 *
 * The change is the push's (LiveDashboard.walletChanges), handed over only
 * once a read at or past its slot had read the history too. It is still being
 * measured while its slot is past BOTH the link's frontier (what the keeper
 * has measured so far) and the newest settlement of that wallet on screen —
 * the second because the keeper's own settlement changes the wallet's lamports
 * too, in the very slot its row carries, and must never read as a new trade.
 *
 * Nothing while settling cannot happen: the vault or the protocol paused (or
 * not known not to be — settle.rs refuses either), a volume vault while volume
 * is not offered, a wallet whose link is not this vault's, or one holding no
 * more than its rent floor and reserve.
 */
function measuringSteps(data: LiveDashboard): PendingStep[] {
  const { vault } = data;
  if (!vault.exists || vault.paused !== false || data.protocolPaused === true || vault.volumeNotOffered) return [];
  const newest = new Map<string, LiveDashboard["walletChanges"][number]>();
  for (const change of data.walletChanges) {
    const held = newest.get(change.wallet);
    if (held === undefined || change.slot > held.slot) newest.set(change.wallet, change);
  }
  const steps: PendingStep[] = [];
  for (const wallet of data.wallets) {
    const change = newest.get(wallet.address);
    if (change === undefined || wallet.linkStatus !== "this_vault") continue;
    // At or under its reserve, settle.rs refuses to pay out of it (WalletBelowReserve):
    // moving the SOL out is itself the change that rang, and no saving can follow.
    if (wallet.canSettle === false) continue;
    if (wallet.frontierSlot !== null && wallet.frontierSlot >= BigInt(change.slot)) continue;
    const settled = data.settlementRows.some(
      (row) => row.ok && row.event.kind === "settled" && row.event.wallet === wallet.address && row.slot >= change.slot,
    );
    if (settled) continue;
    const age = data.nowMs - change.sinceMs;
    if (age > MEASURING_HIDE_MS) continue;
    const stalled = age > MEASURING_STALL_MS;
    steps.push({
      kind: "measuring",
      state: stalled ? "waiting" : "active",
      rest: stalled ? "slow" : null,
      amountRaw: 0n,
      valueUsdcRaw: null,
      symbols: [],
      since: change.sinceMs,
      wallet: { address: wallet.address, label: wallet.label },
      mode: vault.mode,
    });
  }
  return steps;
}

/** What is in flight: a wallet being measured, then converting, then buying. Empty when nothing is due. */
export function pendingSteps(data: LiveDashboard): PendingStep[] {
  return [...measuringSteps(data), ...investSteps(data)];
}

/** What the keeper is about to do with the vault's own money, converting first. */
function investSteps(data: LiveDashboard): PendingStep[] {
  const { vault, policy } = data;
  if (!vault.exists || policy.status !== "exists") return [];
  const rest = turnRest(data);
  if (rest === "unknown") return [];

  const perSol = rawFrom(data.prices?.usdcRawPerSol);
  const stateOf = (kind: InvestKind, reason: PendingRest | null): Pick<PendingStep, "state" | "rest" | "since"> => {
    const since = newestMove(data, kind);
    if (reason !== null) return { state: "waiting", rest: reason, since };
    // NO EVIDENCE, NO LOADER: with no successful move toward the step in the
    // loaded history there is no clock to stop it by, so it waits from the start.
    if (since === null || data.nowMs - since > PENDING_STALL_MS) return { state: "waiting", rest: "slow", since };
    return { state: "active", rest: null, since };
  };
  const steps: PendingStep[] = [];

  // ── SOL on its way to USDC ─────────────────────────────────────────────
  // The keeper's wake rule (wrapPlan, shouldConvert): free SOL from the dust
  // line up is wrapped, and the wSOL held is converted once a wrap added to it
  // or it is over the convert's own dust line.
  const free = vault.withdrawable;
  const wsol = heldToken(data, "wsol");
  const wraps = free !== null && free >= WRAP_DUST_LAMPORTS;
  if (wraps || (wsol !== null && wsol >= CONVERT_DUST_LAMPORTS)) {
    const wrapping = wraps ? free : 0n;
    steps.push({
      kind: "converting",
      // convertRest(data): the turn's "unknown" has already returned above.
      ...stateOf("converting", rest ?? conversionSwitch(policy)),
      amountRaw: wrapping + (wsol ?? 0n),
      // Row by row (the SOL row, then the wSOL row): one sum could differ from the two by a raw unit.
      valueUsdcRaw: perSol === null ? null : usdcRawForLamports(wrapping, perSol) + usdcRawForLamports(wsol ?? 0n, perSol),
      symbols: [],
    });
  }

  // ── USDC ready to buy the basket ───────────────────────────────────────
  // invest-tick.ts: the budget is the USDC held, under one call's cap and the
  // 30-day headroom, split by weight; every leg must clear the minimum or
  // nothing is bought.
  const usdc = heldToken(data, "usdc");
  const weights = policy.legs.map((leg) => leg.weightBps);
  if (usdc !== null && usdc > 0n && policy.minInvestment !== null && policy.maxPerCall !== null) {
    const perCall = usdc < policy.maxPerCall ? usdc : policy.maxPerCall;
    if (buysEveryLeg(perCall, weights, policy.minInvestment)) {
      const max = policy.maxRolling30d;
      const used = policy.usedLast30d;
      const headroom = max === null || used === null || max === U64_MAX ? null : used >= max ? 0n : max - used;
      const budget = headroom !== null && headroom < perCall ? headroom : perCall;
      // A stock's passed old limit refuses the basket; the SOL limit alone does not.
      const buyRest = rest ?? (policy.oldLimitsStop === "basket" ? "price_limits" : null);
      // The cap leaves less than the basket needs: that is month_cap, said by turnRest.
      if (buyRest !== null || buysEveryLeg(budget, weights, policy.minInvestment)) {
        steps.push({
          kind: "buying",
          ...stateOf("buying", buyRest),
          amountRaw: buyRest === null ? budget : perCall,
          valueUsdcRaw: buyRest === null ? budget : perCall,
          symbols: policy.legs.map((leg) => leg.symbol),
        });
      }
    }
  }
  return steps;
}

/** SOL the keeper will convert once the vault holds its wrap line: counted by Next investment, never a row. */
export interface SolUnderWrapLine {
  /** Free SOL under the wrap line, plus wSOL under the convert's line when no conversion takes it, lamports. */
  readonly lamports: bigint;
  /** What the free SOL still lacks to reach WRAP_DUST_LAMPORTS, lamports. */
  readonly shortLamports: bigint;
  /** `lamports` in USDC raw at the price this snapshot read, as the holdings rows value them. Null without a price. */
  readonly valueUsdcRaw: bigint | null;
  /** `shortLamports` in USDC raw at the same price. Null without a price. */
  readonly shortUsdcRaw: bigint | null;
}

/**
 * SOL UNDER THE KEEPER'S WRAP LINE — the owner's $0.43 (2026-10-09). A
 * settlement under 0.005 SOL leaves free SOL the keeper does not wrap
 * (wrapPlan wraps nothing under WRAP_DUST_LAMPORTS, invest-decision.ts), and
 * wSOL under the convert's own line is converted only beside a wrap
 * (shouldConvert). Neither moves until a later saving takes the free SOL to
 * the line; then the turn wraps and converts all of it at once. So it is the
 * next investment's money, waiting: counted, said, and given no row.
 *
 * Null when there is none, when it is not known (the vault's lamports unread),
 * when the free SOL is over the line (then the converting step holds it all,
 * wSOL included), and when a rest the page can read holds the SOL back
 * (convertRest — the same test the converting step rests on), or might.
 *
 * VALUED AS THE HOLDINGS ROWS ARE, one row at a time, so with no rest the bar
 * adds up to the footer's Pending to the raw unit: the SOL row is the free
 * SOL, the wSOL row the wSOL (live-model.ts holdingsOf).
 */
export function solUnderWrapLine(data: LiveDashboard): SolUnderWrapLine | null {
  const { vault, policy } = data;
  if (!vault.exists || policy.status !== "exists" || convertRest(data) !== null) return null;
  const free = vault.withdrawable;
  if (free === null || free >= WRAP_DUST_LAMPORTS) return null;
  // An unread token list is no wSOL to add: the free SOL is still known.
  const wsol = heldToken(data, "wsol") ?? 0n;
  // wSOL over the convert's line converts now, in the converting step.
  const wsolWaiting = wsol < CONVERT_DUST_LAMPORTS ? wsol : 0n;
  const lamports = free + wsolWaiting;
  if (lamports <= 0n) return null;
  const perSol = rawFrom(data.prices?.usdcRawPerSol);
  const shortLamports = WRAP_DUST_LAMPORTS - free;
  return {
    lamports,
    shortLamports,
    valueUsdcRaw: perSol === null ? null : usdcRawForLamports(free, perSol) + usdcRawForLamports(wsolWaiting, perSol),
    shortUsdcRaw: perSol === null ? null : usdcRawForLamports(shortLamports, perSol),
  };
}

/** What the vault's free SOL still lacks before the keeper wraps the NEXT saving: counted by toGoOf, never a row. */
export interface WrapLineAhead {
  /** Lamports a saving must bring for the free SOL to reach WRAP_DUST_LAMPORTS. */
  readonly shortLamports: bigint;
  /** `shortLamports` in USDC raw at the price this snapshot read. Null without a price. */
  readonly shortUsdcRaw: bigint | null;
}

/**
 * THE WRAP LINE THE NEXT SAVING MUST CROSS (review 2026-10-09). A saving lands
 * as free SOL, and the keeper wraps nothing under WRAP_DUST_LAMPORTS — so the
 * line binds every saving, not only the SOL already waiting under it. With no
 * free SOL at all, the normal state after every wrap, solUnderWrapLine has
 * nothing to count and says nothing, and "to go" read as the USDC's own gap:
 * USDC $0.80 of a $1.00 basket said "$0.20 to go", a $0.43 saving landed, the
 * keeper did not wrap it, bought nothing (each leg $0.40), and only then did
 * the card name the line.
 *
 * What is short: the whole line while the free SOL is over it — the converting
 * step wraps that SOL first, so the next saving lands on none — and the line
 * less the free SOL under it otherwise. Null when the free SOL is unread, and
 * when a rest the page can read holds the SOL back (convertRest): then no
 * saving converts at all, and the line is not what is in the way.
 */
export function wrapLineAhead(data: LiveDashboard): WrapLineAhead | null {
  const { vault, policy } = data;
  if (!vault.exists || policy.status !== "exists" || convertRest(data) !== null) return null;
  const free = vault.withdrawable;
  if (free === null) return null;
  const shortLamports = free >= WRAP_DUST_LAMPORTS ? WRAP_DUST_LAMPORTS : WRAP_DUST_LAMPORTS - free;
  const perSol = rawFrom(data.prices?.usdcRawPerSol);
  return { shortLamports, shortUsdcRaw: perSol === null ? null : usdcRawForLamports(shortLamports, perSol) };
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
  /** Unique among the lines: the kind, and for a wallet being measured, its address. */
  readonly key: string;
  readonly kind: PendingKind;
  readonly active: boolean;
  readonly rest: PendingRest | null;
  readonly title: string;
  readonly sub: string;
  readonly amount: string;
  /**
   * What a screen reader hears in place of `amount`, or null to hear `amount`
   * itself. A conversion's dollars are re-priced at every read, so they are
   * hidden from the live region: the SOL is spoken instead, and "" when the
   * row's own line already says it.
   */
  readonly amountSpoken: string | null;
}

const solText = (lamports: bigint): string => formatSolAtMost(lamports, 4);
/**
 * WHAT A SAVING MUST BRING, as the page prints it: rounded UP (amounts.ts
 * formatSolAtLeast), so "once your savings add 0.0012 SOL" is always enough.
 * Half-up printed 1,140,000 lamports as "0.0011", and a saving of exactly that
 * would leave the free SOL under the keeper's wrap line, with nothing
 * converted (review 2026-10-09). Only for an amount to bring: what is held is
 * solText.
 */
const shortText = (lamports: bigint): string => formatSolAtLeast(lamports, 4);

/**
 * The steps in words, for the rows over the feed.
 *
 * `nowMs` IS THE PAGE'S CLOCK (LiveDashboard.nowMs), the one every step's
 * `since` is on: a step stuck since before today says its day (format.ts
 * whenLabel), so "Not done since 23:58 UTC" read the morning after does not
 * pass for a few minutes.
 */
export function pendingLines(steps: readonly PendingStep[], nowMs: number): PendingLine[] {
  return steps.map((step): PendingLine => {
    const active = step.state === "active";
    if (step.kind === "measuring") {
      const label = step.wallet?.label ?? "a trading wallet";
      const mode = step.mode === 0 ? "profit" : step.mode === 1 ? "volume" : "unknown";
      return {
        key: `measuring:${step.wallet?.address ?? ""}`,
        kind: "measuring",
        active,
        rest: step.rest,
        // A measuring step is always timed: since is the read that first saw the change.
        title: active ? PENDING_COPY.measuring(label) : PENDING_COPY.measuringWaiting(label, whenLabel(step.since ?? nowMs, nowMs)),
        sub: active ? PENDING_COPY.measuringSub[mode] : PENDING_COPY.measuringRest[mode],
        amount: "",
        amountSpoken: "",
      };
    }
    const why =
      step.rest === null
        ? null
        : step.rest === "slow"
          ? step.since === null
            ? PENDING_COPY.slowUntimed
            : PENDING_COPY.slow(whenLabel(step.since, nowMs))
          : PENDING_COPY.rest[step.rest];
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
        amountSpoken: why === null ? "" : `${solText(step.amountRaw)} SOL`,
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
      amountSpoken: null,
    };
  });
}

/** The keeper's wrap line as the page prints it — from the constant, so the words cannot drift from the rule. */
const WRAP_LINE_SOL = solText(WRAP_DUST_LAMPORTS);

/** The conversion Next investment counts: on its way (active, or slow), never while a switch the owner set holds it. */
const countedConverting = (steps: readonly PendingStep[]): PendingStep | undefined =>
  steps.find((step) => step.kind === "converting" && (step.state === "active" || step.rest === "slow"));

/**
 * WHAT "NEXT INVESTMENT" COUNTS, AND THE LINE THAT SAYS SO. The USDC already
 * held, plus the SOL converting to USDC, plus the SOL waiting under the wrap
 * line (`waiting`, from solUnderWrapLine) — everything not invested that the
 * keeper will use, at today's price. Null `extraUsdcRaw` when there is nothing
 * to add or no price to add it at; the line then says the SOL.
 *
 * THE LINE SAYS WHAT THE BAR ADDS, all of it: a conversion and SOL under the
 * line together are one sum, said once, with the part that waits and what
 * moves it. A conversion that is due and not done ("slow") is still counted,
 * but not called under way. A basket the USDC alone buys says so — over any
 * SOL waiting, which is not what this buy spends.
 *
 * EACH SOL HOLDING REACHES ITS OWN LINE ON ITS OWN (review 2026-10-09). The
 * keeper wraps the free SOL from WRAP_DUST_LAMPORTS and converts the wSOL from
 * CONVERT_DUST_LAMPORTS, or beside a wrap; it never pools the two toward one
 * line. So no line says "once your vault holds 0.005 SOL" — 0.003 free and
 * 0.003 wrapped is 0.006 held, and nothing moves. What moves the SOL under the
 * lines is always the same thing: savings, which land as free SOL, taking the
 * free SOL to the wrap line — and then the turn wraps it and converts every
 * wSOL beside it. That is what the line says, with the free SOL's own
 * shortfall (`waiting.shortLamports`).
 *
 * WITH NO PRICE the SOL is said in SOL and on its own: the bar's figure is then
 * a dash (nextInvestment), so nothing here begins "Plus" a figure not shown.
 */
export function nextInvestmentOf(
  steps: readonly PendingStep[],
  waiting: SolUnderWrapLine | null = null,
): { readonly extraUsdcRaw: bigint | null; readonly note: string | null } {
  const converting = countedConverting(steps);
  if (converting !== undefined) {
    // Overdue ("slow"): counted all the same, and never called on its way — in every branch below.
    const slow = converting.rest === "slow";
    if (waiting === null) {
      if (converting.valueUsdcRaw === null) {
        const sol = solText(converting.amountRaw);
        return { extraUsdcRaw: null, note: slow ? PENDING_COPY.unpricedConvertingSlow(sol) : PENDING_COPY.unpricedConverting(sol) };
      }
      const usd = formatUsd(converting.valueUsdcRaw);
      return { extraUsdcRaw: converting.valueUsdcRaw, note: slow ? PENDING_COPY.includesConvertingSlow(usd) : PENDING_COPY.includesConverting(usd) };
    }
    const short = shortText(waiting.shortLamports);
    // One price values every SOL figure here: both have a dollar value, or neither does.
    if (converting.valueUsdcRaw === null || waiting.valueUsdcRaw === null) {
      const unpriced = slow ? PENDING_COPY.unpricedBothSlow : PENDING_COPY.unpricedBoth;
      return { extraUsdcRaw: null, note: unpriced(solText(converting.amountRaw + waiting.lamports), solText(waiting.lamports), short) };
    }
    const total = converting.valueUsdcRaw + waiting.valueUsdcRaw;
    const includes = slow ? PENDING_COPY.includesBothSlow : PENDING_COPY.includesBoth;
    return { extraUsdcRaw: total, note: includes(formatUsd(total), formatUsd(waiting.valueUsdcRaw), short) };
  }
  const buying = steps.find((step) => step.kind === "buying" && step.state === "active");
  if (waiting === null) return { extraUsdcRaw: null, note: buying === undefined ? null : PENDING_COPY.readyToBuy };
  const short = shortText(waiting.shortLamports);
  return {
    extraUsdcRaw: waiting.valueUsdcRaw,
    note:
      buying !== undefined
        ? PENDING_COPY.readyToBuy
        : waiting.valueUsdcRaw === null
          ? PENDING_COPY.unpricedWaiting(solText(waiting.lamports), short)
          : PENDING_COPY.includesWaiting(formatUsd(waiting.valueUsdcRaw), short),
  };
}

/**
 * Why the keeper will not buy on what the bar counts, whatever the figures say.
 *
 * "wrap_line": the USDC and the SOL being converted do not reach the basket
 * alone, and either the rest of what is counted is SOL under the keeper's wrap
 * line, which nothing moves until a saving takes the vault's free SOL to that
 * line, or the line is what the next saving must cross, and it is more than
 * the basket lacks (wrapLineAhead).
 *
 * "slow": the SOL being converted would complete the basket, and its
 * conversion is due and not done — the page cannot tell a crank short of SOL,
 * a thin market or a late oracle apart, only that the keeper has not moved.
 *
 * "conversion": the SOL being converted completes the basket at today's price,
 * but not if it fills as far under its quote as the keeper allows
 * (CONVERT_SLIPPAGE_BPS). The keeper converts, then buys only on the USDC the
 * vault really holds — so whether this conversion is enough is known once it
 * lands, and the page does not promise it before.
 *
 * "held": a rest the page can read and the owner can lift (PendingRest less
 * "slow") holds the buy — the buying step's own rest when the USDC buys the
 * basket, or, when it does not, the conversion's: then no SOL reaches USDC,
 * not even the next saving's, so the basket cannot fill whatever is saved. The
 * vault or SaverFi paused, buying or converting switched off, the 30-day
 * limit, old price limits, SOL under its safety floor.
 *
 * "unknown": a switch, or an amount, the page could not read stands between
 * the figures and a buy — the vault's pause or the policy's switch, the vault's
 * free SOL, today's SOL price — so it cannot say whether, or after how much
 * more, the keeper buys. Never a guess either way.
 */
export type NextInvestmentGate = "wrap_line" | "slow" | "conversion" | "held" | "unknown";

/**
 * HOW FAR THE NEXT INVESTMENT STILL IS — the smallest further saving, in USDC
 * raw at today's price, after which the keeper buys — and what gates it.
 *
 * WHY NOT THE THRESHOLD LESS THE BAR. Once SOL under the wrap line is counted
 * the bar can reach the threshold while the keeper idles: USDC $0.80 and $0.39
 * of SOL under the line reads $1.19 of $1.00, and nothing is bought, because
 * the keeper buys only on USDC that gives every leg its minimum
 * (invest-tick.ts) and converts that SOL only once the vault holds the line.
 * The next saving has to take the vault to the line AND the total to the
 * threshold, so what is to go is the larger of the two: the threshold less
 * everything counted, and the value of the SOL the line still lacks.
 *
 * THE LINE BINDS EVERY SAVING, NOT ONLY THE SOL UNDER IT (review
 * 2026-10-09). With no free SOL — the state after every wrap — or with the
 * free SOL being converted now, the next saving lands on an empty vault, and
 * the keeper wraps it only from the line up: to go is at least what the line
 * lacks (`ahead`, wrapLineAhead), gated "wrap_line" when that is the larger.
 *
 * 0 WITH NO GATE MEANS A BUY IS COMING. With a gate it is not, whatever this
 * figure: "slow" lacks no saving at all (0), "conversion" lacks none if the
 * SOL converts near today's price (0), "held" lacks the owner's switch and
 * not money, and a line a few lamports away is worth less than a cent — so
 * the card says a gate in words, never as "$0.00 to go"
 * (savings-rule-panel.tsx), and `note` is those words wherever
 * nextInvestmentOf's own line does not already say them.
 *
 * - The USDC alone buys the basket: 0 — gated "held" when the buying step
 *   waits on a rest the page can read, and `note` names it.
 * - With the SOL being converted it does: 0 — gated "slow" when that
 *   conversion is overdue, so nothing claims a buy is coming, and
 *   "conversion" when it does only at today's price: counted at the most
 *   under its quote the keeper lets it fill, it falls short.
 * - SOL waits under the line: gated "wrap_line", and to go is that larger of two.
 * - The line the next saving must cross is worth more than the threshold less
 *   what is on its way: that, gated "wrap_line", and `note` names the line.
 * - Otherwise: the threshold less what is on its way.
 *
 * Only for what the page can weigh: nextInvestment says "held" and "unknown"
 * for the rest before it gets here, and asks this only with a price.
 */
export function toGoOf(
  readiness: { readonly heldRaw: bigint; readonly investsAtRaw: bigint },
  steps: readonly PendingStep[],
  waiting: SolUnderWrapLine | null,
  ahead: WrapLineAhead | null = null,
): { readonly toGoRaw: bigint; readonly gate: NextInvestmentGate | null; readonly note: string | null } {
  const target = readiness.investsAtRaw;
  if (readiness.heldRaw >= target) {
    // The buying step carries the turn's rest, and a stock's passed old limit (investSteps); "slow" is not one the page can read.
    const rest = steps.find((step) => step.kind === "buying")?.rest ?? null;
    if (rest === null || rest === "slow") return { toGoRaw: 0n, gate: null, note: null };
    return { toGoRaw: 0n, gate: "held", note: PENDING_COPY.rest[rest] };
  }
  const converting = countedConverting(steps);
  const convertingRaw = converting?.valueUsdcRaw ?? null;
  const onItsWay = readiness.heldRaw + (convertingRaw ?? 0n);
  if (converting !== undefined && convertingRaw !== null && onItsWay >= target) {
    if (converting.rest === "slow") return { toGoRaw: 0n, gate: "slow", note: null };
    /*
     * ENOUGH AT TODAY'S PRICE IS NOT ENOUGH ONCE CONVERTED (review 2026-10-09).
     * The conversion pays its pool and may fill up to CONVERT_SLIPPAGE_BPS
     * under its quote, and the keeper then buys on the USDC it really holds,
     * all legs or none (invest-tick.ts). $0.40 of USDC and $0.605 of SOL
     * converting against a $1.00 basket read "$0.00 to go" on a full bar; a
     * fill at $0.598 would leave $0.998, under the basket, and buy nothing. A
     * buy is promised only when the SOL clears the basket at that worst fill.
     */
    const atWorst = readiness.heldRaw + (convertingRaw * (10_000n - CONVERT_SLIPPAGE_BPS)) / 10_000n;
    if (atWorst >= target) return { toGoRaw: 0n, gate: null, note: null };
    return { toGoRaw: 0n, gate: "conversion", note: PENDING_COPY.conversionDecides };
  }
  const gap = target - onItsWay - (waiting?.valueUsdcRaw ?? 0n);
  if (waiting === null) {
    // NO SOL UNDER THE LINE, AND THE LINE STILL IN THE WAY: the next saving must cross it.
    const toLine = ahead?.shortUsdcRaw ?? null;
    if (toLine !== null && toLine > gap) return { toGoRaw: toLine, gate: "wrap_line", note: PENDING_COPY.lineAhead(WRAP_LINE_SOL, formatUsd(toLine)) };
    return { toGoRaw: gap, gate: null, note: null };
  }
  const toLine = waiting.shortUsdcRaw ?? 0n;
  const toGoRaw = gap > toLine ? gap : toLine;
  // nextInvestmentOf's line already names what moves the SOL, and what it lacks.
  return { toGoRaw: toGoRaw > 0n ? toGoRaw : 0n, gate: "wrap_line", note: null };
}

/**
 * THE ONE LINE UNDER THE BAR: what nextInvestmentOf says of the money counted,
 * then what toGoOf says of its gate, as one line — either may be absent.
 */
export const nextInvestmentLine = (counted: string | null, gated: string | null): string | null =>
  counted === null ? gated : gated === null ? counted : `${counted} · ${gated}`;

// ── the next investment, part by part ────────────────────────────────────────

/** Where SOL the vault holds stands in Next investment. */
type SolPart = "converting" | "waiting" | "held";

const EVERY_PART: readonly SolPart[] = ["converting", "waiting", "held"];
const MOVING_PARTS: readonly SolPart[] = ["converting", "waiting"];

/**
 * ONE OF THE VAULT'S TWO SOL HOLDINGS — its free SOL, its wSOL — and the part
 * of Next investment it stands in. WHOLLY IN ONE, never split: the keeper
 * wraps all the free SOL or none, and converts all the wSOL or none. That is
 * what lets each part be valued row by row exactly as the holdings rows are,
 * and so add up to the footer's Pending to the raw unit.
 *
 * `part` is null when the page cannot tell which — a switch it could not read
 * decides whether anything moves, or the free SOL it could not read decides
 * whether the wrap runs — and `could` then names the parts it might be in.
 */
interface SolHolding {
  readonly lamports: bigint | null;
  readonly part: SolPart | null;
  readonly could: readonly SolPart[];
}

/**
 * The free SOL and the wSOL, each placed by the very tests the rows and the
 * bar are made by: convertRest holds both back ("held"); with no rest, the
 * keeper's wake rule (investSteps, solUnderWrapLine) — free SOL from the wrap
 * line is converted and takes every wSOL with it, wSOL from its own line is
 * converted on its own, and the rest waits under the lines.
 */
function solHoldings(data: LiveDashboard): readonly SolHolding[] {
  const free = data.vault.exists ? data.vault.withdrawable : null;
  const wsol = heldToken(data, "wsol");
  const rest = convertRest(data);
  if (rest === "unknown") {
    return [
      { lamports: free, part: null, could: EVERY_PART },
      { lamports: wsol, part: null, could: EVERY_PART },
    ];
  }
  if (rest !== null) {
    return [
      { lamports: free, part: "held", could: [] },
      { lamports: wsol, part: "held", could: [] },
    ];
  }
  const wraps = free === null ? null : free >= WRAP_DUST_LAMPORTS;
  const wsolPart: SolPart | null =
    wraps === true || (wsol !== null && wsol >= CONVERT_DUST_LAMPORTS) ? "converting" : wraps === false && wsol !== null ? "waiting" : null;
  return [
    { lamports: free, part: wraps === null ? null : wraps ? "converting" : "waiting", could: MOVING_PARTS },
    { lamports: wsol, part: wsolPart, could: MOVING_PARTS },
  ];
}

/**
 * One part's SOL, lamports, and its value in USDC raw — each holding at the
 * price this snapshot read, as its holdings row is. Null when a holding that
 * might stand in it could not be placed or measured; a holding of nothing
 * stands nowhere. The value is null without a price unless the part is empty.
 */
function partOf(holdings: readonly SolHolding[], part: SolPart, perSol: bigint | null): { readonly lamports: bigint | null; readonly usdcRaw: bigint | null } {
  let lamports = 0n;
  let usdcRaw = 0n;
  for (const holding of holdings) {
    if (holding.lamports === 0n) continue;
    const here = holding.part === null ? holding.could.includes(part) : holding.part === part;
    if (!here) continue;
    if (holding.part === null || holding.lamports === null) return { lamports: null, usdcRaw: null };
    lamports += holding.lamports;
    if (perSol !== null) usdcRaw += usdcRawForLamports(holding.lamports, perSol);
  }
  return { lamports, usdcRaw: perSol === null && lamports > 0n ? null : usdcRaw };
}

/**
 * WHAT NEXT INVESTMENT IS MADE OF, in USDC raw at today's price — and the SOL
 * behind each SOL part, in lamports. Every part is null when it is unknown,
 * never 0: a part with nothing in it is 0, one the page cannot measure is not.
 *
 * - `usdc`: the vault's USDC. Counted at a dollar, and hidden with every other
 *   dollar when no prices were read — the USDC holdings row's own rule
 *   (live-model.ts holdingsOf: the dollar column is all or nothing).
 * - `converting`: the SOL the converting step counts — under way, or due and
 *   not done ("slow").
 * - `waiting`: the SOL and wSOL under the keeper's lines (solUnderWrapLine).
 * - `held`: the SOL a rest the page can read holds back — the vault or SaverFi
 *   paused, buying or converting switched off, the 30-day limit, old price
 *   limits, the safety floor. Pending, and not counted by the bar. The USDC
 *   under such a rest stays in `usdc`: the gate says the rest.
 *
 * usdc + converting + waiting + held is the footer's Pending (live-model.ts
 * notInvested) to the raw unit whenever all four are known, and the lamports
 * of the three SOL parts are the vault's free SOL and wSOL.
 */
export interface NextInvestmentParts {
  readonly usdcRaw: bigint | null;
  readonly convertingRaw: bigint | null;
  readonly waitingRaw: bigint | null;
  readonly heldRaw: bigint | null;
  readonly convertingLamports: bigint | null;
  readonly waitingLamports: bigint | null;
  readonly heldLamports: bigint | null;
}

/** Next investment, whole: what the bar counts and of what, how far the buy still is, why not, and the line that says so. */
export interface NextInvestment {
  readonly parts: NextInvestmentParts;
  /** usdc + converting + waiting, USDC raw: the bar's figure. Null when any of the three is: no figure, and no bar. */
  readonly readyRaw: bigint | null;
  /**
   * toGoOf's figure, USDC raw. With "held", the money the basket lacks — the
   * switch is what the line names. Null with no basket the caps can ever buy,
   * and with "unknown".
   */
  readonly toGoRaw: bigint | null;
  readonly gate: NextInvestmentGate | null;
  /** nextInvestmentOf's words about the money counted, then the gate's where they do not say it; null for neither. */
  readonly note: string | null;
}

/**
 * NEXT INVESTMENT FOR A LIVE VAULT, from the dashboard: the parts, the bar's
 * figure, what is to go, the gate and the line. Null when there is no basket
 * to measure — no policy readable, or the vault's USDC unread
 * (LivePolicyView.readiness).
 *
 * A NULL FIGURE IS UNKNOWN, NEVER 0 (review 2026-10-09). The bar used to count
 * what it could read and leave out what it could not: the free SOL unread
 * added nothing, and with no price "$0.30 of $1.00" stood beside SOL it had not
 * valued. Now a figure made with an unknown is itself unknown, and the line
 * says which input is missing.
 *
 * In order: a basket the caps can never buy has nothing to go; a switch the
 * page could not read is "unknown" whatever the USDC; the USDC alone buying
 * the basket is toGoOf's ("held" when the buy rests); short of it, a rest on
 * the conversion is "held" — no saving converts while it stands — and the
 * money lacking is what is to go; then the free SOL or today's price unread is
 * "unknown"; and everything readable is toGoOf's.
 */
export function nextInvestment(data: LiveDashboard, steps: readonly PendingStep[] = pendingSteps(data)): NextInvestment | null {
  const readiness = data.policy.readiness;
  if (readiness === null) return null;
  const perSol = rawFrom(data.prices?.usdcRawPerSol);
  const holdings = solHoldings(data);
  const converting = partOf(holdings, "converting", perSol);
  const waitingPart = partOf(holdings, "waiting", perSol);
  const held = partOf(holdings, "held", perSol);
  const usdc = readiness.heldRaw;
  const parts: NextInvestmentParts = {
    usdcRaw: data.prices === null && usdc > 0n ? null : usdc,
    convertingRaw: converting.usdcRaw,
    waitingRaw: waitingPart.usdcRaw,
    heldRaw: held.usdcRaw,
    convertingLamports: converting.lamports,
    waitingLamports: waitingPart.lamports,
    heldLamports: held.lamports,
  };
  const readyRaw = parts.usdcRaw === null || parts.convertingRaw === null || parts.waitingRaw === null ? null : parts.usdcRaw + parts.convertingRaw + parts.waitingRaw;

  // WORDS ABOUT A SUM ONLY WHERE THE SUM CAN BE MADE. With a SOL holding the
  // page cannot place, "Includes about $1.80 of SOL being converted" would sit
  // under a dash and describe a figure that is not there; a basket the USDC
  // alone buys is still said.
  const placed = converting.lamports !== null && waitingPart.lamports !== null && held.lamports !== null;
  const waiting = solUnderWrapLine(data);
  const buying = steps.some((step) => step.kind === "buying" && step.state === "active");
  const counted = placed ? nextInvestmentOf(steps, waiting).note : buying ? PENDING_COPY.readyToBuy : null;
  const result = (toGoRaw: bigint | null, gate: NextInvestmentGate | null, gated: string | null): NextInvestment => ({
    parts,
    readyRaw,
    toGoRaw,
    gate,
    note: nextInvestmentLine(counted, gated),
  });

  const target = readiness.investsAtRaw;
  if (readiness.state === "unreachable" || target <= 0n) return result(null, null, null);
  const rest = convertRest(data);
  if (rest === "unknown") return result(null, "unknown", PENDING_COPY.unknown.switch);
  if (usdc >= target || (rest === null && placed && perSol !== null)) {
    const toGo = toGoOf(readiness, steps, waiting, wrapLineAhead(data));
    return result(toGo.toGoRaw, toGo.gate, toGo.note);
  }
  if (rest !== null) return result(target - usdc, "held", PENDING_COPY.rest[rest]);
  return result(null, "unknown", placed ? PENDING_COPY.unknown.price : PENDING_COPY.unknown.balance);
}
