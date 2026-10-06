/**
 * THE PUBLIC DASHBOARD'S BODY, as a pure function of its model.
 *
 * The reference's composition (owner, 09-30: Uniswap's board on Blockworks, "a
 * nuestro estilo shadcn"), top to bottom: two wide cards with one large centred
 * figure, a row of counters, two stacked-bar charts, two single-figure cards,
 * two more charts. Each card: a title with its "?", one grey line, the figure.
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
import { StackedBarsCard } from "@/components/global-stats-chart";
import { InfoTip } from "@/components/info-tip";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatSolAtMost, formatSol, formatUsd } from "@/lib/amounts";
import { MONO } from "@/lib/classes";
import { urlWithMode } from "@/lib/dashboard-mode";
import { count, dateLabel, pct, shortHex, timeAgo } from "@/lib/format";
import { GLOBAL_STATS_COPY } from "@/lib/global-stats-copy";
import { dollarsFor, type Counted, type GlobalStatsModel, type Raw, type Reason, type Stat, type UtcDay } from "@/lib/global-stats-model";
import { SERIES, investedByDay, pensionsByDay, savedByDay, settlementsByDay } from "@/lib/global-stats-series";
import { cn } from "@/lib/utils";

const COPY = GLOBAL_STATS_COPY;

/** The route this page lives at: its own links carry a mode onto it. */
export const DASHBOARD_PATH = "/dashboard";

const reasonText = (reason: Reason): string => COPY.reason[reason];

/** "1 pension" / "24 pensions". */
const pensionsText = (n: number): string => (n === 1 ? "1 pension" : `${count(n)} pensions`);
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

/** A card's head: title, its "?", the sample badge, and one grey line. */
function Head({ title, info, description, sample }: { readonly title: string; readonly info: string; readonly description?: string; readonly sample: boolean }) {
  return (
    <CardHeader>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <CardTitle>{title}</CardTitle>
        <InfoTip label={title}>{info}</InfoTip>
        <SampleBadge sample={sample} />
      </div>
      {description === undefined ? null : <CardDescription>{description}</CardDescription>}
    </CardHeader>
  );
}

/** The large centred figure and what it is, with any qualifier before it. */
function Figure({ value, qualifier, caption, title, size = "hero" }: { readonly value: string; readonly qualifier?: string | null; readonly caption: string; readonly title?: string; readonly size?: "hero" | "tile" }) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <div className="flex flex-wrap items-baseline justify-center gap-x-2">
        {qualifier === null || qualifier === undefined ? null : <span className="text-base text-muted-foreground">{qualifier}</span>}
        <span
          className={cn(MONO, "font-semibold tracking-tight", size === "hero" ? "text-4xl sm:text-5xl" : "text-3xl sm:text-4xl")}
          {...(title === undefined ? {} : { title })}
        >
          {value}
        </span>
      </div>
      <div className="text-sm">{caption}</div>
    </div>
  );
}

/** A figure nobody could read: a dash, and why. Never a 0. */
function Unread({ caption, reason, size = "hero" }: { readonly caption: string; readonly reason: Reason; readonly size?: "hero" | "tile" }) {
  return (
    <div className="flex flex-col items-center gap-1 text-center" data-reason={reason}>
      <Figure value="—" caption={caption} size={size} />
      <p className="max-w-xs text-xs text-muted-foreground">{reasonText(reason)}</p>
    </div>
  );
}

/** "≈ $X at today's SOL price" — a floor when the SOL total is one, and never $0 for a price nobody read. */
function DollarLine({ total, price, sample, atLeast = false }: { readonly total: Stat<{ readonly lamports: Raw }>; readonly price: Stat<Raw>; readonly sample: boolean; readonly atLeast?: boolean }) {
  if (total.kind === "unavailable") return null;
  const dollars = dollarsFor(total, price);
  if (dollars.kind === "unavailable") return <p className="text-sm text-muted-foreground">{COPY.noDollars(reasonText(dollars.reason))}</p>;
  const usd = formatUsd(BigInt(dollars.value));
  const sentence = sample ? (atLeast ? COPY.atLeastSampleDollars(usd) : COPY.sampleDollars(usd)) : atLeast ? COPY.atLeastDollars(usd) : COPY.dollars(usd);
  return <p className="text-sm text-muted-foreground">{sentence}</p>;
}

