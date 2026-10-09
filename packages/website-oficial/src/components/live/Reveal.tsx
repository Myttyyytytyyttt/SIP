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
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

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

export function Reveal({
  open,
  inGap = false,
  className,
  children,
}: {
  readonly open: boolean;
  /** It sits in a `gap-4` column: while closed it takes the gap back with it. */
  readonly inGap?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const reduced = useReducedMotion();
  // First paint: whatever is asked for is simply there.
  const [phase, setPhase] = useState<RevealPhase>(open ? "open" : "closed");
  // What it showed last while open, so it closes over its content.
  const shown = useRef<ReactNode>(children);
  if (open) shown.current = children;

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

  const look = revealLook(open, phase);
  if (look === "gone") return null;
  return (
    <RevealFrame grown={look === "grown"} clipped={!open || phase !== "open"} leaving={!open} inGap={inGap} {...(className === undefined ? {} : { className })}>
      {open ? children : shown.current}
    </RevealFrame>
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
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity,margin-top] duration-300 ease-out motion-reduce:transition-none",
        grown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        inGap && (grown ? "mt-0" : "-mt-4"),
        className,
      )}
      {...(leaving ? { inert: true, "aria-hidden": true } : {})}
    >
      <div className={cn("min-h-0", clipped && "overflow-hidden")}>{children}</div>
    </div>
  );
}
