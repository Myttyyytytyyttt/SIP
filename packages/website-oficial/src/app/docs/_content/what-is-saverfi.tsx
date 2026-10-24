/**
 * What is SaverFi? — the body of /docs/what-is-saverfi.
 *
 * THE ONE-MINUTE ANSWER (owner, 10-22): what SaverFi does, the three ways it
 * saves, what the savings become, and where to look first. The title, the one
 * line under it and the clip are not written here: the page around this body
 * draws them from the index (src/lib/docs/pages.ts).
 *
 * EVERY FIGURE IS THE PRODUCT'S OWN, read 10-22: profit starts at 20 % and
 * volume at 2 % (DEFAULT_RATES in @sip/solana-core, VOLUME_START_BPS in
 * src/lib/rule-settings.ts), "about once a minute" is the live page's own
 * wording (src/lib/live-copy.ts), and the assets are the two the shelf offers.
 * Round-ups carry no unit and no cap figure (owner, 10-22).
 *
 * THE SAMPLE IS A PLAIN <a>, like the landing's own "See the app": it is a
 * full page load into the app's frame, which is another layout from this one.
 */

import { DocLink, H2, List, P, Steps } from "@/components/docs/docs-content";

export default function WhatIsSaverfiBody() {
  return (
    <>
      <P>
        SaverFi builds you a pension from your trading. You keep trading the way you do now, and a slice of it is put
        aside, automatically, in a vault: savings on Solana that only your own wallet can open.
      </P>

      <H2>How it works</H2>
      <Steps>
        <li>
          Connect your <DocLink to="pension-key">pension key</DocLink>: a Solana wallet you already have, like Phantom.
          It owns your savings.
        </li>
        <li>
          <DocLink to="create-your-vault">Create your vault</DocLink>, and choose how much to save.
        </li>
        <li>
          Create a <DocLink to="trading-wallets">trading wallet</DocLink>, or{" "}
          <DocLink to="import-a-wallet">import one you already use</DocLink>. Send it SOL, and trade as usual: its key
          works in Axiom, GMGN or any Solana app.
        </li>
      </Steps>
      <P>
        From then on you only fund your trading wallet. SaverFi’s automatic helper checks it about once a minute and
        moves your share into your vault. There is no deposit to make, and nothing to press.
      </P>

      <H2>Three ways to save</H2>
      <List>
        <li>
          <DocLink to="saving-from-profit">From your profit</DocLink>: a share of each gain, 20 % to start. A loss
          saves nothing.
        </li>
        <li>
          <DocLink to="saving-from-volume">From your volume</DocLink>: a share of every buy and every sell, win or
          lose, 2 % to start.
        </li>
        <li>
          <DocLink to="round-ups">With round-ups</DocLink>: each trade’s dollar value is rounded up, and the
          difference is saved, up to a daily cap.
        </li>
      </List>

      <H2>What your savings become</H2>
      <P>
        Your savings stay as SOL, or SaverFi uses them to buy the stock tokens you choose: SPYx, which follows the
        S&amp;P 500, ANTHROPIC, a PreStock (a token for a company not yet on the stock market), or both. See{" "}
        <DocLink to="investing" />.
      </P>
      <P>
        SaverFi takes <DocLink to="fees">no fee</DocLink>: all of each saving reaches your vault. Only your pension
        key can <DocLink to="take-money-out">take money out</DocLink>, and the money goes back to that wallet. SaverFi
        is in beta: read <DocLink to="risks-and-beta" /> before you start.
      </P>

      <H2>See it first</H2>
      <P>
        <a
          href="/?mode=mock"
          className="rounded-sm font-medium underline decoration-foreground/30 underline-offset-4 transition-colors outline-none hover:decoration-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Open the sample
        </a>{" "}
        to look around the app with example numbers. It is nobody’s pension, and no wallet is needed.
      </P>
    </>
  );
}
