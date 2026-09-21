"use client";

/**
 * INVESTING: the vault's investment policy, or the form that signs its first one.
 *
 * STATES. Loading: a skeleton. Unreadable (the route, the vault or the policy):
 * words, and never a form, because a policy may exist. No vault: "Create your
 * vault first." No policy: SIP's basket and its $5 rule, the two caps, today's
 * price limits, the rent, and the issuer's powers over SPYx with a box to tick
 * before Sign investment policy. A policy: on or paused, the floors it signed
 * against today's prices, its caps, what it used in the trailing 30 days and in
 * all, whether the next sweep can buy, and buttons to sign again at today's
 * prices or to pause and resume, each keeping the caps it has. Pause signs the
 * stored policy again with investing off and reads no price, so the owner can
 * stop investing when the pools cannot be priced; Sign again and Resume set
 * floors from today's prices.
 *
 * WHAT IS SIGNED is the build's floors, not the ones shown here before building:
 * the flow checks them against SIP's margins, and they are shown again while
 * Phantom asks.
 *
 * WHAT THIS CARD OFFERS, AND IN WHAT SHAPE. All four of the fields the owner
 * asked for are buildable, and the three that belong to the POLICY are wired
 * here; the fourth, the cap per settlement, is the VAULT's rule and lives on
 * VaultCard. investPolicy takes the two caps, the minimum per buy,
 * the basket weights and the venue (INVEST_POLICY_FIELDS in
 * solana-core/src/server/build-handler.ts), and the cap per settlement rides on
 * setPolicy, the vault's own rule. Each has exactly one accepted shape, and the
 * route refuses every other before it reads a single account:
 *  * MOST PER BUY and MOST PER 30 DAYS: decimal strings of USDC raw units; the
 *    route's decimalU64 refuses a float or a JS number outright, so no cap can
 *    arrive through a lossy double.
 *  * THE MINIMUM PER BUY: the same decimal string of USDC raw units. It is
 *    enforced PER LEG, which is what REACHABLE_PER_BUY_RAW below exists for.
 *  * THE BASKET WEIGHTS: {mint, weightBps} pairs, BY MINT and never positional,
 *    that must sum to exactly LEG_WEIGHT_TOTAL_BPS. Nothing is normalised or
 *    filled in for you, so Sign is gated on the sum.
 *  * THE VENUE: a NAME from the closed set the server itself serves
 *    (offeredVenues), never a program id from the browser.
 *  * THE CAP PER SETTLEMENT is NOT here: it is a VAULT field, carried by
 *    setPolicy, which writes all six of the vault's rule at once. It belongs
 *    beside the rest of that rule on VaultCard, not on the policy card.
 * route.test.ts pins every one of those shapes, so a change to the whitelist
 * turns it red rather than leaving this comment quietly wrong.
 *
 * AND THE ONE FIELD THAT MUST NEVER BECOME AN INPUT: min_convert_rate_wad. The
 * program does not validate it, and a zero there silently switches the
 * SOL-to-USDC conversion off. Nothing here can reach it — it is always
 * floorWad(the live pool price, CONVERT_FLOOR_MARGIN_BPS), and vault-flows.ts
 * refuses to sign a build whose convertWad is null, zero or not exactly that.
 * The card states its EFFECT in words beside the live price it came from
 * (INVEST_COPY.convertFloorEffect), which is as far as this should ever go.
 */

import {
  CONVERT_FLOOR_MARGIN_BPS,
  DEFAULT_INVEST_CAPS,
  DEFAULT_PURCHASE_USDC_RAW,
  LEG_FLOOR_MARGIN_BPS,
  LEG_WEIGHT_TOTAL_BPS,
  OFFERED_LEGS,
  SIGNATURE_FEE_LAMPORTS,
  TOKEN_PROGRAM,
  basketWeightsBps,
  defaultInvestPolicy,
  floorWad,
  investmentReadiness,
  ownerComputeBudget,
  priorityFeeLamports,
  usdcRawPer1e8LegRaw,
  usdcRawPerSol,
  type InvestmentReadiness,
} from "@sip/solana-core/client";
import { useState, type ReactNode } from "react";

