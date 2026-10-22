/**
 * Saving from your volume — the body of /docs/saving-from-volume.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function SavingFromVolumeBody() {
  return (
    <>
      <P>
        Your rate applies to the SOL size of every buy and every sell, win or lose. For example, at the starting rate
        of 2 %, a 1 SOL buy plus a 1.1 SOL sell saves 0.042 SOL.
      </P>
    </>
  );
}
