/**
 * Change your settings — the body of /docs/change-settings.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function ChangeSettingsBody() {
  return (
    <>
      <P>
        The gear opens Vault settings. There you choose Profit or Volume and your rate, pause saving, pick what your
        savings buy, and set the investment threshold. Every change is signed with your pension key, and pausing stops
        saving and buying but never withdrawals.
      </P>
    </>
  );
}
