/**
 * Investing your savings — the body of /docs/investing.
 *
 * WHAT IT CAN BUY, HOW A BUY HAPPENS, AT WHAT PRICE, AND WHAT MAKES IT WAIT,
 * one section each. The title, the line under it and the clip come from the
 * index (src/lib/docs/pages.ts) and the page around this body.
 *
 * EVERY FIGURE IS THE CODE'S, read on 10-22; a change there changes this page:
 *  * SOL or a basket, never both, and the two stocks offered today:
 *    lib/onboarding.ts toggleBasket over solana-core's OFFERED_LEGS (SPYx,
 *    ANTHROPIC); a stock is offered only while it passes product.ts OFFER_RULES;
 *  * nothing under 0.005 SOL swapped for USDC: the keeper's WRAP_DUST_LAMPORTS
 *    (solana-keeper invest-decision.ts), said as waiting for more savings and
 *    never as "once your vault holds 0.005 SOL" (live-copy.ts PENDING_COPY,
 *    review 10-09);
 *  * the $10 threshold: lib/rule-settings.ts BASE_THRESHOLD_USD (owner, 10-22);
 *  * all of the basket or none: vault-copy.ts INVEST_COPY.policyRule (its rare
 *    leftover, a later stock refused after an earlier one bought, is left to
 *    the app: too fine for this page, editor 10-22);
 *  * no price floor on the stocks (owner, 10-08) and the SOL's safety floor at
 *    half its price when approved (owner, 10-09): INVEST_COPY.livePrice;
 *  * the first approval is ONLY the "Your first savings arrived" card's Start
 *    buying: a vault with no policy signs nothing from Vault settings, which
 *    only keeps the basket on this device (components/live/rule-settings-plan.ts);
 *  * the 3 % fee limit: vault-copy.ts MAX_LEG_FEE_BPS, the keeper's own;
 *  * a spent 30 days swaps no SOL either: invest-decision.ts rollingDecision;
 *    nor does a paused vault (invest-tick.ts investPauseDecision) or a paused
 *    policy. SOL under its floor stops only the swap for USDC (USDC already
 *    held is still invested, vault-copy.ts chainLimitsParagraph; not said here).
 *
 * THE INDEPENDENT PRICE CHECK ON STOCK BUYS IS WRITTEN AS THERE (owner, 10-22):
 * the docs are written as if everything decided were already there, and go
 * official once it is. "Basket" is said once, in the first paragraph, as the
 * stocks you chose: the word the index and Change your settings use.
 */

import { DocLink, H2, List, P, Steps } from "@/components/docs/docs-content";

export default function InvestingBody() {
  return (
    <>
      <P>
        Your savings can stay as SOL, or buy stocks. With stocks, each saving becomes USDC, a digital dollar, and once
        enough piles up, your basket (the stocks you chose) is bought at the live price and kept in your vault.
      </P>

      <H2>What it can buy</H2>
      <P>A vault keeps SOL or stocks, not both. Today there are two:</P>
      <List>
        <li>
          <strong>SPYx</strong>, a token that follows an S&amp;P 500 fund, one for one.
        </li>
        <li>
          <strong>ANTHROPIC</strong>, a PreStock: a token for a company not yet on the stock market. Its issuer charges a
          fee each time it moves, and can raise it (see <DocLink to="fees" />).
        </li>
      </List>
      <P>A stock is offered only while its fee and its market pass SaverFi’s checks.</P>

      <H2>How a buy happens</H2>
      <Steps>
        <li>Each saving is swapped for USDC on Jupiter within about a minute. Amounts under 0.005 SOL wait for more.</li>
        <li>The USDC waits until it reaches your investment threshold: $10 unless you change it.</li>
        <li>Then your basket is bought at once, split by your shares. If any stock fails its checks, nothing moves.</li>
      </Steps>

      <H2>The price you pay</H2>
      <P>
        Stocks are bought at the live market price, checked against an independent source before every buy. You sign no
        price limit on them. Swapping SOL for USDC keeps one safety floor: half the SOL price when you approved. Below
        it, no SOL is swapped until you approve again.
      </P>

      <H2>Approval and limits</H2>
      <P>
        Buying starts with one approval, on the <strong>Start buying</strong> card your dashboard shows when your first
        savings arrive. It costs a small rent that does not come back, and sets two limits: the most per buy and per 30
        days.
      </P>
      <P>Nothing is bought, and your SOL stays as SOL, while:</P>
      <List>
        <li>a stock’s market is too thin;</li>
        <li>a stock’s issuer fee is above 3 %;</li>
        <li>your 30-day limit is used up;</li>
        <li>your vault, or its investing, is paused.</li>
      </List>
    </>
  );
}
