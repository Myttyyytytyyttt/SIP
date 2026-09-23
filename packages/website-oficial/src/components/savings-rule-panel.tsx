"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";

import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFlash } from "@/hooks/use-flash";
import { LABEL, MONO } from "@/lib/classes";
import { pct, shares, shortHex, timeAgo, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { VAULT_COPY } from "@/lib/vault-copy";
// The leaf, not the barrel: `@/mocks` also re-exports the seeded dataset, and this file ships to the browser.
import { tickerLogo, type ActivityEvent, type InvestedEvent, type SavingsRule, type SavingsStats } from "@/mocks/types";

/** Three volume rates, in basis points: 0.5%, 1% and 2%. The last is the program's ceiling and the demo's rate. */
const RATE_PRESETS = [50, 100, 200] as const;
/**
 * The slider's range, in basis points: 0.01% to 2% of every fill — the volume
 * rates the SIP program accepts (VOLUME_BPS_MIN..VOLUME_BPS_MAX in
 * @sip/solana-core/client, pinned there to state.rs). Written out rather than
 * imported: that entry carries the program's IDL, and this panel ships to the
 * browser for a pair of numbers.
 */
const RATE_MIN = 1;
const RATE_MAX = 200;
/** Names both the rate group and, on the thumb itself, the slider. */
const RATE_LABEL_ID = "rate-label";
/** Milliseconds that "Rule updated" stays on the button. */
const UPDATED_MS = 2000;

/** The three fields the panel can change; targets are read-only here. */
type Baseline = Pick<SavingsRule, "rateBps" | "thresholdUsd" | "paused">;

/**
 * WHAT MAKES THE FORM SIGN. The sample's panel is local state — "Update rule"
 * moves its baseline and says so, nothing more — which on a real pension would
 * be a control that appears to set someone's savings and silently does not.
 * So a live page passes this, and "Update rule" hands what changed to it; the
 * stored rule only moves when the chain says it did (the page reads it again,
 * and remounts this form on the new values).
 */
export interface RuleSigner {
  /** The vault's own mode's range, in basis points: profit 201–10 000, volume 1–200. */
  readonly rateMin: number;
  readonly rateMax: number;
  readonly presets: readonly number[];
  /** Why the threshold cannot be changed from here — no policy yet, or one this page cannot re-sign — or null. */
  readonly thresholdLocked: string | null;
  /** Why a typed threshold cannot be signed against the stored caps, or null when it can. */
  readonly thresholdProblem: (usd: number) => string | null;
  /** A write is running, another holds the page's lock, or a sent one awaits confirmation. */
  readonly busy: boolean;
  readonly onUpdate: (next: Baseline, changed: { readonly rule: boolean; readonly threshold: boolean }) => void;
  /** The signature's own progress, under the button. */
  readonly progress: ReactNode;
}

/**
 * The narrow panel where the reference put its bet controls: the rule that
 * makes the pension, editable, and what it is about to do next. Local state
 * only — "Update rule" moves the baseline and says so, nothing more.
 */
export function SavingsRulePanel({
  rule,
  stats,
  activity,
  now,
  signer,
  className,
}: {
  rule: SavingsRule;
  stats: SavingsStats;
  activity: readonly ActivityEvent[];
  now: string;
  /** A live page: the controls sign. Absent on the sample. */
  signer?: RuleSigner;
  className?: string;
}) {
  const [rate, setRate] = useState(rule.rateBps);
  const [threshold, setThreshold] = useState(() => (rule.thresholdUsd === null ? "" : String(rule.thresholdUsd)));
  const [paused, setPaused] = useState(rule.paused);
  const [baseline, setBaseline] = useState<Baseline>({
    rateBps: rule.rateBps,
    thresholdUsd: rule.thresholdUsd,
    paused: rule.paused,
  });
  const [updated, flash] = useFlash(UPDATED_MS);

  const locked = signer?.thresholdLocked ?? null;
  const thresholdUsd = Number(threshold);
  const thresholdTyped = threshold.trim() !== "" && Number.isFinite(thresholdUsd) && thresholdUsd >= 1;
  // What the stored caps can buy, on a live page: a threshold they cannot reach is never offered for a signature.
  const thresholdProblem = signer !== undefined && locked === null && thresholdTyped ? signer.thresholdProblem(thresholdUsd) : null;
  // A threshold that cannot be edited here is not part of the change at all.
  const thresholdValid = locked !== null || (thresholdTyped && thresholdProblem === null);
  const ruleChanged = rate !== baseline.rateBps || paused !== baseline.paused;
  const thresholdChanged = locked === null && thresholdTyped && thresholdUsd !== baseline.thresholdUsd;
  const dirty = thresholdValid && (ruleChanged || thresholdChanged) && signer?.busy !== true;

  function handleUpdate() {
    if (!dirty) return; // aria-disabled does not stop Enter or Space
    if (signer !== undefined) {
      signer.onUpdate({ rateBps: rate, thresholdUsd: thresholdChanged ? thresholdUsd : baseline.thresholdUsd, paused }, { rule: ruleChanged, threshold: thresholdChanged });
      return;
    }
    setBaseline({ rateBps: rate, thresholdUsd, paused });
    flash();
  }

  const rateMin = signer?.rateMin ?? RATE_MIN;
  const rateMax = signer?.rateMax ?? RATE_MAX;
  const presets = signer?.presets ?? RATE_PRESETS;
  const preset = presets.some((value) => value === rate) ? String(rate) : "";
  const lastInvestment = activity.find((event): event is InvestedEvent => event.kind === "invested");
  // What counts toward the threshold: the sample's pending pile, or — on a live
  // vault — only the USDC already converted and ready to buy with.
  const ready = stats.readyToInvestUsd === undefined ? stats.pendingUsd : stats.readyToInvestUsd;
  // What the rate is taken from, in the vault's own words.
  const appliedTo = rule.mode === "profit" ? "Applied to your realised trading gains" : "Applied to every buy and sell";
  const progress = ready !== null && stats.thresholdUsd !== null && stats.thresholdUsd > 0 ? Math.min(100, (ready / stats.thresholdUsd) * 100) : 0;
  const toGo = ready !== null && stats.thresholdUsd !== null ? Math.max(0, stats.thresholdUsd - ready) : null;

  return (
    // The same desktop spacing as the pension card beside it, and one step
    // tighter again on a short screen: this card is the taller of the two on a
    // 13" laptop, so its padding decides whether the page needs a scroll.
    <Card className={cn("h-fit xl:[--card-spacing:--spacing(3)]", className)}>
      <CardHeader>
        <CardTitle>Savings rule</CardTitle>
        <CardDescription>{appliedTo}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5 xl:space-y-4 xl:short:space-y-3">
        <div role="group" aria-labelledby={RATE_LABEL_ID} className="space-y-3">
          <div className="flex items-center justify-between">
            <Label id={RATE_LABEL_ID}>Rate</Label>
            <Num className="text-sm">{pct(rate)}</Num>
          </div>
          <Slider
            value={[rate]}
            min={rateMin}
            max={rateMax}
            step={1}
            onValueChange={(values) => {
              const next = values[0];
              if (next !== undefined) setRate(next);
            }}
            // The thumb is what a screen reader lands on: name it, and speak the
            // percent it shows rather than the basis points it holds.
            thumbProps={{ "aria-labelledby": RATE_LABEL_ID, "aria-valuetext": pct(rate) }}
          />
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={preset}
            onValueChange={(value) => {
              if (value) setRate(Number(value));
            }}
          >
            {presets.map((value) => (
              <ToggleGroupItem key={value} value={String(value)} className={MONO}>
                {pct(value)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="threshold">Investment threshold</Label>
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-muted-foreground"
            >
              $
            </span>
            <Input
              id="threshold"
              type="number"
              inputMode="decimal"
              min={1}
              step={1}
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              aria-describedby="threshold-help"
              aria-invalid={!thresholdValid}
              disabled={locked !== null}
              className={cn("pl-7", MONO)}
            />
          </div>
          {/* Why "Update rule" will not take the rule, said where the field is described. */}
          <p
            id="threshold-help"
            className={cn("text-xs", thresholdValid ? "text-muted-foreground" : "text-destructive")}
          >
            {locked ?? thresholdProblem ?? (thresholdValid ? "Invests when the pile reaches this" : "Enter at least $1")}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm leading-none font-medium">Invests in</p>
          <ul className="space-y-1.5">
            {rule.targets.map((target) => (
              <li key={target.symbol} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Image
                    src={target.logo ?? tickerLogo(target.symbol)}
                    alt={target.symbol}
                    width={16}
                    height={16}
                    className="rounded-full"
                  />
                  {target.symbol}
                </span>
                <Num>{pct(target.weightBps, 0)}</Num>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-between">
          <Label htmlFor="paused">Pause the rule</Label>
          <Switch id="paused" checked={paused} onCheckedChange={setPaused} />
        </div>

        {/*
          WHAT THE SIGNATURE COSTS, said before the button and not discovered
          after it. The rule's own signature invalidates a settlement already
          on its way; the threshold's re-signs the investing policy's price
          limits at today's pools. Only on a live page, and only once something
          has changed.
        */}
        {signer !== undefined && dirty ? (
          <div className="space-y-2 text-xs">
            {ruleChanged ? <p className="rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2">{VAULT_COPY.nonceNotice}</p> : null}
            {thresholdChanged ? (
              <p className="rounded-md border px-3 py-2 text-muted-foreground">
                The threshold is part of your investing policy, so it is signed again with its price limits read from today&apos;s pools.
              </p>
            ) : null}
            {ruleChanged && thresholdChanged ? <p className="text-muted-foreground">Two signatures: the rule first, then the threshold once the first has landed.</p> : null}
          </div>
        ) : null}

        {/*
          The primary fill is earned by a change; at rest this is a hairline box.
          aria-disabled rather than disabled: the click itself makes the rule
          clean again, and a button that turns `disabled` under focus drops
          focus to <body> — and "Rule updated" would then come from an inert
          element. ui/button only styles `disabled:`, hence the two classes.
        */}
        <Button
          className="w-full aria-disabled:pointer-events-none aria-disabled:opacity-50"
          variant={dirty ? "default" : "outline"}
          aria-disabled={!dirty}
          onClick={handleUpdate}
          aria-live="polite"
        >
          {updated && !dirty ? "Rule updated" : "Update rule"}
        </Button>
        {signer?.progress ?? null}

        <Separator />

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className={LABEL}>Next investment</p>
            <p className={cn(MONO, "text-sm")}>
              {usd(ready)} <span className="text-muted-foreground">of</span> {usd(stats.thresholdUsd)}
            </p>
          </div>
          <Progress value={progress} aria-label="Progress to next investment" />
          <p className="text-xs text-muted-foreground">
            <Num>{usd(toGo)}</Num> to go
          </p>
        </div>

        <div className="space-y-2">
          <p className={LABEL}>Last investment</p>
          {lastInvestment ? (
            <Tooltip>
              {/* A real button, like the feed rows: announced as a control, not as stray text. */}
              <TooltipTrigger
                type="button"
                className="flex w-full items-center gap-3 rounded-md border p-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
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
          ) : (
            <p className="text-sm text-muted-foreground">No investments yet</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
