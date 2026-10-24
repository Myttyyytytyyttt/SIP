/**
 * /sitemap.xml: every page that should be in the index, on the configured site
 * address (src/lib/seo.ts, INDEXED_PATHS) — the landing, the leaderboard, the
 * global dashboard, the prices page, and every docs page from the docs' index.
 * Nothing that redirects, points elsewhere or says noindex.
 */

import type { MetadataRoute } from "next";

import { sitemapEntries } from "@/lib/seo";
import { siteUrl } from "@/lib/site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries(siteUrl());
}
