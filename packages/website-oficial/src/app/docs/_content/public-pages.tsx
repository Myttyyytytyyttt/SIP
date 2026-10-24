/**
 * Public pages: leaderboard, stats and prices — the body of /docs/public-pages.
 *
 * THE THREE PAGES ANYONE CAN OPEN WITHOUT A WALLET (owner, 10-22): what each
 * shows and how to read it. The title, the one line under it and the clip are
 * not written here: the page around this body draws them from the index
 * (src/lib/docs/pages.ts).
 *
 * EVERY LABEL IS THE PAGE'S OWN, read 10-22: the leaderboard's columns, its
 * This week / All time cut (the keeper's seasonStart: Monday 00:00 UTC) and the
 * points' hover (leaderboard-view.tsx); /dashboard's figures, "Days are UTC",
 * "—" and "at least" (src/lib/global-stats-copy.ts); what /prices/view sets
 * beside what (src/components/prices-view.tsx). NO POINTS FORMULA (owner), and
 * no claim that size cannot buy a rank: most of today's score comes from size.
 * The price check before converting or buying is said as the product does it
 * (owner, 10-22: the independent check on stock buys is written as a feature).
 *
 * THE PAGES ARE PLAIN <a>s, like the sample link on what-is-saverfi: each is a
 * full page load into another layout than this one.
 */

import type { ReactNode } from "react";

import { DocLink, H2, List, P } from "@/components/docs/docs-content";

/** DocLink's look, for a page of the site that is not a docs page. */
function SiteLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      className="rounded-sm font-medium underline decoration-foreground/30 underline-offset-4 transition-colors outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
    </a>
  );
}

export default function PublicPagesBody() {
  return (
    <>
      <P>
        Three SaverFi pages are open to everyone, with no wallet needed. They show how SaverFi is doing as a whole, and
        where its prices come from.
      </P>

      <H2>Leaderboard</H2>
      <P>
        The <SiteLink href="/leaderboard">Leaderboard</SiteLink> ranks pensions by points. Switch between{" "}
        <strong>This week</strong>, which starts on Monday (UTC, world time), and <strong>All time</strong>. Each row
        shows:
      </P>
      <List>
        <li>
          <strong>Days</strong>: the days it saved, and its <strong>Streak</strong>, the most days in a row;
        </li>
        <li>
          <strong>Saved</strong> and <strong>Traded</strong>, in SOL;
        </li>
        <li>
          <strong>Points</strong>. Hover them to see what they came from: showing up, size and the streak.
        </li>
      </List>
      <P>Points add up week after week. There is nothing to claim with them.</P>

      <H2>Stats</H2>
      <P>
        The <SiteLink href="/dashboard">Dashboard</SiteLink> tab in the header is not your own dashboard, which is the
        Pension tab (see <DocLink to="dashboard" />). It adds up every SaverFi pension: what has been put aside, the
        buys and sells behind it, how many savings and purchases ran, what pensions bought, and how much came from
        Profit and how much from Volume. Its charts show it day by day.
      </P>
      <List>
        <li>Days are counted in UTC.</li>
        <li>A figure that could not be read shows “—”, never 0.</li>
        <li>A total read from an incomplete history says “at least”.</li>
      </List>

      <H2>Prices</H2>
      <P>
        <SiteLink href="/prices/view">The prices page</SiteLink> shows every price SaverFi reads, with its source, its
        age and a second price to check it against:
      </P>
      <List>
        <li>SOL, beside Pyth, an independent price service;</li>
        <li>SPYx, beside Pyth too;</li>
        <li>ANTHROPIC, beside its issuer’s own prices, with the fee the issuer charges today.</li>
      </List>
      <P>
        It also says why each PreStock, a token for a company not yet on the stock market, is or is not on offer.
        Before SaverFi converts your SOL or buys a stock, it checks the price against an independent source: see{" "}
        <DocLink to="investing" />.
      </P>
    </>
  );
}
