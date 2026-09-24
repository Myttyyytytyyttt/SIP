/**
 * THE FIRST PAINT'S GATE (use-live-dashboard.ts). The first snapshot of a
 * pension is drawn together with its history, so the page does not arrive
 * saying "No activity yet" and then correct itself half a second later
 * (owner, 09-24). But a slow history must not hold the whole page either: the
 * gate opens at the latest `waitMs` after the snapshot answered, whatever the
 * history is still doing.
 *
 * Pure and timer-driven so it can be tested with fake timers; the hook only
 * decides WHEN to hold and WHEN the read has settled.
 *
 *   hold false — the page is drawn at once (every read after the first).
 *   hold true  — drawn when the read settles (`release`) or after `waitMs`,
 *                whichever comes first.
 *   never twice, and never for a read that a newer one has overtaken
 *   (`stale`): a pension key that changed meanwhile has reset the store, and
 *   the old key's snapshot must not land in it.
 */
export interface FirstPaintGate {
  /** The read has settled — answered, failed, or needed nothing more: draw now if not drawn yet. */
  readonly release: () => void;
}

export function firstPaintGate(input: {
  readonly hold: boolean;
  readonly commit: () => void;
  readonly stale: () => boolean;
  readonly waitMs: number;
}): FirstPaintGate {
  let done = false;
  const open = (): void => {
    if (done || input.stale()) return;
    done = true;
    input.commit();
  };
  if (!input.hold) {
    open();
    return { release: () => undefined };
  }
  const timer = setTimeout(open, input.waitMs);
  return {
    release: () => {
      clearTimeout(timer);
      open();
    },
  };
}
