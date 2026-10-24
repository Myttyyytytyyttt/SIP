/**
 * Saving from your volume — the body of /docs/saving-from-volume.
 *
 * ITS ONE QUESTION (owner's index, 10-22): in Volume mode, what exactly is
 * saved? The answer and its example first, then what counts as a trade, when a
 * saving goes, and how Volume is chosen.
 *
 * 2 % EVERYWHERE (owner, 10-22): the starting rate and every example. It is also
 * the top of the range, 0.01 % to 2 % (VOLUME_START_BPS and RATE_RANGES in
 * src/lib/rule-settings.ts; DEFAULT_RATES and VOLUME_BPS_MIN/MAX in
 * solana-core's rules.ts). At 2 %, a 1 SOL buy and a 1.1 SOL sell owe 0.042 SOL.
 *
 * WHAT COUNTS IS THE KEEPER'S (measure-volume.ts, owner's rule of 09-25): signed
 * by the wallet, succeeded, not a plain transfer, SOL one way and a token the
 * other. Its size is how far the SOL moved, so a buy carries its app's fee and
 * tip (a "1 SOL" buy measured 1.0100–1.0123 SOL on mainnet) and a sell counts
 * what arrived. No SOL leg, or a buy and sell in one transaction: less, never
 * more.
 *
 * THE CADENCE is volume-base.ts: 0.001 SOL owed (VOLUME_MIN_OWED_LAMPORTS) or an
 * hour after the oldest unsaved trade (VOLUME_MAX_WAIT_SECONDS); at 2 % that
 * owed amount is 0.05 SOL of trading. Trades not yet saved at a change of mode
 * or volume rate are forgiven (policy-boundary.ts). The activity rows that
 * count trades, buys and sells are one of the decided features the owner had
 * written as live (10-22).
 */

import { Callout, DocLink, H2, List, P } from "@/components/docs/docs-content";

export default function SavingFromVolumeBody() {
  return (
    <>
      <P>
        In Volume mode, SaverFi saves a small share of every buy and every sell your trading wallet makes, win or lose.
        The rate starts at 2 %. For example, at 2 %, a 1 SOL buy and a 1.1 SOL sell are 2.1 SOL of trading, and 0.042
        SOL moves into your vault.
      </P>

      <H2>What counts as a trade</H2>
      <List>
        <li>
          Only trades your trading wallet signs itself and that go through. A failed trade, a plain SOL transfer and
          anything someone else sends you never count.
        </li>
        <li>
          Only the SOL side is measured. A swap with no SOL in it, such as USDC for a token, counts only the SOL paid
          beside it, like a tip.
        </li>
        <li>A buy and a sell inside one transaction count only as their net change in SOL.</li>
      </List>
      <Callout title="Fees are part of a buy">
        A buy’s size includes the app’s fee and any tip. For example, a 1 SOL buy in an app that charges 1 % measures
        about 1.01 SOL. A sell counts what actually arrives, after fees.
      </Callout>

      <H2>When it is saved</H2>
      <P>
        Small amounts are gathered first. A saving goes once 0.001 SOL is owed, which at 2 % is 0.05 SOL of trading, or
        an hour after your oldest unsaved trade, whichever comes first.
      </P>
      <P>
        On the Activity tab, each volume saving shows how many trades it covered, split into buys and sells. One
        saving moves at most 0.06 SOL by default, about 3 SOL of trading at 2 %: see{" "}
        <DocLink to="timing-and-limits" />.
      </P>

      <H2>Choosing Volume</H2>
      <P>
        You can pick Volume when you <DocLink to="create-your-vault">create your vault</DocLink>, or switch to it later
        in <DocLink to="change-settings">Vault settings</DocLink>. The rate goes from 0.01 % up to 2 %. Trades not yet
        saved when you switch to Volume, or change its rate, are forgiven: they are never charged.
      </P>
    </>
  );
}
