"use client";

import { useState } from "react";

import { ExternalLink, Flame, TriangleAlert, Trophy } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { dayLabel, timeAgo } from "@/lib/format";
import { formatSol, type LeaderboardEntry, type LeaderboardResult, type RangeName } from "@/lib/leaderboard";
import { cn } from "@/lib/utils";

const solscanAccountUrl = (address: string): string => `https://solscan.io/account/${address}`;

/** A streak worth a flame: more than three days, so the first run nobody notices does not earn one. */
const FIRE_FROM = 4;

/**
 * Gold, silver, bronze — and a plain number below. The trophy is the reference
 * board's one flourish, and it earns its place by making the top three legible
 * without reading a digit.
 */
function RankCell({ rank }: { readonly rank: number }) {
  const medal =
    rank === 1
      ? "bg-amber-400/15 text-amber-600 ring-amber-500/30 dark:text-amber-300"
      : rank === 2
        ? "bg-zinc-400/15 text-zinc-600 ring-zinc-400/30 dark:text-zinc-300"
        : "bg-orange-500/10 text-orange-700 ring-orange-600/30 dark:text-orange-300";
  if (rank > 3) return <span className="font-mono text-sm tabular-nums text-muted-foreground">{rank}</span>;
  return (
    <span className={cn("inline-flex size-7 items-center justify-center rounded-full ring-1", medal)}>
      <Trophy aria-hidden className="size-3.5" />
      <span className="sr-only">{rank}</span>
    </span>
  );
}

/**
 * An address, short enough to scan and long enough to recognise, linked to
 * Solscan — EXCEPT ON A SAMPLE ROW, which is linked to nothing. A link under an
 * invented score is the difference between "here is what the page looks like"
 * and a claim about whatever account that string happens to be.
 */
function SubjectCell({ address, sample }: { readonly address: string; readonly sample: boolean }) {
  if (sample) {
    return (
      <span className="font-mono text-sm text-muted-foreground" title="Sample row — not a real account">
        {address.slice(0, 4)}…{address.slice(-4)}
      </span>
    );
  }
  return (
    <a
      href={solscanAccountUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-center gap-1.5 font-mono text-sm hover:underline"
      title={address}
    >
      {address.slice(0, 4)}…{address.slice(-4)}
      <ExternalLink aria-hidden className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
      <span className="sr-only">View {address} on Solscan</span>
    </a>
  );
}

function StreakCell({ streak }: { readonly streak: number }) {
  if (streak < FIRE_FROM) return <span className="font-mono tabular-nums text-muted-foreground">{streak}</span>;
  return (
    <span className="inline-flex items-center gap-1 font-mono tabular-nums text-orange-600 dark:text-orange-400">
      <Flame aria-hidden className="size-3.5" />
      {streak}
      <span className="sr-only">days running</span>
    </span>
  );
}

const HEAD = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

function BoardTable({
  entries,
  sample,
  empty,
}: {
  readonly entries: readonly LeaderboardEntry[];
  readonly sample: boolean;
  /** What an empty cut means, which is not the same thing for a week as for all time. */
  readonly empty: string;
}) {
  if (entries.length === 0) {
    // EMPTY IS NOT AN ERROR, and it is not zeros either: it says what would
    // fill it. A QUIET WEEK IS NOT AN EMPTY HISTORY, which is what the old
    // sentence said while the line above it counted a settlement.
    return <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">{empty}</div>;
  }
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn("w-16 pl-4", HEAD)}>Rank</TableHead>
            <TableHead className={HEAD}>Pension</TableHead>
            <TableHead className={cn("hidden text-right sm:table-cell", HEAD)}>Days</TableHead>
            <TableHead className={cn("hidden text-right sm:table-cell", HEAD)}>Streak</TableHead>
            <TableHead className={cn("hidden text-right md:table-cell", HEAD)}>Saved</TableHead>
            <TableHead className={cn("hidden text-right lg:table-cell", HEAD)}>Traded</TableHead>
            <TableHead className={cn("pr-4 text-right", HEAD)}>Points</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.subject} className={cn(entry.rank <= 3 && "bg-muted/30")}>
              <TableCell className="pl-4">
                <RankCell rank={entry.rank} />
              </TableCell>
              <TableCell>
                <SubjectCell address={entry.subject} sample={sample} />
                {/* What the narrow screens drop, kept as one quiet line. */}
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground sm:hidden">
                  <span>
                    {entry.activeDays} {entry.activeDays === 1 ? "day" : "days"}
                  </span>
                  <span aria-hidden>·</span>
                  <StreakCell streak={entry.bestStreak} />
                  <span aria-hidden>·</span>
                  <span>{formatSol(entry.amountRaw)} SOL</span>
                </div>
              </TableCell>
              <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">{entry.activeDays}</TableCell>
              <TableCell className="hidden text-right sm:table-cell">
                <StreakCell streak={entry.bestStreak} />
              </TableCell>
              <TableCell className="hidden text-right font-mono text-sm tabular-nums md:table-cell">
                {formatSol(entry.amountRaw)} <span className="text-muted-foreground">SOL</span>
              </TableCell>
              <TableCell className="hidden text-right font-mono text-sm tabular-nums text-muted-foreground lg:table-cell">
                {entry.volumeRaw === undefined ? "—" : `${formatSol(entry.volumeRaw)} SOL`}
              </TableCell>
              <TableCell
                className="pr-4 text-right font-mono text-base font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                // WHERE THE NUMBER CAME FROM, on hover: the parts and the sum
                // they make. A score nobody can take apart is a score nobody
                // can argue with.
                title={
                  entry.breakdown === undefined
                    ? undefined
                    : `${entry.breakdown.participation} for showing up + ${entry.breakdown.size} for size + ${entry.breakdown.streak} for the streak` +
                      (entry.pointsExact === undefined ? "" : ` = ${entry.pointsExact}`)
                }
              >
                {entry.points}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** When the rankings cannot be read. It says so, and says why — never an empty table. */
