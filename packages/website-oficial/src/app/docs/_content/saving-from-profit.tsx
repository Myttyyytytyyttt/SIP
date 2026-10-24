/**
 * Saving from your profit — the body of /docs/saving-from-profit.
 *
 * ITS ONE QUESTION (owner's index, 10-22): in Profit mode, what exactly is
 * saved? The answer first, then how a gain is counted, an example, what counts
 * as a gain without being a trade, and where the rate is set.
 *
 * EVERY FIGURE IS THE CODE'S, read 10-22:
 *   - 20 % to start, 2.01 % to 100 % in Vault settings: DEFAULT_RATES and
 *     PROFIT_BPS_MIN/MAX in solana-core's rules.ts (pinned to state.rs), which
 *     RATE_RANGES in src/lib/rule-settings.ts repeats for the dialog's bar;
 *   - 5 % to 50 % in the setup: SETUP_RATE in src/lib/onboarding.ts, the part
 *     of that range a first vault is offered;
 *   - a loss dropped once the wallet has signed 100 transactions of its own:
 *     LOSS_DROPPED_AFTER_TXS in src/lib/vault-copy.ts, the keeper's
 *     ZERO_BASE_MIN_TXS;
 *   - what is never a gain, and what is one without being a trade: the keeper's
 *     NON_TRADING set (measure-window.ts). Only a transaction that touches
 *     nothing but plain transfers (and memos) is flow, so SOL from a bridge, an
 *     unstake or a lending or perps exit is counted as trading.
 *
 * THE ONE REAL FIGURE is the first saving, 2026-09-19: 0.0366 SOL, 20 % of a
 * 0.1832 SOL gain. Any other figure is called an example (owner, 10-22).
 */

import { Callout, DocLink, H2, List, P } from "@/components/docs/docs-content";

export default function SavingFromProfitBody() {
  return (
    <>
      <P>
        In Profit mode, SaverFi saves a share of what you win. When your trading wallet (the wallet you trade from)
        holds more SOL than at your last saving, a share of that gain moves into your vault. That share is your rate:
        20 % to start.
      </P>

      <H2>How a gain is counted</H2>
      <P>
        SaverFi looks only at the SOL in your trading wallet. A buy takes SOL out and a sell brings it back, so a win
        counts once you sell back to SOL. Tokens you still hold do not count yet.
      </P>
      <List>
        <li>Plain SOL transfers in or out never count. Topping up your wallet is not a gain.</li>
        <li>If you are behind since your last saving, nothing is saved, and the loss comes off your next gain.</li>
        <li>
          If your wallet signs 100 transactions of its own while still behind, the loss is dropped, and later gains
          count in full.
        </li>
      </List>

      <H2>Examples</H2>
      <P>
        SaverFi’s first real saving, on 19 September 2026: a run of trading ended 0.1832 SOL up, and 0.0366 SOL, 20 %
        of it, moved into the vault.
      </P>
      <P>For example, lose 0.1 SOL and then win 0.3 SOL, and you are 0.2 SOL up: at 20 %, SaverFi saves 0.04 SOL.</P>
      <Callout tone="caution">
        Some SOL counts as a gain without being a trade: SOL that arrives through an app, such as a bridge, an unstake
        or closing a lending or perps position, and selling tokens the wallet held before you linked it. To add SOL
        without it counting, send it as a plain transfer.
      </Callout>

      <H2>Your rate</H2>
      <P>
        You choose your rate when you <DocLink to="create-your-vault">create your vault</DocLink>, from 5 % to 50 %.
        Later, in <DocLink to="change-settings">Vault settings</DocLink>, it can be anything from 2.01 % to 100 %. For
        the most one saving can move, see <DocLink to="timing-and-limits" />.
      </P>
    </>
  );
}
