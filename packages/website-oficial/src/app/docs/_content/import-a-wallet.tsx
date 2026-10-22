/**
 * Import a wallet you already use — the body of /docs/import-a-wallet.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function ImportAWalletBody() {
  return (
    <>
      <P>
        Paste the wallet’s private key: the page shows which address it opens, and checks that address on chain before
        anything happens. The key goes to Privy encrypted and never reaches SaverFi’s servers. Importing makes a copy,
        so the key keeps working wherever you already use it.
      </P>
    </>
  );
}
