"use client";

import { useState } from "react";

import { ExternalLink, Flame, Info, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { dayLabel, timeAgo } from "@/lib/format";
import { BOARD_NAMES, formatSol, type BoardName, type LeaderboardData, type LeaderboardEntry, type LeaderboardResult, type RangeName } from "@/lib/leaderboard";
import { cn } from "@/lib/utils";

const solscanAccountUrl = (address: string): string => `https://solscan.io/account/${address}`;

/** The two boards, in the site's language, with what each one actually measures. */
const BOARD_COPY: Record<BoardName, { label: string; column: string; blurb: string; empty: string }> = {
  ahorro: {
    label: "Savings",
    column: "Saved",
    blurb: "Ranked on how often a pension was actually fed — not on how much money arrived with it.",
    empty: "No pension has been charged yet. The first settlement puts somebody here.",
  },
  volumen: {
    label: "Volume",
    column: "Traded",
    blurb: "The notional each settled window traded, measured from the wallet's own SOL movement. Scored more softly than saving, because volume is the easier of the two to manufacture.",
    empty: "No settled window has traded anything measurable yet.",
  },
};

/** 1, 2 and 3 are worth seeing at a glance; the rest is a number in a column. */
function RankChip({ rank }: { readonly rank: number }) {
  const medal =
    rank === 1
      ? "bg-amber-400/20 text-amber-700 ring-amber-500/30 dark:text-amber-300"
      : rank === 2
        ? "bg-zinc-400/20 text-zinc-700 ring-zinc-500/30 dark:text-zinc-300"
        : rank === 3
          ? "bg-orange-500/15 text-orange-700 ring-orange-600/30 dark:text-orange-300"
          : "text-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-full font-mono text-xs tabular-nums",
        rank <= 3 && "font-semibold ring-1",
        medal,
      )}
    >
      {rank}
    </span>
  );
}

/** An address, short enough to scan and long enough to recognise, linked to Solscan. */
function SubjectCell({ address }: { readonly address: string }) {
  return (
    <a
      href={solscanAccountUrl(address)}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-center gap-1.5 font-mono text-xs hover:underline"
      title={address}
    >
      {address.slice(0, 4)}…{address.slice(-4)}
      <ExternalLink aria-hidden className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
      <span className="sr-only">View {address} on Solscan</span>
    </a>
  );
}

function BoardTable({ entries, board, empty }: { readonly entries: readonly LeaderboardEntry[]; readonly board: BoardName; readonly empty: string }) {
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        {/* EMPTY IS NOT AN ERROR, and it is not zeros either: it says what would fill it. */}
        {empty}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-14 text-center">#</TableHead>
            <TableHead>Pension</TableHead>
            <TableHead className="text-right">Points</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Days</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Streak</TableHead>
            <TableHead className="text-right">{BOARD_COPY[board].column}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.subject}>
              <TableCell className="text-center">
                <RankChip rank={entry.rank} />
              </TableCell>
              <TableCell>
                <SubjectCell address={entry.subject} />
                <div className="text-xs text-muted-foreground sm:hidden">
                  {entry.activeDays} {entry.activeDays === 1 ? "day" : "days"} · streak {entry.bestStreak}
                </div>
              </TableCell>
              <TableCell
                className="text-right font-mono font-semibold tabular-nums"
                // WHERE THE NUMBER CAME FROM, on hover: a score nobody can take
                // apart is a score nobody can argue with.
                // The sum is shown, not just the parts: a breakdown whose
                // arithmetic a reader cannot finish is not a breakdown.
                title={
                  entry.breakdown === undefined
                    ? undefined
                    : `${entry.breakdown.participation} for showing up + ${entry.breakdown.size} for size + ${entry.breakdown.streak} for the streak` +
                      (entry.pointsExact === undefined ? "" : ` = ${entry.pointsExact}`)
                }
              >
                {entry.points}
              </TableCell>
              <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">{entry.activeDays}</TableCell>
              <TableCell className="hidden text-right font-mono tabular-nums sm:table-cell">
                {entry.bestStreak >= 3 ? (
                  <span className="inline-flex items-center gap-1 text-orange-600 dark:text-orange-400">
                    <Flame aria-hidden className="size-3.5" />
                    {entry.bestStreak}
                  </span>
                ) : (
                  entry.bestStreak
                )}
              </TableCell>
              <TableCell className="text-right font-mono text-sm tabular-nums">
                {formatSol(entry.amountRaw)} <span className="text-muted-foreground">SOL</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The rule, in words, FROM THE SERVICE'S OWN CONSTANTS. Every number below is
 * read out of the payload rather than typed here, so a page that says "10
 * points a day" is a page whose keeper is giving 10 points a day.
 */
export function ScoringCard({ data, className }: { readonly data: LeaderboardData; readonly className?: string }) {
  const { ahorro, volumen } = data.rules;
  const unitSol = formatSol(String(ahorro.sizeUnit), 6);
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Info aria-hidden className="size-4" />
          How points work
        </CardTitle>
        <CardDescription>Use beats size, deliberately.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <ul className="space-y-2">
          <li>
            <strong className="text-foreground">{ahorro.participation} points</strong>{" "}
            for every day your pension was actually charged — the
            same whether you saved {unitSol} SOL or fifty.
          </li>
          <li>
            <strong className="text-foreground">up to {ahorro.sizeCap} more</strong>{" "}
            for that day&apos;s size, on a log scale: 100× the amount
            is worth about 2× the points, and past ~100 SOL in a day it is worth nothing.
          </li>
          <li>
            <strong className="text-foreground">+{ahorro.streakPerDay} per consecutive day</strong>, up to +{ahorro.streakCap}. Coming back
            beats any single large day.
          </li>
          <li>A day that charged nothing does not count, so being swept is not an achievement.</li>
          <li>
            Volume is scored more softly — it caps at {volumen.sizeCap} instead of {ahorro.sizeCap} — because a wash trade moves notional and
            saves nobody anything.
          </li>
        </ul>
        <p className="border-t pt-3 text-xs">
          One pension is one competitor, however many trading wallets feed it. Nothing stops a person from holding several pensions: this is a
          ranking of addresses, not of people.
        </p>
      </CardContent>
    </Card>
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

export function LeaderboardView({ result, now }: { readonly result: LeaderboardResult; readonly now: string }) {
  const [board, setBoard] = useState<BoardName>("ahorro");
  const [range, setRange] = useState<RangeName>("season");

  if (!result.ok) return <Unavailable detail={result.detail} />;
  const { data } = result;
  const entries = data.boards[board][range];

  return (
    <div className="space-y-4 lg:space-y-6">
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
      </div>

      <Tabs value={board} onValueChange={(value) => setBoard(value as BoardName)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            {BOARD_NAMES.map((name) => (
              <TabsTrigger key={name} value={name}>
                {BOARD_COPY[name].label}
              </TabsTrigger>
            ))}
          </TabsList>

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

        {BOARD_NAMES.map((name) => (
          <TabsContent key={name} value={name} className="space-y-3">
            <p className="text-sm text-muted-foreground">{BOARD_COPY[name].blurb}</p>
            <BoardTable entries={data.boards[name][range]} board={name} empty={BOARD_COPY[name].empty} />
          </TabsContent>
        ))}
      </Tabs>

      {entries.length > 0 && (
        <Badge variant="secondary" className="font-normal">
          Showing {entries.length} {entries.length === 1 ? "pension" : "pensions"} · {range === "season" ? "this week" : "all time"}
        </Badge>
      )}
    </div>
  );
}
