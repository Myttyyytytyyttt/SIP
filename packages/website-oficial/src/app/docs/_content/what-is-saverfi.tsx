/**
 * What is SaverFi? — the body of /docs/what-is-saverfi.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function WhatIsSaverfiBody() {
  return (
    <>
      <P>
        You trade as usual from a SaverFi trading wallet, and its key also works in Axiom, GMGN or any Solana app. A
        share of each trade goes into a vault that only your own wallet can open. After setup you only fund your
        trading wallet: there is no separate deposit into savings, and nothing to press for each saving.
      </P>
    </>
  );
}
