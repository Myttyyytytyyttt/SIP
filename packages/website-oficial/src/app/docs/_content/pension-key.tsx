/**
 * Your pension key — the body of /docs/pension-key.
 *
 * WHAT THE KEY IS, WHAT IT DOES AND WHAT IT NEVER DOES (owner, 10-22). The
 * title, the one line under it and the clip are not written here: the page
 * around this body draws them from the index (src/lib/docs/pages.ts).
 *
 * HELD TO THE CODE, read 10-22: sign-in is a wallet and nothing else, with
 * Phantom, Backpack and Solflare offered first and a Ledger-backed Phantom
 * supported (src/app/providers.tsx); the key is never one of the app's own
 * wallets (src/lib/pension-key.ts) and is refused as a trading wallet
 * (src/lib/import-preflight.ts); creating the vault, linking, the vault's
 * settings, the investing approval and both withdrawals are the owner's
 * signature in the program, the vault's address is made from the key, and a
 * withdrawal pays the key itself. Nothing in the program moves a vault to
 * another key, which is what the warning at the end says.
 */

import { Callout, DocLink, H2, List, P } from "@/components/docs/docs-content";

export default function PensionKeyBody() {
  return (
    <>
      <P>
        Your pension key is the Solana wallet you connect to SaverFi, such as Phantom. It owns your vault, and it is
        the only key that can withdraw your savings or change how you save.
      </P>

      <H2>Which wallet to use</H2>
      <P>
        A Solana wallet in your browser: Phantom, Backpack, Solflare or another extension. Phantom on a Ledger works
        too. There is no email or social sign-in: connecting your wallet is how you sign in.
      </P>

      <H2>What it does</H2>
      <List>
        <li>It owns your vault. A vault belongs to one key, for good.</li>
        <li>
          It approves every change: creating your vault, linking a trading wallet, changing your settings, starting to
          buy stocks, and each withdrawal.
        </li>
        <li>
          It is the only key that can <DocLink to="take-money-out">take money out</DocLink>, and the money goes only to
          this wallet.
        </li>
        <li>
          It pays the costs of setting up, in SOL, so keep a little in it. Each cost is shown before you approve
          (see <DocLink to="create-your-vault" />).
        </li>
      </List>

      <H2>What it never does</H2>
      <List>
        <li>It never leaves your wallet app. SaverFi never holds it, and never sees its recovery phrase.</li>
        <li>
          It is never a trading wallet. You trade from separate{" "}
          <DocLink to="trading-wallets">trading wallets</DocLink>, so the key that holds your savings stays out of
          trading apps and bots.
        </li>
      </List>

      <H2>Signing out, and switching wallets</H2>
      <P>
        Disconnect signs you out. Your trading wallets are tied to this key too: connect it again, and your vault and
        your wallets are all there. A different wallet has its own pension, or starts fresh.
      </P>

      <Callout tone="caution" title="Keep your recovery phrase safe">
        SaverFi cannot recover your pension key for you, and your vault cannot be moved to another wallet. Back up the
        recovery phrase in your wallet app, and never share it.
      </Callout>
    </>
  );
}