import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { TxProgress } from "@/components/wallets/TxProgress";
import { useVaultWrite, type InvestRequest, type WriteProgress } from "@/hooks/use-vault-actions";
import { DEFAULT_VENUE_NAME, VERIFIABLE_VENUES } from "@/lib/vault-flows";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { AmountError, USDC_DECIMALS, formatSol, formatUnits, formatUsd, parseUnits, rawFrom } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { todaysLimits, usedInLast30Days } from "@/lib/invest-limits";
import { floorsState } from "@/lib/live-model";
import type { InvestPolicyBuildJson, InvestmentPolicyJson, VaultStateJson } from "@/lib/vault-api";
import { INVEST_COPY, MAX_LEG_FEE_BPS, VAULT_COPY, listAnd, ratePercent, shortAddress } from "@/lib/vault-copy";

type VaultWrite = ReturnType<typeof useVaultWrite>;

/** The caps a person typed, in USDC raw units, or why they cannot be signed. */
export type Caps = { readonly ok: true; readonly maxPerCall: bigint; readonly maxRolling30d: bigint } | { readonly ok: false; readonly message: string };

/**
 * THE SMALLEST PER-BUY CAP A POLICY CAN EVER BUY AT, in USDC raw units.
 *
 * min_investment is enforced PER LEG: an invest tick gives each leg its weight's
 * slice of the budget and refuses a slice under the minimum. So the bar is not
 * min_investment itself but the cap at which the LIGHTEST leg's slice clears it,
 * minInvestment x 10,000 / lightestWeightBps — the same arithmetic
 * investmentReadiness does when it calls a policy "reachable", rounded up the
 * same way, so the form and the summary cannot disagree.
 *
 * AT ONE LEG THE TWO NUMBERS COINCIDE, which is why comparing against
 * min_investment alone was invisible until the basket became two. At today's two
 * equal legs min_investment is $2.50, and a $2.50 cap hands each leg $1.25: a
 * policy that can never buy at any balance. The program does not refuse it — its
 * only rule is 0 < min_investment <= max_per_call — and Sign is gated by these
 * caps alone, so without this bar the owner pays the rent for a policy that is
 * dead the moment it lands, and only learns it from the summary afterwards.
 */
export const REACHABLE_PER_BUY_RAW: bigint = (() => {
  const lightest = BigInt(Math.min(...basketWeightsBps(OFFERED_LEGS.length)));
  const minInvestment = defaultInvestPolicy(OFFERED_LEGS.length).minInvestment;
  return (minInvestment * 10_000n + lightest - 1n) / lightest;
})();

/**
 * THE CAP ANTHROPIC'S POOL ALLOWED WHEN IT WAS LAST READ, in USDC raw units.
 *
 * MIN_POOL_DEPTH_MULTIPLE is 50, so a leg may spend at most a fiftieth of the
 * pool's in-side reserve. Read 2026-09-20 at slot 448864213, ANTHROPIC/USDC
 * held 9,541,652,779 raw USDC: $190.83 a leg, and at two equal legs $381.67 for
 * the whole buy. Rounded DOWN to $380 so the figure is never optimistic.
 *
 * THIS IS A CEILING THAT CANNOT BE RE-DERIVED HERE. /api/solana-vault's prices
 * payload carries pool RATES and, now, the pyth block -- no reserve -- so the
 * page has nothing to recompute this from and nothing to invalidate it with.
 * That is why what follows is a warning rather than a refusal, and why the
 * starting value below is not this number.
 */
export const DEPTH_CEILING_PER_BUY_RAW = 380_000_000n;

