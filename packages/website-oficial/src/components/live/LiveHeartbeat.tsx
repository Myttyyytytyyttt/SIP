"use client";

/**
 * HOW FRESH THE PAGE IS, AS ONE DOT IN THE HEADER (10-09).
 *
 * A healthy page and a stuck one used to look the same (G1): nothing said when
 * the figures last changed, and a failed update showed only in the note above
 * the cards. The dot says it at a glance, beside the pension key:
 *
 *   solid       as of the last update            "Updated just now" / "Live · updated 2 min ago"
 *   breathing   a check is out, or the chain     "Checking…" / "Change seen on Solana · updating"
 *               said something changed
 *   hollow      the last update failed           "Behind — couldn’t update" · "As of 14:32 UTC"
 *   ringed      a newer version is served        "A newer version of SaverFi is available" · Reload page
 *
 * THE DOT ONLY, AT EVERY WIDTH (owner, 10-09). Its words are its popover and its
 * accessible name, never text in the bar, and every look is one box: no state
 * can move a thing in the bar. The popover opens on a hover, as InfoTip's does
 * (info-tip.tsx), and on a press; it holds the words, Check now — a real
 * button — and, when there is one, the reload. A press that opens it takes the
 * focus to its first button — so a keyboard reaches it with Tab, Enter — and
 * Escape gives it back to the dot; a hover moves no focus.
 *
 * EVERY STATE IS A SIGNAL THE STORE GIVES (plan B2, the data session's `live`
 * on useLiveDashboard). Nothing here is captured or guessed any more:
 *  * "Updated …" counts from `live.lastReadAt`, the last update that LANDED; a
 *    failure never moves it.
 *  * It breathes while `live.reading` — a check out, the page's own included —
 *    or while `live.heard`: the chain rang about a change no update has
 *    brought yet. A press of Check now breathes because it starts a check,
 *    not because it was pressed.
 *  * "Live" only while `live.socket` is "live": every address watched is
 *    confirmed, a change shows within seconds. Connecting or off, it says
 *    "Not live right now", and how often the page looks only where its
 *    schedule really runs at one (pushOffCadenceMs) — never a cadence the
 *    schedule does not keep.
 *  * "Next check in 14 s" only from `live.nextReadAt`, the timer the page has
 *    actually armed; "Waiting after an error · next try at …" while
 *    `live.backingOff`. Nothing when none is armed.
 *  * Check now opens at `live.refreshReadyAt` — from then a press checks AT
 *    ONCE — or at a retry-after the server named, whichever is later, and
 *    counts down to it.
 *  * "Behind" is the stale view: the last update failed, the figures are the
 *    last good ones. It wins over everything (behind > heard > checking >
 *    fresh). It says as of when, the stale note's own moment — the snapshot's
 *    clock, with its day when that is not this browser's today (format.ts
 *    whenLabel): a page stuck since last night must not read as minutes old.
 *  * The ring is `useNewVersion().updateAvailable` (use-update-available.ts),
 *    worn over whichever of the looks above is true: an update to load never
 *    hides how fresh the figures are. No chip and no words in the bar
 *    (owner, 10-09): the popover says it and offers the reload.
 *
 * NEVER A LIVE REGION. The page reads itself every 20–60 s, and none of that is
 * spoken; a failure is announced by the stale note's own region
 * (DashboardSource.tsx).
 *
 * REDUCED MOTION: the dot does not breathe — a check under way, or a change
 * heard, is the hollow dot, and the words carry it — the popover appears at
 * once, without its fade and zoom, and Check now's glyph stands still.
 *
 * LIVE ONLY. LiveBody puts it before the account in the header. The sample, the
 * first read, and the unreadable and keyless screens never draw it.
 */

import { RefreshCw, RotateCw } from "lucide-react";
import { useEffect, useId, useRef, useState, type PointerEvent } from "react";

import { retryEnableAt } from "@/components/live/RetryButton";
import { useCountdown } from "@/components/live/use-countdown";
import { useTicker } from "@/components/live/use-ticker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { LiveLiveness, LiveStale } from "@/hooks/use-live-dashboard";
import { whenLabel } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import { UNHEARD_POLL_MS, unheardPollWanted } from "@/lib/live-schedule";
import { cn } from "@/lib/utils";

/** How often the age is looked at again. Its words change at most once a minute. */
export const PULSE_TICK_MS = 15_000;
/** Between the pointer leaving and the popover closing: long enough to reach Check now (info-tip.tsx). */
const CLOSE_DELAY_MS = 120;
/** Up to this many seconds away the next check counts down; further off, it names its moment. */
export const NEXT_IN_MAX_S = 90;

export type PulseState = "fresh" | "checking" | "heard" | "behind";

