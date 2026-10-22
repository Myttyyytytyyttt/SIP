/**
 * Take money out — the body of /docs/take-money-out.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function TakeMoneyOutBody() {
  return (
    <>
      <P>
        Go to Manage wallets, then Take money out. You can take out any SOL above the vault’s rent, and each token in
        steps of 25 %, 50 % or All. Each withdrawal is one approval, the money goes only to your pension key’s own
        wallet, and it works even while saving is paused.
      </P>
    </>
  );
}
