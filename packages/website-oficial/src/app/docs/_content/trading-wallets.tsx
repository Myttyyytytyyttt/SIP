/**
 * Trading wallets — the body of /docs/trading-wallets.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function TradingWalletsBody() {
  return (
    <>
      <P>
        “Create wallet and link it” makes a Solana wallet for you and links it to your vault. Send it SOL, keeping
        more than 0.05 SOL in it, and trade. “Export key” shows its key, so you can use the same wallet in Axiom, GMGN
        or any Solana app, and it stays linked after you export.
      </P>
    </>
  );
}