/** Which state the dot is in: a failed update over a change heard, over a check out, over fresh. */
export function pulseStateOf(input: { readonly stale: boolean; readonly heard: boolean; readonly reading: boolean }): PulseState {
  if (input.stale) return "behind";
  if (input.heard) return "heard";
  return input.reading ? "checking" : "fresh";
}

/**
 * HOW OFTEN THE PAGE LOOKS WHILE IT IS NOT LIVE — only where the schedule
 * really runs at one cadence. The push wanted and not live, nothing backing
 * off and no retry-after ahead is exactly when the page reads every
 * UNHEARD_POLL_MS (live-schedule.ts unheardPollWanted, the hook's own
 * predicate: a refusal it earned is `backingOff`). Anything else — a backoff,
 * the history's retry-after, a push that is live or not wanted — has no
 * steady cadence to name, and null says none.
 */
export function pushOffCadenceMs(input: {
  readonly socket: LiveLiveness["socket"];
  readonly backingOff: boolean;
  readonly activityRetryAt: number | null;
  readonly now: number;
}): number | null {
  if (input.backingOff) return null;
  return unheardPollWanted({ socket: input.socket, activityRetryAt: input.activityRetryAt, now: input.now }) ? UNHEARD_POLL_MS : null;
}

export interface PulseFacts {
  readonly state: PulseState;
  readonly socket: LiveLiveness["socket"];
  /** Since the last update that landed (`live.lastReadAt`); null when nothing says. */
  readonly ageMs: number | null;
  /** The figures' own moment, dated when not today: what "behind" says. */
  readonly asOf: string;
  /** The chain said something changed that no update has brought yet. */
  readonly heard: boolean;
  /** pushOffCadenceMs. */
  readonly cadenceMs: number | null;
  /** A newer build is served than this tab runs. */
  readonly update: boolean;
}

/** A line as a screen reader is given it: "·" is read as "dot", so it becomes a comma. */
const spoken = (line: string): string => line.replaceAll(" · ", ", ");

/**
 * What the popover says above its buttons — the first line is its title — and
 * the dot's accessible name. The name says everything on its own: a check
 * under way included, which in the popover is Check now's own label, and an
 * update, which there is its own section. The next check is not in it: that
 * counts down in the popover (NextCheck), and a name is read once.
 */
export function pulseWords(facts: PulseFacts): { readonly lines: readonly string[]; readonly name: string } {
  const lines: string[] = [];
  if (facts.state === "behind") {
    lines.push(LIVE_COPY.pulse.behind, LIVE_COPY.pulse.asOf(facts.asOf));
    if (facts.heard) lines.push(LIVE_COPY.pulse.heardBehind);
  } else {
    // Unknown is "—", never "just now".
    const ago = facts.ageMs === null ? "—" : LIVE_COPY.pulse.ago(facts.ageMs);
    lines.push(facts.socket === "live" ? LIVE_COPY.pulse.live(ago) : LIVE_COPY.pulse.updated(ago));
    if (facts.heard) lines.push(LIVE_COPY.pulse.heard);
    if (facts.socket === "connecting" || facts.socket === "off") {
      lines.push(facts.cadenceMs === null ? LIVE_COPY.pulse.notLive : LIVE_COPY.pulse.notLiveEvery(Math.round(facts.cadenceMs / 1_000)));
    }
  }
  const said = lines.map(spoken);
  if (facts.update) said.push(LIVE_COPY.pulse.update);
  const name = said.join(". ");
  return { lines, name: facts.state === "checking" ? `${LIVE_COPY.pulse.checking} ${name}` : name };
}

/**
 * The next check, in words: a countdown up to NEXT_IN_MAX_S, the moment
 * (whenLabel, dated when not today) beyond it, the next TRY while the checks
 * are backing off. Null with nothing armed, and once its moment has come.
 */
export function nextCheckWords(input: { readonly at: number | null; readonly left: number | null; readonly backingOff: boolean; readonly now: number }): string | null {
  if (input.at === null || input.left === null) return null;
  if (input.left <= NEXT_IN_MAX_S) return input.backingOff ? LIVE_COPY.pulse.retryNextIn(input.left) : LIVE_COPY.pulse.nextIn(input.left);
  const when = whenLabel(input.at, input.now);
  return input.backingOff ? LIVE_COPY.pulse.retryNextAt(when) : LIVE_COPY.pulse.nextAt(when);
}

/**
 * When a press of Check now checks at once: the store's `refreshReadyAt`, or
 * the latest retry-after the server named — the snapshot's (stale) or the
 * history's — whichever is later. refresh() waits for neither retry-after,
 * so the button does, rather than offer a press the server will refuse.
 */
