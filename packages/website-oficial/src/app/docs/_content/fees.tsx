/**
 * Fees — the body of /docs/fees.
 *
 * THE ANSWER FIRST (owner, 10-22): SaverFi takes no fee, so the page opens on
 * that and then names every cost that does exist, and who pays it. The title,
 * the one line under it and the clip are not written here: the page around this
 * body draws them from the index (src/lib/docs/pages.ts).
 *
 * NO FIGURE HERE IS AN EXAMPLE; each was read 10-22 from the code it describes:
 * - a saving's network fee is the trading wallet's (settle-tick.ts makes the
 *   wallet the fee payer) and is two signatures' worth, the wallet's own and the
 *   one the Ed25519 program checks, so 2 × 5,000 lamports = 0.00001 SOL, with
 *   no priority fee on top;
 * - converting and buying are paid by the keeper's own key (invest-tick.ts);
 *   every approval the person signs is paid by the pension key (verify-tx.ts
 *   holds the owner to being the fee payer);
 * - the price allowance is 2 %, or the stock's fee + 1 % when that is higher
 *   (SLIPPAGE_BPS in min-out.ts, legSlippageBps in invest-decision.ts);
 * - the 3 % ceiling on an issuer's fee is MAX_LEG_FEE_BPS (invest-decision.ts),
 *   and SPYx's mint has no fee setting to raise (XSTOCKS_POWERS, vault-copy.ts).
 *
 * NO RENT FIGURES: rent is read from the chain when a screen asks for the
 * approval. The page says where it is shown only for the three screens that
 * do show it (vault-copy.ts: the vault, the link panel, the investing card);
 * a withdrawal's token account is not one of them. NO PROMISE THAT A LINK'S
 * RENT COMES BACK, and no future SaverFi fee: neither is decided (owner, 10-22).
 */

import { DocLink, GoodToKnow, H2, List, P, Term } from "@/components/docs/docs-content";

export default function FeesBody() {
  return (
    <>
      <P>
        SaverFi takes no fee. All of each saving reaches your vault, and SaverFi takes nothing when your savings are
        invested or withdrawn. What you do pay is Solana’s own network fees and rent and, for some stocks, their
        issuer’s fee.
      </P>

      <H2>What you pay</H2>
      <List>
        <li>
          <strong>A network fee for each saving:</strong> about 0.00001 SOL, paid from your trading wallet.
        </li>
        <li>
          <strong>A network fee for each approval you sign</strong>, such as creating your vault or withdrawing. Your
          pension key pays it.
        </li>
        <li>
          <strong>Rent</strong>, also paid by your pension key, for:
          <ul>
            <li>your vault, which does not come back (a vault cannot be closed);</li>
            <li>each trading wallet you link;</li>
            <li>your investment setup, when you first approve buying, which does not come back;</li>
            <li>a token account in your wallet, when withdrawing a stock needs one.</li>
          </ul>
        </li>
      </List>
      <P>SaverFi shows the rent for your vault, a link and your investment setup before you approve.</P>

      <H2>What SaverFi pays</H2>
      <P>The network fees for converting your SOL and buying your stocks.</P>

      <H2>Inside each stock buy</H2>
      <List>
        <li>
          <strong>The market price.</strong> A buy moves the market a little, so SaverFi accepts a buy up to 2 % under
          its quote (more for a stock whose issuer fee is above 1 %). This is a limit, not a charge.
        </li>
        <li>
          <strong>The issuer’s fee.</strong> A PreStock’s issuer charges a fee each time the token moves: when it is
          bought, when you withdraw it, and when you sell it. SaverFi pauses buying while any stock you chose charges
          more than 3 %. SPYx has no such fee, and its issuer cannot add one.
        </li>
      </List>
      <P>
        A PreStock’s fee today is shown on <DocLink to="public-pages">SaverFi’s prices page</DocLink>.
      </P>

      <GoodToKnow>
        <Term name="Rent">
          A small one-off amount Solana keeps for every account, such as your vault. It is paid when the account is
          made.
        </Term>
        <Term name="PreStock">A token for a company not yet on the stock market, such as ANTHROPIC.</Term>
      </GoodToKnow>
    </>
  );
}
