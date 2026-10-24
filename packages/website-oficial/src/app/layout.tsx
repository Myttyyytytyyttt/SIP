import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Geist, Geist_Mono } from "next/font/google";

import { RouteLoaderProvider } from "@/components/route-loader";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { rootMetadata } from "@/lib/seo";
import { siteUrl } from "@/lib/site-url";

import "./globals.css";

/**
 * Geist for words, Geist Mono for every number — the two variables that
 * globals.css's @theme block reads. Loaded once, here.
 */
const sans = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

/**
 * EVERY PAGE'S DEFAULTS, from src/lib/seo.ts: the landing's title and
 * description, the site's social card, and metadataBase — the configured site
 * address (src/lib/site-url.ts) that every relative canonical and image URL is
 * made absolute against. Phantom reads og:title before <title>, so og:title is
 * "SaverFi" here and on every page where a wallet connects. Each page adds its
 * own canonical, robots and card text (SITE_PAGES).
 *
 * NO `icons` KEY ON PURPOSE. Declaring one here overrides Next's file
 * convention, and the icons now come from src/app/{favicon.ico,icon.png,
 * apple-icon.png} — generated from the brand mark, content-hashed, and
 * emitted with their own sizes and types. The old public/favicon.ico was
 * Nuvem's mark and is gone: it would also have collided with app/favicon.ico.
 */
export const metadata: Metadata = rootMetadata(siteUrl());

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: next-themes writes the theme class onto <html>
    // before React hydrates, and that one attribute is allowed to differ.
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={200}>
            {/* Here, above every layout, because the tabs cross them: the loader between tabs outlives each page. */}
            <RouteLoaderProvider>{children}</RouteLoaderProvider>
          </TooltipProvider>
        </ThemeProvider>
        {/* Vercel Web Analytics: page views, referrers, countries and devices, without cookies and
            without identifying anyone. ONLY ON VERCEL (VERCEL=1, set on every Vercel build and
            runtime): there the script is served from this site's own /_vercel/insights, which the
            CSP's 'self' already allows. Anywhere else it would load a debug script from
            va.vercel-scripts.com that the CSP blocks, leaving a red console line in every local run. */}
        {process.env.VERCEL === "1" ? <Analytics /> : null}
      </body>
    </html>
  );
}
