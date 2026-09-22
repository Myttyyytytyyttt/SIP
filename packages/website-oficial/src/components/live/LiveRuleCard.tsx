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
 *
 * IT WEARS THE SAMPLE'S CLOTHES ALL THE SAME. A rate with a bar under it, a
 * basket listed with its marks and its weights — the shape the sample uses,
 * with the chain's numbers and none of its controls. The gear in the corner is
 * where every change goes, and it opens the modal that signs one.
 *
 * THE BAR'S TRACK IS THE MODE'S OWN RANGE, which is what makes it mean
 * anything: the program allows a profit rate up to 100 % and a volume rate up
 * to 2 %, so the same 2 % is a sliver of one track and the whole of the other.
 * Its far end is printed under it — a bar with no scale is a fraction of
 * nothing.
 *
 * NO THRESHOLD FIGURE UP HERE. The policy's min_investment is enforced PER LEG,
 * not on the pile, so a basket of two at $5 does not buy at $5; "Next
 * investment" below reads investsAtRaw, which is the balance that actually
 * unblocks a buy, and one threshold on a card is the most it can have without
 * disagreeing with itself.
 */

import { Settings } from "lucide-react";

import { PROFIT_BPS_MAX, VOLUME_BPS_MAX } from "@sip/solana-core/client";

import { AssetMark } from "@/components/live/AssetMark";
import { LiveActivityRow } from "@/components/live/LiveActivityRow";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { formatSol, formatUsd } from "@/lib/amounts";
import { LABEL, MONO } from "@/lib/classes";
import { pct } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
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
  const volume = vault.mode === 1;
  const rate = vault.rateBps === null ? null : pct(vault.rateBps);
  const measure = volume ? ACTIVITY_COPY.measureVolume : ACTIVITY_COPY.measureProfit;
  // The track is what the PROGRAM allows this mode, so the same 2 % is a
  // sliver of a profit track and the whole of a volume one.
  const rateMax = volume ? VOLUME_BPS_MAX : PROFIT_BPS_MAX;
  const lastInvested: LiveRow | undefined = rows.find((row) => row.event.kind === "invested");
  const readiness = policy.readiness;
  // A floor the market has passed: buying waits until the owner signs again.
  const floorPassed = policy.pricesKnown && !policy.belowMarket;

  return (
    <Card className={cn("h-fit", className)}>
      <CardHeader>
        <CardTitle>{LIVE_COPY.ruleTitle}</CardTitle>
        <CardDescription>{LIVE_COPY.ruleDescription}</CardDescription>
        <CardAction className="flex items-center gap-2">
          {vault.paused === true ? <Badge variant="destructive">{LIVE_COPY.vaultPausedBadge}</Badge> : null}
          {/* Every change to any of this is a signed transaction, and they all
              live in one modal. The gear is the door; nothing on this card
              pretends to be a control.

              Its name is an aria-label and a title rather than a Tooltip: one
              icon does not need a provider mounted above it, and a Tooltip's
              trigger composes the click handler, which put `window` inside a
              path the server render walks. */}
          <Button type="button" variant="ghost" size="icon" aria-label={LIVE_COPY.ruleSettings} title={LIVE_COPY.ruleSettings} onClick={onOpenWallets}>
            <Settings aria-hidden />
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── the rate, with the track its own mode allows ──────────────────── */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{LIVE_COPY.rateOf(measure)}</p>
            <Num className="text-sm font-medium">{rate ?? LIVE_COPY.unknownFigure}</Num>
          </div>
          {vault.rateBps === null ? null : (
            <>
              <Progress value={Math.min(100, (vault.rateBps * 100) / rateMax)} aria-label={LIVE_COPY.rateOf(measure)} />
              <div className={cn("flex justify-between text-xs text-muted-foreground", MONO)}>
                <span>{LIVE_COPY.rateFloor}</span>
                <span>{pct(rateMax)}</span>
              </div>
            </>
          )}
          {vault.maxContribution === null ? null : <p className="pt-1 text-sm text-muted-foreground">{LIVE_COPY.mostPerSettlement(formatSol(vault.maxContribution))}</p>}
          {vault.walletReserve === null ? null : <p className="text-sm text-muted-foreground">{LIVE_COPY.alwaysLeft(formatSol(vault.walletReserve))}</p>}
        </div>

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

              {/* THE BASKET, AS A LIST WITH ITS MARKS — the sample's shape. A
                  leg with no artwork draws its lettered disc, which is how a
                  new leg can be listed the day the policy names it. */}
              {policy.legs.length === 0 ? null : (
                <div className="space-y-2">
                  <p className={LABEL}>{LIVE_COPY.investsIn}</p>
                  <ul className="space-y-1.5">
                    {policy.legs.map((leg) => (
                      <li key={leg.mint} className="flex items-center gap-2 text-sm">
                        <AssetMark symbol={leg.symbol} mint={leg.mint} size={20} />
                        <span className="min-w-0 flex-1 truncate">{leg.symbol}</span>
                        <Num className="text-sm">{pct(leg.weightBps)}</Num>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-3">
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

      </CardContent>
    </Card>
  );
}
