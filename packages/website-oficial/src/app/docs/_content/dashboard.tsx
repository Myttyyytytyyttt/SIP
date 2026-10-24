/**
 * Reading your dashboard — the body of /docs/dashboard.
 *
 * THE PENSION TAB, BLOCK BY BLOCK (owner, 10-22): what each part of the
 * connected page is, what the header's dot says, and that a dash is never a
 * zero. The title, the one line under it and the clip (the landing's app loop,
 * with its "Example" caption) are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts) and src/lib/docs/clips.ts.
 *
 * EVERY LABEL IS THE APP'S OWN, read 10-22: the setup list, "Saved so far",
 * "Pension value", "Next investment" and "Last investment" (src/lib/live-copy.ts,
 * pension-panel.tsx, savings-rule-panel.tsx); "In progress", "Waiting" and the
 * "?" (LIVE_COPY.pendingHeading, pendingWhy); the dot's three looks
 * (live/LiveHeartbeat.tsx); "Account upkeep" and "Show them" (ACTIVITY_COPY).
 * The strip's "Recent settlements" is only its accessible name, so it is
 * described here, not quoted; so is the hero's pill (LIVE_COPY.heroPill, "+$0.43
 * saved · 14:32 UTC"), whose face is a figure. The header calls this page
 * "Pension"; its public "Dashboard" tab is another page (public-pages).
 */

import { DocLink, H2, List, P } from "@/components/docs/docs-content";

export default function DashboardBody() {
  return (
    <>
      <P>
        Your dashboard is the <strong>Pension</strong> tab in the header. It shows what you have saved, what it is
        worth, and what SaverFi is doing with it right now.
      </P>

      <H2>While you set up</H2>
      <P>
        A card at the top shows your next step, and a “Getting started” list ticks each one off.
      </P>

      <H2>The main numbers</H2>
      <List>
        <li>
          <strong>The strip</strong> at the top: your mode and rate, then one chip per recent saving.
        </li>
        <li>
          <strong>Saved so far</strong>: everything put aside, in dollars at today’s SOL price. A small pill beside it
          shows each saving as it lands. <strong>Pension value</strong> is what your vault holds today.
        </li>
        <li>
          <strong>Savings rule</strong>: your rate, what your savings buy, <strong>Next investment</strong> (how close
          the next buy is) and <strong>Last investment</strong>. Its gear opens{" "}
          <DocLink to="change-settings">Vault settings</DocLink>.
        </li>
        <li>
          <strong>Stats</strong> and <strong>Holdings</strong>: your savings in figures, and each asset with its value.
          The app also calls a saving a “settlement”.
        </li>
      </List>

      <H2>What is moving now</H2>
      <P>
        Rows headed “In progress”, above your activity, show money on its way: checking your latest activity,
        converting SOL to USDC, buying a stock. When every step rests, the heading says “Waiting”, and the “?” beside a
        step says why. If nothing arrives, see <DocLink to="not-saving" />.
      </P>

      <H2>The dot in the corner</H2>
      <P>The dot at the far right of the header says how fresh the page is:</P>
      <List>
        <li>
          <strong>Green</strong>: up to date, and updating itself.
        </li>
        <li>
          <strong>Red</strong>: the last update failed. You see the last good figures, and SaverFi keeps trying.
        </li>
        <li>
          <strong>A ring</strong>: a newer version of SaverFi is out. Press the dot, then <strong>Reload page</strong>.
        </li>
      </List>
      <P>A “—” means a figure could not be read just now. It never means zero.</P>

      <H2>Every transaction</H2>
      <P>
        The <strong>Activity</strong> tab lists every saving, conversion, buy, withdrawal and rule change. Each row
        opens on Solscan, a public Solana explorer. Small “Account upkeep” rows stay hidden until you press{" "}
        <strong>Show them</strong>.
      </P>
    </>
  );
}
