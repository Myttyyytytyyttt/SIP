/**
 * Public pages: leaderboard, stats and prices — the body of /docs/public-pages.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function PublicPagesBody() {
  return (
    <>
      <P>
        Three pages need no wallet. The leaderboard shows days, streaks, savings and points; the dashboard adds up
        every pension; and the prices page shows each price SaverFi reads, with its source and its age.
      </P>
    </>
  );
}
