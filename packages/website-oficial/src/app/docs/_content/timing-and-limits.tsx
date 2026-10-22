/**
 * When savings happen, and their limits — the body of /docs/timing-and-limits.
 *
 * A PLACEHOLDER (10-22): one paragraph from the docs proposal, as amended by the
 * owner's decisions, until this page's writer replaces it. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts). Write with the pieces in
 * src/components/docs/docs-content.tsx, in the present tense, with no status tags.
 */

import { P } from "@/components/docs/docs-content";

export default function TimingAndLimitsBody() {
  return (
    <>
      <P>
        SaverFi checks your linked wallets about once a minute. In Profit mode a gain is usually saved within a minute
        or two of the trade that closes it; in Volume mode small amounts wait up to an hour. Your trading wallet
        always keeps 0.05 SOL, and a saving that would take it below that waits until you top it up.
      </P>
    </>
  );
}
