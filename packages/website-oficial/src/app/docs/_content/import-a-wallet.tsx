/**
 * Import a wallet you already use — the body of /docs/import-a-wallet, the
 * sub-page of Trading wallets.
 *
 * YES, AND HOW: the steps first, then where the key goes, then the two things
 * worth knowing before pressing Import. The title, the line under it and the
 * clip come from the index (src/lib/docs/pages.ts) and the page around this body.
 *
 * EVERY FACT IS THE CODE'S, read on 10-22; a change there changes this page:
 *  * the formats, a private key or a key file of 64 numbers, never a recovery
 *    phrase: lib/import-key.ts KEY_COPY (owner, 10-08);
 *  * the buttons and what the key's trip to Privy does: vault-copy.ts
 *    IMPORT_PANEL_COPY (copy, travel, login, noCreatedYet);
 *  * the refusals: lib/import-preflight.ts PREFLIGHT_COPY, with the 10 wallets
 *    of lib/trading-wallets.ts MAX_TRADING_WALLETS;
 *  * tokens sold later count as gain, and the box ticked for it:
 *    import-preflight.ts HOLDINGS_COPY;
 *  * Remove and Grant SaverFi permission, and gains in between still counted:
 *    lib/trading-wallets.ts REMOVE_COPY (owner, 10-08: imported wallets only).
 *    The grant back is NOT promised: it needs Privy's record to show the
 *    wallet's id, which nothing has shown yet for an imported wallet, so the
 *    page says the row's own answer ("if the row cannot offer it, it says why").
 *
 * "Privy" IS NAMED because the import panel names it beside the key's field,
 * and it is the same window the person sees at an export.
 */

import { Callout, DocLink, H2, List, P, Steps } from "@/components/docs/docs-content";

export default function ImportAWalletBody() {
  return (
    <>
      <P>
        Yes. If you already trade from a Solana wallet, in Phantom, Solflare, Axiom, GMGN or a trading bot, you can import
        it, and SaverFi saves from it just like from a <DocLink to="trading-wallets">trading wallet</DocLink> it created.
      </P>

      <H2>Import it</H2>
      <Steps>
        <li>
          In <strong>Manage wallets</strong>, go to <strong>Trading wallets</strong> and press{" "}
          <strong>Import a wallet I already use</strong>.
        </li>
        <li>
          Paste the wallet’s private key (a long string of letters and numbers), or a key file’s list of 64 numbers. A
          recovery phrase (a list of words) is not accepted.
        </li>
        <li>
          Press <strong>Check this wallet</strong>, and make sure the address it shows is the wallet you expect.
        </li>
        <li>
          Press <strong>Import and link</strong>, and approve in your wallet app.
        </li>
      </Steps>

      <H2>Where your key goes</H2>
      <P>
        Your key travels encrypted from this page to Privy, the service that keeps your trading wallets’ keys, and never
        reaches SaverFi’s servers. Importing makes a copy, so the key keeps working where you use it now. Once imported,
        the wallet stays on your account.
      </P>

      <H2>Before you import</H2>
      <Callout tone="caution" title="Tokens it holds count as gain when sold">
        SaverFi cannot know what you paid for tokens the wallet already holds, so in Profit mode all the SOL from selling
        them counts as gain. Sell or move them first, or tick the box that says you understand.
      </Callout>
      <Callout title="Create a wallet first if you will want one">
        If an imported wallet is your account’s first trading wallet, Create stops working on that account.
      </Callout>
      <P>These cannot be imported:</P>
      <List>
        <li>your pension key;</li>
        <li>a wallet that owns a SaverFi vault, or is already linked to another vault;</li>
        <li>any wallet once your account holds 10 trading wallets.</li>
      </List>

      <H2>Stopping it later</H2>
      <P>
        Press <strong>Remove SaverFi permission</strong> on its row: nothing is saved from it until you press{" "}
        <strong>Grant SaverFi permission</strong> (if the row cannot offer it, it says why). Gains made meanwhile can
        still count then.
      </P>
    </>
  );
}
