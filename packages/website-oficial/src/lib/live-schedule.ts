/**
 * WHEN THE LIVE DASHBOARD READS SOLANA AGAIN. Pure, so the whole policy is one
 * table of numbers a test can pin rather than timers scattered through a hook.
 *
 * THE KEEPER SWEEPS ABOUT ONCE A MINUTE, so polling faster than that spends the
 * Helius key the keeper shares to show the same numbers again. A visible tab
 * costs about 7 client tokens and 5 upstream calls a minute; a hidden one costs
 * nothing at all, because nobody is looking. While a step is under way
 * (PENDING_POLL_MS below) the same reads run three times a minute, for at most
 * five minutes at a stretch, and so they do while the chain's push is down
 * (UNHEARD_POLL_MS). A change the chain announces (live-push.ts) brings
 * the next read forward, never closer than MANUAL_FLOOR_MS to the last: six
 * reads a minute at most, however busy the chain.
 *
 * A REFUSAL IS OBEYED, NOT RETRIED THROUGH. A 429 carries retry-after, and that
 * always wins over the backoff: asking again sooner than the server said is how
 * one browser turns a busy minute into a locked-out one.
 */

import type { SocketState } from "@/lib/live-socket";

/** The keeper's sweep: reading faster shows the same numbers twice. */
export const POLL_BASE_MS = 60_000;

/**
 * WHILE SOMETHING IS ON ITS WAY — SOL converting, a basket about to be bought
 * (src/lib/live-pending.ts) — the dashboard reads every 20 s instead, so the
 * next read after the step lands comes at most 20 s later rather than up to a
 * minute, and the loader gives way to the real row with it. Three times the
 * reads, so it is bounded twice: it stops when no step is under way, and
 * PENDING_POLL_MAX_MS after one was first seen, whatever the steps say.
 */
export const PENDING_POLL_MS = 20_000;

/** The longest the faster cadence runs for one stretch of pending steps: five sweeps. */
export const PENDING_POLL_MAX_MS = 5 * 60_000;

/**
 * WHILE NOTHING WILL RING (owner, 10-09: "todo lo que pase se muestre
 * rápidamente"). The minute's poll was sized for a page the chain also rings:
 * the socket brings a change forward, the poll only sweeps up after it. With
 * the socket down — still connecting, closed and waiting for its next attempt,
 * or with no endpoint to open — the poll is ALL the page has, and a saving
 * that lands just after a read stays off screen for up to a minute. So a
 * visible tab whose push is wanted and not live reads every 20 s.
 *
 * WHAT IT COSTS, against /api/solana-live's own per-client bucket of
 * relay.perClientPerMin = 60 weighted tokens a minute (solana-core
 * build-handler.ts): a quiet read is a snapshot (4: BUILD_REQUEST_WEIGHT 3 + 1
 * more call) and an activity page (3, plus 1 per new transaction), about 7
 * tokens, so three a minute is about 21 of the 60 FOR ONE VISIBLE TAB — the
 * pending cadence's rate, never added to it. Upstream, 15 calls a minute per
 * such tab (relay.readsGlobalPerMin, 1,800 by default, is what every route's
 * reads share). A hidden tab still reads nothing, a backoff still wins, and so
 * does a retry-after.
 *
 * THE BUCKET IS PER CLIENT, NOT PER TAB (review 2026-10-09): one IPv4 address
 * or IPv6 /64 (handlers.ts). With the push down for everyone behind one NAT —
 * a laptop, a phone on the same Wi-Fi and a second window — every visible
 * dashboard there drops to 20 s at once: three of them is about 63 tokens a
 * minute, and reads start coming back 429. So a refusal this cadence earned
 * is not a failure (refusalBacksOff): the tab goes back to the minute's poll
 * until a read succeeds, obeying the retry-after, instead of stepping into
 * BACKOFF_MS's two to five minutes — slower than the minute it replaced.
 */
export const UNHEARD_POLL_MS = 20_000;

/**
 * Whether the page is on its own: a socket is wanted (a live pension with a
 * vault to watch — "none" otherwise) and it is not live. Never while the
 * history's retry-after is still ahead: every read asks for the history, and
 * the faster cadence would ask before the moment the server named. Never once
 * a read at this cadence was refused (`refused`), until a read succeeds.
 */
export function unheardPollWanted(input: {
  readonly socket: SocketState | "none";
  readonly activityRetryAt: number | null;
  readonly now: number;
  /** A read this cadence bought was refused (429) and none has succeeded since (refusalBacksOff). */
  readonly refused?: boolean;
}): boolean {
  if (input.socket === "none" || input.socket === "live" || input.refused === true) return false;
  return !(input.activityRetryAt !== null && input.activityRetryAt > input.now);
}

