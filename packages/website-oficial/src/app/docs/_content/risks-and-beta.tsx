/**
 * Risks and beta status — the body of /docs/risks-and-beta.
 *
 * WHAT CAN GO WRONG, THEN HOW FAR IT IS PROVEN. The title, the one line under it
 * and the clip are not written here: the page around this body draws them from
 * the index (src/lib/docs/pages.ts).
 *
 * EACH RISK IS THE CODE'S OWN, read 10-22: no price limit on stocks is
 * LIVE_PRICE_FLOOR_WAD (owner, 10-08, @sip/solana-core product.ts), so the
 * owner-signed per-buy and 30-day caps are what bound a failed or stolen
 * keeper; the issuers' powers are the ones vault-copy.ts states with their
 * read dates (PRESTOCKS_POWERS, XSTOCKS_POWERS, FEE_RAISED); withdrawing needs
 * no keeper and no unpaused protocol (withdraw.rs, withdraw_token.rs). The SOL
 * conversion's floor is a safeguard, not a risk: the investing page says it.
 *
 * THE ONLY REAL FIGURES are the mainnet date (15 September 2026) and the first
 * saving (19 September 2026: 0.0366 SOL, 20 % of a 0.1832 SOL gain). No
 * Solscan link: the full signatures are not in the repo, and a link is never
 * guessed.
 *
 * THE AUDIT, IN THE OWNER'S WORDS (10-22): the team is preparing SaverFi for an
 * independent external audit, said warmly and on its own after the list; the
 * team is asking audit firms for prices (owner, 10-22), so "already talking
 * with audit firms", and no firm, date or price. Never "audited" and never "no
 * audit" (docs.test.ts holds both). Written as live (owner, 10-22): the
 * independent price check on stock buys, and upgrades behind a multisig with a
 * time delay.
 */

import { DocLink, H2, List, P } from "@/components/docs/docs-content";

export default function RisksAndBetaBody() {
  return (
    <>
      <P>
        SaverFi is in beta. Your savings face three risks: prices can fall, stock issuers hold power over their tokens,
        and SaverFi itself is young.
      </P>

      <H2>Prices move</H2>
      <P>
        SOL, the S&amp;P 500 (through SPYx) and PreStocks can all fall, so your savings can be worth less than you put
        aside.
      </P>
      <P>
        You sign no price limit on stocks, so if SaverFi’s keeper (its automatic helper) failed or its key were
        stolen, only your per-buy and 30-day limits would cap what it pays.
      </P>

      <H2>Issuers hold power over their tokens</H2>
      <List>
        <li>
          ANTHROPIC is a PreStock, a token for a company not yet on the stock market. Its issuer can create more, freeze
          or pause it, change its fee up to 100 % (it has before) and take tokens from any account, your vault
          included. Its market is small, so its price can jump.
        </li>
        <li>SPYx’s issuer can freeze, pause and take tokens the same way, but can never add a fee.</li>
        <li>SOL depends on no issuer.</li>
      </List>

      <H2>If SaverFi stops</H2>
      <List>
        <li>No new savings are made, and your vault stays as it is.</li>
        <li>
          Trades made meanwhile are saved later, under your rule, though a loss waiting to come off your next gain can
          be forgotten.
        </li>
        <li>Withdrawing needs only your pension key, never the keeper. SaverFi’s website prepares the withdrawal.</li>
      </List>

      <H2>Beta status</H2>
      <List>
        <li>SaverFi has been live on Solana mainnet since 15 September 2026.</li>
        <li>The first real saving came on 19 September 2026: 0.0366 SOL, 20 % of a 0.1832 SOL gain.</li>
        <li>Saving, converting SOL, buying stocks and withdrawing a token have each been done on mainnet.</li>
        <li>
          Program upgrades need several team members and a time delay (see <DocLink to="who-controls-what" />).
        </li>
      </List>
      <P>
        The team is preparing SaverFi for an independent external audit, and is already talking with audit firms, so
        that outside experts check the code that keeps your savings.
      </P>
    </>
  );
}
