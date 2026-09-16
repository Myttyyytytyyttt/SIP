/**
 * WHEN THE LIVE DASHBOARD READS SOLANA AGAIN. Pure, so the whole policy is one
 * table of numbers a test can pin rather than timers scattered through a hook.
 *
 * THE KEEPER SWEEPS ABOUT ONCE A MINUTE, so polling faster than that spends the
 * Helius key the keeper shares to show the same numbers again. A visible tab
 * costs about 7 client tokens and 5 upstream calls a minute; a hidden one costs
 * nothing at all, because nobody is looking.
 *
 * A REFUSAL IS OBEYED, NOT RETRIED THROUGH. A 429 carries retry-after, and that
 * always wins over the backoff: asking again sooner than the server said is how
 * one browser turns a busy minute into a locked-out one.
 */

/** The keeper's sweep: reading faster shows the same numbers twice. */
export const POLL_BASE_MS = 60_000;

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
}

const backoffFor = (failures: number): number => {
  if (failures <= 0) return POLL_BASE_MS;
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
  const gap = backoffFor(input.failures);
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

/** Whether a tab that just became visible should read at once: its numbers are a sweep old. */
export const shouldRefreshOnShow = (lastReadAt: number | null, now: number): boolean =>
  lastReadAt === null || now - lastReadAt >= POLL_BASE_MS;