/**
 * WHETHER A READ THAT FAILED COUNTS TOWARD THE BACKOFF. Every failure does,
 * but one: a rate limit (429) on a read the faster unheard cadence bought,
 * with nothing failed before it. That one is the cadence's own doing — the
 * tab drops back to the minute (unheardPollWanted's `refused`) and obeys the
 * retry-after, so the faster cadence never steps a tab into BACKOFF_MS sooner
 * than a plain sweep would. A refusal at the minute's cadence after it counts
 * as it always has.
 */
export function refusalBacksOff(input: { readonly rateLimited: boolean; readonly unheard: boolean; readonly failures: number }): boolean {
  return !(input.rateLimited && input.unheard && input.failures === 0);
}

/** After repeated failures: 2 minutes, 4, then 5 at most. Reset on success. */
export const BACKOFF_MS: readonly number[] = [120_000, 240_000, 300_000];

/** A manual refresh, or one after the wallets modal closes, waits at least this long after the previous read. */
export const MANUAL_FLOOR_MS = 10_000;

export interface ScheduleInput {
  /** Consecutive failed reads; 0 after any success. */
  readonly failures: number;
  /** From a 429's retry-after, when the last answer carried one. */
  readonly retryAfterSeconds: number | null;
  /** document.visibilityState === "visible". */
  readonly visible: boolean;
  /** When the last read finished; null when none has. */
  readonly lastReadAt: number | null;
  readonly now: number;
  /** A read is in flight right now. Nothing is scheduled on top of one. */
  readonly reading: boolean;
  /** A step is under way and the faster cadence is still allowed (pendingPollWanted). Never shortens a backoff. */
  readonly pending?: boolean;
  /** The push is wanted and not live (unheardPollWanted): the poll is all there is. Never shortens a backoff. */
  readonly unheard?: boolean;
}

const backoffFor = (failures: number, input: Pick<ScheduleInput, "pending" | "unheard">): number => {
  if (failures <= 0) {
    if (input.pending === true) return PENDING_POLL_MS;
    return input.unheard === true ? UNHEARD_POLL_MS : POLL_BASE_MS;
  }
  return BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]!;
};

/**
 * Milliseconds from `now` until a target that is `gap` after the last read.
 *
 * WITH NO LAST READ the answer depends on whether anything has FAILED. Nothing
 * read and nothing failed is the first read: it happens now. But nothing read
 * after a failure must still wait out the gap — returning 0 there would retry
 * as fast as the event loop allows, which is a hot loop against a server that
 * has already said no, and precisely what the backoff exists to prevent.
 */
const untilGapFrom = (lastReadAt: number | null, now: number, gap: number, failures: number): number => {
  if (lastReadAt === null) return failures > 0 ? gap : 0;
  const elapsed = now - lastReadAt;
  return elapsed >= gap ? 0 : gap - elapsed;
};

/**
 * How long until the next poll, or NULL for "do not schedule one": a hidden tab
 * runs no timer, because a dashboard nobody is looking at should cost nothing.
 */
export function nextDelayMs(input: ScheduleInput): number | null {
  if (!input.visible) return null;
  /*
   * A READ IS ALREADY RUNNING, so there is nothing to schedule on top of it.
   *
   * This is not an optimisation. The first read starts BEFORE this is first
   * asked, and with nothing read yet and nothing failed the answer below is 0 —
   * "the first read happens now". The timer then fires at once, finds the
   * caller's in-flight guard closed, does nothing, and re-arms itself at 0: a
   * re-render of the whole dashboard every few milliseconds (the browser's
   * nested-timeout clamp) for as long as the first round trip takes, and
   * forever if a request never answers. The read re-arms the poll when it
   * finishes; until then the answer is that there is nothing to do.
   */
  if (input.reading) return null;
  const gap = backoffFor(input.failures, input);
  const scheduled = untilGapFrom(input.lastReadAt, input.now, gap, input.failures);
  // The server's own retry-after always wins: it knows what it is holding back.
  const retry = input.retryAfterSeconds === null ? 0 : Math.max(0, input.retryAfterSeconds) * 1_000;
  return Math.max(scheduled, retry);
}

/**
 * A refresh someone asked for (the Refresh line, or the wallets modal closing).
 * It still waits out MANUAL_FLOOR_MS since the last read, so clicking twice —
 * or closing the modal right after it opened — cannot spend a minute's tokens
 * in a second. A retry-after still wins over it.
 */
export function nextManualDelayMs(input: Pick<ScheduleInput, "lastReadAt" | "now" | "retryAfterSeconds">): number {
  const floor = untilGapFrom(input.lastReadAt, input.now, MANUAL_FLOOR_MS, 0);
  const retry = input.retryAfterSeconds === null ? 0 : Math.max(0, input.retryAfterSeconds) * 1_000;
  return Math.max(floor, retry);
}

