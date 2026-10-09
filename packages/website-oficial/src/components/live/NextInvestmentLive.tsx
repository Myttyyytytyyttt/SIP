/**
 * NEXT INVESTMENT ON A LIVE PAGE, DRAWN (10-09, plan B1: the owner's bug, its
 * UI half).
 *
 * He traded, SaverFi saved $0.43 from it, and the card said "$0.00 of $1.00"
 * beside "Pending $0.43", with no line saying why (G3). The figure is the
 * data's now (live-pending.ts, through SavingsStats): the USDC, the SOL on its
 * way to USDC and the SOL waiting under the line before it can convert, at
 * today's price. The card works out the rest — the bar's fill, held short of
 * full while something holds the buy; whether "to go" is printed — and hands
 * it here (savings-rule-panel.tsx NextInvestmentView). THIS FILE ONLY DRAWS:
 * no sum, no difference, no cap of its own.
 *
 *   label   "Next investment", and beside it at most one mark:
 *             turning    a conversion or a buy under way (the steps over the
 *                        feed, LivePending.tsx) — blue for the buy
 *             hourglass  part of the figure is SOL waiting under the line
 *             clock      the conversion that would complete it is overdue
 *             pause      a rest the line under the bar names holds the buy
 *           and nothing otherwise: never a mark the words beside it do not
 *           explain. Work under way wins over a gate — it is what is moving.
 *   figure  "$0.43 of $1.00"; "— of $1.00" when the figure could not be made,
 *           and then NO BAR: an empty bar under a dash read as nothing saved.
 *   bar     the card's fill, in up to three STILL segments when the data says
 *           what the figure is made of — USDC, SOL on its way, SOL waiting —
 *           scaled to that fill. No stripes and no transition: the dollars are
 *           re-priced on every update, and a bar that slid on each would say
 *           money moved when only a price did. Its accessible value is the
 *           headline's, then the parts in the line's own words.
 *   lines   "$0.61 to go" where the card prints it, and the data's note verbatim.
 *
 * The mark is aria-hidden, like every WorkMark: what it means is in the note
 * under the bar, and in the steps' own region, which announces them. Nothing
 * here moves for reduced motion but the turning mark, which then stands still
 * with the same words beside it.
 *
 * LIVE ONLY: LiveRulePanel hands it to the card as `renderNextInvestment`. The
 * sample never passes that, and keeps its own block character for character.
 */

import type { PendingRow } from "@/components/live/LivePending";
import { WorkMark, type WorkState } from "@/components/live/WorkMark";
import { Num } from "@/components/num";
import type { NextInvestmentView, RulePanelPulse } from "@/components/savings-rule-panel";
import { LABEL, MONO, type Tone } from "@/lib/classes";
import { usd } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveRow } from "@/lib/live-types";
import { cn } from "@/lib/utils";

/** The keeper's step under way that feeds the figure, as the steps over the feed draw it. */
export interface NextWork {
  readonly kind: "converting" | "buying";
  /** A newer snapshot, committed without its history, no longer has it under way (use-whole-read.ts): the loader stands still. */
  readonly still: boolean;
}

/** What the live rule card is handed beyond the card's own figures (LiveRulePanel.tsx). */
export interface LiveRulePulse extends RulePanelPulse {
  /** The step under way beside "Next investment"; null when none is. */
  readonly work: NextWork | null;
}

/** The mark beside the label. */
export interface NextMark {
  readonly state: WorkState;
  readonly tone: Tone;
  readonly still: boolean;
}

/** The gates a mark stands for; a "conversion" decides itself on landing and an "unknown" is the note's to say. */
const GATED: Partial<Record<NonNullable<NextInvestmentView["gate"]>, WorkState>> = { wrap_line: "gated", slow: "slow", held: "held" };

/** Which mark the label wears: the work under way, else the gate's, else none. */
export function nextMarkOf(work: NextWork | null, gate: NextInvestmentView["gate"]): NextMark | null {
  if (work !== null) return { state: "active", tone: work.kind === "buying" ? "invest" : "quiet", still: work.still };
  const state = gate === null ? undefined : GATED[gate];
  return state === undefined ? null : { state, tone: "quiet", still: false };
}

/** The step of this kind under way among the rows drawn — never one already on its way out. */
const underWay = (rows: readonly PendingRow[], kind: "converting" | "buying") =>
  rows.find((row): row is Extract<PendingRow, { show: "line" }> => row.show === "line" && !row.leaving && row.kind === kind && row.line.active);

/**
 * The work beside the label: a buy under way before a conversion, since the buy
 * is the investment itself. A step the page can no longer confirm is drawn
 * resting (LivePending.tsx unconfirmedOf), so it is no work under way here
 * either, and the mark falls back to the newest data's gate.
 */
export function nextWorkOf(rows: readonly PendingRow[]): NextWork | null {
  const row = underWay(rows, "buying") ?? underWay(rows, "converting");
  return row === undefined ? null : { kind: row.kind === "buying" ? "buying" : "converting", still: row.still };
}

