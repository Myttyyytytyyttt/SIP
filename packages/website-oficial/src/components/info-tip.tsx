"use client";

/**
 * THE "?" BESIDE A TITLE (owner, 09-25): one or two plain sentences on what
 * the thing is and what changing it does, on hover AND on a tap.
 *
 * A POPOVER, NOT A TOOLTIP. Radix Tooltip returns early on a touch pointer and
 * closes on click, so a Tooltip "?" never opens on a phone — and the people
 * this explains things to are the ones most likely to be on one. A Popover
 * opens on a click; the hover is added here by hand.
 *
 * HOW IT OPENS, AND WHY EACH PIECE IS THERE:
 *  * A MOUSE HOVER OPENS IT, and leaving closes it after a short delay, so the
 *    pointer can cross the gap into the bubble without it vanishing.
 *  * A CLICK OR A TAP PINS IT, and a second one unpins and closes it. The click
 *    handler calls preventDefault, which is what makes Radix skip its own
 *    toggle — without it, hover-then-click opens and closes in one gesture.
 *  * IT NEVER TAKES FOCUS. Opening and closing leave focus where it was, so a
 *    "?" beside a field can be read while typing in that field.
 *  * THE SENTENCE IS ALSO IN THE BUTTON, screen-reader only. That is what a
 *    screen reader announces, and what a server render — and every test, which
 *    renders without a DOM, where an open popover draws nothing — can see.
 *
 * NEVER INSIDE A <label>: a click there would also activate the labelled
 * control. Place it beside the label. `window` is touched only in handlers,
 * never while rendering.
 */

import { CircleHelp } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Milliseconds between the pointer leaving and the bubble closing: long enough to reach the bubble, short enough to feel like a tooltip. */
const CLOSE_DELAY_MS = 120;

export function InfoTip({ label, children, className }: { readonly label: string; readonly children: string; readonly className?: string }) {
  const [open, setOpen] = useState(false);
  // Pinned by a click or a tap: a hover's leaving no longer closes it.
  const pinned = useRef(false);
  const timer = useRef<number | null>(null);

  const cancelClose = (): void => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  };

  const scheduleClose = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || pinned.current) return;
    cancelClose();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen(false);
    }, CLOSE_DELAY_MS);
  };

  // A timer left running when the tip unmounts (the dialog closing under it) must not set state afterwards.
  useEffect(() => {
    const pending = timer;
    return () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    };
  }, []);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Radix closes it on Escape and on a press outside: that also unpins it.
        if (!next) pinned.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        type="button"
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          cancelClose();
          setOpen(true);
        }}
        onPointerLeave={scheduleClose}
        onClick={(event) => {
          // Radix's own toggle is skipped; this one pins as well as opens, so a hover-then-click keeps it open.
          event.preventDefault();
          cancelClose();
          const next = !pinned.current;
          pinned.current = next;
          setOpen(next);
        }}
        className={cn(
          "relative inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none after:absolute after:-inset-2 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
          className,
        )}
      >
        <CircleHelp className="size-3.5" aria-hidden />
        <span className="sr-only">
          {label}: {children}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") cancelClose();
        }}
        onPointerLeave={scheduleClose}
        // The tooltip's own look (ui/tooltip.tsx): the inverted chip, not the popover's card.
        className="w-auto max-w-64 gap-0 rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-none ring-0"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
