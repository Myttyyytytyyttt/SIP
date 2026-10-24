/**
 * THE PUBLIC DASHBOARD'S BODY, as a pure function of its model.
 *
 * The reference's composition (owner, 09-30: Uniswap's board on Blockworks, "a
 * nuestro estilo shadcn"), top to bottom: two wide cards with one large centred
 * figure, a row of counters, two stacked-bar charts, two single-figure cards,
 * two more charts. Each card: a short title, then the figure.
 *
 * NO GREY LINES (owner, 10-24: "lo que esté de más, quítalo", as on the
 * pension page the day before). Nothing under the page title, under a card's
 * title or under a figure explains anything, and there is no footnote. What a
 * figure must still say — that days are UTC, why it is "at least", which price
 * made a dollar, why a dash — is in the hover of that figure or title. A "?" is kept on three cards
 * only, where the figure is read wrong without it (src/lib/global-stats-copy.ts).
 *
 * WHAT IT NEVER DOES: print a 0 for something it could not read, print the
 * sample without saying so, or print a figure without its unit. The model
 * decides what is known (src/lib/global-stats-model.ts); this file only words it.
 *
 * A server component: the chart cards and the "?" are the client parts, and
 * they receive plain, serialisable props. Nothing here reads a clock — `now`
 * comes from the page.
 */

import { Info, TriangleAlert } from "lucide-react";

import { AppLink } from "@/components/app-link";
import { RunningTotalCard } from "@/components/global-stats-area";
import { StackedBarsCard, type HeadlineProps } from "@/components/global-stats-chart";
import { InfoTip } from "@/components/info-tip";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatSolAtMost, formatSol, formatUsd } from "@/lib/amounts";
import { MONO } from "@/lib/classes";
import { urlWithMode, type UrlMode } from "@/lib/dashboard-mode";
import { UNKNOWN, count, dateLabel, dayLabel, pct, shortHex, timeAgo } from "@/lib/format";
import { GLOBAL_STATS_COPY } from "@/lib/global-stats-copy";
import { dollarsFor, type Counted, type GlobalStatsModel, type Raw, type Reason, type Stat, type StatsDay, type UtcDay } from "@/lib/global-stats-model";
import {
  SERIES,
  growthBps,
  investedByDay,
  pensionsByDay,
  savedByDay,
  savedTotalByDay,
  settlementsByDay,
  sparkBars,
  tradedByDay,
  unreadDays,
  type DayValues,
} from "@/lib/global-stats-series";
import { cn } from "@/lib/utils";

const COPY = GLOBAL_STATS_COPY;

/** Past this, a charts block older than the totals beside it says its own age: the keeper re-adds every two minutes. */
const STALE_STATS_MS = 10 * 60 * 1_000;

/** The route this page lives at: its own links carry a mode onto it. */
export const DASHBOARD_PATH = "/dashboard";

const reasonText = (reason: Reason): string => COPY.reason[reason];

/** A hover, or none: the notes that are there, joined. */
const titled = (...notes: readonly (string | null | undefined)[]): { readonly title?: string } => {
  const title = notes.filter((note): note is string => note !== null && note !== undefined && note !== "").join(" · ");
  return title === "" ? {} : { title };
};

const settlementsText = (n: number): string => (n === 1 ? "1 settlement" : `${count(n)} settlements`);

/**
 * A SOL total for a face read at a glance: four places under 1,000 SOL, two
 * under a million, none above. A positive amount never reads as 0
 * (formatSolAtMost). The exact figure is kept for the title attribute.
 */
export function heroSol(lamports: Raw): { readonly text: string; readonly exact: string } {
  const value = BigInt(lamports);
  const decimals = value < 1_000n * 1_000_000_000n ? 4 : value < 1_000_000n * 1_000_000_000n ? 2 : 0;
  return { text: formatSolAtMost(value, decimals), exact: `${formatSol(value)} SOL` };
}

/** USDC raw as "1,240.00": the dashboard's USDC figures never wear "$". */
const usdcText = (raw: Raw): string => formatUsd(BigInt(raw)).slice(1);

function SampleBadge({ sample }: { readonly sample: boolean }) {
  return sample ? (
    <Badge variant="secondary" className="font-normal">
      {COPY.sampleCardBadge}
    </Badge>
  ) : null;
}

/** A card's head: its short title and the sample badge. Nothing under it. */
function Head({ title, sample }: { readonly title: string; readonly sample: boolean }) {
  return (
    <CardHeader>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <CardTitle>{title}</CardTitle>
        <SampleBadge sample={sample} />
      </div>
    </CardHeader>
  );
}

/** The large centred figure: a label or qualifier before it, its unit after it, and every digit and caveat in its hover. */
function Figure({ value, qualifier = null, unit = null, title }: { readonly value: string; readonly qualifier?: string | null; readonly unit?: string | null; readonly title?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-center gap-x-2 text-center" {...titled(title)}>
      {qualifier === null ? null : <span className="text-base text-muted-foreground">{qualifier}</span>}
      <span className={cn(MONO, "text-3xl font-semibold tracking-tight sm:text-4xl")}>{value}</span>
      {unit === null ? null : <span className="text-sm text-muted-foreground">{unit}</span>}
    </div>
  );
}

