/**
 * /docs/<slug>/opengraph-image — a docs page's own social card: its group, its
 * title and its line (src/components/og-card.tsx). One per page in the index,
 * built ahead like the pages themselves; an address that is not a page is a 404.
 */

import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";

import { DocCard, OG_SIZE, markDataUrl } from "@/components/og-card";
import { DOC_PAGES, docPage, type DocSlug } from "@/lib/docs/pages";

export const alt = "SaverFi Docs";
export const size = OG_SIZE;
export const contentType = "image/png";

export const dynamicParams = false;

export function generateStaticParams(): { slug: DocSlug }[] {
  return DOC_PAGES.map(({ slug }) => ({ slug }));
}

export default async function Image({ params }: { readonly params: Promise<{ slug: string }> }): Promise<ImageResponse> {
  const page = docPage((await params).slug);
  if (page === null) notFound();
  return new ImageResponse(<DocCard mark={await markDataUrl()} group={page.group} title={page.title} description={page.description} />, OG_SIZE);
}
