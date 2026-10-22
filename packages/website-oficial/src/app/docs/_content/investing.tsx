/**
 * Investing your savings — the body of /docs/investing.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function InvestingBody() {
  return (
    <>
      <P>
        A vault keeps its savings as SOL, or buys a basket with them. With a basket, saved SOL is changed to USDC, and
        once the USDC reaches your threshold, $10 to start, each stock is bought according to its share. Stocks are
        bought at the live market price, checked before every buy.
      </P>
    </>
  );
}