/**
 * THE MOMENT A REFRESH STOPS WAITING (UI plan 10-09, §5 item 5): from then on
 * refresh() reads at once instead of deferring to the floor — the moment a
 * Retry or a "Check Solana now" can honestly be offered. `lastReadAt` is when
 * the last read FINISHED, failed ones included: a failed read starts the floor
 * as a good one does, so a Retry pressed straight after it waits too. 0 before
 * any read: nothing to wait for. A retry-after is not in it — refresh() does not
 * wait for one; the page compares it itself.
 */
export const manualReadyAt = (lastReadAt: number | null): number => (lastReadAt === null ? 0 : lastReadAt + MANUAL_FLOOR_MS);

/**
 * WHEN THE NEXT READ NOBODY ASKED FOR IS DUE (§5 item 6), on this browser's
 * clock: the earlier of the poll's timer and the push's, each as armed (null
 * when it is not). Null while the tab is hidden — neither timer runs then —
 * and while none is armed: a read is out, or nothing is scheduled.
 */
export function nextReadAtOf(input: { readonly visible: boolean; readonly pollAt: number | null; readonly pushAt: number | null }): number | null {
  if (!input.visible) return null;
  if (input.pollAt === null) return input.pushAt;
  return input.pushAt === null ? input.pollAt : Math.min(input.pollAt, input.pushAt);
}

/**
 * WHETHER THE READS ARE BACKING OFF (§5 item 6): a failed read put the poll on
 * BACKOFF_MS's two to five minutes (`failures`), or a 429 the faster unheard
 * cadence earned put it back on the minute (`refused`, refusalBacksOff). Not a
 * history-only refusal: the snapshot was read, nothing is backed off, and the
 * next read comes EARLIER, at the server's moment (nextActivityRetryMs).
 */
export const backingOffOf = (input: { readonly failures: number; readonly refused: boolean }): boolean => input.failures > 0 || input.refused;

/*
 * A tab that becomes visible again reads at once when its last read is the
 * manual floor old — no longer a whole sweep: live-push.ts showReadWanted,
 * beside the push that also brings reads forward.
 */

/** Early re-reads the HISTORY may buy between one page that WAS read and the next. */
export const ACTIVITY_RETRIES = 1;

export interface ActivityRetryInput {
  /** When the server said this browser may ask for the history again. */
  readonly retryAt: number | null;
  /** Early re-reads already spent since the last page that was read. */
  readonly attempts: number;
  readonly now: number;
}

/**
 * HOW LONG UNTIL A READ REFUSED ONLY ITS HISTORY IS WORTH REPEATING EARLY, or
 * null for "do not: the ordinary poll gets there first".
 *
 * The route says WHEN this browser may ask again (a 429's retry-after, often a
 * second or two on a bucket that refills at one token a second) and the hook
 * used to throw it away. So the sidebar said "Activity could not be read just
 * now" for the rest of the minute over a problem that had cleared, and the
 * Retry button offered no idea when it would help.
 *
 * NULL PAST THE SWEEP, because two schedules for one read is one too many, and
 * the poll is already coming. NULL PAST ACTIVITY_RETRIES, because a refusal
 * that keeps repeating is a bucket that needs the whole minute, not a faster
 * question.
 *
 * NOTHING HERE BACKS THE PAGE OFF. The snapshot's own leg succeeded — every
 * figure on the screen is current — and counting this as a dashboard failure
 * would put all of them on BACKOFF_MS's two-to-five minute clock for a column
 * of rows.
 */
export function nextActivityRetryMs(input: ActivityRetryInput): number | null {
  if (input.retryAt === null || input.attempts >= ACTIVITY_RETRIES) return null;
  const wait = input.retryAt - input.now;
  if (wait >= POLL_BASE_MS) return null;
  return Math.max(0, wait);
}

/**
 * Whether the faster cadence applies now: a step is under way, and it has not
 * already run for PENDING_POLL_MAX_MS. `activeSince` is when this page first saw
 * a step under way in the current stretch (null when none is). The bound is what
 * stops a step the chain never resolves — USDC that arrived with no row to time
 * it by, say, held back for a reason the page cannot read — from tripling the
 * reads for as long as the tab stays open.
 */
export function pendingPollWanted(input: {
  readonly active: boolean;
  readonly activeSince: number | null;
  readonly now: number;
  /**
   * When the history route said this browser may ask for it again (a 429's
   * retry-after), or null. Every read asks for the history, so while that
   * moment is still ahead the faster cadence would ask before it — the one
   * thing "A REFUSAL IS OBEYED" forbids. The ordinary cadence, and the early
   * re-read nextActivityRetryMs schedules for exactly that moment, apply instead.
   */
  readonly activityRetryAt: number | null;
}): boolean {
  if (!input.active || input.activeSince === null) return false;
  if (input.activityRetryAt !== null && input.activityRetryAt > input.now) return false;
  return input.now - input.activeSince < PENDING_POLL_MAX_MS;
}
