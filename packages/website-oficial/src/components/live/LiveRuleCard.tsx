"use client";

/**
 * THE RULE, AS THE CHAIN HOLDS IT — in the sample's own clothes, READ-ONLY.
 *
 * IT IS THE SAMPLE'S PANEL, WIRED. savings-rule-panel.tsx's layout and its
 * words are taken as they stand: the rate with a bar under it, "Invests in" as
 * a list of marks and weights, a rule across the card, then "Next investment"
 * and "Last investment" at the foot. What the sample says that this cannot
 * source is left out rather than faked, and what the chain says that the sample
 * has no concept of is kept only where a figure would be misread without it.
 *
 * NONE OF ITS CONTROLS CAME WITH IT. The sample's slider, presets, threshold
 * box, pause switch and "Update rule" are local useState that change nothing.
 * On a live pension a control that appears to set someone's savings rate and
 * silently does not is a lie about their money. Changing the rule is a signed
 * set_policy_v2, which this branch deliberately does NOT build — so the
 * controls are gone rather than inert, and the gear in the corner opens the
 * modal where the verified flows live. LiveRuleCard.test.ts holds that.
 *
 * WHAT IS NOT SET UP IS SAID, NOT ZEROED. No policy reads "Investing is not set
 * up", never "$0 of $5"; a policy that could not be read says so and is never
 * treated as missing.
 *
 * THE BAR'S TRACK IS THE MODE'S OWN RANGE, which is what makes it mean
 * anything: the program allows a profit rate up to 100 % and a volume rate up
 * to 2 %, so the same 2 % is a sliver of one track and the whole of the other.
 * Its far end is printed under it — a bar with no scale is a fraction of
 * nothing.
 *
 * NO THRESHOLD FIGURE UP HERE. The policy's min_investment is enforced PER LEG,
 * not on the pile, so a basket of two at $5 does not buy at $5; "Next
 * investment" reads investsAtRaw, which is the balance that actually unblocks a
 * buy, and one threshold on a card is the most it can have without disagreeing
 * with itself. The sample's "$X of $Y" is what prints it.
 *
 * WHAT WAS CUT, AND WHY EACH WAS FILLER: the description under the title
 * restated where the rule came from; "Investing is on." restated the block it
 * sat in and the figures under it; the "Investing" heading labelled a block
 * whose every other state already names itself in its first three words. The
 * signed price limits are neither filler nor glanceable — two dense lines
 * nobody reads at rest and everybody needs the day buying stops — so they sit
 * behind a <details> instead of in the rhythm.
 */

import { Settings } from "lucide-react";

import { PROFIT_BPS_MAX, VOLUME_BPS_MAX } from "@sip/solana-core/client";

import { AssetMark } from "@/components/live/AssetMark";
import { LiveActivityRow } from "@/components/live/LiveActivityRow";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { formatSol, formatUsd } from "@/lib/amounts";
import { LABEL, MONO } from "@/lib/classes";
import { pct } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard, LiveRow } from "@/lib/live-types";
import { cn } from "@/lib/utils";
import { INVEST_COPY } from "@/lib/vault-copy";

/**
 * The sample's own heading class, written out rather than imported: over there
 * it comes from <Label>, which names a control, and this card has none to name.
 */