/**
 * WHAT THE "Most per buy" BOX STARTS AT, in USDC raw units.
 *
 * NOT DEFAULT_INVEST_CAPS.maxPerCall, which is $1,000. The card's own thin-pool
 * notice tells the owner that at $1,000 the basket buys "nothing bought, no SOL
 * converted, at any balance" -- and the form pre-filled exactly that, with Sign
 * lit, over 0.0117348 SOL of rent that does not come back. readCaps enforces
 * only a LOWER bound (REACHABLE_PER_BUY_RAW), so nothing stopped it: the
 * failure REACHABLE_PER_BUY_RAW closes at the low end was wide open at the high
 * end, where the shipped default landed.
 *
 * HALF THE CEILING, NOT THE CEILING. $380 cleared the measured reserve by
 * 0.44 %; $190 leaves about 2x cover, so an ordinary day's drift in that pool
 * does not turn the starting value into a policy that buys nothing. The owner
 * can still type anything at or above REACHABLE_PER_BUY_RAW -- this is where
 * the box starts, not a limit.
 */
export const SUGGESTED_PER_BUY_RAW = DEPTH_CEILING_PER_BUY_RAW / 2n;

/** The two caps as typed, in dollars: at least REACHABLE_PER_BUY_RAW per buy, and at least one buy per 30 days. */
export function readCaps(perBuyText: string, per30DaysText: string): Caps {
  try {
    const maxPerCall = parseUnits(perBuyText, USDC_DECIMALS, INVEST_COPY.mostPerBuy);
    const maxRolling30d = parseUnits(per30DaysText, USDC_DECIMALS, INVEST_COPY.mostPer30Days);
    if (maxPerCall < REACHABLE_PER_BUY_RAW || maxRolling30d < maxPerCall) return { ok: false, message: INVEST_COPY.capsProblem(formatUsd(REACHABLE_PER_BUY_RAW)) };
    return { ok: true, maxPerCall, maxRolling30d };
  } catch (error) {
    if (error instanceof AmountError) return { ok: false, message: error.message };
    throw error;
  }
}

/** The least one LEG may be given, as typed, in USDC raw units — or why it cannot be signed. */
export type Minimum = { readonly ok: true; readonly raw: bigint } | { readonly ok: false; readonly message: string };

/**
 * THE MINIMUM PER BUY, WHICH IS ENFORCED PER LEG.
 *
 * The program's only rule is 0 < min_investment <= max_per_call, so it would
 * accept a minimum that makes the policy unbuyable at the cap beside it — the
 * same trap REACHABLE_PER_BUY_RAW closes from the other side. Checked here
 * against the cap actually typed, so the two boxes cannot disagree.
 */
export function readMinimum(text: string, maxPerCall: bigint | null): Minimum {
  try {
    const raw = parseUnits(text, USDC_DECIMALS, INVEST_COPY.minPerBuy);
    if (raw <= 0n) return { ok: false, message: INVEST_COPY.minimumProblem };
    // Per LEG: the lightest leg's slice of the cap has to clear it.
    if (maxPerCall !== null) {
      const lightest = BigInt(Math.min(...basketWeightsBps(OFFERED_LEGS.length)));
      if ((maxPerCall * lightest) / 10_000n < raw) return { ok: false, message: INVEST_COPY.minimumUnreachable(formatUsd(raw)) };
    }
    return { ok: true, raw };
  } catch (error) {
    if (error instanceof AmountError) return { ok: false, message: error.message };
    throw error;
  }
}

/** The basket as typed, by mint — or why it cannot be signed. */
export type Weights = { readonly ok: true; readonly byMint: ReadonlyMap<string, number> } | { readonly ok: false; readonly message: string };

/**
 * THE BASKET, BY MINT, SUMMING TO EXACTLY LEG_WEIGHT_TOTAL_BPS.
 *
 * NOTHING IS REPAIRED HERE, because nothing is repaired on the server either: a
 * sum of 9,999 is not normalised and a missing leg is not filled in at the
 * share that would make it work — each is a different basket from the one on
 * screen. Whole percentages only, which is what the boxes take; the server
 * takes basis points and this multiplies by 100, so a weight cannot arrive as
 * a fraction of a point nobody typed.
 */
