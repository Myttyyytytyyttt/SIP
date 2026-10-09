"use client";

/**
 * SOMETHING THAT COMES AND GOES WITHOUT SHOVING THE PAGE (10-09). A stage card,
 * the strip on its first settlement, the card of steps in progress: each used to
 * pop in at full height and push everything under it down in one frame (G8).
 * Here it opens — its row grows from nothing as it fades in — and closes the
 * same way, so the page around it moves with it instead of jumping.
 *
 * THE PAGE'S FIRST PAINT NEVER ANIMATES. Whatever is open when this mounts is
 * simply there; only a change after that moves. A page that arrives with its
 * card already open has nothing to announce by growing it.
 *
 * MOUNTED ONLY WHILE OPEN, OR ON ITS WAY OUT. A closed Reveal renders nothing,
 * because even an empty row in a `gap-4` column still takes its 16 px. For that
 * column, `inGap` also pulls the gap back (`-mt-4`) while it is closed, and lets
 * it out as it opens, in the same 300 ms.
 *
 * ON ITS WAY OUT IT CANNOT BE USED: `inert` and `aria-hidden`, so a Create
 * button that is leaving cannot be pressed, focused or read out. It keeps
 * showing what it last held, so it closes over its content rather than over
 * an empty box.
 *
 * Reduced motion: the same end states, swapped at once.
 *
 * The 0fr→1fr grid row is what lets a height of "whatever the content needs"
 * transition at all. While it moves the content is clipped to the row; once it
 * stands open it is not, so a card's ring and a focused button's ring are drawn
 * whole.
 *
 * WHY min-w-0 ON THE ROW'S ITEM (review, 10-09): a grid item whose overflow is
 * visible takes its content's min-content width as its floor, so once the clip
 * is lifted a strip of 20 chips widened the column to 1674 px at 375 and the
 * page scrolled sideways, and a pending row's `truncate` title stopped
 * truncating. min-width only, never overflow: the rings above stay whole.
 *
 * JOINING A PAGE ALREADY DRAWN (`appear`, 10-09). Something mounted at the very
 * moment it is wanted — the strip on the first settlement, whose wrapper must
 * not stand empty before it; a step joining a card already open — has no
 * closed render to grow from. `appear` gives it one: it starts collapsed and
 * grows. Never passed for what is there on the page's first paint.
 *
 * ONE CARD BECOMING ANOTHER (HeightSwap, below). A stage card that turns into
 * the next stage's is one box whose height moves from the old card's to the new
 * one's while the content swaps inside it — never an exit and an entrance
 * stacked, which would hold two cards on screen at once.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

/** duration-300, and a frame's grace so the clip is not lifted before the row has finished growing. */
export const REVEAL_MS = 320;

/**
 * Where the Reveal is in its life.
 *   closed   nothing rendered;
 *   growing  its row at 1fr, still clipped while it grows;
 *   open     standing open, nothing clipped;
 *   closing  collapsed, inert, about to unmount.
 * "Opening" is not a phase: it is `open` asked for while closed or closing —
 * the collapsed frame the growth starts from.
 */
export type RevealPhase = "closed" | "growing" | "open" | "closing";

/** What the Reveal draws for `open` in `phase`: nothing, its collapsed frame, or its row grown. */
export function revealLook(open: boolean, phase: RevealPhase): "gone" | "collapsed" | "grown" {
  if (open) return phase === "growing" || phase === "open" ? "grown" : "collapsed";
  return phase === "closed" ? "gone" : "collapsed";
}

/**
 * Where a Reveal is in its life, for `open`. Its own component uses it, and so
 * does anything that must stay mounted around what comes and goes — a live
 * region that has to exist before its first announcement (LivePending.tsx).
 */
