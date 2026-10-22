/**
 * Who controls what — the body of /docs/who-controls-what.
 *
 * THREE HOLDERS, EACH WITH WHAT IT CAN AND CANNOT DO, read 10-22 from the
 * program (packages/solana-program/programs/sip-vault). The title, the one line
 * under it and the clip are not written here: the page around this body draws
 * them from the index (src/lib/docs/pages.ts).
 * - THE PENSION KEY is the vault's owner and the only signer of withdraw and
 *   withdraw_token (which pay only to itself), set_policy_v2, set_invest_policy
 *   and link_wallet.
 * - THE KEEPER, on the trading wallets, signs savings and nothing else (owner,
 *   10-22: runbook §8 is applied), each one bounded by the vault's cap and the
 *   wallet's reserve (settle.rs; 0.06 and 0.05 SOL are DEFAULT_VAULT_POLICY in
 *   @sip/solana-core). In the vault it converts no lower than the SOL floor
 *   the owner signed (convert.rs; the per-buy and 30-day caps do not bound a
 *   conversion, vault-copy.ts says why) and buys within those caps
 *   (invest.rs). No withdrawal takes its key.
 * - THE TEAM holds the protocol pause, which stops settle, link_wallet,
 *   wrap_sol, convert and invest and never a withdrawal (set_protocol_paused.rs),
 *   the keeper's key (set_keeper.rs), and upgrades.
 *
 * WRITTEN AS LIVE (owner, 10-22): upgrades behind a multisig with a time delay.
 * "Privy" is named only at its export window, the one place a person sees it.
 */

import { DocLink, H2, List, P } from "@/components/docs/docs-content";

export default function WhoControlsWhatBody() {
  return (
    <>
      <P>
        Only your pension key can take money out of your vault, and the money always goes back to it. SaverFi’s
        keeper, its automatic helper, can only add savings to your vault and invest them within the limits you signed.
        SaverFi’s team can pause saving for everyone, but never a withdrawal.
      </P>

      <H2>Your pension key</H2>
      <P>
        Your <DocLink to="pension-key">pension key</DocLink> is the wallet you connect, such as Phantom. It stays in
        your wallet app, and it is the only key that can:
      </P>
      <List>
        <li>withdraw your savings;</li>
        <li>change your rules: your mode, your rate, a pause, what your savings buy, and your limits;</li>
        <li>link a trading wallet to your vault.</li>
      </List>

      <H2>Your trading wallets</H2>
      <P>
        Your <DocLink to="trading-wallets">trading wallets</DocLink> sit in a wallet account you sign in to with your
        pension key. “Export key” shows a wallet’s private key in Privy’s own window, to use in any Solana app. Whoever
        holds that key controls the wallet’s SOL.
      </P>

      <H2>The keeper</H2>
      <List>
        <li>
          On each linked trading wallet it has one permission: to sign a saving into your vault. It cannot send your SOL
          anywhere else or export your key.
        </li>
        <li>
          Each saving stays within the limits you set: by default at most 0.06 SOL, and never touching the 0.05 SOL
          the wallet keeps.
        </li>
        <li>
          In your vault, it changes saved SOL into USDC, never below the SOL safety floor you signed, and buys your
          stocks within your most per buy and most per 30 days.
        </li>
        <li>It can never withdraw.</li>
      </List>

      <H2>SaverFi’s team</H2>
      <List>
        <li>It can pause saving, buying and new links for every vault at once. A pause never stops a withdrawal.</li>
        <li>It can replace the keeper’s key.</li>
        <li>
          It can upgrade SaverFi’s program. An upgrade needs several team members to approve it (a multisig), then
          waits out a time delay. An upgrade can change any rule, so this is the team’s biggest power.
        </li>
      </List>
    </>
  );
}