function Unavailable({ detail }: { readonly detail: string }) {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TriangleAlert aria-hidden className="size-4 text-amber-600 dark:text-amber-400" />
          The rankings are unavailable
        </CardTitle>
        <CardDescription>
          {/* An empty board would say "nobody has saved anything", which is a
              different claim entirely — and, right now, an unproven one. */}
          This is not an empty leaderboard: it could not be read at all.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{detail}</CardContent>
    </Card>
  );
}

/**
 * ONE BOARD, ONE SCORE. There used to be a Savings tab and a Volume tab, which
 * asked a visitor to pick which ranking to believe before they had read either;
 * the score is now both measures together and the split lives in the tooltip.
 * The week/all-time cut stays — a weekly reset is what gives somebody who joins
 * on a Thursday a reason to trade.
 */
export function LeaderboardView({
  result,
  now,
  sample = false,
}: {
  readonly result: LeaderboardResult;
  readonly now: string;
  /** Built from example rows, and saying so on screen. */
  readonly sample?: boolean;
}) {
  const [range, setRange] = useState<RangeName>("season");

  if (!result.ok) return <Unavailable detail={result.detail} />;
  const { data } = result;
  const entries = data.boards.total[range];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            Season began <span className="text-foreground">{dayLabel(data.seasonStart)}</span>
          </span>
          <span aria-hidden>·</span>
          <span>Updated {timeAgo(data.computedAt, now)}</span>
          <span aria-hidden>·</span>
          <span>
            {data.coverage.subjects} {data.coverage.subjects === 1 ? "pension" : "pensions"}, {data.coverage.settlements}{" "}
            {data.coverage.settlements === 1 ? "settlement" : "settlements"}
          </span>
          {sample ? (
            // SAID ON SCREEN, not only in the URL. A board of invented pensions
            // that looks exactly like the real one is the one thing this page
            // must never be mistaken for.
            <Badge variant="secondary" className="font-normal">
              Sample data — not real pensions
            </Badge>
          ) : null}
        </div>

        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={range}
          // A toggle group hands back "" when the pressed item is pressed
          // again; that must not blank the board.
          onValueChange={(value) => setRange(value === "" ? range : (value as RangeName))}
          aria-label="Range"
        >
          <ToggleGroupItem value="season">This week</ToggleGroupItem>
          <ToggleGroupItem value="all">All time</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <BoardTable
        entries={entries}
        sample={sample}
        empty={
          range === "season"
            ? "No pension has been charged this week. All time has the ones that were."
            : "No pension has been charged yet. The first settlement puts somebody here."
        }
      />

      {/*
        NO RULE ON THE PAGE, by the owner's decision: a board that prints its
        own formula invites somebody to farm it. What the score is made of is
        still there for anyone who wants to check a number — the points column
        carries its own breakdown — but the thresholds are not the headline.
      */}
    </div>
  );
}
