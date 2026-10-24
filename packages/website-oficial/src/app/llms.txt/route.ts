/**
 * /llms.txt — SaverFi described for an AI assistant (llmstxt.org): what it is in
 * two lines, then every docs page with its description and address. Built from
 * the docs' index at build time (src/lib/seo.ts, llmsTxt), plain text.
 */

import { llmsTxt } from "@/lib/seo";
import { siteUrl } from "@/lib/site-url";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(llmsTxt(siteUrl()), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
