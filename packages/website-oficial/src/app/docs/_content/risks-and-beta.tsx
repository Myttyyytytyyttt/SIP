/**
 * Risks and beta status — the body of /docs/risks-and-beta.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function RisksAndBetaBody() {
  return (
    <>
      <P>
        Prices move: SOL, the S&P 500 through SPYx, and private-company tokens can all fall. SaverFi has been live on
        Solana mainnet since 15 September 2026, and the team is preparing it for an independent external audit.
      </P>
    </>
  );
}
