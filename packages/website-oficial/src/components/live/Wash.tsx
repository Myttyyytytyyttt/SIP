/**
 * A ROW OR CHIP THAT JUST ARRIVED (10-09, plan P3): a tint that fades in 2.4 s
 * and a 2 px edge in the row's own tone, held while it is marked
 * (use-arrivals.ts). The look is `.live-wash` in globals.css.
 *
 * ITS OWN ABSOLUTELY PLACED CHILD, never a class on the host: the host keeps its
 * rise-in, its focus ring and its hover ground. The ring is an inset
 * box-shadow the wash would paint over, so while the host has keyboard focus
 * the wash's edge steps aside (globals.css) and the ring stays whole on all
 * four sides. It must stay the host's DIRECT child for that rule to find it.
 * While it is arrived the host wears WASH_HOST — a box for the wash to fill,
 * and a stacking context, so the wash sits over the host's ground and under its
 * content — and only then: the sample never passes `arrived`, so its rows and
 * chips keep their exact markup.
 *
 * DECORATION. The announcer says what arrived (LiveAnnouncer.tsx); the wash is
 * aria-hidden. Reduced motion: a still 10 % tint and the edge, for as long as it
 * is held, gone without a fade.
 *
 * No state, no hooks: the sample's server components can mount it.
 */

import type { Tone } from "@/lib/classes";

/** The wash's tones: the feed's, with a failure washed grey — the edge says it arrived, never that it went well. */
export type WashTone = Exclude<Tone, "failed">;

export const washToneOf = (tone: Tone): WashTone => (tone === "failed" ? "quiet" : tone);

/** What the host of a wash wears while it is arrived. */
export const WASH_HOST = "relative isolate";

/** A chip's entrance, as it arrives (strip and header). Nothing for whoever asked for less motion. */
export const CHIP_ENTRANCE = "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-2";

export function Wash({ tone }: { readonly tone: WashTone }) {
  return <span aria-hidden className="live-wash" data-tone={tone} />;
}