/**
 * EVERYTHING THE LIVE RULE CARD SHOWS MOVING, from what LiveBody already has:
 * the steps as the rows draw them (usePendingView), the vault's own rows, and
 * the signatures just arrived (use-arrivals.ts). A rule change is one that
 * LANDED: a failed one changed nothing, and its row washes grey in the feed.
 */
export function rulePulseOf(input: {
  readonly rows: readonly PendingRow[];
  readonly history: readonly LiveRow[];
  readonly arrived: ReadonlySet<string>;
}): LiveRulePulse {
  const buying = underWay(input.rows, "buying");
  return {
    work: nextWorkOf(input.rows),
    buying: buying === undefined ? null : { text: LIVE_COPY.buyingUnderWay(buying.line.title), still: buying.still },
    arrived: input.arrived,
    ruleArrived: input.history.some((row) => row.ok && row.event.kind === "rule_changed" && input.arrived.has(row.signature)),
  };
}

export type BarPart = "whole" | "usdc" | "converting" | "waiting";

/** Still tints: USDC the card's own ink, SOL on its way a lighter one, SOL waiting the machinery's grey. */
const SEGMENT: Readonly<Record<BarPart, string>> = {
  whole: "bg-primary",
  usdc: "bg-primary",
  converting: "bg-primary/45",
  waiting: "bg-muted-foreground/35",
};

const PARTS = ["usdc", "converting", "waiting"] as const;

/**
 * The bar's segments, in percent of its width: one, at the card's fill, until
 * every part is known; then each part's share OF THAT FILL, so the segments end
 * exactly where the card's bar would — held short of full by a gate included.
 * Shares of the drawn fill, not dollars added up: the parts are each rounded
 * from their own raw sums, and only the card's fill is the figure.
 */
export function segmentsOf(progress: number, parts: NextInvestmentView["parts"]): readonly { readonly part: BarPart; readonly width: number }[] {
  const whole = [{ part: "whole" as const, width: progress }];
  if (parts === null || parts.usdc === null || parts.converting === null || parts.waiting === null) return whole;
  const known = { usdc: parts.usdc, converting: parts.converting, waiting: parts.waiting };
  const total = known.usdc + known.converting + known.waiting;
  if (!(total > 0)) return whole;
  return PARTS.filter((part) => known[part] > 0).map((part) => ({ part, width: (progress * known[part]) / total }));
}

/** A part worth saying: known, and not a fraction of a cent that prints as $0.00. */
const said = (value: number | null): value is number => value !== null && usd(value) !== usd(0);

/** "$0.43 of $1.00", then what it is made of when any of it is not USDC yet. */
export function barValueText(next: Pick<NextInvestmentView, "readyUsd" | "thresholdUsd" | "parts">): string {
  const value = LIVE_COPY.nextBar.value(usd(next.readyUsd), usd(next.thresholdUsd));
  const parts = next.parts;
  if (parts === null || !(said(parts.converting) || said(parts.waiting))) return value;
  const named = [
    said(parts.usdc) ? LIVE_COPY.nextBar.usdc(usd(parts.usdc)) : null,
    said(parts.converting) ? LIVE_COPY.nextBar.converting(usd(parts.converting)) : null,
    said(parts.waiting) ? LIVE_COPY.nextBar.waiting(usd(parts.waiting)) : null,
  ].filter((part): part is string => part !== null);
  return LIVE_COPY.nextBar.parts(value, named);
}

/** The Progress box's own size and ground (ui/progress.tsx), its fill drawn in still parts. */
function Bar({ next, progress }: { readonly next: NextInvestmentView; readonly progress: number }) {
  return (
    <div
      role="progressbar"
      aria-label={LIVE_COPY.progressLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
      aria-valuetext={barValueText(next)}
      className="relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted"
      data-next-investment-bar=""
    >
      {segmentsOf(progress, next.parts).map((segment) => (
        // A thousandth of a percent is far under a pixel; the float's last digits would only churn the markup.
        <span key={segment.part} className={cn("block h-full shrink-0", SEGMENT[segment.part])} style={{ width: `${Number(segment.width.toFixed(3))}%` }} data-part={segment.part} />
      ))}
    </div>
  );
}

export function NextInvestmentLive({ next, work }: { readonly next: NextInvestmentView; readonly work: NextWork | null }) {
  const mark = nextMarkOf(work, next.gate);
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        {/* The mark is 14 px, under the label's own 16 px line: the row is as tall with it as without. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <p className={LABEL}>{LIVE_COPY.nextInvestment}</p>
          {mark === null ? null : (
            <span className="flex" data-next-mark={mark.state}>
              <WorkMark state={mark.state} tone={mark.tone} tile={false} still={mark.still} />
            </span>
          )}
        </div>
        <p className={cn(MONO, "text-sm")}>
          {usd(next.readyUsd)} <span className="text-muted-foreground">of</span> {usd(next.thresholdUsd)}
        </p>
      </div>
      {next.progress === null ? null : <Bar next={next} progress={next.progress} />}
      {next.toGoShown ? (
        <p className="text-xs text-muted-foreground">
          <Num>{usd(next.toGoUsd)}</Num> to go
        </p>
      ) : null}
      {next.note ? (
        <p className="text-xs text-muted-foreground" data-next-investment-note="">
          {next.note}
        </p>
      ) : null}
    </>
  );
}
