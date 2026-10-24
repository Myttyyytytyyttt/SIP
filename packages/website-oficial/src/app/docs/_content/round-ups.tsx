/**
 * Saving with round-ups — the body of /docs/round-ups.
 *
 * ITS ONE QUESTION (owner's index, 10-22): what do round-ups save? The answer
 * first, then an example, how it works, what catches people out, and how it is
 * turned on.
 *
 * WRITTEN AS LIVE, WITH NO UNIT OR CAP FIGURE (owner, 10-22): round-up saving is
 * one of the decided features the docs describe in the present tense, but its
 * unit and its caps are still his to set, so the page names none of them. The
 * $1 unit below is an example, and called one. The shape is the round-up mode
 * already built on the scale-dispatcher branch (reports/
 * ROADMAP_NEXT_RESEARCH_2026-10-20.md, "research: roundup"): a whole-dollar
 * unit, (unit − value mod unit) saved per trade, so an exact multiple saves
 * nothing and no trade gives more than one unit; trades found by the same
 * check Volume uses; each priced at the SOL price of its own minute; saved once
 * enough is owed or an hour after the oldest trade; a daily cap beside the most
 * per saving, with anything above either forgiven, not carried.
 *
 * THE WARNING IS ARITHMETIC, NOT A FIGURE OF HIS: a round-up is at most one unit,
 * so it is a larger share of a small trade ($0.90 of $10.10 against $0.90 of
 * $200.10, at the example's $1).
 */

import { Callout, DocLink, H2, List, P, Steps } from "@/components/docs/docs-content";

export default function RoundUpsBody() {
  return (
    <>
      <P>
        With round-ups, SaverFi rounds the dollar value of each trade up to the next whole unit, and saves the
        difference in SOL, like keeping the change when you pay with a note. You choose the unit: a whole number of
        dollars.
      </P>

      <H2>An example</H2>
      <P>
        For example, with a $1 unit, a trade worth $47.30 rounds up to $48, and $0.70 worth of SOL moves into your
        vault. A trade worth exactly $48 saves nothing.
      </P>

      <H2>How it works</H2>
      <List>
        <li>
          Trades count the same way as in <DocLink to="saving-from-volume">Volume mode</DocLink>: every buy and every
          sell your trading wallet makes itself. Plain SOL transfers never count.
        </li>
        <li>Each trade is valued in dollars at the SOL price at the time of the trade.</li>
        <li>
          Round-ups are gathered and saved together, once enough has built up or an hour after the oldest trade
          waiting, whichever comes first.
        </li>
        <li>
          A daily cap limits how much round-ups save in one day, and the most one saving can move still applies.
          Anything over a cap is not saved, and is not carried over.
        </li>
      </List>
      <Callout tone="caution" title="Small trades save a bigger share">
        A round-up is never more than one unit, so it weighs more on a small trade. With a $1 unit, a $10.10 trade
        saves $0.90, about 9 % of it, while a $200.10 trade saves the same $0.90, under half a percent. If you make
        many small trades, compare it with Volume.
      </Callout>

      <H2>Turning it on</H2>
      <Steps>
        <li>
          Open <DocLink to="change-settings">Vault settings</DocLink> with the gear on your Savings rule card.
        </li>
        <li>
          Set <strong>Mode</strong> to Round-ups, and choose your unit.
        </li>
        <li>
          Press <strong>Save changes</strong>, and approve in your wallet app.
        </li>
      </Steps>
      <P>
        Your vault saves one way at a time: from your profit, from your volume, or with round-ups. See{" "}
        <DocLink to="timing-and-limits" /> for how soon a saving goes.
      </P>
    </>
  );
}
