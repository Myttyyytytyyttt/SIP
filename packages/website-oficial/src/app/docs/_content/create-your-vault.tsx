/**
 * Create your vault — the body of /docs/create-your-vault.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function CreateYourVaultBody() {
  return (
    <>
      <P>
        Setup is two steps: Welcome, then Create your vault. You choose Profit or Volume and your rate, and what your
        savings become: SOL, or SPYx and/or ANTHROPIC, split evenly. It takes one approval, and each cost is shown
        before you approve.
      </P>
    </>
  );
}