export function checkEnableAt(input: { readonly refreshReadyAt: number; readonly staleRetryAt: number | null; readonly activityRetryAt: number | null }): number {
  const { staleRetryAt: a, activityRetryAt: b } = input;
  return retryEnableAt(a === null ? b : b === null ? a : Math.max(a, b), input.refreshReadyAt);
}

/** What Check now says, and whether it can be pressed. */
export function checkLook(input: { readonly left: number | null; readonly checking: boolean }): { readonly label: string; readonly disabled: boolean } {
  if (input.checking) return { label: LIVE_COPY.pulse.checking, disabled: true };
  if (input.left !== null) return { label: LIVE_COPY.pulse.checkIn(input.left), disabled: true };
  return { label: LIVE_COPY.pulse.checkNow, disabled: false };
}

/** The dot's look in each state. All are the same box, so no state moves anything. */
export const PULSE_DOT: Readonly<Record<PulseState, string>> = {
  fresh: "bg-muted-foreground/70",
  // globals.css stops the breath under reduced motion; the hollow ring stands in for it.
  checking: "live-breathe bg-muted-foreground/70 motion-reduce:border motion-reduce:border-muted-foreground motion-reduce:bg-transparent",
  heard: "live-breathe bg-muted-foreground/70 motion-reduce:border motion-reduce:border-muted-foreground motion-reduce:bg-transparent",
  behind: "border border-muted-foreground bg-transparent",
};

/**
 * WORN OVER ANY LOOK while a newer version is served: a ring set off from the
 * dot, in the quiet tone. A box-shadow, so the box does not change, and still
 * at every motion setting.
 */
export const PULSE_UPDATE = "ring-2 ring-muted-foreground/60 ring-offset-1 ring-offset-background";

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

/** The next check the page has armed, counting down — in the popover only, so it ticks only while it is open. */
export function NextCheck({ at, backingOff }: { readonly at: number | null; readonly backingOff: boolean }) {
  const left = useCountdown(at);
  const line = nextCheckWords({ at, left, backingOff, now: Date.now() });
  return line === null ? null : <p className="text-muted-foreground">{line}</p>;
}

/** A newer version, said, and the one control that loads it. */
export function UpdateOffer() {
  return (
    <div className="flex flex-col gap-1.5 border-t pt-2" data-pulse-update="">
      <p className="text-foreground">{LIVE_COPY.pulse.update}</p>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => window.location.reload()}>
        <RotateCw aria-hidden />
        {LIVE_COPY.pulse.reloadPage}
      </Button>
    </div>
  );
}

export function LiveHeartbeat({
  nowMs,
  stale,
  live,
  activityRetryAt,
  updateAvailable,
  onCheck,
}: {
  /** The snapshot's own clock: the moment "behind" names. */
  readonly nowMs: number;
  readonly stale: LiveStale | null;
  /** How live the page is, from the store (use-live-dashboard.ts LiveLiveness). */
  readonly live: LiveLiveness;
  /** When the server said the history may be asked for again; Check now waits for it too. */
  readonly activityRetryAt: number | null;
  /** A newer build is served than this tab runs (use-update-available.ts). */
  readonly updateAvailable: boolean;
  /** The store's refresh — the same read every Retry asks for. */
  readonly onCheck: () => void;
}) {
  // The ticker is what re-renders; the clock is read here, as in use-countdown.ts.
  useTicker(true, PULSE_TICK_MS);
  const now = Date.now();
  const state = pulseStateOf({ stale: stale !== null, heard: live.heard !== null, reading: live.reading });
  const words = pulseWords({
    state,
    socket: live.socket,
    ageMs: live.lastReadAt === null ? null : now - live.lastReadAt,
    // The browser's day: the snapshot's own clock is the moment named, and against itself it is always today.
    asOf: whenLabel(nowMs, now),
    heard: live.heard !== null,
    cadenceMs: pushOffCadenceMs({ socket: live.socket, backingOff: live.backingOff, activityRetryAt, now }),
    update: updateAvailable,
  });
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
          {...(updateAvailable ? { "data-update": "" } : {})}
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
          <span aria-hidden className={cn("size-2 rounded-full", PULSE_DOT[state], updateAvailable && PULSE_UPDATE)} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-labelledby={titleId}
        // A hover takes no focus; a press takes it to the first button.
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
          <NextCheck at={live.nextReadAt} backingOff={live.backingOff} />
        </div>
        {updateAvailable ? <UpdateOffer /> : null}
        <CheckNow enableAt={checkEnableAt({ refreshReadyAt: live.refreshReadyAt, staleRetryAt: stale?.retryAt ?? null, activityRetryAt })} checking={live.reading} onCheck={onCheck} />
      </PopoverContent>
    </Popover>
  );
}
