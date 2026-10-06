/**
 * /dashboard — every SaverFi pension added up, to check the numbers and see how
 * the protocol is running (owner, 10-06: "Dashboard", not "Analytics").
 *
 * MOCK SHOWS THE SAMPLE, LIVE SHOWS THE REAL FIGURES, like the rest of the app:
 * `?mode=mock` is the sample, anything else reads the keeper
 * (src/lib/global-stats-mode.ts). In Mock nothing is fetched; in Live a failed
 * read is said on the page, never filled in with the sample.
 *
 * PUBLIC, like /leaderboard, and outside the (dashboard) route group: that
 * layout mounts the Privy provider for every visitor. A stranger gets a link
 * in the account slot and no wallet SDK; a returning visitor gets their bar.
 *
 * `now` IS RESOLVED ONCE, HERE, and passed down: the sample's days and every
 * "updated … ago" are measured against it.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";

import { CATALOGUE, OFFERED_LEGS } from "@sip/solana-core/client";

import { GlobalStatsModeToggle } from "@/components/global-stats-mode-toggle";
import { DASHBOARD_PATH, GlobalStatsView } from "@/components/global-stats-view";
import { LeaderboardAccountHost } from "@/components/leaderboard-account-host";
import { OpenPension } from "@/components/open-pension";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { toSolanaPublicConfig } from "@/lib/config";
import { GLOBAL_STATS_COPY } from "@/lib/global-stats-copy";
import { loadGlobalStats } from "@/lib/global-stats-load";
import { buildGlobalStats, known, type Shelf } from "@/lib/global-stats-model";
import { decideGlobalStatsMode } from "@/lib/global-stats-mode";
import { readSolPriceCached } from "@/lib/global-stats-price";
import { SAMPLE_USDC_RAW_PER_SOL, sampleGlobalStatsBody } from "@/lib/global-stats-sample";
import { loadConfig } from "@/lib/load-config";
import { SESSION_HINT_COOKIE } from "@/lib/session-hint";

export const metadata: Metadata = {
  title: GLOBAL_STATS_COPY.metaTitle,
  description: GLOBAL_STATS_COPY.metaDescription,
};

// Read at request time. The keeper read has its own shared cache (60 s), and so
// does the SOL price, so a visitor costs a cached read, not an upstream request.
export const dynamic = "force-dynamic";

/** What a pension can choose to buy, from the app's own list. */
const SHELF: Shelf = {
  offered: OFFERED_LEGS.map((leg) => leg.symbol),
  listed: CATALOGUE.length,
  symbolOf: Object.fromEntries(CATALOGUE.map((asset) => [asset.mint, asset.symbol])),
};

export default async function DashboardPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const now = new Date().toISOString();
  const decision = decideGlobalStatsMode((await searchParams)["mode"], (await cookies()).get(SESSION_HINT_COOKIE)?.value);
  const { mode, showSample, returning, control } = decision;

  const model = showSample
    ? buildGlobalStats({
        source: "sample",
        feed: { ok: true, body: sampleGlobalStatsBody(now, OFFERED_LEGS.map((leg) => leg.mint)) },
        price: known(SAMPLE_USDC_RAW_PER_SOL),
        shelf: SHELF,
      })
    : await loadGlobalStats({ shelf: SHELF, readPrice: readSolPriceCached });

  const loaded = loadConfig();
  const config = loaded.ok ? toSolanaPublicConfig(loaded.config) : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        current="dashboard"
        mode={mode}
        control={control ? <GlobalStatsModeToggle mode={showSample ? "mock" : "live"} path={DASHBOARD_PATH} /> : null}
        // NO CONNECT BUTTON HERE, as on /leaderboard: connecting needs the
        // Privy provider this page deliberately does not mount.
        account={returning && config !== null ? <LeaderboardAccountHost config={config} /> : <OpenPension returning={returning} mode={mode} />}
        activitySheet={<p className="p-4 text-sm text-muted-foreground">{GLOBAL_STATS_COPY.sheet}</p>}
      />

      <main className="flex min-w-0 flex-1 flex-col gap-5 p-4 lg:gap-6 lg:p-6">
        <GlobalStatsView model={model} now={now} />
      </main>

      <SiteFooter now={now} mode={mode} />
    </div>
  );
}
