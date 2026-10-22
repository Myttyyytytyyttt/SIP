/**
 * Create your vault — the body of /docs/create-your-vault.
 *
 * WHAT YOU NEED, WHAT YOU CHOOSE, WHAT IT COSTS, in that order, for a trader
 * who has never made one (owner, 10-22: "documentación simple, con
 * explicaciones simples"). The title, the line under it and the clip come from
 * the index (src/lib/docs/pages.ts) and the page around this body.
 *
 * EVERY FIGURE IS THE CODE'S, read on 10-22; a change there changes this page:
 *  * the setup's bar, 5 % to 50 % from 20 %: lib/onboarding.ts SETUP_RATE;
 *  * Volume from 2 %: lib/rule-settings.ts VOLUME_START_BPS (owner, 10-22);
 *  * SOL or stocks, never a mix, the stocks split evenly: onboarding.ts
 *    toggleBasket and basketSplit, over what solana-core offers today
 *    (OFFERED_LEGS: SPYx and ANTHROPIC);
 *  * the stock choice kept in this browser only: lib/onboarding-memory.ts;
 *  * a vault's rent never comes back: vault-copy.ts VAULT_COPY.bothModes.
 *
 * VOLUME IS CHOSEN IN THE SETUP (owner, 10-22): the docs are written as if
 * everything decided were already there, and go official once it is. Only
 * Volume joins the setup; Round-ups is turned on in Vault settings, which its
 * own page says too. The link's rent is named and nothing is said about
 * getting it back (owner, 10-22).
 */

import { Callout, DocLink, H2, List, P, Steps } from "@/components/docs/docs-content";

export default function CreateYourVaultBody() {
  return (
    <>
      <P>
        Your vault is where your savings are kept, and only your pension key can take them out. You create it once, in
        a short setup that opens the first time you connect. It takes one approval, and every choice can be changed
        later.
      </P>

      <H2>What you need</H2>
      <List>
        <li>
          Your <DocLink to="pension-key">pension key</DocLink>: the wallet you connect, which owns your vault.
        </li>
        <li>
          A little SOL in it, for the vault’s rent (a small one-off amount Solana keeps for every account) and the
          network fee. The cost is shown before you approve.
        </li>
      </List>
      <Callout tone="caution">
        The vault’s rent does not come back, because a vault cannot be closed. Each trading wallet you link later costs
        a small rent too, from the same key.
      </Callout>

      <H2>The setup, step by step</H2>
      <Steps>
        <li>
          Press <strong>Connect</strong> and choose your wallet. If it has no vault yet, the setup opens by itself.
        </li>
        <li>
          <strong>Welcome</strong> sums up how SaverFi works. Press <strong>Continue</strong>.
        </li>
        <li>
          On <strong>Create your vault</strong>, choose how you save. <strong>Profit</strong> saves a share of each
          gain: anything from 5 % to 50 %, starting at 20 %. <strong>Volume</strong> saves a share of the size of every
          buy and every sell, starting at 2 %. <DocLink to="round-ups">Round-ups</DocLink> are turned on later, in
          Vault settings.
        </li>
        <li>
          Choose what your savings become: SOL, or stocks (SPYx, ANTHROPIC or both, split evenly).{" "}
          <DocLink to="investing">What these stocks are</DocLink>.
        </li>
        <li>
          Approve once in your wallet app, and you see <strong>Your vault is ready</strong>.
        </li>
      </Steps>

      <H2>After the setup</H2>
      <P>Nothing is saved until a trading wallet is linked to your vault. Your dashboard walks you through the rest:</P>
      <List>
        <li>
          create and link a <DocLink to="trading-wallets">trading wallet</DocLink>;
        </li>
        <li>send it SOL and trade from it;</li>
        <li>if you chose stocks, approve buying when your first savings arrive.</li>
      </List>
      <Callout>
        Until you approve buying, your stock choice is kept only in this browser. On another device, choose your
        stocks again in <DocLink to="change-settings">Vault settings</DocLink>.
      </Callout>
    </>
  );
}
