"use client";

/**
 * WHETHER A NEWER VERSION IS SERVED, KEPT FOR AS LONG AS THIS TAB RUNS ITS
 * BUNDLE (plan B2, 10-09). The data session's useNewVersion (hooks/
 * use-new-version.ts) asks /api/version and says `updateAvailable`; nothing
 * mounted it, so a tab opened before a deploy said nothing (D5). It is mounted
 * HERE, by the live body that draws it — as the header dot's ring and its
 * popover's reload (LiveHeartbeat.tsx) — and nowhere the sample can reach, so
 * /?mode=mock asks nothing it did not ask before.
 *
 * ONCE TRUE, TRUE UNTIL THE RELOAD. The live body is mounted again on every
 * walk between / and /activity, and the hook's own state starts false with it:
 * a ring seen on one view would be gone on the other until the next check, up
 * to minutes later. The answer cannot become less true — this tab's bundle
 * does not change under it — so what the hook said once is held for the life
 * of the module, which is the life of the bundle.
 */

import { useNewVersion } from "@/hooks/use-new-version";

/** What this bundle has been told. Module-wide on purpose: it outlives the body that asks. */
const SEEN = { update: false };

/**
 * `available` now, or ever before in this bundle. Writes only ever turn it on,
 * so a render React throws away can leave nothing untrue behind.
 */
export function heldUpdate(seen: { update: boolean }, available: boolean): boolean {
  if (available) seen.update = true;
  return seen.update;
}

export function useUpdateAvailable(): boolean {
  return heldUpdate(SEEN, useNewVersion().updateAvailable);
}