export function readWeights(percents: readonly string[]): Weights {
  const byMint = new Map<string, number>();
  let total = 0;
  for (const [index, leg] of OFFERED_LEGS.entries()) {
    const text = (percents[index] ?? "").trim();
    if (!/^[0-9]{1,3}$/.test(text)) return { ok: false, message: INVEST_COPY.weightProblem(leg.symbol) };
    const bps = Number(text) * 100;
    if (bps <= 0) return { ok: false, message: INVEST_COPY.weightProblem(leg.symbol) };
    byMint.set(leg.mint, bps);
    total += bps;
  }
  if (total !== LEG_WEIGHT_TOTAL_BPS) return { ok: false, message: INVEST_COPY.weightsSum(ratePercent(total)) };
  return { ok: true, byMint };
}

/** Whether the setup form may ask Phantom: the issuer's powers acknowledged, every field valid, and no other write in the way. */
export const canSignPolicy = (input: {
  readonly acknowledged: boolean;
  readonly capsOk: boolean;
  readonly blocked: boolean;
  /** Default true, so the existing two-argument callers keep their meaning. */
  readonly minimumOk?: boolean;
  readonly weightsOk?: boolean;
}): boolean => input.acknowledged && input.capsOk && (input.minimumOk ?? true) && (input.weightsOk ?? true) && !input.blocked;

// These two moved to src/lib/invest-limits.ts, where the live dashboard's rule
// card reads the same numbers; re-exported so this card's existing imports and
// its test are untouched.
export { todaysLimits, usedInLast30Days, type TodaysLimits } from "@/lib/invest-limits";

/** The rent a first policy costs: the policy account if missing, and each vault token account missing; null when any part is unknown. */
export function setupRent(state: VaultStateJson): bigint | null {
  const { rents } = state;
  if (rents === null || state.vaultTokenAccounts.status !== "exists") return null;
  let total = state.policy.status === "missing" ? rawFrom(rents.policy) : 0n;
  if (total === null) return null;
  for (const account of state.vaultTokenAccounts.items) {
    if (account.status === "exists") continue;
    if (account.status !== "missing") return null;
    const rent = rawFrom(account.tokenProgram === TOKEN_PROGRAM ? rents.tokenAccount : rents.legTokenAccounts[account.mint]);
    if (rent === null) return null;
    total += rent;
  }
  return total;
}

function readinessWords(readiness: InvestmentReadiness): string {
  if (readiness.state === "ready") return INVEST_COPY.ready;
  if (readiness.state === "waiting") return INVEST_COPY.waiting(formatUsd(readiness.investsAtRaw));
  return INVEST_COPY.unreachable;
}

