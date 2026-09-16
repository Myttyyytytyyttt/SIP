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
 */

import {
  CONVERT_FLOOR_MARGIN_BPS,
  DEFAULT_INVEST_CAPS,
  DEFAULT_PURCHASE_USDC_RAW,
  LEG_FLOOR_MARGIN_BPS,
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
import { useVaultScreen } from "@/hooks/use-vault-state";
import { AmountError, USDC_DECIMALS, formatSol, formatUnits, formatUsd, parseUnits, rawFrom } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { todaysLimits, usedInLast30Days } from "@/lib/invest-limits";
import { floorsState } from "@/lib/live-model";
import type { InvestPolicyBuildJson, InvestmentPolicyJson, VaultStateJson } from "@/lib/vault-api";
import { INVEST_COPY, VAULT_COPY, ratePercent, shortAddress } from "@/lib/vault-copy";

type VaultWrite = ReturnType<typeof useVaultWrite>;

/** The caps a person typed, in USDC raw units, or why they cannot be signed. */
export type Caps = { readonly ok: true; readonly maxPerCall: bigint; readonly maxRolling30d: bigint } | { readonly ok: false; readonly message: string };

/** The two caps as typed, in dollars: at least the per-buy minimum per buy, and at least one buy per 30 days. */
export function readCaps(perBuyText: string, per30DaysText: string): Caps {
  try {
    const maxPerCall = parseUnits(perBuyText, USDC_DECIMALS, INVEST_COPY.mostPerBuy);
    const maxRolling30d = parseUnits(per30DaysText, USDC_DECIMALS, INVEST_COPY.mostPer30Days);
    const minimum = defaultInvestPolicy(OFFERED_LEGS.length).minInvestment;
    if (maxPerCall < minimum || maxRolling30d < maxPerCall) return { ok: false, message: INVEST_COPY.capsProblem(formatUsd(minimum)) };
    return { ok: true, maxPerCall, maxRolling30d };
  } catch (error) {
    if (error instanceof AmountError) return { ok: false, message: error.message };
    throw error;
  }
}

/** Whether the setup form may ask Phantom: the issuer's powers acknowledged, the caps valid, and no other write in the way. */
export const canSignPolicy = (input: { readonly acknowledged: boolean; readonly capsOk: boolean; readonly blocked: boolean }): boolean =>
  input.acknowledged && input.capsOk && !input.blocked;

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

/** What Phantom is asked to sign, from the checked build: its floors, and the caps this card sent; or, for a pause, the policy as it is. */
function SigningDetail({ progress, request }: { readonly progress: WriteProgress; readonly request: InvestRequest | "pause" | null }) {
  if (progress.phase !== "running" || progress.built === null || request === null) return null;
  if (request === "pause") return <p className="font-normal text-foreground">{INVEST_COPY.pauseSigning}</p>;
  const floors = (progress.built as Partial<InvestPolicyBuildJson>).floors;
  const solFloor = rawFrom(floors?.floorUsdcRawPerSol);
  if (floors === undefined || solFloor === null) return null;
  const legs = floors.legs.map((leg) => INVEST_COPY.legSigning(leg.symbol, formatUsd(rawFrom(leg.maxUsdcRawPer1e8) ?? 0n))).join("; ");
  return <p className="font-normal text-foreground">{INVEST_COPY.youAreSigning(formatUsd(solFloor), legs, formatUsd(request.maxPerCall), formatUsd(request.maxRolling30d))}</p>;
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
  const [perBuy, setPerBuy] = useState(() => formatUnits(DEFAULT_INVEST_CAPS.maxPerCall, USDC_DECIMALS));
  const [per30Days, setPer30Days] = useState(() => formatUnits(DEFAULT_INVEST_CAPS.maxRolling30d, USDC_DECIMALS));
  const [acknowledged, setAcknowledged] = useState(false);

  const caps = readCaps(perBuy, per30Days);
  const blocked = write.running || write.busyElsewhere || write.unconfirmed;
  const limits = todaysLimits(state.prices);
  const rent = setupRent(state);
  const fees = SIGNATURE_FEE_LAMPORTS + priorityFeeLamports(ownerComputeBudget("set_invest_policy"));
  const weights = basketWeightsBps(OFFERED_LEGS.length);
  const floorText = limits === null ? "today's floor" : formatUsd(limits.floorPerSol);
  const ceilingText = limits === null ? "today's ceiling" : limits.legs.map((leg) => formatUsd(leg.maxPer1e8)).join(" / ");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{INVEST_COPY.title}</CardTitle>
        <CardDescription>
          {INVEST_COPY.policyRule(
            floorText,
            ceilingText,
            caps.ok ? formatUsd(caps.maxPerCall) : `$${perBuy.trim()}`,
            caps.ok ? formatUsd(caps.maxRolling30d) : `$${per30Days.trim()}`,
            rent === null ? "some" : formatSol(rent),
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Fact label={INVEST_COPY.basket}>{OFFERED_LEGS.map((leg, index) => `${leg.symbol} · ${ratePercent(weights[index]!)}`).join(", ")}</Fact>
          <Fact label={INVEST_COPY.rule}>{INVEST_COPY.buysEach(formatUsd(DEFAULT_PURCHASE_USDC_RAW))}</Fact>
        </dl>

        <div className="grid gap-3 sm:grid-cols-2">
          <CapField id="invest-max-per-call" label={INVEST_COPY.mostPerBuy} value={perBuy} onChange={setPerBuy} disabled={blocked} />
          <CapField id="invest-max-rolling" label={INVEST_COPY.mostPer30Days} value={per30Days} onChange={setPer30Days} disabled={blocked} />
        </div>
        {!caps.ok ? (
          <p role="alert" className="text-xs text-destructive">
            {caps.message}
          </p>
        ) : caps.maxPerCall > 1_000_000_000n ? (
          <p className="text-xs text-destructive">{INVEST_COPY.convertWarning}</p>
        ) : null}

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
            </>
          )}
        </div>

        <p className="text-xs">{rent === null ? VAULT_COPY.costUnknown : VAULT_COPY.cost(formatSol(rent), formatSol(fees))}</p>

        <div className="space-y-2 rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs">
          <p>{INVEST_COPY.freezeNotice}</p>
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
          disabled={!canSignPolicy({ acknowledged, capsOk: caps.ok, blocked })}
          aria-busy={write.running}
          onClick={() => {
            if (caps.ok && acknowledged) start({ maxPerCall: caps.maxPerCall, maxRolling30d: caps.maxRolling30d, enabled: true });
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