/** A figure nobody could read: a dash, and why in its hover. Never a 0. */
function Unread({ reason }: { readonly reason: Reason }) {
  return (
    <div data-reason={reason}>
      <Figure value={UNKNOWN} title={reasonText(reason)} />
    </div>
  );
}

/** The dollar value under a SOL headline, the price that made it in its hover: a floor when the total is one, never $0 for a price nobody read. */
function dollarLine(total: Stat<{ readonly lamports: Raw }>, price: Stat<Raw>, sample: boolean, atLeast: boolean): HeadlineProps["dollars"] {
  if (total.kind === "unavailable") return null;
  const dollars = dollarsFor(total, price);
  if (dollars.kind === "unavailable") return { text: COPY.noDollars, title: reasonText(dollars.reason) };
  const usd = formatUsd(BigInt(dollars.value));
  return { text: atLeast ? COPY.atLeastDollars(usd) : COPY.dollars(usd), title: sample ? COPY.sampleDollarsHint : COPY.dollarsHint };
}

/** "+12.4% in 7 days" — only from a running total that stood above zero a week before, and only when that week was read whole. */
function growthText(rows: readonly DayValues[], end: UtcDay, series: readonly string[], partial: boolean): string | null {
  if (partial) return null;
  const bps = growthBps(rows, end, 7, series);
  return bps === null || bps <= 0 ? null : COPY.growth(pct(bps, 1));
}

/**
 * NO PROVENANCE LINE UNDER THE TOTAL (10-24). "across 3 pensions" repeated the
 * strip and the Pensions tile, and "since Sep 19" the span under the page
 * title; a cut read says so in the figure's hover, beside its "at least".
 */
function savedHeadline(model: GlobalStatsModel, sample: boolean, days: readonly DayValues[] | null, partial: boolean, end: UtcDay): HeadlineProps {
  const { saved } = model;
  if (saved.kind === "unavailable") return { value: UNKNOWN, qualifier: null, unit: "SOL", title: reasonText(saved.reason), delta: null, dollars: null };
  const floor = saved.value.bound === "at-least";
  const figure = heroSol(saved.value.lamports);
  return {
    value: figure.text,
    qualifier: floor ? COPY.saved.atLeast : null,
    unit: "SOL",
    title: titled(figure.exact, floor ? COPY.saved.atLeastHint : null).title ?? null,
    delta: days === null ? null : growthText(days, end, ["saved"], partial || floor),
    dollars: dollarLine(saved, model.solPrice, sample, floor),
  };
}

function tradedHeadline(model: GlobalStatsModel, sample: boolean, days: readonly DayValues[] | null, partial: boolean, end: UtcDay): HeadlineProps {
  const { traded } = model;
  if (traded.kind === "unavailable") return { value: UNKNOWN, qualifier: null, unit: "SOL", title: reasonText(traded.reason), delta: null, dollars: null };
  const figure = heroSol(traded.value.lamports);
  return {
    value: figure.text,
    // Approximate, always: never "at least" — the measure can over-count as well as under-count. Its "?" says how.
    qualifier: "≈",
    unit: "SOL",
    title: titled(figure.exact, traded.value.partial ? COPY.traded.partial : null).title ?? null,
    delta: days === null ? null : growthText(days, end, ["profit", "volume"], partial || traded.value.partial),
    dollars: dollarLine(traded, model.solPrice, sample, false),
  };
}

/** One figure on the strip: its label, its value, and in its hover what it needs said — a dash's reason among them. */
function StripItem({ label, value, title }: { readonly label: string; readonly value: string; readonly title?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 whitespace-nowrap" {...(title === undefined ? {} : { title })}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn(MONO, "font-medium text-foreground")}>{value}</dd>
    </div>
  );
}

/**
 * THE STRIP UNDER THE TITLE: the reference's "ETH Price · Transactions (24H) ·
 * Pairs · Fees (24H)", in this protocol's terms. "Today" is the UTC day the
 * figures were added up on — said in the hover of the two items it dates, no
 * longer as a grey sentence at the strip's end (10-24), which took a row of
 * its own on a phone. An item nobody published is left out; one that could
 * not be read is a dash.
 */