const HEADING = "text-sm leading-none font-medium";

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
  // Either of these means no buy is coming, whatever the pile says.
  const stopped = vault.paused === true || floorPassed;
  // `unreachable` is a threshold the caps can never reach, so it gets no bar.
  const reachable = readiness !== null && readiness.state !== "unreachable" && readiness.investsAtRaw > 0n;
  const storedLimits = policy.storedSolFloorPerSol !== null || policy.legs.some((leg) => leg.storedCeilingPer1e8 !== null);

  return (
    <Card className={cn("h-fit", className)}>
      <CardHeader>
        <CardTitle>{LIVE_COPY.ruleTitle}</CardTitle>
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
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            {/* WHICH of the vault's two rates this is, folded into the label:
                the vault carries a profit rate and a volume rate and settles by
                one of them, so a bare "Rate" would be the wrong number half the
                time rather than a shorter way of saying the right one. */}
            <p className={HEADING}>{LIVE_COPY.rateOf(measure)}</p>
            <Num className="text-sm">{rate ?? LIVE_COPY.unknownFigure}</Num>
          </div>
          {vault.rateBps === null ? null : (
            <div className="space-y-1.5">
              <Progress value={Math.min(100, (vault.rateBps * 100) / rateMax)} aria-label={LIVE_COPY.rateOf(measure)} />
              <div className={cn("flex justify-between text-xs text-muted-foreground", MONO)}>
                <span>{LIVE_COPY.rateFloor}</span>
                <span>{pct(rateMax)}</span>
              </div>
            </div>
          )}
          {/* The two limits the rate is applied under. Both qualify the figure
              above — the cap is not carried over, the reserve never leaves the
              trading wallet — so they sit under it, quietly, rather than as
              rows of their own. */}
          {vault.maxContribution === null && vault.walletReserve === null ? null : (
            <div className="space-y-1 text-xs text-muted-foreground">
              {vault.maxContribution === null ? null : <p>{LIVE_COPY.mostPerSettlement(formatSol(vault.maxContribution))}</p>}
              {vault.walletReserve === null ? null : <p>{LIVE_COPY.alwaysLeft(formatSol(vault.walletReserve))}</p>}
            </div>
          )}
        </div>

        {vault.paused === true ? <p className="text-sm text-muted-foreground">{LIVE_COPY.vaultPaused}</p> : null}
        {vault.volumeNotOffered ? <p className="text-sm text-amber-700 dark:text-amber-400">{LIVE_COPY.volumeNotOffered}</p> : null}

        {/* ── what it buys, and under which caps ────────────────────────────── */}
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
          <div className="space-y-4">
            {policy.enabled === false ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{LIVE_COPY.investingPausedNote}</p>
                <Button type="button" size="sm" variant="outline" onClick={onOpenWallets}>
                  {LIVE_COPY.resumeInvesting}
                </Button>
              </div>
            ) : null}

            {/* WHAT THIS BLOCK IS, said once, and ONLY where nothing else says
                it. Every not-set-up state below opens with the word itself
                ("Investing is not set up", "Investing is paused"), so a heading
                over those is the label repeating its own sentence. The enabled
                state has no such sentence — and with an empty basket it went
                straight from the savings rate into three dollar caps, which
                read as limits on what is SAVED. */}
            {policy.enabled !== false ? <p className={HEADING}>{LIVE_COPY.investingSection}</p> : null}

            {/* THE BASKET, AS A LIST WITH ITS MARKS — the sample's own list, its
                <Image src={tickerLogo(...)}> slot taken by the mark the mint
                decides. A leg with no artwork draws its lettered disc, which is
                how a new leg can be listed the day the policy names it. */}
            {policy.legs.length === 0 ? null : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className={HEADING}>{LIVE_COPY.investsIn}</p>
                  {floorPassed ? <Badge variant="destructive">{LIVE_COPY.buyingWaits}</Badge> : null}
                </div>
                <ul className="space-y-1.5">
                  {policy.legs.map((leg) => (
                    <li key={leg.mint} className="flex items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <AssetMark symbol={leg.symbol} mint={leg.mint} size={20} />
                        <span className="truncate">{leg.symbol}</span>
                      </span>
                      {/* Not the sample's pct(bps, 0): its targets are round and
                          a chain's are not, and a third of a basket printed as
                          "33%" three times is somebody's weights not adding up. */}
                      <Num>{pct(leg.weightBps)}</Num>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* THE TWO CAPS, AND NOT WHAT HAS BEEN SPENT AGAINST THEM. This
                card is what was SIGNED; "used in the last 30 days" is a moving
                figure and it already has a tile of its own, where it is printed
                over the cap it is a fraction of. Here it had neither its
                denominator nor a window anyone could see, and the same number
                in two places is a number two places can come to disagree
                about — which is why Today left the stats grid for the header. */}
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
            </dl>

            {/* The signed limits: two dense lines that are the whole answer the
                day buying stops, and noise on every other day. Folded shut, not
                dropped — a limit somebody signed has to stay checkable. */}
            {storedLimits ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{LIVE_COPY.signedPriceLimits}</summary>
                <div className="mt-2 space-y-1">
                  {policy.storedSolFloorPerSol === null ? null : (
                    <p>{INVEST_COPY.storedSolFloor(formatUsd(policy.storedSolFloorPerSol), policy.todayPerSol === null ? null : formatUsd(policy.todayPerSol))}</p>
                  )}
                  {policy.legs.map((leg) =>
                    leg.storedCeilingPer1e8 === null ? null : (
                      <p key={leg.mint}>{INVEST_COPY.storedLegCeiling(leg.symbol, formatUsd(leg.storedCeilingPer1e8), leg.todayPer1e8 === null ? null : formatUsd(leg.todayPer1e8))}</p>
                    ),
                  )}
                </div>
              </details>
            ) : null}

            {floorPassed ? <p className="text-xs text-destructive">{LIVE_COPY.floorPassed}</p> : null}
          </div>
        )}

        {/* The sample's one rule across the card, and it only earns its place
            where something follows it: both blocks below are a policy's, and a
            vault without one would end on a hairline over nothing. */}
        {policy.status === "exists" ? <Separator /> : null}

        {/* ── what happens next, and what happened last ─────────────────────── */}
        {policy.status === "exists" && policy.enabled !== false && readiness !== null ? (
          <div className="space-y-2">
            {/*
              A PROGRESS PAIR IS A PROMISE THAT FILLING IT BUYS SOMETHING, so
              `unreachable` gets the sentence alone and no figures. There the
              threshold is one the caps can NEVER reach — min_investment applies
              per leg while max_per_call caps the call — and drawing "$500.00 of
              $5.00" with a full bar over it read as "target met" for a basket
              that cannot be bought. investsAtRaw is always above zero, so the
              old guard on it never caught this.

              AND NOTHING IS ABOUT TO BUY WHILE BUYING IS STOPPED. A paused
              vault and a passed price floor each already say so on this card;
              a full bar and "the next sweep can buy" underneath them was the
              card contradicting itself twice over.
            */}
            <div className="flex items-center justify-between gap-2">
              <p className={LABEL}>{LIVE_COPY.nextInvestment}</p>
              {reachable ? (
                <p className={cn(MONO, "text-sm")}>
                  {formatUsd(readiness.heldRaw)} <span className="text-muted-foreground">of</span> {formatUsd(readiness.investsAtRaw)}
                </p>
              ) : null}
            </div>
            {reachable ? (
              <Progress
                value={Math.min(100, Number((readiness.heldRaw * 100n) / readiness.investsAtRaw))}
                aria-label={LIVE_COPY.progressLabel}
              />
            ) : null}
            {/* `waiting` says nothing here: the figures and the bar above ARE
                the wait, and the sentence for it repeats the threshold beside
                them. The other two states carry a fact no number does — that a
                sweep is what buys, and that these caps never can. */}
            {readiness.state === "unreachable" ? (
              <p className="text-xs text-destructive">{INVEST_COPY.unreachable}</p>
            ) : readiness.state === "ready" && !stopped ? (
              <p className="text-xs text-muted-foreground">{INVEST_COPY.ready}</p>
            ) : null}
            {/* Nothing converts while the rule is paused. */}
            {vault.withdrawable === null || vault.paused === true ? null : (
              <p className="text-xs text-muted-foreground">{LIVE_COPY.solWaitingToConvert(formatSol(vault.withdrawable))}</p>
            )}
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
