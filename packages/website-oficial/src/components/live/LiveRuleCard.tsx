"use client";

/**
 * THE RULE, AS THE CHAIN HOLDS IT — and it is READ-ONLY on purpose.
 *
 * The mock's panel has a rate slider, a threshold box, target weights, a pause
 * switch and an "Update rule" button, and every one of them is a local useState
 * that changes nothing. On a live pension that is worse than useless: a control
 * that appears to set someone's savings rate and silently does not is a lie
 * about their money. Changing the rule is a signed set_policy_v2, which this
 * branch deliberately does NOT build — so the controls are gone rather than
 * inert, and the one button here opens the modal where the verified flows live.
 *
 * WHAT IS NOT SET UP IS SAID, NOT ZEROED. No policy reads "Investing is not set
 * up", never "$0 of $5"; a policy that could not be read says so and is never
 * treated as missing.
 */

import { LiveActivityRow } from "@/components/live/LiveActivityRow";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { formatSol, formatUsd } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard, LiveRow } from "@/lib/live-types";
import { cn } from "@/lib/utils";
import { INVEST_COPY, ratePercent } from "@/lib/vault-copy";

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className={LABEL}>{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function LiveRuleCard({
  data,
  labelOf,
  onOpenWallets,
  className,
}: {
  readonly data: LiveDashboard;
  readonly labelOf: (wallet: string | null) => string;
  readonly onOpenWallets: () => void;
  readonly className?: string;
}) {
  const { vault, policy, rows } = data;
  const rate = vault.rateBps === null ? null : ratePercent(vault.rateBps);
  const modeLabel = rate === null ? LIVE_COPY.unknownFigure : vault.mode === 1 ? LIVE_COPY.modeVolume(rate) : LIVE_COPY.modeProfit(rate);
  const lastInvested: LiveRow | undefined = rows.find((row) => row.event.kind === "invested");
  const readiness = policy.readiness;
  // A floor the market has passed: buying waits until the owner signs again.
  const floorPassed = policy.pricesKnown && !policy.belowMarket;

  return (
    <Card className={cn("h-fit", className)}>
      <CardHeader>
        <CardTitle>{LIVE_COPY.ruleTitle}</CardTitle>
        <CardDescription>{LIVE_COPY.ruleDescription}</CardDescription>
        {vault.paused === true ? (
          <CardAction>
            <Badge variant="destructive">{LIVE_COPY.vaultPausedBadge}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── the vault's own rule ─────────────────────────────────────────── */}
        <dl className="space-y-3">
          <Fact label={LIVE_COPY.mode}>
            <Num>{modeLabel}</Num>
          </Fact>
          {vault.maxContribution === null ? null : <p className="text-sm text-muted-foreground">{LIVE_COPY.mostPerSettlement(formatSol(vault.maxContribution))}</p>}
          {vault.walletReserve === null ? null : <p className="text-sm text-muted-foreground">{LIVE_COPY.alwaysLeft(formatSol(vault.walletReserve))}</p>}
        </dl>

        {vault.paused === true ? <p className="text-sm text-muted-foreground">{LIVE_COPY.vaultPaused}</p> : null}
        {vault.volumeNotOffered ? <p className="text-sm text-amber-700 dark:text-amber-400">{LIVE_COPY.volumeNotOffered}</p> : null}

        <Separator />

        {/* ── investing ────────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className={LABEL}>{LIVE_COPY.investingSection}</p>
            {floorPassed ? <Badge variant="destructive">{LIVE_COPY.buyingWaits}</Badge> : null}
          </div>

          {policy.status === "unreadable" ? (
            <p role="status" className="text-sm text-muted-foreground">
              {LIVE_COPY.policyUnreadable}
            </p>
          ) : policy.status !== "exists" ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{LIVE_COPY.investingNotSetUp}</p>
              <Button type="button" size="sm" onClick={onOpenWallets}>
                {LIVE_COPY.setUpInvesting}
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{policy.enabled === false ? LIVE_COPY.investingPausedNote : INVEST_COPY.enabled}</p>
              {policy.enabled === false ? (
                <Button type="button" size="sm" variant="outline" onClick={onOpenWallets}>
                  {LIVE_COPY.resumeInvesting}
                </Button>
              ) : null}

              <dl className="grid grid-cols-2 gap-3">
                <Fact label={INVEST_COPY.basket}>
                  <Num>{policy.legs.map((leg) => `${leg.symbol} · ${ratePercent(leg.weightBps)}`).join(", ")}</Num>
                </Fact>
                {policy.minInvestment === null ? null : <Fact label={INVEST_COPY.rule}>{INVEST_COPY.buysEach(formatUsd(policy.minInvestment))}</Fact>}
                {policy.maxPerCall === null ? null : (
                  <Fact label={INVEST_COPY.mostPerBuy}>
                    <Num>{formatUsd(policy.maxPerCall)}</Num>
                  </Fact>
                )}
                {policy.maxRolling30d === null ? null : (
                  <Fact label={INVEST_COPY.mostPer30Days}>
                    <Num>{formatUsd(policy.maxRolling30d)}</Num>
                  </Fact>
                )}
                {policy.usedLast30d === null ? null : (
                  <Fact label={INVEST_COPY.usedLast30}>
                    <Num>{formatUsd(policy.usedLast30d)}</Num>
                  </Fact>
                )}
              </dl>

              <div className="space-y-1 text-xs text-muted-foreground">
                {policy.storedSolFloorPerSol === null ? null : (
                  <p>{INVEST_COPY.storedSolFloor(formatUsd(policy.storedSolFloorPerSol), policy.todayPerSol === null ? null : formatUsd(policy.todayPerSol))}</p>
                )}
                {policy.legs.map((leg) =>
                  leg.storedCeilingPer1e8 === null ? null : (
                    <p key={leg.mint}>{INVEST_COPY.storedLegCeiling(leg.symbol, formatUsd(leg.storedCeilingPer1e8), leg.todayPer1e8 === null ? null : formatUsd(leg.todayPer1e8))}</p>
                  ),
                )}
              </div>

              {floorPassed ? <p className="text-xs text-destructive">{LIVE_COPY.floorPassed}</p> : null}
            </div>
          )}
        </div>

        {/* ── what happens next, and what happened last ────────────────────── */}
        {policy.status === "exists" && policy.enabled !== false && readiness !== null ? (
          <div className="space-y-2">
            <p className={LABEL}>{LIVE_COPY.nextInvestment}</p>
            <p className="text-sm">
              {readiness.state === "ready" ? INVEST_COPY.ready : readiness.state === "waiting" ? INVEST_COPY.waiting(formatUsd(readiness.investsAtRaw)) : INVEST_COPY.unreachable}
            </p>
            {readiness.investsAtRaw > 0n ? (
              <Progress
                value={Math.min(100, Number((readiness.heldRaw * 100n) / readiness.investsAtRaw))}
                aria-label={LIVE_COPY.progressLabel}
              />
            ) : null}
            {vault.withdrawable === null ? null : <p className="text-xs text-muted-foreground">{LIVE_COPY.solWaitingToConvert(formatSol(vault.withdrawable))}</p>}
          </div>
        ) : null}

        {policy.status === "exists" ? (
          <div className="space-y-2">
            <p className={LABEL}>{LIVE_COPY.lastInvestment}</p>
            {lastInvested === undefined ? (
              <p className="text-sm text-muted-foreground">{LIVE_COPY.noInvestmentLoaded}</p>
            ) : (
              <div className="rounded-md border">
                <LiveActivityRow row={lastInvested} labelOf={labelOf} maxContribution={vault.maxContribution} />
              </div>
            )}
          </div>
        ) : null}

        <Button type="button" variant="outline" className="w-full" onClick={onOpenWallets}>
          {LIVE_COPY.manageInWallets}
        </Button>
      </CardContent>
    </Card>
  );
}
