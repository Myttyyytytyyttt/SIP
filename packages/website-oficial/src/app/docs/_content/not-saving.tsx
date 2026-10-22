/**
 * Why isn't it saving? — the body of /docs/not-saving.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function NotSavingBody() {
  return (
    <>
      <P>
        Start with your trading wallet: at or under its 0.05 SOL reserve, saving waits until you top it up. Then check
        whether anything is owed yet: in Volume mode a saving is made once 0.001 SOL is owed or within the hour, and
        in Profit mode once a stretch of trading ends in a gain.
      </P>
    </>
  );
}
