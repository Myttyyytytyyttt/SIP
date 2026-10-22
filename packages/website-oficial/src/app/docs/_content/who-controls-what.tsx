/**
 * Who controls what — the body of /docs/who-controls-what.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function WhoControlsWhatBody() {
  return (
    <>
      <P>
        Your pension key is the only key that can withdraw, change your rules or link wallets. On your trading
        wallets, SaverFi’s keeper, its automatic helper, may sign savings into your vault and nothing else; in the
        vault it buys only within the limits you signed, and it can never withdraw.
      </P>
    </>
  );
}
