/**
 * Reading your dashboard — the body of /docs/dashboard.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function DashboardBody() {
  return (
    <>
      <P>
        Until your pension is running, one card shows your next step. After that the page shows your recent savings,
        the Savings rule card with your next and last investment, and what you have saved so far and what it is worth
        now. A “—” means a figure could not be read; it never means zero.
      </P>
    </>
  );
}
