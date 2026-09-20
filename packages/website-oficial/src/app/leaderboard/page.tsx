/**
 * /leaderboard — who is actually using this, ranked.
 *
 * OUTSIDE THE DASHBOARD GROUP, ON PURPOSE. The rankings are public: no Privy
 * session, no live store, no pension key. Mounting this inside the dashboard's
 * frame would put a second PrivyProvider in the tree (the bug that group exists
 * to prevent) and would make a page that is about other people depend on
 * whether you are signed in.
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

import { LeaderboardView, ScoringCard } from "@/components/leaderboard-view";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { fetchLeaderboard } from "@/lib/leaderboard";

export const metadata: Metadata = {
  title: "Leaderboard — SaverFi",
  description: "Who saves most often on SaverFi. Ranked on use, not on size.",
};

// Read at request time. The upstream fetch has its own shared cache, so this
// costs a cached read rather than a keeper request per visitor.
export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const result = await fetchLeaderboard();
  const now = new Date().toISOString();
  const scoring = result.ok ? <ScoringCard data={result.data} className="border-0 bg-transparent shadow-none" /> : null;

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
          <div className="p-2">{scoring ?? <p className="text-sm text-muted-foreground">Scoring is explained once the rankings load.</p>}</div>
        }
      />

      <div className="flex flex-1">
        <aside className="hidden w-80 shrink-0 border-r lg:block xl:w-88">
          <div className="sticky top-14 p-2">{scoring}</div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
          <header className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Leaderboard</h1>
            <p className="max-w-prose text-sm text-muted-foreground">
              Every settlement this keeper has recorded, grouped by pension. The ranking rewards saving often over saving big — the whole
              scoring rule is in the panel, and every number in it comes from the service that applied it.
            </p>
          </header>

          <LeaderboardView result={result} now={now} />
        </main>
      </div>

      <SiteFooter now={now} />
    </div>
  );
}
