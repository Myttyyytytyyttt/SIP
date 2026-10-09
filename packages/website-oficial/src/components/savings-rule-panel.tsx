"use client";

import Image from "next/image";
import { Settings } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { WASH_HOST, Wash } from "@/components/live/Wash";
import { WorkMark } from "@/components/live/WorkMark";
import { Num } from "@/components/num";
import { RuleSettingsDialog, RuleSettingsForm, type SettingsJudgement } from "@/components/rule-settings-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LABEL, MONO } from "@/lib/classes";
import { pct, relativeDayLabel, shares, shortHex, timeAgo, usd } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import { shareTotal, thresholdUsdOf, type RuleMode, type SettingsCategory, type SettingsDraft } from "@/lib/rule-settings";
import { SETTINGS_COPY } from "@/lib/settings-copy";
import { cn } from "@/lib/utils";
// The leaf, not the barrel: `@/mocks` also re-exports the seeded dataset, and this file ships to the browser.
import { tickerLogo, type ActivityEvent, type InvestedEvent, type SavingsRule, type SavingsStats, type SavingsTarget } from "@/mocks/types";

/*
 * THE CARD SHOWS THE RULE; THE GEAR CHANGES IT (owner, 09-25).
 *
 * Every control that changes the vault — how it saves (mode, rate, pause) and
 * what it buys (the assets by category, their shares, the threshold) — lives
 * behind the gear in the card's corner, in one dialog (rule-settings-dialog.tsx)
 * with a "?" beside each title. The card itself is read-only: the rate, what the
 * savings buy, and what the pension is about to do next.
 *
 * ONE CARD, TWO HOSTS. A live page passes `settings` — its own dialog signs
 * (live/LiveRulePanel.tsx). The sample passes nothing, and the card hosts the
 * same dialog over local state: Save moves what this page shows, and nothing
 * else. Nothing the sample can show says "sign" (savings-rule-panel.test.ts).
 */

/** What a live page hands the card: the gear's state, and whether the vault needs its owner. */
export interface RuleSettingsDoor {
  readonly open: boolean;
  readonly onOpen: () => void;
  /** Something behind the gear needs doing (old price limits to switch from, a write to confirm): a dot on the gear. */
  readonly attention: boolean;
}

/** The sample's shelf, in the sample's own tickers: what its dialog can pick from. */
const SAMPLE_CATEGORIES: readonly SettingsCategory[] = [
  { id: "index", title: SETTINGS_COPY.categories.index, help: SETTINGS_COPY.help.index, assets: [{ id: "INDEX", symbol: "INDEX", name: "Total market index" }], unavailable: [] },
  {
    id: "xstock",
    title: SETTINGS_COPY.categories.xstock,
    help: SETTINGS_COPY.help.xstock,
    assets: [
      { id: "SPYx", symbol: "SPYx", name: "S&P 500" },
      { id: "GLDx", symbol: "GLDx", name: "Gold" },
    ],
    unavailable: [],
  },
];
/** The most assets the sample's basket holds; the live shelf's own limit is the same five. */
const SAMPLE_MAX_LEGS = 5;

/**
 * How full the Next investment bar may draw while a gate holds the buy
 * (SavingsStats.nextInvestmentGate). Short of 100 by enough to be seen: at the
 * card's width a 99 % bar reads as full.
 */
const GATED_PROGRESS_MAX = 95;

/**
 * THE NEXT INVESTMENT BLOCK'S FIGURES, as the card works them out — the
 * sample's own arithmetic, or a live page's figures and gate — handed to a
 * live caller that draws the block itself (`renderNextInvestment`): a mark
 * beside the label, the parts as segments of the bar, the line as a waiting
 * note. Everything a drawing needs is here, so it does no arithmetic of its own.
 */
export interface NextInvestmentView {
  /** What counts toward the threshold, in dollars. Null when unknown: then no bar is drawn, never an empty one. */
  readonly readyUsd: number | null;
  readonly thresholdUsd: number | null;
  /** The bar's fill, 0–100, already held short of full while a gate holds the buy; null when no bar is drawn. */
  readonly progress: number | null;
  /** What is still to go, in dollars, and whether the card prints it as "$0.61 to go". */
  readonly toGoUsd: number | null;
  readonly toGoShown: boolean;
  /** The line under the bar, verbatim (SavingsStats.nextInvestmentNote). */
  readonly note: string | null;
  /** Why the keeper will not buy on the bar (SavingsStats.nextInvestmentGate); null for none, or on the sample. */
  readonly gate: NonNullable<SavingsStats["nextInvestmentGate"]> | null;
  /** What the figure is made of (SavingsStats.nextInvestmentParts); null when unknown, or on the sample. */
  readonly parts: NonNullable<SavingsStats["nextInvestmentParts"]> | null;
}