function StatsStrip({ model, sample, end }: { readonly model: GlobalStatsModel; readonly sample: boolean; readonly end: UtcDay }) {
  const items: { readonly key: string; readonly label: string; readonly value: string; readonly title?: string }[] = [];
  if (model.solPrice.kind === "known") {
    items.push({ key: "price", label: sample ? COPY.strip.sampleSolPrice : COPY.strip.solPrice, value: formatUsd(BigInt(model.solPrice.value)) });
  } else items.push({ key: "price", label: COPY.strip.solPrice, value: UNKNOWN, title: reasonText(model.solPrice.reason) });

  const daily = model.daily;
  if (daily.kind === "known") {
    const row = daily.value.rows.find((day) => day.day === end);
    // A day with no row is a quiet day only when the series is whole.
    const unread = row === undefined && daily.value.partial;
    const settled = row === undefined ? 0 : (row.profit?.settlements ?? 0) + (row.volume?.settlements ?? 0);
    const put = row === undefined ? 0n : BigInt(row.profit?.savedRaw ?? "0") + BigInt(row.volume?.savedRaw ?? "0");
    // "Today" only when the series' last day IS the day the totals were added
    // up; a block kept from an earlier read names its own day instead.
    const isToday = model.computedAt.kind === "known" && model.computedAt.value.slice(0, 10) === end;
    const why = titled(isToday ? COPY.strip.todayIsUtc : COPY.daysUtc, unread ? COPY.charts.partial : null);
    items.push({ key: "today-settlements", label: isToday ? COPY.strip.todaySettlements : COPY.strip.settlementsOn(dayLabel(end)), value: unread ? UNKNOWN : count(settled), ...why });
    items.push({ key: "today-saved", label: isToday ? COPY.strip.todaySaved : COPY.strip.savedOn(dayLabel(end)), value: unread ? UNKNOWN : `${formatSolAtMost(put, 4)} SOL`, ...why });
  } else if (daily.reason !== "not-served-yet") {
    items.push({ key: "today-settlements", label: COPY.strip.todaySettlements, value: UNKNOWN, title: reasonText(daily.reason) });
  }
  if (model.pensions.kind === "known") {
    const { count: n, bound } = model.pensions.value;
    items.push({ key: "pensions", label: COPY.strip.pensions, value: bound === "at-least" ? `≥ ${count(n)}` : count(n), title: COPY.pensions.hint });
  }
  items.push({ key: "assets", label: COPY.strip.assets, value: count(model.shelf.offered.length) });

  return (
    <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card/60 px-4 py-3 text-sm" data-card="strip">
      {items.map((item) => (
        <StripItem key={item.key} label={item.label} value={item.value} {...titled(item.title)} />
      ))}
    </dl>
  );
}

/**
 * A SPARKLINE OF BARS, drawn on the server: shape only, no figures — the tile's
 * number above it is the figure. Null bars (a day in the window could not be
 * read) draw nothing at all, because a missing bar reads as a quiet day.
 */
function Spark({ bars, tone }: { readonly bars: readonly number[] | null; readonly tone: "count" | "money" | "invested" }) {
  if (bars === null || bars.length === 0) return null;
  const width = 100 / bars.length;
  const fill = tone === "money" ? "fill-emerald-600" : tone === "invested" ? "fill-blue-600" : "fill-neutral-400 dark:fill-neutral-500";
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden className="mt-auto h-10 w-full pt-3">
      {bars.map((bar, index) => {
        // A true zero keeps a hairline, so the rhythm of the days stays visible.
        const height = bar > 0 ? Math.max(2, bar * 32) : 0.75;
        return <rect key={index} x={index * width + width * 0.18} y={32 - height} width={width * 0.64} height={height} rx={0.8} className={bar > 0 ? fill : "fill-muted-foreground/25"} />;
      })}
    </svg>
  );
}

/**
 * A counter: label and figure, and the last two weeks of it under it when they
 * were read whole. What the count includes, and the count behind it, are the
 * figure's hover (10-24): no line under it.
 */
function Tile({
  id,
  title,
  sample,
  figure,
  hint,
  spark = null,
  tone = "count",
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly sample: boolean;
  readonly figure: Stat<{ readonly text: string; readonly qualifier?: string | null; readonly unit?: string }>;
  readonly hint?: string | null;
  readonly spark?: readonly number[] | null;
  readonly tone?: "count" | "money" | "invested";
  readonly children?: React.ReactNode;
}) {
  return (
    <Card className="min-w-0" data-card={id}>
      <Head title={title} sample={sample} />
      <CardContent className="flex flex-1 flex-col">
        {figure.kind === "known" ? (
          <div className="flex flex-wrap items-baseline gap-x-1.5" {...titled(hint)}>
            {figure.value.qualifier === null || figure.value.qualifier === undefined ? null : <span className="text-sm text-muted-foreground">{figure.value.qualifier}</span>}
            <span className={cn(MONO, "text-3xl font-semibold tracking-tight")}>{figure.value.text}</span>
            {figure.value.unit === undefined ? null : <span className="text-sm text-muted-foreground">{figure.value.unit}</span>}
          </div>
        ) : (
          <div data-reason={figure.reason} title={reasonText(figure.reason)}>
            <span className={cn(MONO, "text-3xl font-semibold tracking-tight")}>{UNKNOWN}</span>
          </div>
        )}
        {children}
        <Spark bars={spark} tone={tone} />
      </CardContent>
    </Card>
  );
}