export function InvestingCard() {
  const screen = useVaultScreen();
  const write = useVaultWrite("policy");
  const [signing, setSigning] = useState<InvestRequest | "pause" | null>(null);
  if (screen === null) return null;
  const { view } = screen;

  // An explicit object: the flow gets the caps shown, never a click event.
  const start = (input: InvestRequest): void => {
    setSigning(input);
    void write.investPolicy(input);
  };
  // The policy on screen, re-signed with investing off: no prices are read.
  const pause = (policy: InvestmentPolicyJson): void => {
    setSigning("pause");
    void write.pauseInvesting(policy);
  };
  const progress = (
    <TxProgress
      progress={write.progress}
      successLabel={INVEST_COPY.signed}
      onBuildAgain={() => void write.buildAgain()}
      onCheckAgain={() => void write.checkAgain()}
      onDismiss={() => write.dismiss()}
      approveDetail={<SigningDetail progress={write.progress} request={signing} />}
    />
  );

  if (view.kind === "loading") {
    return (
      <Card aria-busy="true" aria-label={INVEST_COPY.title}>
        <CardHeader>
          <CardTitle>{INVEST_COPY.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (view.kind === "unreadable" || view.state.vault.status === "unreadable") return <Shell description={VAULT_COPY.unreadable} alert />;
  const { state } = view;
  if (state.vault.status === "missing") return <Shell description={INVEST_COPY.needsVault} />;
  if (state.policy.status === "unreadable" || (state.policy.status === "exists" && state.policy.state === undefined)) {
    return <Shell description={INVEST_COPY.policyUnreadable} alert>{write.progress.phase !== "idle" ? progress : null}</Shell>;
  }
  return state.policy.status === "missing" || state.policy.state === undefined ? (
    <PolicySetup state={state} write={write} start={start} progress={progress} />
  ) : (
    <PolicySummary state={state} policy={state.policy.state} write={write} start={start} pause={pause} progress={progress} />
  );
}

function Shell({ description, alert = false, children }: { readonly description: string; readonly alert?: boolean; readonly children?: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{INVEST_COPY.title}</CardTitle>
        <CardDescription role={alert ? "alert" : undefined}>{description}</CardDescription>
      </CardHeader>
      {children !== undefined && children !== null ? <CardContent>{children}</CardContent> : null}
    </Card>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className={LABEL}>{label}</dt>
      <dd>
        <Num>{children}</Num>
      </dd>
    </div>
  );
}

/**
 * What Phantom is asked to sign, from the checked build: its floors, and the
 * caps this card sent; or, for a pause, the policy as it is.
 *
 * EVERY FIGURE COMES FROM THE WADS THE FLOW CHECKED and the transaction
 * actually carries — never from the answer's own dollar fields
 * (floorUsdcRawPerSol, maxUsdcRawPer1e8, symbol). Those ride along beside the
 * wads and nothing holds them to each other, so a build could print a floor of
 * $90.03 over bytes that signed $0.00. The basket's names are SaverFi's own
 * OFFERED_LEGS, in the order the flow pinned them to.
 */
export function SigningDetail({ progress, request }: { readonly progress: WriteProgress; readonly request: InvestRequest | "pause" | null }) {
  if (progress.phase !== "running" || progress.built === null || request === null) return null;
  if (request === "pause") return <p className="font-normal text-foreground">{INVEST_COPY.pauseSigning}</p>;
  const floors = (progress.built as Partial<InvestPolicyBuildJson>).floors;
  const convertWad = rawFrom(floors?.convertWad);
  // A floor nobody can read is not guessed at: the progress says nothing rather
  // than a figure the bytes may not carry.
  if (floors === undefined || floors === null || convertWad === null || convertWad <= 0n) return null;
  const legs: string[] = [];
  for (const [index, leg] of OFFERED_LEGS.entries()) {
    const wad = rawFrom(floors.legs?.[index]?.wad);
    if (wad === null || wad <= 0n) return null;
    legs.push(INVEST_COPY.legSigning(leg.symbol, formatUsd(usdcRawPer1e8LegRaw(wad))));
  }
  return (
    <p className="font-normal text-foreground">
      {INVEST_COPY.youAreSigning(formatUsd(usdcRawPerSol(convertWad)), legs.join("; "), formatUsd(request.maxPerCall), formatUsd(request.maxRolling30d))}
    </p>
  );
}

function CapField({ id, label, value, onChange, disabled }: { readonly id: string; readonly label: string; readonly value: string; readonly onChange: (value: string) => void; readonly disabled: boolean }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <Input id={id} inputMode="decimal" autoComplete="off" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="font-mono" />
        <span className="text-sm text-muted-foreground">USD</span>
      </div>
    </div>
  );
}

function PolicySetup({
  state,
  write,
  start,
  progress,
}: {
  readonly state: VaultStateJson;
  readonly write: VaultWrite;
  readonly start: (input: InvestRequest) => void;
  readonly progress: ReactNode;
}) {
  const [perBuy, setPerBuy] = useState(() => formatUnits(SUGGESTED_PER_BUY_RAW, USDC_DECIMALS));
  const [per30Days, setPer30Days] = useState(() => formatUnits(DEFAULT_INVEST_CAPS.maxRolling30d, USDC_DECIMALS));
  const [acknowledged, setAcknowledged] = useState(false);
  // The catalogue's own defaults, as the route would build them when these
  // fields are left alone: the $5-split minimum and equal shares.
  const [minimum, setMinimum] = useState(() => formatUnits(defaultInvestPolicy(OFFERED_LEGS.length).minInvestment, USDC_DECIMALS));
  const [percents, setPercents] = useState<readonly string[]>(() => basketWeightsBps(OFFERED_LEGS.length).map((bps) => String(bps / 100)));
  // THE INTERSECTION, not the server's list: a name the web cannot check the
  // bytes of is never offered. See VERIFIABLE_VENUES in vault-flows.ts.
  const venues = (state.offeredVenues ?? []).filter((name) => VERIFIABLE_VENUES.has(name));
  const [venue, setVenue] = useState(DEFAULT_VENUE_NAME);

  const caps = readCaps(perBuy, per30Days);
  const minPerLeg = readMinimum(minimum, caps.ok ? caps.maxPerCall : null);
  const weightsTyped = readWeights(percents);
  const blocked = write.running || write.busyElsewhere || write.unconfirmed;
  const limits = todaysLimits(state.prices);
  const rent = setupRent(state);
  const fees = SIGNATURE_FEE_LAMPORTS + priorityFeeLamports(ownerComputeBudget("set_invest_policy"));
  const weights = OFFERED_LEGS.map((leg, index) => (weightsTyped.ok ? weightsTyped.byMint.get(leg.mint)! : basketWeightsBps(OFFERED_LEGS.length)[index]!));
  const floorText = limits === null ? "today's floor" : formatUsd(limits.floorPerSol);
  // "SPYx at 50 % and ANTHROPIC at 50 %", from the offered legs and their
  // weights — so the prose and the Basket field below cannot say different
  // things, which is what they did while this sentence named SPYx alone.
  const basket = listAnd(OFFERED_LEGS.map((leg, index) => `${leg.symbol} at ${ratePercent(weights[index]!)}`));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{INVEST_COPY.title}</CardTitle>
        <CardDescription>
          {INVEST_COPY.policyRule(
            basket,
            floorText,
            minPerLeg.ok ? formatUsd(minPerLeg.raw * BigInt(OFFERED_LEGS.length)) : formatUsd(DEFAULT_PURCHASE_USDC_RAW),
            caps.ok ? formatUsd(caps.maxPerCall) : `$${perBuy.trim()}`,
            caps.ok ? formatUsd(caps.maxRolling30d) : `$${per30Days.trim()}`,
            rent === null ? "some" : formatSol(rent),
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Fact label={INVEST_COPY.basket}>{OFFERED_LEGS.map((leg, index) => `${leg.symbol} · ${ratePercent(weights[index]!)}`).join(", ")}</Fact>
          <Fact label={INVEST_COPY.rule}>
            {INVEST_COPY.buysEach(minPerLeg.ok ? formatUsd(minPerLeg.raw * BigInt(OFFERED_LEGS.length)) : formatUsd(DEFAULT_PURCHASE_USDC_RAW))}
          </Fact>
        </dl>

        <div className="grid gap-3 sm:grid-cols-2">
          <CapField id="invest-max-per-call" label={INVEST_COPY.mostPerBuy} value={perBuy} onChange={setPerBuy} disabled={blocked} />
          <CapField id="invest-max-rolling" label={INVEST_COPY.mostPer30Days} value={per30Days} onChange={setPer30Days} disabled={blocked} />
        </div>
        {!caps.ok ? (
          <p role="alert" className="text-xs text-destructive">
            {caps.message}
          </p>
        ) : (
          <>
            {caps.maxPerCall > DEPTH_CEILING_PER_BUY_RAW ? (
              <p role="alert" className="text-xs text-destructive">
                {INVEST_COPY.depthWarning(formatUsd(DEPTH_CEILING_PER_BUY_RAW))}
              </p>
            ) : null}
            {caps.maxPerCall > 1_000_000_000n ? <p className="text-xs text-destructive">{INVEST_COPY.convertWarning}</p> : null}
          </>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <CapField id="invest-min-investment" label={INVEST_COPY.minPerBuy} value={minimum} onChange={setMinimum} disabled={blocked} />
          {venues.length > 0 ? (
            <div className="space-y-1">
              <Label htmlFor="invest-venue">{INVEST_COPY.venueLabel}</Label>
              <select
                id="invest-venue"
                name="invest-venue"
                value={venue}
                disabled={blocked}
                onChange={(event) => setVenue(event.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm disabled:opacity-50"
              >
                {venues.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{INVEST_COPY.venueHint}</p>
            </div>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{INVEST_COPY.minPerBuyHint}</p>
        {!minPerLeg.ok ? (
          <p role="alert" className="text-xs text-destructive">
            {minPerLeg.message}
          </p>
        ) : null}

        <div className="space-y-1">
          <div className={LABEL}>{INVEST_COPY.weightsTitle}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            {OFFERED_LEGS.map((leg, index) => (
              <div key={leg.mint} className="space-y-1">
                <Label htmlFor={`invest-weight-${leg.mint}`}>{leg.symbol}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`invest-weight-${leg.mint}`}
                    inputMode="numeric"
                    autoComplete="off"
                    value={percents[index] ?? ""}
                    disabled={blocked}
                    onChange={(event) => setPercents((current) => current.map((value, at) => (at === index ? event.target.value : value)))}
                    className="font-mono"
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{INVEST_COPY.weightsHint}</p>
          {!weightsTyped.ok ? (
            <p role="alert" className="text-xs text-destructive">
              {weightsTyped.message}
            </p>
          ) : null}
        </div>

        <div className="space-y-1 rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs">
          <div className={LABEL}>{INVEST_COPY.thinPoolTitle}</div>
          <p>{INVEST_COPY.thinPool(formatUsd(SUGGESTED_PER_BUY_RAW))}</p>
        </div>

        <div className="space-y-1 rounded-md border px-3 py-2 text-xs">
          <div className={LABEL}>{INVEST_COPY.floorsTitle}</div>
          {limits === null ? (
            <p>{INVEST_COPY.pricesUnknown}</p>
          ) : (
            <>
              <p>{INVEST_COPY.solFloor(formatUsd(limits.floorPerSol), formatUsd(limits.todayPerSol))}</p>
              {limits.legs.map((leg) => (
                <p key={leg.mint}>{INVEST_COPY.legCeiling(leg.symbol, formatUsd(leg.maxPer1e8))}</p>
              ))}
              <p className="text-muted-foreground">{INVEST_COPY.convertFloorEffect(ratePercent(CONVERT_FLOOR_MARGIN_BPS))}</p>
            </>
          )}
        </div>

        <p className="text-xs">{rent === null ? VAULT_COPY.costUnknown : VAULT_COPY.cost(formatSol(rent), formatSol(fees))}</p>

        <div className="space-y-1 rounded-md border px-3 py-2 text-xs">
          <div className={LABEL}>{INVEST_COPY.costTitle}</div>
          <p>{INVEST_COPY.issuerCost}</p>
          <p>{INVEST_COPY.feeCeiling(ratePercent(MAX_LEG_FEE_BPS))}</p>
          <p>{INVEST_COPY.marketCost}</p>
          <p>{INVEST_COPY.costTogether}</p>
        </div>

        <div className="space-y-2 rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs">
          <p>{INVEST_COPY.freezeNotice}</p>
          <p>{INVEST_COPY.issuerKeys}</p>
          <p>{INVEST_COPY.hookSwitch}</p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              name="invest-acknowledge"
              checked={acknowledged}
              disabled={blocked}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>{INVEST_COPY.acknowledge}</span>
          </label>
        </div>

        <Button
          type="button"
          disabled={!canSignPolicy({ acknowledged, capsOk: caps.ok, minimumOk: minPerLeg.ok, weightsOk: weightsTyped.ok, blocked })}
          aria-busy={write.running}
          onClick={() => {
            if (caps.ok && minPerLeg.ok && weightsTyped.ok && acknowledged) {
              start({
                maxPerCall: caps.maxPerCall,
                maxRolling30d: caps.maxRolling30d,
                enabled: true,
                minInvestment: minPerLeg.raw,
                weights: weightsTyped.byMint,
                // A NAME from the closed set, never a program id.
                venue,
              });
            }
          }}
        >
          {write.running ? INVEST_COPY.signing : INVEST_COPY.sign}
        </Button>
        {progress}
      </CardContent>
    </Card>
  );
}

function PolicySummary({
  state,
  policy,
  write,
  start,
  pause,
  progress,
}: {
  readonly state: VaultStateJson;
  readonly policy: InvestmentPolicyJson;
  readonly write: VaultWrite;
  readonly start: (input: InvestRequest) => void;
  readonly pause: (policy: InvestmentPolicyJson) => void;
  readonly progress: ReactNode;
}) {
  const limits = todaysLimits(state.prices);
  // The live rule card reads the same state, so the two cannot disagree about
  // whether a floor has been passed.
  const { storedConvert, legs, pricesKnown, belowMarket } = floorsState(policy, state.prices);

  const maxPerCall = rawFrom(policy.maxPerCall) ?? 0n;
  const maxRolling30d = rawFrom(policy.maxRolling30d) ?? 0n;
  const minInvestment = rawFrom(policy.minInvestment) ?? 0n;
  const usdcHeld = state.holdings.status === "exists" ? state.holdings.items.filter((item) => item.mint === policy.inMint).reduce((total, item) => total + (rawFrom(item.amountRaw) ?? 0n), 0n) : null;
  const readiness = usdcHeld === null ? null : investmentReadiness(usdcHeld, policy.legs, minInvestment, maxPerCall);
  const blocked = write.running || write.busyElsewhere || write.unconfirmed;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{INVEST_COPY.title}</CardTitle>
        <CardDescription>{policy.enabled ? INVEST_COPY.enabled : INVEST_COPY.paused}</CardDescription>
        {pricesKnown ? (
          <CardAction>
            <Badge variant={belowMarket ? "outline" : "destructive"}>{belowMarket ? INVEST_COPY.floorsBelowMarket : INVEST_COPY.floorPassed}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {pricesKnown && !belowMarket ? (
          <p role="status" className="text-xs text-destructive">
            {INVEST_COPY.marketPast}
          </p>
        ) : null}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Fact label={INVEST_COPY.basket}>{legs.map((leg) => `${leg.symbol} · ${ratePercent(leg.weightBps)}`).join(", ")}</Fact>
          <Fact label={INVEST_COPY.mostPerBuy}>{formatUsd(maxPerCall)}</Fact>
          <Fact label={INVEST_COPY.mostPer30Days}>{formatUsd(maxRolling30d)}</Fact>
          <Fact label={INVEST_COPY.usedLast30}>{formatUsd(usedInLast30Days(policy.bucketDays, policy.bucketAmounts, Date.now() / 1_000))}</Fact>
          <Fact label={INVEST_COPY.lifetime}>{formatUsd(rawFrom(policy.lifetimeInvested) ?? 0n)}</Fact>
        </dl>
        <div className="space-y-1 text-xs">
          {storedConvert !== null && storedConvert > 0n ? (
            <p>{INVEST_COPY.storedSolFloor(formatUsd(usdcRawPerSol(storedConvert)), limits === null ? null : formatUsd(limits.todayPerSol))}</p>
          ) : null}
          {legs.map((leg) =>
            leg.floor !== null && leg.floor > 0n ? (
              <p key={leg.mint}>{INVEST_COPY.storedLegCeiling(leg.symbol, formatUsd(usdcRawPer1e8LegRaw(leg.floor)), leg.today === null ? null : formatUsd(leg.today))}</p>
            ) : null,
          )}
        </div>
        {readiness !== null ? <p className="text-xs">{readinessWords(readiness)}</p> : null}
        <p className="text-xs text-muted-foreground">{INVEST_COPY.freezeShort}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={blocked} aria-busy={write.running} onClick={() => start({ maxPerCall, maxRolling30d, enabled: policy.enabled })}>
            {INVEST_COPY.signAgain}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={blocked}
            onClick={() => (policy.enabled ? pause(policy) : start({ maxPerCall, maxRolling30d, enabled: true }))}
          >
            {policy.enabled ? INVEST_COPY.pause : INVEST_COPY.resume}
          </Button>
        </div>
        {policy.enabled ? <p className="text-xs text-muted-foreground">{INVEST_COPY.pauseKeeps}</p> : null}
        <p className="text-xs text-muted-foreground">{INVEST_COPY.noRefill}</p>
        {progress}
      </CardContent>
    </Card>
  );
}
