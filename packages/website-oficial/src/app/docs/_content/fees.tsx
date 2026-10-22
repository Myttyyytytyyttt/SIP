/**
 * Fees — the body of /docs/fees.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function FeesBody() {
  return (
    <>
      <P>
        SaverFi takes no fee: all of each saving reaches your vault. You pay each saving’s network fee, about 0.00001
        SOL from the trading wallet, and the rents shown before you approve.
      </P>
    </>
  );
}