const countedFigure = (stat: Stat<Counted>): Stat<{ readonly text: string; readonly qualifier: string | null }> =>
  stat.kind === "known" ? { kind: "known", value: { text: count(stat.value.count), qualifier: stat.value.bound === "at-least" ? COPY.atLeast : null } } : stat;

/** The last 14 days of a daily series, as spark bars, or null when it is not served or any of those days could not be read. */
function sparkOf(series: Stat<{ readonly rows: readonly DayValues[]; readonly partial: boolean; readonly missing?: readonly UtcDay[] }>, end: UtcDay, names: readonly string[]): readonly number[] | null {
  if (series.kind === "unavailable") return null;
  return sparkBars(series.value.rows, end, 14, names, unreadDays(series.value.rows, series.value.partial, series.value.missing ?? []));
}

function Tiles({ model, sample, series, end }: { readonly model: GlobalStatsModel; readonly sample: boolean; readonly series: DailySeries; readonly end: UtcDay }) {
  const { invested, shelf } = model;
  // Not published yet: named once in the panel below, not drawn as an empty card here.
  const showInvested = !(invested.kind === "unavailable" && invested.reason === "not-served-yet");
  const paying = model.payingSettlements.kind === "known" ? model.payingSettlements.value : null;
  // The paying count was the line under Settlements; it is in the hover now, beside what the figure includes.
  const settlementsHint = titled(
    COPY.settlements.hint,
    paying === null ? null : COPY.settlements.paying(paying.bound === "at-least" ? `${COPY.atLeast} ${count(paying.count)}` : count(paying.count)),
  ).title;
  const tiles = [
    <Tile key="pensions" id="pensions" title={COPY.pensions.title} sample={sample} figure={countedFigure(model.pensions)} hint={COPY.pensions.hint} spark={sparkOf(series.pensions, end, ["pensions"])} />,
    <Tile
      key="settlements"
      id="settlements"
      title={COPY.settlements.title}
      sample={sample}
      figure={countedFigure(model.settlements)}
      hint={settlementsHint}
      spark={sparkOf(series.settlements, end, ["profit", "volume"])}
    />,
    ...(showInvested
      ? [
          <Tile
            key="invested"
            id="invested"
            title={COPY.invested.title}
            sample={sample}
            figure={
              invested.kind === "known" ? { kind: "known", value: { text: usdcText(invested.value.usdcRaw), unit: "USDC", qualifier: invested.value.bound === "at-least" ? COPY.atLeast : null } } : invested
            }
            // In the hover: the Assets table's Purchases column is hidden below md.
            hint={invested.kind === "known" && invested.value.buys !== null ? COPY.invested.buys(count(invested.value.buys), invested.value.buys === 1) : null}
            spark={sparkOf(series.invested, end, ["invested"])}
            tone="invested"
          />,
        ]
      : []),
    // Which assets are on offer, and of how many: the badges below say it, filled or outlined.
    <Tile key="shelf" id="shelf" title={COPY.shelf.title} sample={sample} figure={{ kind: "known", value: { text: count(shelf.offered.length) } }} hint={COPY.shelf.hint}>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {shelf.assets.map((asset) => (
          <Badge key={asset.mint} variant={asset.offered ? "secondary" : "outline"} className={cn("font-mono font-normal", asset.offered ? "" : "text-muted-foreground")}>
            {asset.symbol}
          </Badge>
        ))}
      </div>
    </Tile>,
  ];
  // Three tiles on two columns leave the last one alone: it takes the row.
  return <div className={cn("grid gap-4 sm:grid-cols-2", tiles.length === 4 ? "lg:grid-cols-4" : "sm:*:last:col-span-2 lg:grid-cols-3 lg:*:last:col-span-1")}>{tiles}</div>;
}

