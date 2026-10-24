/**
 * /robots.txt (owner, 10-22: the site goes into Google). Production lets every
 * page be crawled but /api/ and names the sitemap; a Vercel preview is closed
 * to every crawler. The rules and why are in src/lib/seo.ts (robotsFor).
 *
 * BUILT ONCE, at build time, from that build's environment — which on Vercel is
 * the deployment's own: a preview build is told VERCEL_ENV=preview.
 */

import type { MetadataRoute } from "next";

import { robotsFor } from "@/lib/seo";
import { siteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  return robotsFor(siteUrl());
}