/**
 * WHAT A LIVE PAGE HAS JUST SEEN MOVE ON THIS CARD (10-09, plan B1), outside
 * the Next investment block, which it draws itself (`renderNextInvestment`):
 *
 *   a buy under way   its words and a blue turning mark beside "Last
 *                     investment", in the label's own 16 px line, so the card
 *                     does not grow when it starts or shrink when it lands;
 *   a buy arrived     the last investment's block washes blue (Wash.tsx) —
 *                     when it IS the transaction that just arrived;
 *   a rule change     the rate's line washes mustard, once it has landed.
 *
 * Every piece is keyed on the prop being there: the sample never passes it,
 * and keeps its label, its rate line and its block byte for byte
 * (sample-golden.test.ts).
 */
export interface RulePanelPulse {
  /** A buy under way, in the step's own words ("Buying SPYx and ANTHROPIC…"); null when none is. */
  readonly buying: { readonly text: string; readonly still: boolean } | null;
  /** The transactions just arrived, by signature (use-arrivals.ts). */
  readonly arrived: ReadonlySet<string>;
  /** A rule change that landed is among them. */
  readonly ruleArrived: boolean;
}

/** The rate's line, and the last investment's block: the sample's exact strings, so its markup cannot drift when a live page washes them. */
const RATE_LINE = "flex items-center justify-between gap-2";
const LAST_BUY = "flex w-full items-center gap-3 rounded-md border p-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** What the sample's dialog edits, kept by the card. */
interface SampleRule {
  readonly mode: RuleMode;
  readonly rateBps: number;
  readonly paused: boolean;
  readonly thresholdUsd: number | null;
  readonly targets: readonly SavingsTarget[];
}

const draftOf = (sample: SampleRule): SettingsDraft => ({
  mode: sample.mode,
  rateBps: sample.rateBps,
  paused: sample.paused,
  picked: sample.targets.map((target) => ({ id: target.symbol, percent: String(Math.round(target.weightBps / 100)) })),
  threshold: sample.thresholdUsd === null ? "" : String(sample.thresholdUsd),
});

/** The sample's own verdict on a draft: what changed, and why it cannot be kept. Nothing is ever approved. */
function judgeSample(sample: SampleRule, draft: SettingsDraft): SettingsJudgement {
  const opened = draftOf(sample);
  const rule = draft.mode !== opened.mode || draft.rateBps !== opened.rateBps || draft.paused !== opened.paused;
  const picks = (d: SettingsDraft): string => d.picked.map((pick) => `${pick.id}:${pick.percent.trim()}`).join(",");
  const buying = picks(draft) !== picks(opened) || draft.threshold.trim() !== opened.threshold.trim();
  const total = shareTotal(draft.picked);
  const problem =
    draft.picked.length > 0 && total !== 100
      ? { section: "buying" as const, message: SETTINGS_COPY.sharesTotal(total) }
      : thresholdUsdOf(draft.threshold) === null || thresholdUsdOf(draft.threshold)! < 1
        ? { section: "buying" as const, message: SETTINGS_COPY.thresholdTooSmall("$1") }
        : null;
  return { changes: { rule, buying }, problem, notices: [], acknowledge: null, approvals: 0 };
}

