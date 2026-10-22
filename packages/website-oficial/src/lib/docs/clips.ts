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
  "what-is-saverfi": clipFiles("what-is-saverfi", { webm: "52d2fa73", mp4: "9b35ddaa", poster: "8c6baa47" }),
  "pension-key": clipFiles("pension-key", { webm: "4805f4bd", mp4: "cba8839f", poster: "26beb5e2" }),
  "saving-from-profit": clipFiles("saving-from-profit", { webm: "f4844567", mp4: "45f92468", poster: "bd0e0fc9" }),
  "saving-from-volume": clipFiles("saving-from-volume", { webm: "fc07fae3", mp4: "e970f659", poster: "3a22f1cf" }),
  "round-ups": clipFiles("round-ups", { webm: "a6b40bb7", mp4: "fa25e79e", poster: "24d3b430" }),
  "timing-and-limits": clipFiles("timing-and-limits", { webm: "0b69eb29", mp4: "69b93f31", poster: "2d6448ab" }),
  "import-a-wallet": clipFiles("import-a-wallet", { webm: "58c55dfa", mp4: "20bc9f8b", poster: "43faad35" }),
  investing: clipFiles("investing", { webm: "5e07c456", mp4: "15d46dfe", poster: "05a92ca7" }),
  "take-money-out": clipFiles("take-money-out", { webm: "aa6c799a", mp4: "e2c4bd53", poster: "83e7a1f4" }),
  "who-controls-what": clipFiles("who-controls-what", { webm: "7f07c7b7", mp4: "26d566dd", poster: "d0ba132a" }),
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
