/**
 * THE CLIPS THAT EXIST (owner, 10-22): one short loop at the top of each docs
 * page, named after the page's slug and served from this site
 * (public/docs/clips/<slug>.{webm,mp4,jpg}), because the CSP's media-src allows
 * 'self' only.
 *
 * A PAGE WHOSE CLIP IS NOT LISTED HERE SHOWS A QUIET FRAME, never a <video>
 * that points at a file that is not there: a broken player at the top of a page
 * reads as a broken page. So a clip goes live in two steps: its three files land
 * in public/docs/clips/, then its slug is added here with `clipFiles(slug)`.
 * src/app/docs/docs.test.ts fails if a listed file is missing.
 *
 * "dashboard" REUSES THE LANDING'S APP LOOP (owner, 10-22): the same 8 s loop
 * over the sample, with the caption the landing's frame wears, because the
 * video itself carries none.
 */

import type { DocSlug } from "@/lib/docs/pages";

export type ClipFiles = {
  readonly webm: string;
  readonly mp4: string;
  /** The rest frame: shown until the loop plays, and all that shows under reduced motion until play is pressed. */
  readonly poster: string;
  /** A line under the frame, for a clip whose picture needs one (an example that is nobody's pension). */
  readonly caption?: string;
};

/** The three files a new clip ships as: public/docs/clips/<slug>.{webm,mp4,jpg}. */
export function clipFiles(slug: DocSlug): ClipFiles {
  return { webm: `/docs/clips/${slug}.webm`, mp4: `/docs/clips/${slug}.mp4`, poster: `/docs/clips/${slug}.jpg` };
}

export const CLIPS: Readonly<Partial<Record<DocSlug, ClipFiles>>> = {
  dashboard: {
    webm: "/landing/app-loop.webm",
    mp4: "/landing/app-loop.mp4",
    poster: "/landing/app-loop.jpg",
    caption: "Example — nobody’s pension",
  },
};

/** This page's clip, or null while it has none: the page then shows the quiet frame. */
export function clipOf(slug: DocSlug): ClipFiles | null {
  return CLIPS[slug] ?? null;
}