export function SavingsRulePanel({
  rule,
  stats,
  activity,
  now,
  settings,
  renderNextInvestment,
  pulse,
  className,
}: {
  rule: SavingsRule;
  stats: SavingsStats;
  activity: readonly ActivityEvent[];
  now: string;
  /** A live page: its gear opens a dialog that signs. Absent on the sample, whose own dialog moves local state. */
  settings?: RuleSettingsDoor;
  /**
   * A LIVE PAGE'S OWN DRAWING OF THE NEXT INVESTMENT BLOCK, from the figures
   * the card worked out (NextInvestmentView): what it returns stands in the
   * block's place, under the same spacing. Absent on the sample, which keeps
   * today's label, bar and lines character for character.
   */
  renderNextInvestment?: (next: NextInvestmentView) => ReactNode;
  /** What a live page has just seen move on the card (RulePanelPulse). Absent on the sample. */
  pulse?: RulePanelPulse;
  className?: string;
}) {
  // THE SAMPLE'S RULE, as its dialog last saved it. Unused on a live page, whose rule is the chain's.
  const [sample, setSample] = useState<SampleRule>(() => ({
    mode: rule.mode ?? "volume",
    rateBps: rule.rateBps,
    paused: rule.paused,
    thresholdUsd: rule.thresholdUsd,
    targets: rule.targets,
  }));
  const [sampleOpen, setSampleOpen] = useState(false);
  const judge = useCallback((draft: SettingsDraft) => judgeSample(sample, draft), [sample]);

  const live = settings !== undefined;
  const mode: RuleMode = live ? (rule.mode === "volume" ? "volume" : "profit") : sample.mode;
  const rateBps = live ? rule.rateBps : sample.rateBps;
  const paused = live ? rule.paused : sample.paused;
  const targets = live ? rule.targets : sample.targets;
  const targetsNote = live ? (rule.targetsNote ?? null) : null;
  const thresholdUsd = live ? stats.thresholdUsd : sample.thresholdUsd;

  const lastInvestment = activity.find((event): event is InvestedEvent => event.kind === "invested");
  // What counts toward the threshold: the sample's pending pile, or — on a live
  // vault — everything not invested the keeper will use: the USDC, the SOL
  // being converted to it, and the SOL waiting under the keeper's wrap line.
  const ready = stats.readyToInvestUsd === undefined ? stats.pendingUsd : stats.readyToInvestUsd;
  // What the rate is taken from, in the vault's own words.
  const appliedTo = mode === "profit" ? "Applied to your realised trading gains" : "Applied to every buy and sell";
  /*
   * THE SAMPLE KEEPS ITS OWN ARITHMETIC, character for character: with no
   * `toGoUsd` (the sample never sets it) both figures are today's formulas, so
   * not even a float's last digit can move the landing's bar.
   *
   * A LIVE PAGE'S "TO GO" IS THE KEEPER'S (live-pending.ts toGoOf). While a
   * gate holds the buy — the wrap line, a conversion overdue or one enough
   * only at today's price, a rest the page can read — the bar stops short of
   * full, and dollars to go are printed only where they are
   * the headline's own difference: "$1.19 of $1.00 · $0.11 to go" would argue
   * with itself, and "$0.00 to go" would promise a buy that is not coming. The
   * note under the bar says what is left instead.
   */
  const gate = stats.nextInvestmentGate ?? null;
  /*
   * A FIGURE NOBODY COULD MAKE DRAWS NO BAR (review 2026-10-09). A live page's
   * figure is null when an input it is made of could not be read; an empty
   * bar under "— of $1.00" read as nothing saved, and "— to go" as nothing
   * left. The headline keeps its dash and the line under it says why. Only a
   * live page sets the figure to null: the sample's is undefined, and draws
   * exactly what it always drew.
   *
   * NOR DOES A THRESHOLD NOBODY CAN REACH (review 2026-10-09). A live basket
   * the caps can never buy has no threshold (live-mock.ts: null) and nothing
   * to go, while its figure is known: "$0.80 of —" drew an empty bar under it
   * and "— to go" beside it — the very misreading above, from the other side.
   * The headline keeps the figure and the dash; no bar, no "to go". A live
   * page is told apart by `toGoUsd`, which only it sets.
   */
  const figureUnknown = stats.readyToInvestUsd === null;
  const nothingToMeasure = stats.toGoUsd !== undefined && (thresholdUsd === null || thresholdUsd <= 0);
  const fill =
    stats.toGoUsd === undefined
      ? ready !== null && thresholdUsd !== null && thresholdUsd > 0
        ? Math.min(100, (ready / thresholdUsd) * 100)
        : 0
      : ready !== null && thresholdUsd !== null && thresholdUsd > 0
        ? Math.min(gate === null ? 100 : GATED_PROGRESS_MAX, (ready / thresholdUsd) * 100)
        : 0;
  const progress = figureUnknown || nothingToMeasure ? null : fill;
  const toGo = stats.toGoUsd === undefined ? (ready !== null && thresholdUsd !== null ? Math.max(0, thresholdUsd - ready) : null) : stats.toGoUsd;
  const toGoShown =
    !figureUnknown &&
    // A live "to go" nobody could make is not printed as "— to go"; the sample's arithmetic is untouched.
    (stats.toGoUsd === undefined || toGo !== null) &&
    (gate === null ||
      (toGo !== null && ready !== null && thresholdUsd !== null && usd(toGo) !== usd(0) && usd(toGo) === usd(Math.max(0, thresholdUsd - ready))));
  const nextView: NextInvestmentView = {
    readyUsd: ready,
    thresholdUsd,
    progress,
    toGoUsd: toGo,
    toGoShown,
    note: stats.nextInvestmentNote ?? null,
    gate,
    parts: stats.nextInvestmentParts ?? null,
  };

  const open = live ? settings.open : sampleOpen;
  const attention = live && settings.attention;
  // Washed only while a live page says so: never on the sample, which passes no pulse.
  const ruleWashed = pulse?.ruleArrived === true;
  const lastWashed = pulse !== undefined && lastInvestment !== undefined && pulse.arrived.has(lastInvestment.txHash);

  return (
    // The same desktop spacing as the pension card beside it, and one step
    // tighter again on a short screen: this card is the taller of the two on a
    // 13" laptop, so its padding decides whether the page needs a scroll.
    <Card className={cn("h-fit xl:[--card-spacing:--spacing(3)]", className)}>
      <CardHeader>
        <CardTitle>Savings rule</CardTitle>
        <CardDescription>{appliedTo}</CardDescription>
        <CardAction>
          {/*
            THE GEAR. Muted at rest; mustard — the colour of a setting — on
            hover and while its dialog is open, and a mustard dot when something
            behind it needs the owner (old price limits to switch from, a write to confirm).
          */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={attention ? SETTINGS_COPY.gearAttention : SETTINGS_COPY.gear}
            title={SETTINGS_COPY.gear}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={live ? settings.onOpen : () => setSampleOpen(true)}
            className="relative text-muted-foreground hover:text-amber-700 aria-expanded:text-amber-700 dark:hover:text-amber-400 dark:aria-expanded:text-amber-400"
          >
            <Settings aria-hidden />
            {attention ? <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-500" /> : null}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-5 xl:space-y-4 xl:short:space-y-3">
        <div className={ruleWashed ? cn(RATE_LINE, WASH_HOST, "rounded-md") : RATE_LINE}>
          {/* The line has no padding of its own: the wash reaches a little past it, and moves nothing. */}
          {ruleWashed ? <Wash tone="setting" bleed /> : null}
          <p className="text-sm leading-none font-medium">Rate</p>
          <span className="flex items-center gap-2">
            {paused ? <Badge variant="outline">{SETTINGS_COPY.paused}</Badge> : null}
            <Num className="text-sm">{pct(rateBps)}</Num>
          </span>
        </div>

        <div className="space-y-2">
          <p className="text-sm leading-none font-medium">Invests in</p>
          {targets.length === 0 ? (
            <p className="text-xs text-muted-foreground">{targetsNote ?? SETTINGS_COPY.nothingPicked}</p>
          ) : (
            <ul className="space-y-1.5">
              {targets.map((target) => (
                <li key={target.symbol} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Image src={target.logo ?? tickerLogo(target.symbol)} alt={target.symbol} width={16} height={16} className="rounded-full" />
                    {target.symbol}
                  </span>
                  <Num>{pct(target.weightBps, 0)}</Num>
                </li>
              ))}
            </ul>
          )}
          {targets.length > 0 && targetsNote !== null ? <p className="text-xs text-muted-foreground">{targetsNote}</p> : null}
        </div>

        <Separator />

        <div className="space-y-2">
          {renderNextInvestment !== undefined ? (
            renderNextInvestment(nextView)
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className={LABEL}>Next investment</p>
                <p className={cn(MONO, "text-sm")}>
                  {usd(ready)} <span className="text-muted-foreground">of</span> {usd(thresholdUsd)}
                </p>
              </div>
              {progress === null ? null : <Progress value={progress} aria-label="Progress to next investment" />}
              {toGoShown ? (
                <p className="text-xs text-muted-foreground">
                  <Num>{usd(toGo)}</Num> to go
                </p>
              ) : null}
              {/* A live page's money not yet USDC, what it waits for, or the input it could not read; the sample never sets it. */}
              {stats.nextInvestmentNote ? (
                <p className="text-xs text-muted-foreground" data-next-investment-note="">
                  {stats.nextInvestmentNote}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="space-y-2">
          {pulse === undefined ? (
            <p className={LABEL}>Last investment</p>
          ) : (
            // THE LABEL'S OWN 16 px LINE (h-4), as the hero's pill does it: a buy starting or landing never moves the card.
            <div className="flex h-4 min-w-0 items-center justify-between gap-2">
              <p className={cn(LABEL, "shrink-0")}>Last investment</p>
              {pulse.buying === null ? null : (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-buying="">
                  <WorkMark state="active" tone="invest" tile={false} still={pulse.buying.still} />
                  <span className="truncate">{pulse.buying.text}</span>
                </span>
              )}
            </div>
          )}
          {lastInvestment ? (
            <Tooltip>
              {/* A real button, like the feed rows: announced as a control, not as stray text. */}
              <TooltipTrigger type="button" className={lastWashed ? cn(LAST_BUY, WASH_HOST) : LAST_BUY}>
                {lastWashed ? <Wash tone="invest" /> : null}
                <Image
                  src={lastInvestment.logo ?? tickerLogo(lastInvestment.symbol)}
                  alt={lastInvestment.symbol}
                  width={20}
                  height={20}
                  className="rounded-full"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">Invested in {lastInvestment.symbol}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <Num>{lastInvestment.sharesText ?? shares(lastInvestment.shares)}</Num> shares ·{" "}
                    {lastInvestment.at === null ? null : timeAgo(lastInvestment.at, now)}
                  </span>
                </span>
                <Num className="shrink-0 text-sm">{usd(lastInvestment.amountUsd)}</Num>
              </TooltipTrigger>
              <TooltipContent>
                <span className="font-mono">{shortHex(lastInvestment.txHash)}</span>
              </TooltipContent>
            </Tooltip>
          ) : stats.investedOutsideHistory === true ? (
            /*
             * A BUY THE CHAIN RECORDS BUT THIS PAGE DID NOT LOAD. The history
             * here is one page of the newest transactions; the vault's own
             * counters say when it last bought and how much that day. Never
             * "No investments yet" beside the stock it bought.
             */
            <div className="rounded-md border p-3">
              <p className="text-sm">{LIVE_COPY.olderThanHistory}</p>
              {stats.lastInvestedDay === null || stats.lastInvestedDay === undefined ? null : (
                <p className="text-xs text-muted-foreground">
                  {LIVE_COPY.lastBuyOutsideHistory(relativeDayLabel(stats.lastInvestedDay.day, now), usd(stats.lastInvestedDay.spentUsd))}
                </p>
              )}
            </div>
          ) : stats.investedOutsideHistory === null ? (
            <p className="text-sm text-muted-foreground">{LIVE_COPY.noInvestmentLoaded}</p>
          ) : (
            <p className="text-sm text-muted-foreground">No investments yet</p>
          )}
        </div>
      </CardContent>

      {live ? null : (
        <RuleSettingsDialog open={sampleOpen} onOpenChange={setSampleOpen} holdClose={false} description={SETTINGS_COPY.descriptionSample}>
          <RuleSettingsForm
            // Reopened on what was last saved: the form's fields are seeded once.
            key={JSON.stringify(draftOf(sample))}
            initial={draftOf(sample)}
            rates={{ profit: sample.mode === "profit" ? sample.rateBps : 2_000, volume: sample.mode === "volume" ? sample.rateBps : 200 }}
            live={false}
            volume={{ selectable: true, note: null }}
            categories={SAMPLE_CATEGORIES}
            maxLegs={SAMPLE_MAX_LEGS}
            weightsEditable
            buyingLocked={null}
            thresholdNote={null}
            frozen={false}
            judge={judge}
            onSave={(draft) => {
              setSample({
                mode: draft.mode,
                rateBps: draft.rateBps,
                paused: draft.paused,
                thresholdUsd: thresholdUsdOf(draft.threshold) ?? sample.thresholdUsd,
                targets: draft.picked.map((pick) => ({ symbol: pick.id, weightBps: Number(pick.percent.trim()) * 100 })),
              });
              setSampleOpen(false);
            }}
            onCancel={() => setSampleOpen(false)}
            refresh={null}
            progress={null}
          />
        </RuleSettingsDialog>
      )}
    </Card>
  );
}
