/**
 * GET /api/leaderboard — the keeper's rankings, proxied and cached.
 *
 * WHY A ROUTE AT ALL, when the page reads the same thing server side: so the
 * board is scriptable. A judge checking the numbers, a second front end, a bot
 * posting the week's winner — none of them should have to scrape a page, and
 * none of them should need the keeper's hostname, which this app already knows.
 *
 * IT PROXIES, IT DOES NOT COMPUTE. The scoring lives in the keeper, beside the
 * only writer of the history it scores; duplicating it here would be two rules
 * that agree until one is edited.
 *
 * A REFUSAL IS A 503 WITH A REASON, never an empty board at 200: the page must
 * be able to say "unavailable" rather than draw a credible, wrong, empty table.
 */

import { LEADERBOARD_REVALIDATE_SECONDS, fetchLeaderboard } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await fetchLeaderboard();
  if (!result.ok) {
    return Response.json(
      { error: "the leaderboard is not available", detail: result.detail },
      // NOT CACHED. A failure that is cached for a minute outlives the thing
      // that caused it, and the next visitor pays for it.
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(result.data, {
    headers: {
      // The shared cache does the work; a browser revalidates on its own.
      "cache-control": `public, s-maxage=${LEADERBOARD_REVALIDATE_SECONDS}, stale-while-revalidate=300`,
    },
  });
}
