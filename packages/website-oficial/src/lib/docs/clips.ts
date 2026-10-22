/**
 * THE CLIPS THAT EXIST (owner, 10-22): a short loop at the top of a docs page,
 * named after the page's slug and served from this site
 * (public/docs/clips/<slug>.{webm,mp4,webp}), because the CSP's media-src allows
 * 'self' only.
 *
 * NOT EVERY PAGE HAS ONE (owner, 10-22): only where a clip makes the page easier
 * to understand. A page not listed here shows no media at all, and never a
 * <video> that points at a file that is not there: a broken player at the top
 * of a page reads as a broken page. src/app/docs/docs.test.ts fails if a listed
 * file is missing.
 *
 * TO ADD OR RE-RENDER A CLIP (scripts/docs-clip.mts says the rest):
 *   1. the films make it in launch-video/ (out/docs/): 1280×720, dark, each with
 *      its own "Example" or "Real" label inside the picture, so no caption;
 *   2. `pnpm run docs:clip <slug> --from <checkout>/launch-video/out/docs` copies
 *      its two loops into public/docs/clips/, makes its WebP poster from the first
 *      frame, and writes the three versions below (a new slug gets its line printed:
 *      add it to CLIPS);
 *   3. `CI=1 vitest run src/app/docs`.
 *
 * EVERY /docs/clips/ URL CARRIES ITS FILE'S VERSION (?v=, the first 8 hex of its
 * sha256). Such a URL is cached for a year without asking again
 * (next.config.mjs), so a repeat visit does not ask for it again; a re-rendered
 * clip gets a new address instead of a stale copy. scripts/check-clips.mts
 * recomputes every version and fails on a stale one, in the tests and before
 * every build.
 *
 * "dashboard" REUSES THE LANDING'S APP LOOP (owner, 10-22): the same 8 s loop
 * over the sample, with the caption the landing's frame wears, because the
 * video itself carries none. Its poster is the docs' own WebP of that loop's
 * first frame: the landing's JPEG weighs more than twice as much. The loop's
 * URLs are the landing's own, with no ?v=: /landing/ keeps the landing's
 * caching, so a version would buy nothing and would make a reader who has seen
 * the landing download the loop again.
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

/** Each file's version: the first 8 hex of its sha256, written by scripts/docs-clip.mts. */
type Versions = { readonly webm: string; readonly mp4: string; readonly poster: string };

/** The three files a clip of its own ships as: public/docs/clips/<slug>.{webm,mp4,webp}. */
export function clipFiles(slug: DocSlug, v: Versions): ClipFiles {
  return {
    webm: `/docs/clips/${slug}.webm?v=${v.webm}`,
    mp4: `/docs/clips/${slug}.mp4?v=${v.mp4}`,
    poster: `/docs/clips/${slug}.webp?v=${v.poster}`,
  };
}

export const CLIPS: Readonly<Partial<Record<DocSlug, ClipFiles>>> = {
  "what-is-saverfi": clipFiles("what-is-saverfi", { webm: "4e14e0ee", mp4: "77275341", poster: "0f98f5d9" }),
  "pension-key": clipFiles("pension-key", { webm: "5bfc4bc5", mp4: "54192c86", poster: "bb84d300" }),
  "saving-from-profit": clipFiles("saving-from-profit", { webm: "893bb724", mp4: "3f7c9a3c", poster: "2e237866" }),
  "saving-from-volume": clipFiles("saving-from-volume", { webm: "d0d0be56", mp4: "63ed1f9d", poster: "62086fc4" }),
  "round-ups": clipFiles("round-ups", { webm: "5e37aa00", mp4: "474fe02b", poster: "a5a6ec23" }),
  "timing-and-limits": clipFiles("timing-and-limits", { webm: "3163fe15", mp4: "3268b595", poster: "edcccc9a" }),
  "import-a-wallet": clipFiles("import-a-wallet", { webm: "91b16835", mp4: "4eb003dc", poster: "797cf887" }),
  investing: clipFiles("investing", { webm: "540f4c5d", mp4: "a2a4b502", poster: "96c890bd" }),
  "take-money-out": clipFiles("take-money-out", { webm: "8fb0a00d", mp4: "9b3c8632", poster: "8f7acf8c" }),
  "who-controls-what": clipFiles("who-controls-what", { webm: "0966641e", mp4: "7861b2e8", poster: "18b62928" }),
  dashboard: {
    webm: "/landing/app-loop.webm",
    mp4: "/landing/app-loop.mp4",
    poster: "/docs/clips/dashboard.webp?v=b8e44938",
    caption: "Example — nobody’s pension",
  },
};

/** This page's clip, or null when it has none: the page then shows no media. */
export function clipOf(slug: DocSlug): ClipFiles | null {
  return CLIPS[slug] ?? null;
}
