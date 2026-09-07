"use client";

import Image from "next/image";
import { useState } from "react";

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
// The leaf, not the barrel: `@/mocks` also re-exports the seeded dataset, and this file ships to the browser.
import { tickerLogo, type ActivityEvent, type InvestedEvent, type SavingsRule, type SavingsStats } from "@/mocks/types";

/** The reference's ½ · 2x · MAX, as slices of volume — in basis points. */
const RATE_PRESETS = [10, 20, 50] as const;
/** The slider's range, in basis points: 0.01% to 1% of every fill. */
const RATE_MIN = 1;
const RATE_MAX = 100;
/** Names both the rate group and, on the thumb itself, the slider. */
const RATE_LABEL_ID = "rate-label";
/** Milliseconds that "Rule updated" stays on the button. */
const UPDATED_MS = 2000;

/** The three fields the panel can change; targets are read-only here. */
type Baseline = Pick<SavingsRule, "rateBps" | "thresholdUsd" | "paused">;

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
  className,
}: {
  rule: SavingsRule;
  stats: SavingsStats;
  activity: readonly ActivityEvent[];
  now: string;
  className?: string;
}) {
  const [rate, setRate] = useState(rule.rateBps);
  const [threshold, setThreshold] = useState(() => String(rule.thresholdUsd));
  const [paused, setPaused] = useState(rule.paused);
  const [baseline, setBaseline] = useState<Baseline>({
    rateBps: rule.rateBps,
    thresholdUsd: rule.thresholdUsd,
    paused: rule.paused,
  });
  const [updated, flash] = useFlash(UPDATED_MS);

  const thresholdUsd = Number(threshold);
  const thresholdValid = threshold.trim() !== "" && Number.isFinite(thresholdUsd) && thresholdUsd >= 1;
  const dirty =
    thresholdValid &&
    (rate !== baseline.rateBps || thresholdUsd !== baseline.thresholdUsd || paused !== baseline.paused);

  function handleUpdate() {
    if (!dirty) return; // aria-disabled does not stop Enter or Space
    setBaseline({ rateBps: rate, thresholdUsd, paused });
    flash();
  }

  const preset = RATE_PRESETS.some((value) => value === rate) ? String(rate) : "";
  const lastInvestment = activity.find((event): event is InvestedEvent => event.kind === "invested");
  const progress = stats.thresholdUsd > 0 ? Math.min(100, (stats.pendingUsd / stats.thresholdUsd) * 100) : 0;
  const toGo = Math.max(0, stats.thresholdUsd - stats.pendingUsd);

  return (
    <Card className={cn("h-fit", className)}>
      <CardHeader>
        <CardTitle>Savings rule</CardTitle>
        <CardDescription>Applied to every buy and sell</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div role="group" aria-labelledby={RATE_LABEL_ID} className="space-y-3">
          <div className="flex items-center justify-between">
            <Label id={RATE_LABEL_ID}>Rate</Label>
            <Num className="text-sm">{pct(rate)}</Num>
          </div>
          <Slider
            value={[rate]}
            min={RATE_MIN}
            max={RATE_MAX}
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
            {RATE_PRESETS.map((value) => (
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
              className={cn("pl-7", MONO)}
            />
          </div>
          {/* Why "Update rule" will not take the rule, said where the field is described. */}
          <p
            id="threshold-help"
            className={cn("text-xs", thresholdValid ? "text-muted-foreground" : "text-destructive")}
          >
            {thresholdValid ? "Invests when the pile reaches this" : "Enter at least $1"}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-sm leading-none font-medium">Invests in</p>
          <ul className="space-y-1.5">
            {rule.targets.map((target) => (
              <li key={target.symbol} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Image
                    src={tickerLogo(target.symbol)}
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

        <Separator />

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className={LABEL}>Next investment</p>
            <p className={cn(MONO, "text-sm")}>
              {usd(stats.pendingUsd)} <span className="text-muted-foreground">of</span> {usd(stats.thresholdUsd)}
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
                  src={tickerLogo(lastInvestment.symbol)}
                  alt={lastInvestment.symbol}
                  width={20}
                  height={20}
                  className="rounded-full"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">Invested in {lastInvestment.symbol}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <Num>{shares(lastInvestment.shares)}</Num> shares ·{" "}
                    {timeAgo(lastInvestment.at, now)}
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
