/**
 * /activity — the same pension, with its history full width.
 *
 * A REAL ROUTE, not an anchor. The feed used to be `#activity`, a link into a
 * sidebar that only exists from `lg` up: on a phone the nav item went nowhere.
 * Now it is a page, it shares the frame's Privy session and live store with `/`,
 * and the mode rules apply to it unchanged — a connected pension key gets its
 * own history here too, and ?mode=mock cannot force the sample onto it.
 */

import type { Metadata } from "next";

import { DashboardView } from "@/components/dashboard-shell";
import { SITE_PAGES, pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

/**
 * NOT INDEXED, LINKS FOLLOWED (10-22): a visitor without a wallet is sent on to
 * the landing, and a connected pension sees its own history. Its own title, so
 * a tab of it no longer reads as the landing.
 */
export const metadata: Metadata = pageMetadata(SITE_PAGES.activity);

export default function ActivityPage() {
  return <DashboardView view="activity" />;
}
