"use client";

/**
 * A CONNECTED PENSION'S FIRST READ, STILL IN FLIGHT (10-09) — the one screen
 * between Connect and the numbers.
 *
 * IT SAYS WHAT IT IS DOING. It used to be pulsing blocks and nothing else (G7):
 * a wait with no words looks the same at second two as at minute two, and it
 * had no end — the client sets no timeout on the read, so one that hung pulsed
 * for ever (G15). Now a visible line leads it:
 *
 *   from the start   "Reading your pension…"
 *   after 5 s        "· 8 s" beside it, counting (Elapsed.tsx)
 *   after 20 s       "Taking longer than usual · still reading", in its place
 *   after 45 s       a Reload page button — the one control that helps, since
 *                    a refresh asked for while a read runs is turned away at
 *                    its in-flight guard (use-live-dashboard.ts)
 *
 * The times count from when this screen appeared, in this browser: how long
 * the person has been waiting, which is the thing being said.
 *
 * ITS SHAPE IS THE PAGE'S. The blocks are laid out in DashboardMain's own
 * column and grid (dashboard-main.tsx) — the strip, then the rule and pension
 * cards in RULE_SLOT / PENSION_SLOT order, the hero, the chart, four tiles and
 * three holdings — so the page does not jump when the read lands. They do NOT
 * rise in: the real cards do that when they arrive (the sample's entrance), and
 * a skeleton that rose in first would make it play twice.
 *
 * FOR A SCREEN READER: the words are the region (role=status, aria-busy, its
 * accessible name fixed), and nothing else is in it. The count sits beside
 * them, aria-hidden — a status region is read out whole when anything in it
 * changes, and this changes every second — and so does the Reload button: a
 * control inside a polite region is spoken whenever it changes. The blocks
 * are hidden from it, and stand still for anyone who asked for less motion
 * (ui/skeleton.tsx); so does the line's glyph.
 *
 * WHY A SECOND REGION (review, 10-09): a busy region holds its changes back,
 * so "taking longer" said only inside it was never spoken, and the Reload
 * button arrived unannounced. Beside it, sr-only and NOT busy, a second status
 * is there and empty from the first render and says two sentences in the
 * whole wait: that it is slower than usual (20 s), then that a reload is the
 * way out (45 s). Nothing in it ticks, and the button itself stays outside.
 *
 * Only the live first read uses it. The frame /?mode=mock shows before Privy
 * answers is still LiveLoading with no props (LiveStates.tsx), frozen with the
 * sample (sample-golden.test.ts).
 */

import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { PENSION_SLOT, RULE_SLOT } from "@/components/dashboard-main";
import { Elapsed } from "@/components/live/Elapsed";
import { useReached } from "@/components/live/use-countdown";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";

/** The count appears beside the words. */
export const FIRST_READ_ELAPSED_MS = 5_000;
/** The words become "Taking longer than usual · still reading". */
export const FIRST_READ_SLOW_MS = 20_000;
/** Reload page is offered. */
export const FIRST_READ_RELOAD_MS = 45_000;

/**
 * DashboardMain's own column and card grid (dashboard-main.tsx), class for
 * class, so the blocks stand where the cards will. A div, not a second <main>:
 * this is drawn inside the plain frame's own (dashboard-shell.tsx PlainBody).
 * LiveFirstRead.test.ts fails if the two drift apart.
 */
const COLUMN = "flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6 xl:min-h-[calc(100dvh-3.5rem)] xl:gap-4 xl:p-4 xl:short:gap-3 xl:short:p-3";
const CARDS = "grid gap-4 md:grid-cols-[minmax(16rem,20rem)_1fr] lg:grid-cols-1 lg:gap-6 xl:flex-1 xl:grid-cols-[minmax(16rem,20rem)_1fr] xl:gap-4 xl:short:gap-3";

/** A card slot's place in the row, without its entrance: `rise-in` and its delay stay with the real card. */
export const stillSlot = (slot: string): string =>
  slot
    .split(" ")
    .filter((name) => !name.startsWith("rise-"))
    .join(" ");

export function LiveFirstRead({
  since: given,
}: {
  /** When the wait began, in this browser's clock. By default, when this screen appeared. */
  readonly since?: number;
}) {
  const [mounted] = useState(() => Date.now());
  const since = given ?? mounted;
  // Two moments, two re-renders: the count ticks in its own leaf.
  const slow = useReached(since + FIRST_READ_SLOW_MS);
  const reload = useReached(since + FIRST_READ_RELOAD_MS);

  return (
    <div className={COLUMN}>
      {/* Below sm the Reload button wraps under the words (they plus it need ~425 px;
          a 375 px screen gives 343), so two lines are reserved there: 28 + 8 + 28.
          The words keep the button's own h-7 and the lines pack to the top, so
          neither the 20 s words nor the 45 s Reload moves the words or the blocks
          below. From sm up it all fits on one line of the button's height. */}
      <div className="flex min-h-16 flex-wrap content-start items-center gap-x-3 gap-y-2 sm:min-h-7">
        <div className="flex min-h-7 min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin" />
          <p role="status" aria-busy="true" aria-label={LIVE_COPY.reading}>
            {slow ? LIVE_COPY.firstRead.slow : LIVE_COPY.firstRead.reading}
          </p>
          <Elapsed from={since} after={FIRST_READ_ELAPSED_MS} className="shrink-0" />
          {/* Not busy, there and empty from the start: its two sentences are insertions a screen reader reads (see the top of the file). */}
          <span role="status" className="sr-only">
            {reload ? LIVE_COPY.firstRead.reloadSpoken : slow ? LIVE_COPY.firstRead.slowSpoken : ""}
          </span>
        </div>
        {reload ? (
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RefreshCw aria-hidden />
            {LIVE_COPY.firstRead.reloadPage}
          </Button>
        ) : null}
      </div>

      {/* The strip: its h-9 badge and chips. */}
      <Skeleton aria-hidden="true" className="h-9 w-full" />

      <div aria-hidden="true" className={CARDS}>
        {/* The rule card: rate, what it invests in, the next and the last investment. */}
        <Card className={cn("h-fit xl:[--card-spacing:--spacing(3)]", stillSlot(RULE_SLOT))}>
          <CardHeader>
            <Skeleton className="h-4 w-28" />
          </CardHeader>
          <CardContent className="space-y-5 xl:space-y-4">
            <Skeleton className="h-4 w-full" />
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-1 w-full" />
            </div>
            <Skeleton className="h-14 w-full" />
          </CardContent>
        </Card>

        {/* The pension card: the hero, the chart (which takes the row's height on xl), four tiles, three holdings. */}
        <Card className={cn("overflow-hidden xl:[--card-spacing:--spacing(3)]", stillSlot(PENSION_SLOT))}>
          <CardHeader className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-12 w-48" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </CardHeader>
          <CardContent className="xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
            <Skeleton className="h-64 w-full sm:h-72 xl:h-auto xl:min-h-32 xl:flex-1" />
          </CardContent>
          <CardContent className="space-y-6 xl:space-y-4">
            <div className="@container">
              <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
                {[0, 1, 2, 3].map((tile) => (
                  <Skeleton key={tile} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            </div>
            <div className="space-y-2">
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-9 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
