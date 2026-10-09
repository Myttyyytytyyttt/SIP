"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * MANY THINGS HELD FOR A WHILE, ON ONE TIMER (10-09). A row that just arrived
 * keeps its edge for 30 s; a step that just finished stays "done" for 4 s. Each
 * is an id with a time it lets go — one Map of id → until, and one timer set for
 * whichever lets go first, rather than a timer per row that a busy read would
 * multiply. A single flag held for a while is useFlash's job (hooks/use-flash.ts).
 *
 * BROWSER TIME, on purpose: how long a mark stays is about the person looking,
 * not the chain. Holding an id again restarts its clock.
 */

/** Each held id, and the browser ms at which it lets go. */
export type Holds = ReadonlyMap<string, number>;

const NONE: Holds = new Map();

/** `ids` held until `until`, a later hold winning. The same Map back when nothing changed, so React keeps the render. */
export function holdUntil(holds: Holds, ids: Iterable<string>, until: number): Holds {
  let next: Map<string, number> | null = null;
  for (const id of ids) {
    if ((holds.get(id) ?? -Infinity) >= until) continue;
    next ??= new Map(holds);
    next.set(id, until);
  }
  return next ?? holds;
}

/** What is still held at `now`; the same Map back when nothing was due. */
export function releaseDue(holds: Holds, now: number): Holds {
  let next: Map<string, number> | null = null;
  for (const [id, until] of holds) {
    if (until > now) continue;
    next ??= new Map(holds);
    next.delete(id);
  }
  return next ?? holds;
}

/** When the next hold lets go, or null when nothing is held. */
export function nextRelease(holds: Holds): number | null {
  let first: number | null = null;
  for (const until of holds.values()) if (first === null || until < first) first = until;
  return first;
}

/**
 * `held` is every id still held; `hold(ids)` holds them for `ms` from now.
 * `hold` is stable, so it can sit in an effect's dependencies.
 */
export function useHold(ms: number): readonly [held: ReadonlySet<string>, hold: (ids: Iterable<string>) => void] {
  const [holds, setHolds] = useState<Holds>(NONE);

  const hold = useCallback((ids: Iterable<string>) => setHolds((current) => holdUntil(current, ids, Date.now() + ms)), [ms]);

  useEffect(() => {
    const at = nextRelease(holds);
    if (at === null) return;
    // Released as at `at` at the least: a timer may wake a millisecond early,
    // and one that released nothing would leave this Map unchanged — and no
    // effect would ever set the next timer.
    const timer = setTimeout(() => setHolds((current) => releaseDue(current, Math.max(Date.now(), at))), Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [holds]);

  const held = useMemo<ReadonlySet<string>>(() => new Set(holds.keys()), [holds]);
  return [held, hold] as const;
}