function SavedHero({ model, sample }: { readonly model: GlobalStatsModel; readonly sample: boolean }) {
  const { saved } = model;
  const floor = saved.kind === "known" && saved.value.bound === "at-least";
  const pensions = model.pensions.kind === "known" ? model.pensions.value : null;
  // A cut read's first day is only the oldest day that was READ: no "since" then.
  const provenance = [
    ...(pensions === null ? [] : [pensions.bound === "at-least" ? COPY.acrossAtLeast(pensionsText(pensions.count)) : COPY.across(pensionsText(pensions.count))]),
    ...(!floor && pensions?.bound !== "at-least" && model.firstDay.kind === "known" && model.firstDay.value !== null ? [COPY.since(dateLabel(model.firstDay.value))] : []),
  ].join(" · ");
  const info = saved.kind === "known" && saved.value.bound === "at-least" ? `${COPY.saved.info} ${COPY.saved.atLeastInfo}` : COPY.saved.info;
  return (
    <Card className="min-w-0" data-card="saved">
      <Head title={COPY.saved.title} info={info} description={COPY.saved.description} sample={sample} />
      <CardContent className="flex flex-col items-center gap-2 py-4">
        {saved.kind === "known" ? (
          <>
            <Figure
              value={heroSol(saved.value.lamports).text}
              title={heroSol(saved.value.lamports).exact}
              qualifier={saved.value.bound === "at-least" ? COPY.saved.atLeast : null}
              caption={COPY.saved.caption}
            />
            <DollarLine total={saved} price={model.solPrice} sample={sample} atLeast={floor} />
            {provenance === "" ? null : <p className="text-xs text-muted-foreground">{provenance}</p>}
          </>
        ) : (
          <Unread caption={COPY.saved.caption} reason={saved.reason} />
        )}
      </CardContent>
    </Card>
  );
}

function TradedHero({ model, sample }: { readonly model: GlobalStatsModel; readonly sample: boolean }) {
  const { traded } = model;
  return (
    <Card className="min-w-0" data-card="traded">
      <Head title={COPY.traded.title} info={COPY.traded.info} description={COPY.traded.description} sample={sample} />
      <CardContent className="flex flex-col items-center gap-2 py-4">
        {traded.kind === "known" ? (
          <>
            <Figure value={heroSol(traded.value.lamports).text} title={heroSol(traded.value.lamports).exact} qualifier="≈" caption={COPY.traded.caption} />
            <DollarLine total={traded} price={model.solPrice} sample={sample} />
            <p className="text-xs text-muted-foreground">{traded.value.partial ? `${COPY.traded.provenance} ${COPY.traded.partial}` : COPY.traded.provenance}</p>
          </>
        ) : (
          <Unread caption={COPY.traded.caption} reason={traded.reason} />
        )}
      </CardContent>
    </Card>
  );
}

/** A counter: a figure that is known, or a dash and why. */
function Tile({
  id,
  title,
  info,
  sample,
  figure,
  caption,
}: {
  readonly id: string;
  readonly title: string;
  readonly info: string;
  readonly sample: boolean;
  readonly figure: Stat<{ readonly text: string; readonly qualifier?: string | null }>;
  readonly caption: string;
}) {
  return (
    <Card className="min-w-0" data-card={id}>
      <Head title={title} info={info} sample={sample} />
      <CardContent className="flex flex-col items-center gap-1 py-2">
        {figure.kind === "known" ? (
          <Figure value={figure.value.text} qualifier={figure.value.qualifier ?? null} caption={caption} size="tile" />
        ) : (
          <Unread caption={caption} reason={figure.reason} size="tile" />
        )}
      </CardContent>
    </Card>
  );
}

const countedFigure = (stat: Stat<Counted>): Stat<{ readonly text: string; readonly qualifier: string | null }> =>
  stat.kind === "known" ? { kind: "known", value: { text: count(stat.value.count), qualifier: stat.value.bound === "at-least" ? COPY.atLeast : null } } : stat;

function Tiles({ model, sample }: { readonly model: GlobalStatsModel; readonly sample: boolean }) {
  const { invested, shelf } = model;
  // Not published yet: named once in the panel below, not drawn as an empty card here.
  const showInvested = !(invested.kind === "unavailable" && invested.reason === "not-served-yet");
  const paying = model.payingSettlements.kind === "known" ? model.payingSettlements.value : null;
  const settlementsCaption =
    paying === null ? COPY.settlements.caption : COPY.settlements.paying(paying.bound === "at-least" ? `${COPY.atLeast} ${count(paying.count)}` : count(paying.count));
  const tiles = [
    <Tile key="pensions" id="pensions" title={COPY.pensions.title} info={COPY.pensions.info} sample={sample} figure={countedFigure(model.pensions)} caption={COPY.pensions.caption} />,
    <Tile key="settlements" id="settlements" title={COPY.settlements.title} info={COPY.settlements.info} sample={sample} figure={countedFigure(model.settlements)} caption={settlementsCaption} />,
    ...(showInvested
      ? [
          <Tile
            key="invested"
            id="invested"
            title={COPY.invested.title}
            info={COPY.invested.info}
            sample={sample}
            figure={invested.kind === "known" ? { kind: "known", value: { text: usdcText(invested.value.usdcRaw), qualifier: invested.value.bound === "at-least" ? COPY.atLeast : null } } : invested}
            caption={invested.kind === "known" && invested.value.buys !== null ? COPY.invested.caption(count(invested.value.buys)) : COPY.invested.captionNoBuys}
          />,
        ]
      : []),
    <Tile
      key="shelf"
      id="shelf"
      title={COPY.shelf.title}
      info={COPY.shelf.info}
      sample={sample}
      figure={{ kind: "known", value: { text: count(shelf.offered.length) } }}
      caption={COPY.shelf.caption(shelf.offered.join(", "), count(shelf.listed))}
    />,
  ];
  // Three tiles on two columns leave the last one alone: it takes the row.
  return <div className={cn("grid gap-4 sm:grid-cols-2", tiles.length === 4 ? "lg:grid-cols-4" : "sm:*:last:col-span-2 lg:grid-cols-3 lg:*:last:col-span-1")}>{tiles}</div>;
}

