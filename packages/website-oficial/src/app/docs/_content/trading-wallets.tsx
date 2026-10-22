/**
 * Trading wallets — the body of /docs/trading-wallets.
 *
 * WHERE YOU TRADE FROM, HOW TO MAKE ONE AND HOW TO TAKE IT TO AXIOM OR GMGN,
 * then what SaverFi may do with it. The title, the line under it and the clip
 * come from the index (src/lib/docs/pages.ts) and the page around this body.
 *
 * EVERY FACT IS THE CODE'S, read on 10-22; a change there changes this page:
 *  * one press, the pension key's wallet app opening once partway through
 *    (the link's other two signatures are the new wallet's, and ask nothing):
 *    vault-copy.ts CREATE_LINK_COPY.ahead;
 *  * the 0.05 SOL left in the wallet is the vault's default reserve
 *    (solana-core product.ts DEFAULT_VAULT_POLICY.walletReserve);
 *  * the key shown in Privy's own window, never on SaverFi's page, and the
 *    link kept after an export: hooks/use-export-trading-wallet.ts;
 *  * 10 wallets an account: lib/trading-wallets.ts MAX_TRADING_WALLETS.
 *
 * THE KEEPER SIGNS SAVINGS AND NOTHING ELSE (owner, 10-22: runbook §8 is
 * applied), so the permission is said as that. "Privy" is named once, at the
 * export, because that window is Privy's and the person sees it. Nothing here
 * stops one wallet on its own: a created wallet stops with Pause saving, and
 * the link's rent is named without saying anything about getting it back
 * (owner, 10-22).
 */

import { Callout, DocLink, H2, List, P, Steps } from "@/components/docs/docs-content";

export default function TradingWalletsBody() {
  return (
    <>
      <P>
        You trade from a trading wallet: an ordinary Solana wallet that SaverFi creates for you and links to your vault.
        SaverFi watches the wallet, not the app, so your trades save wherever you use it, Axiom and GMGN included.
      </P>

      <H2>Create one</H2>
      <Steps>
        <li>
          Open <strong>Manage wallets</strong> and go to <strong>Trading wallets</strong>.
        </li>
        <li>
          Press <strong>Create wallet and link it</strong>.
        </li>
        <li>
          Your wallet app opens once, for your pension key. Approve: this confirms the link and pays its rent, a small
          one-off amount Solana keeps for every account. When the row says <strong>Linked</strong>, it is ready.
        </li>
      </Steps>

      <H2>Fund it and trade</H2>
      <P>
        Send SOL to the wallet’s address and trade as usual. Keep more than 0.05 SOL in it: by default, a saving never
        takes the wallet below that, and waits until you top up (see{" "}
        <DocLink to="timing-and-limits">the limits on each saving</DocLink>).
      </P>

      <H2>Use it in Axiom, GMGN or another app</H2>
      <Steps>
        <li>
          On the wallet’s row, press <strong>Export key</strong>. The key appears in a window from Privy, the service that
          keeps your trading wallets’ keys. SaverFi’s page never holds it.
        </li>
        <li>Import the key into Axiom, GMGN or any Solana app that accepts a private key.</li>
      </Steps>
      <P>The wallet stays linked after you export it, so those trades save too.</P>
      <Callout tone="caution">Anyone with this key can spend the wallet’s SOL. Keep it as safe as a password.</Callout>

      <H2>What SaverFi’s permission allows</H2>
      <P>
        SaverFi’s keeper, its automatic helper, holds a limited permission on each trading wallet. It can sign one thing
        only: a saving, which moves a slice from that wallet into your vault. It cannot export your key, sign messages or
        make any other transaction. See <DocLink to="who-controls-what" />.
      </P>
      <List>
        <li>One account holds up to 10 trading wallets.</li>
        <li>
          To stop saving from every wallet at once, turn on Pause saving in{" "}
          <DocLink to="change-settings">Vault settings</DocLink>.
        </li>
        <li>
          Already trade from a wallet of your own? <DocLink to="import-a-wallet">Import it</DocLink>.
        </li>
      </List>
    </>
  );
}
