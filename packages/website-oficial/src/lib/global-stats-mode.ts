/**
 * WHICH NUMBERS THE PUBLIC DASHBOARD SHOWS, decided once, on the server.
 *
 * THE OWNER'S RULE (10-06): it follows the app's mode — in Mock it shows the
 * sample, in Live the real figures. So `?mode=mock` is the sample and anything
 * else (`?mode=live`, no mode, a mode this app does not know) is live: a
 * connected pension's own tabs carry no mode at all, and they must land on real
 * numbers. Unlike /leaderboard, there is no `?demo=1`.
 *
 * THE ONE DIFFERENCE FROM THE PENSION PAGE: there, a connected pension key that
 * types `?mode=mock` is put back in Live, because the sample there is shaped
 * like somebody's own pension. Here the sample is invented totals for invented
 * pensions under a badge on every card, so the URL is taken at its word.
 *
 * THE LIVE|MOCK CONTROL is offered only to a browser that has never connected
 * (no session hint): the pension page does not offer it to a connected key,
 * and this page cannot ask Privy, so the hint stands in.
 */

import { readUrlMode, type UrlMode } from "@/lib/dashboard-mode";
import { hasSessionHint } from "@/lib/session-hint";

export interface GlobalStatsMode {
  /** The mode the page's links carry, as read; null leaves them bare. */
  readonly mode: UrlMode | null;
  readonly showSample: boolean;
  readonly returning: boolean;
  readonly control: boolean;
}

export function decideGlobalStatsMode(requested: string | string[] | undefined, hintCookie: string | undefined): GlobalStatsMode {
  // An array (?mode=mock&mode=live) is no mode at all.
  const mode = readUrlMode(typeof requested === "string" ? requested : null);
  const returning = hasSessionHint(hintCookie);
  return { mode, showSample: mode === "mock", returning, control: !returning };
}