/** Which mode the SOL put aside came from: a share, a two-part meter, and each side's figures. */
function ByModeCard({ model, sample }: { readonly model: GlobalStatsModel; readonly sample: boolean }) {
  const { byMode } = model;
  const body = (() => {
    if (byMode.kind === "unavailable") return <Unread caption={COPY.byMode.caption} reason={byMode.reason} size="tile" />;
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
        <Figure value={pct(profitBps, 2)} qualifier={floor ? "≈" : null} caption={COPY.byMode.caption} size="tile" />
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
      <Head title={COPY.byMode.title} info={COPY.byMode.info} description={COPY.byMode.description} sample={sample} />
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/** What one settlement puts aside, on average: SOL put aside over the settlements that put something aside, from the same read. */
function AverageCard({ model, sample }: { readonly model: GlobalStatsModel; readonly sample: boolean }) {
  const { average } = model;
  const body = (() => {
    if (average.kind === "unavailable") return <Unread caption={COPY.average.caption} reason={average.reason} size="tile" />;
    if (average.value === null) return <p className="py-6 text-center text-sm text-muted-foreground">{COPY.average.nothing}</p>;
    const figure = heroSol(average.value.lamports);
    // A floor over a floor is neither: an estimate.
    return <Figure value={figure.text} title={figure.exact} qualifier={average.value.bound === "at-least" ? "≈" : null} caption={COPY.average.caption} size="tile" />;
  })();
  return (
    <Card className="min-w-0" data-card="average">
      <Head title={COPY.average.title} info={COPY.average.info} description={COPY.average.description} sample={sample} />
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
        <CardDescription>{COPY.coming.body}</CardDescription>
      </CardHeader>
      <CardContent>
        <AppLink href={urlWithMode(DASHBOARD_PATH, "mock")} className="text-sm font-medium underline underline-offset-4 hover:text-foreground">
          {COPY.coming.link}
        </AppLink>
      </CardContent>
    </Card>
  );
}

function Charts({ model, sample, end }: { readonly model: GlobalStatsModel; readonly sample: boolean; readonly end: UtcDay }) {
  const first = model.firstDay.kind === "known" ? model.firstDay.value : null;
  const daily = model.daily;
  const unavailableCaption = (stat: Stat<unknown>): string => (stat.kind === "unavailable" ? reasonText(stat.reason) : "");
  const saved = daily.kind === "known" ? { kind: "known" as const, value: { rows: savedByDay(daily.value.rows), partial: daily.value.partial } } : daily;
  const settlements = daily.kind === "known" ? { kind: "known" as const, value: { rows: settlementsByDay(daily.value.rows), partial: daily.value.partial } } : daily;
  const pensions = (() => {
    if (daily.kind === "unavailable") return daily;
    const read = pensionsByDay(daily.value.rows);
    return { kind: "known" as const, value: { rows: read.rows, partial: daily.value.partial, missing: read.missing } };
  })();
  const invested = model.investedDaily.kind === "known" ? { kind: "known" as const, value: { rows: investedByDay(model.investedDaily.value.rows), partial: model.investedDaily.value.partial } } : model.investedDaily;
  const byAsset =
    model.invested.kind === "known" && model.invested.value.byAsset.length > 0
      ? `${COPY.charts.byAsset}: ${model.invested.value.byAsset.map((asset) => `${model.shelf.symbolOf[asset.mint] ?? shortHex(asset.mint)} ${usdcText(asset.usdcRaw)} USDC`).join(" · ")}`
      : null;
  const common = { sample, end, first } as const;

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <StackedBarsCard
          {...common}
          id="saved"
          title={COPY.charts.saved.title}
          description={COPY.charts.saved.description}
          info={COPY.charts.saved.info}
          series={["profit", "volume"]}
          unit={{ label: "SOL", decimals: 9 }}
          days={saved}
          daysOf="saving"
          periods={["day", "week"]}
          views={["period", "cumulative", "share"]}
          emptyCaption={COPY.charts.empty}
          unavailableCaption={unavailableCaption(saved)}
        />
        <StackedBarsCard
          {...common}
          id="settlements"
          title={COPY.charts.settlements.title}
          description={COPY.charts.settlements.description}
          info={COPY.charts.settlements.info}
          series={["profit", "volume"]}
          unit={{ label: null, decimals: 0 }}
          days={settlements}
          periods={["day", "week"]}
          views={["period", "cumulative", "share"]}
          emptyCaption={COPY.charts.empty}
          unavailableCaption={unavailableCaption(settlements)}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ByModeCard model={model} sample={sample} />
        <AverageCard model={model} sample={sample} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <StackedBarsCard
          {...common}
          id="pensions"
          title={COPY.charts.pensions.title}
          description={COPY.charts.pensions.description}
          info={COPY.charts.pensions.info}
          series={["pensions"]}
          unit={{ label: null, decimals: 0 }}
          days={pensions}
          // Distinct pensions do not add up across days, so there is no week and no running total.
          periods={["day"]}
          views={["period"]}
          emptyCaption={COPY.charts.empty}
          unavailableCaption={unavailableCaption(pensions)}
        />
        <StackedBarsCard
          {...common}
          id="invested"
          title={COPY.charts.invested.title}
          description={COPY.charts.invested.description}
          info={COPY.charts.invested.info}
          series={["invested"]}
          unit={{ label: "USDC", decimals: 6 }}
          days={invested}
          periods={["day", "week"]}
          views={["period", "cumulative"]}
          emptyCaption={COPY.charts.emptyInvested}
          unavailableCaption={unavailableCaption(invested)}
          daysOf="purchase"
          footer={byAsset}
        />
      </div>
    </>
  );
}

function SampleStrip() {
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">
        <Badge variant="secondary" className="mr-1.5 align-baseline text-[0.6875rem]">
          {COPY.sampleBadge}
        </Badge>
        {COPY.sampleNotice}{" "}
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
        <CardDescription>{COPY.failedDescription}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{reasonText(reason)}</CardContent>
    </Card>
  );
}

export function GlobalStatsView({ model, now }: { readonly model: GlobalStatsModel; readonly now: string }) {
  const sample = model.source === "sample";
  const meta = [
    ...(model.computedAt.kind === "known" ? [COPY.updated(timeAgo(model.computedAt.value, now))] : []),
    COPY.daysUtc,
    ...(model.firstDay.kind === "known" && model.firstDay.value === null ? [COPY.noSettlementYet] : []),
    ...(model.firstDay.kind === "known" && model.firstDay.value !== null && model.lastDay.kind === "known" && model.lastDay.value !== null
      ? [COPY.span(dateLabel(model.firstDay.value), dateLabel(model.lastDay.value))]
      : []),
  ];
  // The charts end on the day the figures were added up: later days are not zero, they are not known yet.
  const end = model.computedAt.kind === "known" ? model.computedAt.value.slice(0, 10) : model.lastDay.kind === "known" && model.lastDay.value !== null ? model.lastDay.value : now.slice(0, 10);
  const nothingPublished = [model.daily, model.investedDaily, model.byMode].every((stat) => stat.kind === "unavailable" && stat.reason === "not-served-yet");

  return (
    <div className="flex flex-col gap-4 lg:gap-6">
      <section className="rise-in flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{COPY.title}</h1>
        <p className="max-w-prose text-sm text-muted-foreground sm:text-base">{COPY.subtitle}</p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {meta.map((item, index) => (
            <span key={item} className="flex items-center gap-3">
              {index === 0 ? null : <span aria-hidden>·</span>}
              {item}
            </span>
          ))}
        </p>
      </section>

      {sample ? <SampleStrip /> : null}

      {!model.feed.ok ? (
        <Failed reason={model.feed.reason} />
      ) : (
        <>
          <div className="rise-in rise-d1 grid gap-4 md:grid-cols-2">
            <SavedHero model={model} sample={sample} />
            <TradedHero model={model} sample={sample} />
          </div>
          <div className="rise-in rise-d2">
            <Tiles model={model} sample={sample} />
          </div>
          <div className="rise-in rise-d3 flex flex-col gap-4 lg:gap-6">{nothingPublished ? <ComingCard /> : <Charts model={model} sample={sample} end={end} />}</div>
        </>
      )}

      <p className="text-xs text-muted-foreground">{sample ? COPY.sampleFootnote : COPY.footnote}</p>
    </div>
  );
}
