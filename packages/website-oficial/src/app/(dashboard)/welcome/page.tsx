/**
 * /welcome — the landing, whoever is looking (see components/welcome-landing.tsx).
 * Inside the (dashboard) layout for the Privy session the landing's Connect uses.
 */

import type { Metadata } from "next";

import { WelcomeLanding } from "@/components/welcome-landing";
import { loadConfig } from "@/lib/load-config";
import { SITE_PAGES, pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

/** The same landing as "/", so "/" is its canonical address (10-22): one page in the index, not two. */
export const metadata: Metadata = pageMetadata(SITE_PAGES.welcome);

export default function WelcomePage() {
  return <WelcomeLanding walletsConfigured={loadConfig().ok} />;
}
