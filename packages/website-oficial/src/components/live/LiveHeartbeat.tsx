"use client";

/**
 * HOW FRESH THE PAGE IS, AS ONE DOT IN THE HEADER (10-09).
 *
 * A healthy page and a stuck one used to look the same (G1): nothing said when
 * the figures last changed, and a failed update showed only in the note above
 * the cards. The dot says it at a glance, beside the pension key:
 *
 *   solid       as of the last update            "Updated just now" / "Updated 2 min ago"
 *   breathing   a check someone asked for runs   "Checking…"
 *   hollow      the last update failed           "Behind — couldn’t update" · "As of 14:32 UTC"
 *
 * THE DOT ONLY, AT EVERY WIDTH (owner, 10-09). Its words are its popover and its
 * accessible name, never text in the bar, and its three looks are one box: no
 * state can move a thing in the bar. The popover opens on a hover, as InfoTip's
 * does (info-tip.tsx), and on a press; it holds the words and Check now, a real
 * button. A press that opens it takes the focus to Check now — so a keyboard
 * reaches it with Tab, Enter — and Escape gives it back to the dot; a hover
 * moves no focus.
 *
 * WHAT IT KNOWS TODAY [fallback, until the data session's `live` object lands].
 * The store does not yet say when a read ran, or that one is running. So:
 *  * "Updated …" counts from the moment this browser first saw the snapshot it
 *    shows — when `data.nowMs` changed. That moment is remembered per pension
 *    key (seenAt), so a walk to /activity and back, which mounts this again,
 *    does not reset a minute-old update to "just now".
 *  * "Checking…" is only ever a check SOMEONE ASKED FOR: from a press of Check
 *    now until a read finishes, or 15 s (usePressedUntilRead). The page's own
 *    reads make no mark — there is no signal for them yet, and a dot that
 *    breathed on a guess would be the dishonest kind of live.
 *  * "Behind" is the stale view: the last update failed, the figures are the
 *    last good ones. It wins over a press (behind > checking > fresh); the
 *    press still shows, on Check now itself. It says as of when, the stale
 *    note's own moment — the snapshot's clock, with its day when that is not
 *    this browser's today (format.ts whenLabel): a page stuck since last night
 *    must not read as minutes old.
 *  * Check now opens at the floor after the last read this browser saw finish
 *    (useReadyAt, the same moment every Retry on the page counts to) or at the
 *    server's retry-after, whichever is later — a press before that would be
 *    held by the store without a word — and counts down to it.
 *
 * NEVER A LIVE REGION. The page reads itself every 20–60 s, and none of that is
 * spoken; a failure is announced by the stale note's own region
 * (DashboardSource.tsx).
 *
 * REDUCED MOTION: the dot does not breathe — a check under way is the hollow
 * dot, and the words carry it — the popover appears at once, without its fade
 * and zoom, and Check now's glyph stands still.
 *
 * LIVE ONLY. LiveBody puts it before the account in the header. The sample, the
 * first read, and the unreadable and keyless screens never draw it.
 */

import { RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";

import { pressKeyOf, retryEnableAt, usePressedUntilRead } from "@/components/live/RetryButton";
import { useCountdown } from "@/components/live/use-countdown";
import { useTicker } from "@/components/live/use-ticker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { LiveStale } from "@/hooks/use-live-dashboard";
import { whenLabel } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";

/** How often the age is looked at again. Its words change at most once a minute. */
export const PULSE_TICK_MS = 15_000;
/** Between the pointer leaving and the popover closing: long enough to reach Check now (info-tip.tsx). */
const CLOSE_DELAY_MS = 120;

export type PulseState = "fresh" | "checking" | "behind";

/** Which state the dot is in. A failed update wins over a press, which Check now shows itself. */
export function pulseStateOf(input: { readonly stale: boolean; readonly checking: boolean }): PulseState {
  if (input.stale) return "behind";
  return input.checking ? "checking" : "fresh";
}

/**
 * What the popover says above Check now, and the dot's accessible name. The
 * name says everything on its own — a check under way included, which in the
 * popover is Check now's own label, so the popover does not say it twice.
 * `asOf` is the figures' own moment, dated when not today: what "behind" says.
 */
export function pulseWords(state: PulseState, ageMs: number, asOf: string): { readonly lines: readonly string[]; readonly name: string } {
  const ago = LIVE_COPY.pulse.ago(ageMs);
  if (state === "behind") {
    const lines = [LIVE_COPY.pulse.behind, LIVE_COPY.pulse.asOf(asOf)];
    return { lines, name: lines.join(". ") };
  }
  const updated = LIVE_COPY.pulse.updated(ago);
  return { lines: [updated], name: state === "checking" ? `${LIVE_COPY.pulse.checking} ${updated}` : updated };
}

/** What Check now says, and whether it can be pressed. */
export function checkLook(input: { readonly left: number | null; readonly checking: boolean }): { readonly label: string; readonly disabled: boolean } {
  if (input.checking) return { label: LIVE_COPY.pulse.checking, disabled: true };
  if (input.left !== null) return { label: LIVE_COPY.pulse.checkIn(input.left), disabled: true };
  return { label: LIVE_COPY.pulse.checkNow, disabled: false };
}

/**
 * When this browser first saw `nowMs` for this pension: `now` the first time,
 * the same moment every time after, until a newer snapshot replaces it: one
 * entry per pension key, never one per snapshot.
 */
export function seenAt(store: Map<string, { readonly nowMs: number; readonly at: number }>, key: string, nowMs: number, now: number): number {
  const held = store.get(key);
  if (held !== undefined && held.nowMs === nowMs) return held.at;
  store.set(key, { nowMs, at: now });
  return now;
}

/**
 * Module-wide on purpose: it outlives the body that mounts the dot, which a
 * walk between / and /activity remounts. Written only in the browser — the
 * live body never renders on the server, where `ready` is false.
 */
const SEEN = new Map<string, { readonly nowMs: number; readonly at: number }>();

/** The dot's look in each state. All three are the same box, so no state moves anything. */
export const PULSE_DOT: Readonly<Record<PulseState, string>> = {
  fresh: "bg-muted-foreground/70",
  // globals.css stops the breath under reduced motion; the hollow ring stands in for it.
  checking: "live-breathe bg-muted-foreground/70 motion-reduce:border motion-reduce:border-muted-foreground motion-reduce:bg-transparent",
  behind: "border border-muted-foreground bg-transparent",
};

/**
 * Check now, inside the popover — mounted only while it is open, so its
 * countdown ticks only while someone can see it. Held with aria-disabled, not
 * `disabled`, so a keyboard press keeps the focus (RetryButton.tsx).
 */
export function CheckNow({ enableAt, checking, onCheck }: { readonly enableAt: number; readonly checking: boolean; readonly onCheck: () => void }) {
  const left = useCountdown(enableAt);
  const look = checkLook({ left, checking });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="self-start aria-disabled:pointer-events-none aria-disabled:opacity-50"
      {...(look.disabled ? { "aria-disabled": true } : {})}
      onClick={() => {
        if (look.disabled) return;
        onCheck();
      }}
    >
      <RefreshCw aria-hidden className={checking ? "motion-safe:animate-spin" : undefined} />
      {look.label}
    </Button>
  );
}

