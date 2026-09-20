/**
 * /leaderboard — who is actually using this, ranked.
 *
 * THE DATA COMES FROM THE KEEPER, not from a database this app talks to. The
 * site still holds no connection string; it reads one public URL, server side,
 * through a shared cache — see src/lib/leaderboard.ts.
 *
 * `now` IS RESOLVED ONCE, HERE, and passed down as a prop. Every date on the
 * page is measured against it, because a `new Date()` inside a component
 * renders one string on the server and another in the browser, which React
 * reports as a hydration mismatch on every load.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { LeaderboardView } from "@/components/leaderboard-view";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { fetchLeaderboard } from "@/lib/leaderboard";
import { SAMPLE_LEADERBOARD } from "@/lib/leaderboard-sample";

export const metadata: Metadata = {
  title: "Leaderboard — SaverFi",
  description: "Who saves most often on SaverFi. Ranked on use, not on size.",
};

// Read at request time. The upstream fetch has its own shared cache, so this
// costs a cached read rather than a keeper request per visitor.
export const dynamic = "force-dynamic";

export default async function LeaderboardPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // ?demo=1 fills the board with ten invented pensions, for looking at the page
  // when the chain has one row on it. It is labelled on screen, never silent.
  const sample = (await searchParams)["demo"] === "1";
  const result = sample ? ({ ok: true, data: SAMPLE_LEADERBOARD } as const) : await fetchLeaderboard();
  const now = new Date().toISOString();

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        current="leaderboard"
        // NO CONNECT BUTTON HERE. Connecting needs the Privy provider this page
        // deliberately does not mount, so the account slot is a door back to
        // the app rather than a button that would need a second provider.
        account={
          <Button asChild size="sm">
            <Link href="/">Open my pension</Link>
          </Button>
        }
        activitySheet={
          <p className="p-4 text-sm text-muted-foreground">
            The pensions that save most often. A day counts when a settlement actually charged; showing up beats showing
            up with more money.
          </p>
        }
      />

      <main className="flex min-w-0 flex-1 flex-col gap-5 p-4 lg:gap-6 lg:p-6">
        {/*
          THE BANNER. One wide card that says what this page ranks before any
          number appears — the reference board's shape, in this site's palette
          rather than its colours.
        */}
        <section className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-emerald-500/10 via-background to-background px-6 py-10 sm:px-10 sm:py-12">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: "radial-gradient(60% 70% at 85% 30%, rgba(16,185,129,0.12) 0%, transparent 65%)" }}
          />
          <div className="relative max-w-prose">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Leaderboard</h1>
            <p className="mt-2 text-sm text-muted-foreground sm:text-base">
              The pensions that feed themselves most often. Every settlement this keeper has recorded, grouped by
              pension and scored on use rather than size.
            </p>
          </div>
        </section>

        <LeaderboardView result={result} now={now} sample={sample} />
      </main>

      <SiteFooter now={now} />
    </div>
  );
}