/** Which mode the SOL put aside came from: a share, a two-part meter, and each side's figures. */
function ByModeCard({ model, sample }: { readonly model: GlobalStatsModel; readonly sample: boolean }) {
  const { byMode } = model;
  const body = (() => {
    if (byMode.kind === "unavailable") return <Unread reason={byMode.reason} />;
    const profit = BigInt(byMode.value.profit?.savedRaw ?? "0");
    const volume = BigInt(byMode.value.volume?.savedRaw ?? "0");
    const total = profit + volume;
    if (total === 0n) return <p className="py-6 text-center text-sm text-muted-foreground">{COPY.byMode.nothing}</p>;
    const profitBps = Number((profit * 10_000n) / total);
    // From a cut read both sides are floors, so the split is an estimate.
    const floor = byMode.value.bound === "at-least";
    const sides = [
      { key: "profit" as const, bps: profitBps, totals: byMode.value.profit },
      { key: "volume" as const, bps: 10_000 - profitBps, totals: byMode.value.volume },
    ];
    return (
      <div className="flex flex-col gap-4">
        {/* "Profit" before the share: the line under it that said whose share it is went on 10-24. */}
        <Figure value={pct(profitBps, 2)} qualifier={floor ? `${COPY.byMode.label} ≈` : COPY.byMode.label} title={COPY.byMode.hint} />
        <div aria-hidden className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
          {sides.map((side) => (side.bps === 0 ? null : <div key={side.key} className={cn("h-full", SERIES[side.key].swatch)} style={{ width: `${side.bps / 100}%` }} />))}
        </div>
        <ul className="grid gap-1.5 text-xs">
          {sides.map((side) => (
            <li key={side.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2.5 shrink-0 rounded-[2px]", SERIES[side.key].swatch)} />
                {SERIES[side.key].label}
                <span className="text-muted-foreground">{pct(side.bps, 2)}</span>
              </span>
              <span className={cn(MONO, "text-muted-foreground")}>
                {/* A side the keeper did not send had no settlement in that mode: its zero is a true one. */}
                {`${floor ? `${COPY.atLeast} ` : ""}${COPY.byMode.row(formatSolAtMost(BigInt(side.totals?.savedRaw ?? "0"), 4), settlementsText(side.totals?.settlements ?? 0))}`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  })();
  return (
    <Card className="min-w-0" data-card="by-mode">
      <Head title={COPY.byMode.title} sample={sample} />
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/** What one settlement puts aside, on average: SOL put aside over the settlements that put something aside, from the same read. */
function AverageCard({ model, sample }: { readonly model: GlobalStatsModel; readonly sample: boolean }) {
  const { average } = model;
  const body = (() => {
    if (average.kind === "unavailable") return <Unread reason={average.reason} />;
    if (average.value === null) return <p className="py-6 text-center text-sm text-muted-foreground">{COPY.average.nothing}</p>;
    const figure = heroSol(average.value.lamports);
    // A floor over a floor is neither: an estimate. The unit sits beside the figure: the line under it that named SOL went on 10-24.
    return <Figure value={figure.text} unit="SOL" title={titled(figure.exact, COPY.average.hint).title} qualifier={average.value.bound === "at-least" ? "≈" : null} />;
  })();
  return (
    <Card className="min-w-0" data-card="average">
      <Head title={COPY.average.title} sample={sample} />
      <CardContent className="flex min-h-32 flex-col justify-center">{body}</CardContent>
    </Card>
  );
}

/** Everything the keeper does not publish yet, said ONCE, with the way to see it on the sample. */
function ComingCard() {
  return (
    <Card className="border border-dashed ring-0" data-card="coming">
      <CardHeader>
        <CardTitle>{COPY.coming.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <AppLink href={urlWithMode(DASHBOARD_PATH, "mock")} className="text-sm font-medium underline underline-offset-4 hover:text-foreground">
          {COPY.coming.link}
        </AppLink>
      </CardContent>
    </Card>
  );
}

/** One served daily series, as the cards take it: rows, whether days may be missing, and the days known to be. */
type Daily = Stat<{ readonly rows: readonly DayValues[]; readonly partial: boolean; readonly missing?: readonly UtcDay[] }>;

interface DailySeries {
  readonly saved: Daily;
  readonly savedByMode: Daily;
  readonly traded: Daily;
  readonly settlements: Daily;
  readonly pensions: Daily;
  readonly invested: Daily;
}

/** Every chart's days, from the model's served rows, once. */
function dailySeries(model: GlobalStatsModel): DailySeries {
  const daily = model.daily;
  const from = (build: (rows: readonly StatsDay[]) => { readonly rows: readonly DayValues[]; readonly missing: readonly UtcDay[] }): Daily => {
    if (daily.kind === "unavailable") return daily;
    const read = build(daily.value.rows);
    return { kind: "known", value: { rows: read.rows, partial: daily.value.partial, missing: read.missing } };
  };
  const whole = (build: (rows: readonly StatsDay[]) => readonly DayValues[]) => from((rows) => ({ rows: build(rows), missing: [] }));
  return {
    saved: whole(savedTotalByDay),
    savedByMode: whole(savedByDay),
    traded: from(tradedByDay),
    settlements: whole(settlementsByDay),
    pensions: from(pensionsByDay),
    invested:
      model.investedDaily.kind === "known"
        ? { kind: "known", value: { rows: investedByDay(model.investedDaily.value.rows), partial: model.investedDaily.value.partial } }
        : model.investedDaily,
  };
}

const rowsOf = (series: Daily): readonly DayValues[] | null => (series.kind === "known" ? series.value.rows : null);
const partialOf = (series: Daily): boolean => series.kind === "known" && (series.value.partial || (series.value.missing ?? []).length > 0);
const unavailableCaption = (stat: Stat<unknown>): string => (stat.kind === "unavailable" ? reasonText(stat.reason) : "");

/** The two lead cards: the reference's "Liquidity" and "Volume (24hr)" — the running total put aside, and the trading behind it. */
function LeadCards({ model, sample, series, end, first }: { readonly model: GlobalStatsModel; readonly sample: boolean; readonly series: DailySeries; readonly end: UtcDay; readonly first: UtcDay | null }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <RunningTotalCard
        id="saved"
        title={COPY.saved.title}
        info={COPY.saved.info}
        sample={sample}
        headline={savedHeadline(model, sample, rowsOf(series.saved), partialOf(series.saved), end)}
        days={series.saved}
        series="saved"
        unit={{ label: "SOL", decimals: 9 }}
        end={end}
        first={first}
        emptyCaption={COPY.charts.empty}
        unavailableCaption={unavailableCaption(series.saved)}
        className="min-w-0"
      />
      <StackedBarsCard
        id="traded"
        title={COPY.traded.title}
        info={COPY.traded.info}
        sample={sample}
        headline={tradedHeadline(model, sample, rowsOf(series.traded), partialOf(series.traded), end)}
        approximate
        series={["profit", "volume"]}
        unit={{ label: "SOL", decimals: 9 }}
        days={series.traded}
        end={end}
        first={first}
        periods={["day", "week"]}
        views={["period", "cumulative"]}
        emptyCaption={COPY.charts.empty}
        unavailableCaption={unavailableCaption(series.traded)}
      />
    </div>
  );
}

/**
 * The four per-day charts. A title each, the unit in it where the axis has
 * none, and what it counts in the title's hover — no line under the title, no
 * count of days under the bars, and no per-asset footer, which repeated the
 * Assets table's Invested column (10-24).
 */
function Charts({ model, sample, series, end, first }: { readonly model: GlobalStatsModel; readonly sample: boolean; readonly series: DailySeries; readonly end: UtcDay; readonly first: UtcDay | null }) {
  const common = { sample, end, first } as const;

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <StackedBarsCard
          {...common}
          id="saved-per-day"
          title={COPY.charts.saved.title}
          series={["profit", "volume"]}
          unit={{ label: "SOL", decimals: 9 }}
          days={series.savedByMode}
          periods={["day", "week"]}
          views={["period", "cumulative", "share"]}
          emptyCaption={COPY.charts.empty}
          unavailableCaption={unavailableCaption(series.savedByMode)}
        />
        <StackedBarsCard
          {...common}
          id="settlements-per-day"
          title={COPY.charts.settlements.title}
          hint={COPY.charts.settlements.hint}
          series={["profit", "volume"]}
          unit={{ label: null, decimals: 0 }}
          days={series.settlements}
          periods={["day", "week"]}
          views={["period", "cumulative", "share"]}
          emptyCaption={COPY.charts.empty}
          unavailableCaption={unavailableCaption(series.settlements)}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ByModeCard model={model} sample={sample} />
        <AverageCard model={model} sample={sample} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <StackedBarsCard
          {...common}
          id="pensions-per-day"
          title={COPY.charts.pensions.title}
          hint={COPY.charts.pensions.hint}
          series={["pensions"]}
          unit={{ label: null, decimals: 0 }}
          days={series.pensions}
          // Distinct pensions do not add up across days, so there is no week and no running total.
          periods={["day"]}
          views={["period"]}
          emptyCaption={COPY.charts.empty}
          unavailableCaption={unavailableCaption(series.pensions)}
        />
        <StackedBarsCard
          {...common}
          id="invested-per-day"
          title={COPY.charts.invested.title}
          hint={COPY.charts.invested.hint}
          series={["invested"]}
          unit={{ label: "USDC", decimals: 6 }}
          days={series.invested}
          periods={["day", "week"]}
          views={["period", "cumulative"]}
          emptyCaption={COPY.charts.emptyInvested}
          unavailableCaption={unavailableCaption(series.invested)}
        />
      </div>
    </>
  );
}

/**
 * THE LEADERBOARD'S TOP, as a table: the reference's "Top Pairs", in this
 * protocol's terms. Each row is a pension a visitor can check on the chain —
 * except in the sample, whose placeholders are not addresses and link nowhere.
 */
function LeadersTable({ model, sample, mode }: { readonly model: GlobalStatsModel; readonly sample: boolean; readonly mode: UrlMode | null }) {
  const { leaders } = model;
  return (
    <Card className="min-w-0" data-card="leaders">
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <CardTitle>{COPY.leaders.title}</CardTitle>
          <InfoTip label={COPY.leaders.title}>{COPY.leaders.info}</InfoTip>
          <SampleBadge sample={sample} />
        </div>
        <CardAction>
          <AppLink href={mode === null ? "/leaderboard" : urlWithMode("/leaderboard", mode)} className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {COPY.leaders.seeAll}
          </AppLink>
        </CardAction>
      </CardHeader>
      <CardContent>
        {leaders.kind === "unavailable" ? (
          <p className="text-sm text-muted-foreground">{reasonText(leaders.reason)}</p>
        ) : leaders.value.length === 0 ? (
          // Nobody ranked, but somebody settled: every settlement put nothing aside (the board ranks only days that did).
          <p className="text-sm text-muted-foreground">{model.pensions.kind === "known" && model.pensions.value.count > 0 ? COPY.leaders.emptyNothingSaved : COPY.leaders.empty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">{COPY.leaders.rank}</TableHead>
                <TableHead>{COPY.leaders.pension}</TableHead>
                <TableHead className="text-right">{COPY.leaders.saved}</TableHead>
                <TableHead className="hidden text-right sm:table-cell">{COPY.leaders.traded}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{COPY.leaders.settlements}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{COPY.leaders.days}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leaders.value.map((leader) => (
                <TableRow key={leader.subject}>
                  <TableCell className={cn(MONO, "text-muted-foreground")}>{leader.rank}</TableCell>
                  <TableCell className={MONO}>
                    {sample ? (
                      shortHex(leader.subject)
                    ) : (
                      <a href={`https://solscan.io/account/${leader.subject}`} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline" title={leader.subject}>
                        {shortHex(leader.subject)}
                      </a>
                    )}
                  </TableCell>
                  <TableCell className={cn(MONO, "text-right")}>{`${formatSolAtMost(BigInt(leader.savedRaw), 4)} SOL`}</TableCell>
                  <TableCell className={cn(MONO, "hidden text-right text-muted-foreground sm:table-cell")}>{leader.tradedRaw === null ? UNKNOWN : `≈ ${formatSolAtMost(BigInt(leader.tradedRaw), 2)} SOL`}</TableCell>
                  <TableCell className={cn(MONO, "hidden text-right md:table-cell")}>{count(leader.settlements)}</TableCell>
                  <TableCell className={cn(MONO, "hidden text-right md:table-cell")}>{count(leader.activeDays)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * WHAT PENSIONS CAN BUY, AND WHAT THEY BOUGHT: the reference's "Top Tokens".
 * Every catalogue asset is listed, offered or not; the spend per asset is
 * there only when every purchase day was read, and a bar shows each one's share.
 */
function AssetsTable({ model, sample }: { readonly model: GlobalStatsModel; readonly sample: boolean }) {
  const { invested, shelf } = model;
  const spent = invested.kind === "known" ? invested.value.byAsset : null;
  // Spend not read: each dash carries the reason in its hover, no sentence under the table (10-24).
  const unread = spent === null ? titled(reasonText(invested.kind === "unavailable" ? invested.reason : "field-unreadable")) : {};
  const total = spent === null ? 0n : spent.reduce((sum, asset) => sum + BigInt(asset.usdcRaw), 0n);
  const known = new Set(shelf.assets.map((asset) => asset.mint));
  // An asset bought but no longer in the catalogue is still listed, by its address.
  const rows = [
    ...shelf.assets,
    ...(spent ?? []).filter((asset) => !known.has(asset.mint)).map((asset) => ({ mint: asset.mint, symbol: shortHex(asset.mint), name: COPY.assets.unlisted, offered: false })),
  ]
    .map((asset) => ({ ...asset, spend: spent?.find((row) => row.mint === asset.mint) ?? null }))
    .sort((a, b) => Number(b.offered) - Number(a.offered) || (BigInt(b.spend?.usdcRaw ?? "0") > BigInt(a.spend?.usdcRaw ?? "0") ? 1 : BigInt(b.spend?.usdcRaw ?? "0") < BigInt(a.spend?.usdcRaw ?? "0") ? -1 : 0));

  return (
    <Card className="min-w-0" data-card="assets">
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <CardTitle>{COPY.assets.title}</CardTitle>
          <SampleBadge sample={sample} />
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{COPY.assets.asset}</TableHead>
              <TableHead className="text-right">{COPY.assets.invested}</TableHead>
              <TableHead className="hidden w-32 sm:table-cell">{COPY.assets.share}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{COPY.assets.purchases}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((asset) => {
              const bps = asset.spend === null || total === 0n ? null : Number((BigInt(asset.spend.usdcRaw) * 10_000n) / total);
              return (
                <TableRow key={asset.mint}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className={cn(MONO, "font-medium")}>{asset.symbol}</span>
                      <span className="hidden truncate text-xs text-muted-foreground lg:inline">{asset.name}</span>
                      {asset.offered ? (
                        <Badge variant="secondary" className="font-normal">
                          {COPY.assets.onOffer}
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className={cn(MONO, "text-right")} {...unread}>
                    {spent === null ? UNKNOWN : asset.spend === null ? "0.00" : usdcText(asset.spend.usdcRaw)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {bps === null ? null : (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                          <div className={cn("h-full rounded-full", SERIES.invested.swatch)} style={{ width: `${bps / 100}%` }} />
                        </div>
                        <span className={cn(MONO, "w-12 text-right text-xs text-muted-foreground")}>{pct(bps, 1)}</span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className={cn(MONO, "hidden text-right md:table-cell")} {...unread}>
                    {spent === null ? UNKNOWN : count(asset.spend?.buys ?? 0)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function SampleStrip() {
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">
        {/* What the sample is for is the hover; that it is not real stays on screen. */}
        <span title={COPY.sampleNoticeHint}>
          <Badge variant="secondary" className="mr-1.5 align-baseline text-[0.6875rem]">
            {COPY.sampleBadge}
          </Badge>
          {COPY.sampleNotice}
        </span>{" "}
        <AppLink href={urlWithMode(DASHBOARD_PATH, "live")} className="font-medium text-foreground underline underline-offset-4">
          {COPY.seeLive}
        </AppLink>
      </p>
    </div>
  );
}

function Failed({ reason }: { readonly reason: Reason }) {
  return (
    <Card className="border border-dashed ring-0" data-reason={reason}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TriangleAlert aria-hidden className="size-4 text-amber-600 dark:text-amber-400" />
          {COPY.failedTitle}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{reasonText(reason)}</CardContent>
    </Card>
  );
}

export function GlobalStatsView({ model, now, mode = null }: { readonly model: GlobalStatsModel; readonly now: string; readonly mode?: UrlMode | null }) {
  const sample = model.source === "sample";
  // "Days are UTC" is the hover of these, not one of them (10-24).
  const meta = [
    ...(model.computedAt.kind === "known" ? [COPY.updated(timeAgo(model.computedAt.value, now))] : []),
    ...(model.firstDay.kind === "known" && model.firstDay.value === null ? [COPY.noSettlementYet] : []),
    // "From" only a first day the history provably starts on; a cut read's oldest day is not one.
    ...(model.firstDay.kind === "known" && model.firstDay.value !== null && model.lastDay.kind === "known" && model.lastDay.value !== null
      ? [model.firstDayProven ? COPY.span(dateLabel(model.firstDay.value), dateLabel(model.lastDay.value)) : COPY.spanUpTo(dateLabel(model.lastDay.value))]
      : []),
    // A charts block the service kept from an earlier read is said to be older.
    ...(model.statsComputedAt !== null && model.computedAt.kind === "known" && Date.parse(model.computedAt.value) - Date.parse(model.statsComputedAt) > STALE_STATS_MS
      ? [COPY.chartsUpdated(timeAgo(model.statsComputedAt, now))]
      : []),
  ];
  // The charts end on the day the figures were added up: later days are not zero, they are not known yet.
  const end =
    model.seriesEnd ?? (model.computedAt.kind === "known" ? model.computedAt.value.slice(0, 10) : model.lastDay.kind === "known" && model.lastDay.value !== null ? model.lastDay.value : now.slice(0, 10));
  const first = model.firstDay.kind === "known" ? model.firstDay.value : null;
  const series = dailySeries(model);
  const nothingPublished = [model.daily, model.investedDaily, model.byMode].every((stat) => stat.kind === "unavailable" && stat.reason === "not-served-yet");

  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      <section className="rise-in flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{COPY.title}</h1>
        {/*
          NO ROW STARTS WITH A BARE "·" (10-24): on a phone this line wraps, and
          a dot written between items began the second and third rows. Every
          item carries its dot before it; the line is pulled left by one dot
          and its gap, and clipped, so the dot that opens any row falls outside.
        */}
        <div className="overflow-hidden">
          <p className="-ml-4 flex flex-wrap gap-x-3 gap-y-1 pb-1 text-xs text-muted-foreground">
            {meta.map((item) => (
              <span key={item} className="flex items-center gap-3" title={COPY.daysUtc}>
                <span aria-hidden className="w-1 text-center">
                  ·
                </span>
                {item}
              </span>
            ))}
            {/* The way to the sample from Live on every screen size: the header's Live|Mock is not shown on a phone. */}
            {sample ? null : (
              <span className="flex items-center gap-3">
                <span aria-hidden className="w-1 text-center">
                  ·
                </span>
                <AppLink href={urlWithMode(DASHBOARD_PATH, "mock")} className="underline underline-offset-4 hover:text-foreground">
                  {COPY.seeSample}
                </AppLink>
              </span>
            )}
          </p>
        </div>
      </section>

      {sample ? <SampleStrip /> : null}

      {!model.feed.ok ? (
        <Failed reason={model.feed.reason} />
      ) : (
        <>
          <div className="rise-in rise-d1">
            <StatsStrip model={model} sample={sample} end={end} />
          </div>
          <div className="rise-in rise-d1">
            <LeadCards model={model} sample={sample} series={series} end={end} first={first} />
          </div>
          <div className="rise-in rise-d2">
            <Tiles model={model} sample={sample} series={series} end={end} />
          </div>
          <div className="rise-in rise-d3 flex flex-col gap-4 lg:gap-6">{nothingPublished ? <ComingCard /> : <Charts model={model} sample={sample} series={series} end={end} first={first} />}</div>
          <div className="rise-in rise-d3 grid gap-4 xl:grid-cols-2">
            <LeadersTable model={model} sample={sample} mode={mode} />
            <AssetsTable model={model} sample={sample} />
          </div>
        </>
      )}
    </div>
  );
}