export function useRevealPhase(open: boolean, appear = false): RevealPhase {
  const reduced = useReducedMotion();
  // First paint: whatever is asked for is simply there — unless it is joining a
  // page already drawn, which starts from its collapsed frame (reduced motion: there at once).
  const [phase, setPhase] = useState<RevealPhase>(open && (!appear || reduced) ? "open" : "closed");

  useEffect(() => {
    if (open) {
      if (phase === "open") return;
      if (reduced) {
        setPhase("open");
        return;
      }
      if (phase === "growing") {
        const timer = setTimeout(() => setPhase("open"), REVEAL_MS);
        return () => clearTimeout(timer);
      }
      // Closed or closing: the collapsed frame is on screen now. Two frames, so
      // the browser has painted it — there is nothing to grow FROM otherwise.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setPhase("growing"));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    if (phase === "closed") return;
    if (reduced) {
      setPhase("closed");
      return;
    }
    if (phase !== "closing") {
      setPhase("closing");
      return;
    }
    const timer = setTimeout(() => setPhase("closed"), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [open, phase, reduced]);

  return phase;
}

export function Reveal({
  open,
  appear = false,
  inGap = false,
  className,
  children,
}: {
  readonly open: boolean;
  /** Mounted at the moment it is wanted, on a page already drawn: it grows in rather than popping (see the top of the file). */
  readonly appear?: boolean;
  /** It sits in a `gap-4` column: while closed it takes the gap back with it. */
  readonly inGap?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const phase = useRevealPhase(open, appear);
  // What it showed last while open, so it closes over its content.
  const shown = useRef<ReactNode>(children);
  if (open) shown.current = children;

  const look = revealLook(open, phase);
  if (look === "gone") return null;
  return (
    <RevealFrame grown={look === "grown"} clipped={!open || phase !== "open"} leaving={!open} inGap={inGap} {...(className === undefined ? {} : { className })}>
      {open ? children : shown.current}
    </RevealFrame>
  );
}

/**
 * The outer box's classes at one moment. `still` drops the transition: for a
 * box that stays mounted while closed (a live region), the first collapsed
 * frame after "gone" must not animate from whatever it looked like before.
 */
export function revealFrameClass(input: { readonly grown: boolean; readonly inGap: boolean; readonly still?: boolean }): string {
  return cn(
    "grid",
    input.still !== true && "transition-[grid-template-rows,opacity,margin-top] duration-300 ease-out motion-reduce:transition-none",
    input.grown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
    input.inGap && (input.grown ? "mt-0" : "-mt-4"),
  );
}

/** The markup of one moment of a Reveal: what the browser transitions between. */
export function RevealFrame({
  grown,
  clipped,
  leaving,
  inGap,
  className,
  children,
}: {
  /** Its row at 1fr (opening or open), or at 0fr (about to open, or closing). */
  readonly grown: boolean;
  /** The content clipped to the row: everywhere but standing open. */
  readonly clipped: boolean;
  /** On its way out: inert, and gone from the accessibility tree. */
  readonly leaving: boolean;
  readonly inGap: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn(revealFrameClass({ grown, inGap }), className)} {...(leaving ? { inert: true, "aria-hidden": true } : {})}>
      <div className={cn("min-h-0 min-w-0", clipped && "overflow-hidden")}>{children}</div>
    </div>
  );
}

/**
 * Whether a swap from one card to the next should move the box: there was a
 * card before, its key changed, the two heights differ, and nobody asked for
 * less motion. Anything else simply swaps.
 */
export function swapMoves(input: {
  readonly before: { readonly key: string; readonly height: number | null };
  readonly key: string;
  readonly height: number | null;
  readonly reduced: boolean;
}): boolean {
  const { before, key, height, reduced } = input;
  return !reduced && before.key !== key && before.height !== null && height !== null && before.height !== height;
}

/**
 * ONE BOX, ITS CARD SWAPPED (10-09): the stage card of one stage becoming the
 * next one's. Measure, then set height: the new card is laid out at once, the
 * box is held at the old card's height for the frame that paints it, then moves
 * to the new card's in the same 300 ms as a Reveal, then lets go of its height
 * altogether, so whatever the card does next it does in its own height. The new
 * card fades in over the old one's place (motion-safe; reduced motion swaps at
 * once, at the new height).
 *
 * THE FIRST PAINT NEVER MOVES, and neither does a card that only changes inside
 * its own stage: only a change of `swapKey` does.
 */
export function HeightSwap({ swapKey, className, children }: { readonly swapKey: string; readonly className?: string; readonly children: ReactNode }) {
  const reduced = useReducedMotion();
  const inner = useRef<HTMLDivElement>(null);
  // The key and height of the card the box last held, measured after every commit.
  const seen = useRef<{ key: string; height: number | null }>({ key: swapKey, height: null });
  // Held at a height (px) while a swap moves; `moving` once the transition runs.
  const [lock, setLock] = useState<{ readonly px: number; readonly moving: boolean } | null>(null);
  // Once a swap has happened, every new card fades in; the first one never does.
  const first = useRef(swapKey);
  const swapped = useRef(false);
  if (swapKey !== first.current) swapped.current = true;

  // Before the paint: a new key, a different height — hold the box where it was.
  useLayoutEffect(() => {
    const height = inner.current?.offsetHeight ?? null;
    const before = seen.current;
    seen.current = { key: swapKey, height };
    if (swapMoves({ before, key: swapKey, height, reduced })) setLock({ px: lock?.px ?? before.height!, moving: false });
  });

  useEffect(() => {
    if (lock === null) return;
    if (!lock.moving) {
      // Two frames, so the held height has been painted before it moves.
      let second = 0;
      const frame = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setLock({ px: inner.current?.offsetHeight ?? lock.px, moving: true }));
      });
      return () => {
        cancelAnimationFrame(frame);
        cancelAnimationFrame(second);
      };
    }
    const timer = setTimeout(() => setLock(null), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [lock]);

  return (
    <div
      className={cn(lock !== null && "overflow-hidden", lock?.moving === true && "transition-[height] duration-300 ease-out motion-reduce:transition-none", className) || undefined}
      {...(lock === null ? {} : { style: { height: lock.px } })}
    >
      <div key={swapKey} ref={inner} className={swapped.current ? "motion-safe:animate-in motion-safe:fade-in" : undefined}>
        {children}
      </div>
    </div>
  );
}
