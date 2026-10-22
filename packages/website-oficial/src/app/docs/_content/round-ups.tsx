/**
 * Saving with round-ups — the body of /docs/round-ups.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function RoundUpsBody() {
  return (
    <>
      <P>
        Round-ups save the small change of your trading: each trade is rounded up, and the difference goes into your
        vault, up to a daily cap.
      </P>
    </>
  );
}
