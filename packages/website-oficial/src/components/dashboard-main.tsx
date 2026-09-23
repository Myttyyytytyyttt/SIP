import type { ReactNode } from "react";

/**
 * THE PENSION PAGE'S MAIN COLUMN, for the sample and the live page alike — one
 * layout, so the two cannot drift into different ones.
 *
 * EVERYTHING ON ONE SCREEN, ON EVERY SCREEN (owner, 09-23): opening the page
 * should show the strip, the rule, the curve, the stats and what the pension
 * holds without a scroll — on a 13" laptop and on a 27" monitor alike. So from
 * xl up the column is at least the viewport's height, the cards' row takes what
 * the strip leaves, and inside the pension card the CHART takes what the rest
 * leaves (pension-panel.tsx): short on a laptop, tall on a big screen, and the
 * figures around it the same size on both. A screen too short for even the
 * chart's minimum simply scrolls, as a page should.
 *
 * Below xl the cards stack or the sidebar is a sheet, nothing fits one screen
 * anyway, and the column is the ordinary scrolling page it always was.
 */

/** The rule card's place in the row: second on a phone, first beside the sidebar. */
export const RULE_SLOT = "order-2 md:order-1 lg:order-2 xl:order-1";
/** The pension card's place: first on a phone, and on xl it fills the row's height so its chart can grow. */
export const PENSION_SLOT = "order-1 md:order-2 lg:order-1 xl:order-2";

export function DashboardMain({ top, strip, cards }: { readonly top?: ReactNode; readonly strip: ReactNode; readonly cards: ReactNode }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6 xl:min-h-[calc(100dvh-3.5rem)] xl:gap-4 xl:p-4 xl:short:gap-3 xl:short:p-3">
      {top}
      {strip}
      <div className="grid gap-4 md:grid-cols-[minmax(16rem,20rem)_1fr] lg:grid-cols-1 lg:gap-6 xl:flex-1 xl:grid-cols-[minmax(16rem,20rem)_1fr] xl:gap-4 xl:short:gap-3">{cards}</div>
    </main>
  );
}
