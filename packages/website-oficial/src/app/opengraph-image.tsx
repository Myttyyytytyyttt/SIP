/**
 * /opengraph-image — the site's social card (src/components/og-card.tsx), built
 * once at build time. Every page without a card of its own names it explicitly
 * (SITE_CARD in src/lib/seo.ts says why it is named rather than inherited).
 */

import { ImageResponse } from "next/og";

import { OG_SIZE, SiteCard, markDataUrl } from "@/components/og-card";
import { SITE_CARD } from "@/lib/seo";

export const alt = SITE_CARD.alt;
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image(): Promise<ImageResponse> {
  return new ImageResponse(<SiteCard mark={await markDataUrl()} />, OG_SIZE);
}
