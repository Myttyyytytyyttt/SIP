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
import { cookies } from "next/headers";

import { LeaderboardAccountHost } from "@/components/leaderboard-account-host";
import { OpenPension } from "@/components/open-pension";
import { LeaderboardView } from "@/components/leaderboard-view";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { toSolanaPublicConfig } from "@/lib/config";
import { fetchLeaderboard } from "@/lib/leaderboard";
import { loadConfig } from "@/lib/load-config";
import { SAMPLE_LEADERBOARD } from "@/lib/leaderboard-sample";
import { SESSION_HINT_COOKIE, hasSessionHint } from "@/lib/session-hint";

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
  // WHO GETS PRIVY HERE, AND WHO DOES NOT. This page is public and most of its
  // readers have no session: making every one of them download a wallet SDK to
  // render a corner of the chrome is a bad trade. So the decision is taken on
  // the server, before the first paint, from the session hint — a stranger gets
  // a link and no Privy at all, and somebody coming back gets the same bar they
  // have inside the app: their key, their balance and their way out.
  //
  // A STALE HINT COSTS A MOUNT, NOT A LIE: Privy answers "not authenticated",
  // the bar falls back to the link, and the hint clears itself.
  const returning = hasSessionHint((await cookies()).get(SESSION_HINT_COOKIE)?.value);
  const loaded = loadConfig();
  const config = loaded.ok ? toSolanaPublicConfig(loaded.config) : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        current="leaderboard"
        // NO CONNECT BUTTON HERE. Connecting needs the Privy provider this page
        // deliberately does not mount, so the account slot is a door back to
        // the app rather than a button that would need a second provider.
        account={returning && config !== null ? <LeaderboardAccountHost config={config} /> : <OpenPension returning={returning} />}
        activitySheet={
          <p className="p-4 text-sm text-muted-foreground">
            Who is actually using SaverFi, ranked. Points are earned by a pension being fed, they are permanent, and
            they are what SaverFi will recognise its savers by. Nothing to claim yet.
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
            {/*
              WHAT THIS IS AND WHY IT IS WORTH BEING ON IT — and not a word about
              how the score is computed. The last clause is the honest shape of a
              promise that has no date: points are being kept and will count,
              and there is nothing to claim today.
            */}
            <p className="mt-2 max-w-prose text-sm text-muted-foreground sm:text-base">
              The public record of who is actually using SaverFi — every pension here has been fed by its owner&apos;s
              own trading, on chain, where anyone can check it.
            </p>
            <p className="mt-3 max-w-prose text-sm text-muted-foreground sm:text-base">
              Points are earned by using it and they are permanent: they stack week after week, they cannot be bought,
              and they are what SaverFi will recognise its earliest savers by. Nothing to claim yet — the board is the
              receipt.
            </p>
          </div>
        </section>

        <LeaderboardView result={result} now={now} sample={sample} />
      </main>

      <SiteFooter now={now} />
    </div>
  );
}
