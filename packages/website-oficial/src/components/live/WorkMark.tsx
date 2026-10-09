/**
 * ONE MARK FOR WORK IN FLIGHT (10-09). The square PendingRows drew inline,
 * made shareable, so every place that says "this is under way", "this rests",
 * "this is done" says it with the same glyph in the same tone:
 *
 *   active   turning loader   quiet for a conversion or a wallet being checked, blue for a buy
 *   held     pause            a reason is on screen beside it (paused, switched off, a limit)
 *   slow     clock            due, and not done a few sweeps after the chain last moved
 *   gated    hourglass        waiting under a minimum before it can move at all
 *   syncing  turning loader   a write landed and the page has not caught up (phase B)
 *   done     check            in the step's own tone, for the few seconds it is held
 *
 * Only "active" and "syncing" turn, and only for motion-safe. Under reduced
 * motion the loader stands still, and a turning square wears a faint ring of its
 * own tone, so it differs from a resting one by more than the shape of its glyph.
 * `still` stops the turn for a step the page is no longer sure of — a newer read
 * says it ended and its history has not landed yet (use-read-settled.ts) — and
 * drops the ring with it: nothing is claimed to be moving.
 *
 * THE GLYPH IS DECORATION: aria-hidden. What it means is always in the words
 * beside it — the row's title and line — so it is never said by shape or hue alone.
 *
 * Two sizes: the 32 px square that leads a row, and a bare 14 px glyph for a
 * label's line (no square).
 */

import { Check, Clock, Hourglass, Loader2, Pause } from "lucide-react";

import { TONE_TEXT, TONE_TILE, type Tone } from "@/lib/classes";
import { cn } from "@/lib/utils";

export type WorkState = "active" | "held" | "slow" | "gated" | "syncing" | "done";

/** Whether this state turns: work the page can vouch for being under way. */
export const turns = (state: WorkState): boolean => state === "active" || state === "syncing";

function Glyph({ state, still, className }: { readonly state: WorkState; readonly still: boolean; readonly className: string }) {
  if (turns(state)) return <Loader2 className={cn(className, !still && "motion-safe:animate-spin")} aria-hidden data-work-loader={still ? "still" : ""} />;
  if (state === "held") return <Pause className={className} aria-hidden />;
  if (state === "slow") return <Clock className={className} aria-hidden />;
  if (state === "gated") return <Hourglass className={className} aria-hidden />;
  return <Check className={className} aria-hidden />;
}

export function WorkMark({
  state,
  tone = "quiet",
  tile = true,
  still = false,
  className,
}: {
  readonly state: WorkState;
  /** The step's tone (lib/classes.ts). Only a buy under way, or a buy done, is blue; the rest is the machinery's grey. */
  readonly tone?: Tone;
  /** The row's 32 px square; false for the bare glyph on a label's line. */
  readonly tile?: boolean;
  /** A turning state the page is no longer sure of: the loader stands still. */
  readonly still?: boolean;
  readonly className?: string;
}) {
  const ring = turns(state) && !still;
  if (!tile) return <Glyph state={state} still={still} className={cn("size-3.5 shrink-0", TONE_TEXT[tone], className)} />;
  return (
    <span
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md",
        TONE_TILE[tone],
        ring && "motion-reduce:ring-1 motion-reduce:ring-current/30",
        className,
      )}
      data-work-mark={state}
    >
      <Glyph state={state} still={still} className="size-4" />
    </span>
  );
}
