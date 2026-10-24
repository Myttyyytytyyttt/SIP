/**
 * Take money out — the body of /docs/take-money-out.
 *
 * HOW TO WITHDRAW, AND WHO CAN STOP IT (owner, 10-22): the steps on the Take
 * money out tab, what can come out, and the one party besides the reader with
 * any say over a token, its issuer. The title, the one line under it and the
 * clip are not written here: the page around this body draws them from the
 * index (src/lib/docs/pages.ts).
 *
 * EVERY CLAIM IS THE PRODUCT'S OWN, read 10-22: Max and 25 % / 50 % / All are
 * WithdrawCard.tsx (TOKEN_SHARES); one approval each, and the money only to
 * the pension key, are the program's withdraw and withdraw_token (the owner
 * signs, the destination is pinned to the owner, and both ignore every pause);
 * the rent that stays, the account a token withdrawal may create and "within
 * about a minute" are WITHDRAW_COPY's; "Pause investing" is INVEST_COPY.pause.
 * The issuer's powers are VAULT_COPY's freeze notice, in fewer words.
 */

import { Callout, DocLink, H2, List, P, Steps } from "@/components/docs/docs-content";

export default function TakeMoneyOutBody() {
  return (
    <>
      <P>
        Your savings are yours to take out at any time. A withdrawal goes only to your{" "}
        <DocLink to="pension-key">pension key</DocLink>, the wallet you connected, and only that key can make one.
      </P>

      <H2>How to withdraw</H2>
      <Steps>
        <li>
          Open <strong>Manage wallets</strong>, then the <strong>Take money out</strong> tab.
        </li>
        <li>
          For SOL, type an amount or press <strong>Max</strong>. For a token, press <strong>25 %</strong>,{" "}
          <strong>50 %</strong> or <strong>All</strong>.
        </li>
        <li>Approve in your wallet app. Each withdrawal is one approval.</li>
      </Steps>
      <P>
        Your pension key pays the small network fee. The first time you take out a token, the withdrawal may also open
        an account for it in your wallet, which costs a small rent (see <DocLink to="fees" />).
      </P>

      <H2>What you can take out</H2>
      <List>
        <li>
          <strong>SOL</strong>: everything above the vault’s rent, the small one-off amount Solana keeps for every
          account. The rent stays for good, because a vault cannot be closed.
        </li>
        <li>
          <strong>Tokens</strong>: USDC and every stock your vault holds.
        </li>
      </List>
      <P>
        SaverFi never sells your stocks for you. Take the tokens out and sell them yourself, in any Solana app.
      </P>
      <Callout tone="caution">
        A PreStock, a token for a company not yet on the stock market, costs a fee each time it moves. Its issuer
        charges it once when you withdraw it, and again when you sell it.
      </Callout>

      <H2>Can anyone stop me?</H2>
      <P>
        SaverFi can’t pause or block your withdrawals. They work while your vault is paused, and even while SaverFi is
        paused for everyone (see <DocLink to="who-controls-what" />).
      </P>
      <P>
        A stock’s issuer is the one exception: it can freeze or pause its own token, and then withdrawing that stock
        can fail. SOL never depends on an issuer.
      </P>

      <H2>Taking out SOL while investing is on</H2>
      <P>
        While investing is on, new SOL in your vault can turn into USDC within about a minute. To take out SOL instead,
        press <strong>Pause investing</strong> in Manage wallets → Investing first, or simply withdraw the USDC.
      </P>
    </>
  );
}
