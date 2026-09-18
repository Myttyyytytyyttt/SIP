/**
 * THE KEEPER-SEAT WORK ON EACH TRADING WALLET, kept OUTSIDE any component.
 *
 * A re-seat runs for up to a minute: the removal, the wait for Privy's record,
 * the add. The row that started it can unmount meanwhile — the Manage wallets
 * modal closed, the page left — and its promise runs on regardless. Kept in the
 * row, the lock and the outcome went with it: the owner never saw how the re-seat
 * ended, and a row mounted again started with no lock, read "No seat" halfway
 * through, and offered a Grant that raced the running re-seat (both are
 * read-modify-writes of the wallet's additional_signers). So both live here, by
 * address, for the life of the page: a row mounted again shows "Re-seating…" and
 * then the outcome.
 *
 * LEAVING MID-RE-SEAT IS HELD BACK. Between the removal and the add only this page
 * holds the add, and a page that goes away takes it along: the wallet stays with no
 * signer. While a re-seat runs, reloading or closing the tab asks first
 * (beforeunload), and a click on a link is stopped before Next's router sees it;
 * WalletsModal will not close (reseatRunning). The browser's own back button is
 * not held.
 *
 * Client-safe and pure: no React. The hook reads it with useSyncExternalStore.
 */

export type SeatBusy = "granting" | "reseating" | "checking";

export interface SeatActivity {
  readonly busy: SeatBusy | null;
  /** What stopped the last operation, for the page; null when nothing did. */
  readonly failure: string | null;
  /** What the last operation did when the badge alone cannot show it. */
  readonly notice: string | null;
  /**
   * Until when (epoch ms) Grant keeper permission is held back on this wallet, or null. Set after an add Privy
   * accepted and its record may not show yet: a grant on a record that lags appends the signer a second time.
   */
  readonly holdGrantUntil: number | null;
}

export const IDLE_ACTIVITY: SeatActivity = Object.freeze({ busy: null, failure: null, notice: null, holdGrantUntil: null });

const activities = new Map<string, SeatActivity>();
const listeners = new Set<() => void>();

/** This wallet's activity. The same object until it changes, as useSyncExternalStore needs. */
export function seatActivity(address: string): SeatActivity {
  return activities.get(address) ?? IDLE_ACTIVITY;
}

export function subscribeSeatActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a re-seat is running on any wallet. */
export function reseatRunning(): boolean {
  for (const activity of activities.values()) if (activity.busy === "reseating") return true;
  return false;
}

function write(address: string, next: SeatActivity): void {
  activities.set(address, next);
  holdTheDoor(reseatRunning());
  for (const listener of [...listeners]) listener();
}

/**
 * Start one operation on this wallet: false, changing nothing, while one is running there. A failure is cleared;
 * the notice too, unless `keepNotice` (a re-read changes nothing a notice said).
 */
export function beginSeatTask(address: string, busy: SeatBusy, { keepNotice = false }: { keepNotice?: boolean } = {}): boolean {
  const current = seatActivity(address);
  if (current.busy !== null) return false;
  write(address, { busy, failure: null, notice: keepNotice ? current.notice : null, holdGrantUntil: current.holdGrantUntil });
  return true;
}

/**
 * End the operation running on this wallet with its outcome. `holdGrantFor` holds Grant keeper permission back for
 * that many milliseconds from now; the hold lifts on its own, and the store says so to every subscriber.
 */
export function endSeatTask(address: string, outcome: { failure?: string | null; notice?: string | null; holdGrantFor?: number } = {}): void {
  const current = seatActivity(address);
  const holdGrantUntil = outcome.holdGrantFor === undefined ? current.holdGrantUntil : Date.now() + outcome.holdGrantFor;
  write(address, {
    busy: null,
    failure: outcome.failure ?? null,
    notice: outcome.notice === undefined ? current.notice : outcome.notice,
    holdGrantUntil,
  });
  if (outcome.holdGrantFor !== undefined) {
    setTimeout(() => {
      const now = seatActivity(address);
      if (now.holdGrantUntil === holdGrantUntil) write(address, { ...now, holdGrantUntil: null });
    }, outcome.holdGrantFor);
  }
}

/** Forget everything. For tests: in the app the store lives as long as the page. */
export function clearSeatActivity(): void {
  activities.clear();
  holdTheDoor(false);
  for (const listener of [...listeners]) listener();
}

let held = false;

function askBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Older browsers show the prompt only when returnValue is set.
  event.returnValue = "";
}

function stopLinkClick(event: MouseEvent): void {
  const target = event.target;
  if (typeof Element === "undefined" || !(target instanceof Element) || target.closest("a[href]") === null) return;
  event.preventDefault();
  event.stopPropagation();
}

/** Install or remove the guards against leaving; nothing outside a browser. */
function holdTheDoor(hold: boolean): void {
  if (hold === held || typeof window === "undefined" || typeof document === "undefined") return;
  held = hold;
  if (hold) {
    window.addEventListener("beforeunload", askBeforeUnload);
    // Capture, on the document: it runs before React's own listener on the root, so Next's Link never navigates.
    document.addEventListener("click", stopLinkClick, true);
  } else {
    window.removeEventListener("beforeunload", askBeforeUnload);
    document.removeEventListener("click", stopLinkClick, true);
  }
}
