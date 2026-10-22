/**
 * Why isn't it saving? — the body of /docs/not-saving.
 *
 * WHAT TO CHECK WHEN NOTHING ARRIVES (owner, 10-22), most common first: no
 * saving is owed yet, the trading wallet is at its reserve, a wallet or the
 * vault needs its owner, nothing is being bought, or the page cannot see the
 * pension at all. The title, the one line under it and the clip are not
 * written here: the page around this body draws them from the index
 * (src/lib/docs/pages.ts).
 *
 * EVERY FIGURE AND LABEL IS THE PRODUCT'S OWN, read 10-22: 0.001 SOL and an
 * hour are the volume keeper's VOLUME_MIN_OWED_LAMPORTS and
 * VOLUME_MAX_WAIT_SECONDS (PENDING_COPY.measuringSub says the same); the
 * 0.05 SOL reserve is DEFAULT_VAULT_POLICY in @sip/solana-core; the row
 * statuses and buttons are ROW_COPY, LINK_COPY and START_BUYING_COPY;
 * "Approve again at today's price" is SETTINGS_COPY.safetyFloor; the two
 * sign-in messages are LIVE_COPY.keylessTitle and stalledTitle. A row's
 * "Paused" is ROW_COPY.pausedNote: the vault's pause or SaverFi's own.
 *
 * ONE RULE, SAID ONE WAY (editor, 10-22): Profit is "more SOL than at your last
 * saving", the words of saving-from-profit, and Round-ups gathers like Volume
 * with no figure of its own (owner, 10-22: written as live, no unit or cap).
 */

import { DocLink, H2, List, P } from "@/components/docs/docs-content";

export default function NotSavingBody() {
  return (
    <>
      <P>
        Usually nothing is wrong: no saving is owed yet. SaverFi checks your linked trading wallets about once a
        minute. If nothing arrives, check these in order.
      </P>

      <H2>Nothing is owed yet</H2>
      <List>
        <li>
          <strong>Profit</strong>: a saving comes only once your trading wallet holds more SOL than at your last saving.
          While you are behind, nothing is saved. Plain transfers never count.
        </li>
        <li>
          <strong>Volume</strong>: small amounts wait. A saving is made once 0.001 SOL is owed, or an hour after your
          oldest unsaved trade.
        </li>
        <li>
          <strong>Round-ups</strong>: small amounts gather the same way, and are saved within the hour.
        </li>
      </List>

      <H2>Your trading wallet is too low</H2>
      <P>
        By default, your trading wallet always keeps 0.05 SOL, and nothing is saved while it holds no more than that.
        The app says so beside the wallet. Top it up: what is owed waits.
      </P>

      <H2>A wallet or your vault needs you</H2>
      <P>In Manage wallets, read the wallet’s row:</P>
      <List>
        <li>
          <strong>Needs permission</strong>: press <strong>Grant SaverFi permission</strong>.
        </li>
        <li>
          <strong>Not linked</strong>: press <strong>Link to vault</strong>.
        </li>
        <li>
          <strong>Paused</strong>: switch off Pause saving in <DocLink to="change-settings">Vault settings</DocLink>. If
          SaverFi itself is paused for everyone, the page says so.
        </li>
      </List>

      <H2>It saves, but buys nothing</H2>
      <List>
        <li>Next investment has not reached your threshold yet.</li>
        <li>
          Your first buy waits for you: press <strong>Start buying</strong> on the “Your first savings arrived” card.
        </li>
        <li>You chose your stocks in another browser: choose them again in Vault settings.</li>
        <li>
          SOL fell under its safety floor: press <strong>Approve again at today’s price</strong> in Vault settings.
        </li>
        <li>A stock’s market is too thin today: buying waits until it recovers.</li>
      </List>
      <P>
        On your dashboard, the “?” beside a waiting step says which it is. See <DocLink to="investing" />.
      </P>

      <H2>You can’t see your pension</H2>
      <List>
        <li>
          “This session has no pension key”: disconnect, then connect your{" "}
          <DocLink to="pension-key">pension key</DocLink> again.
        </li>
        <li>
          “Wallet sign-in has not loaded”: reload the page. If it keeps happening, a browser extension may be blocking
          the sign-in.
        </li>
      </List>
    </>
  );
}