export function LiveHeartbeat({
  pensionKey,
  nowMs,
  stale,
  readyAt,
  onCheck,
}: {
  readonly pensionKey: string;
  /** The snapshot's own clock: it changes with every update that landed, and only then. */
  readonly nowMs: number;
  readonly stale: LiveStale | null;
  /** When a press reads at once: the page's one floor (useReadyAt in LiveBody). */
  readonly readyAt: number;
  /** The store's refresh — the same read every Retry asks for. */
  readonly onCheck: () => void;
}) {
  const at = useMemo(() => seenAt(SEEN, pensionKey, nowMs, Date.now()), [pensionKey, nowMs]);
  // The ticker is what re-renders; the clock is read here, as in use-countdown.ts.
  useTicker(true, PULSE_TICK_MS);
  const retryAt = stale?.retryAt ?? null;
  const [checking, press] = usePressedUntilRead(pressKeyOf(retryAt, readyAt));
  const state = pulseStateOf({ stale: stale !== null, checking });
  // The browser's day: the snapshot's own clock is the moment named, and against itself it is always today.
  const now = Date.now();
  const words = pulseWords(state, now - at, whenLabel(nowMs, now));
  const titleId = useId();

  // HOVER OPENS, A PRESS PINS — InfoTip's mechanics (info-tip.tsx), and why each piece is there is said there.
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  // Opened by a press, so the focus went in and goes back to the dot; a hover moves no focus either way.
  const pressedOpen = useRef(false);
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
        if (!next) pinned.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          // THE BAR HAS NO WIDTH TO SPARE AT md (768 px already overflows for a
          // connected key). The target stays 28 px, the header's own control
          // size, but reaches 6 px into the gap on each side — never as far as
          // a neighbour — so the row grows by 24 px, not 36.
          className="-mx-1.5"
          aria-label={words.name}
          data-pulse={state}
          onPointerEnter={(event) => {
            if (event.pointerType !== "mouse") return;
            cancelClose();
            setOpen(true);
          }}
          onPointerLeave={scheduleClose}
          onClick={(event) => {
            event.preventDefault();
            cancelClose();
            const next = !pinned.current;
            pinned.current = next;
            pressedOpen.current = next;
            setOpen(next);
          }}
        >
          <span aria-hidden className={cn("size-2 rounded-full", PULSE_DOT[state])} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-labelledby={titleId}
        // A hover takes no focus; a press takes it to Check now.
        onOpenAutoFocus={(event) => {
          if (!pressedOpen.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (!pressedOpen.current) event.preventDefault();
          pressedOpen.current = false;
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") cancelClose();
        }}
        onPointerLeave={scheduleClose}
        // The zoom and slide are the stock popover's; for reduced motion it simply appears.
        className="w-60 gap-2 p-3 text-xs motion-reduce:animate-none!"
      >
        <div className="flex flex-col gap-0.5">
          {words.lines.map((line, index) => (
            <p key={line} id={index === 0 ? titleId : undefined} className={index === 0 ? "font-medium text-foreground" : "text-muted-foreground"}>
              {line}
            </p>
          ))}
        </div>
        <CheckNow
          enableAt={retryEnableAt(retryAt, readyAt)}
          checking={checking}
          onCheck={() => {
            press();
            onCheck();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
