/**
 * Saving from your profit — the body of /docs/saving-from-profit.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function SavingFromProfitBody() {
  return (
    <>
      <P>
        When a stretch of trading ends with more SOL than it started with, your rate times that gain moves to your
        vault. The rate starts at 20 %. Plain transfers never count, and tokens you still hold count only once they
        are sold back to SOL.
      </P>
    </>
  );
}
