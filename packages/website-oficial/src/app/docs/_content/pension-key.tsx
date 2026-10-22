/**
 * Your pension key — the body of /docs/pension-key.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function PensionKeyBody() {
  return (
    <>
      <P>
        You connect an external Solana wallet: Phantom, Backpack, Solflare or another browser extension. That wallet
        owns your vault, signs every change, and is the only key that can withdraw. It stays in your wallet app:
        SaverFi never holds it, and it is never used as a trading wallet.
      </P>
    </>
  );
}
