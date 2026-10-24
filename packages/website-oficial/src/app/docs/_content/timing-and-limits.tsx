/**
 * When savings happen, and their limits — the body of /docs/timing-and-limits.
 *
 * ITS ONE QUESTION (owner's index, 10-22): how often does SaverFi act, and how
 * much can one saving move? The answer first, then how soon each mode saves,
 * the cap, the reserve and its fee, and the steps to change the two limits.
 *
 * EVERY FIGURE IS THE CODE'S, read 10-22:
 *   - about once a minute: the keeper's DEFAULT_SWEEP_MS (config.ts);
 *   - Volume's 0.001 SOL or one hour: VOLUME_MIN_OWED_LAMPORTS and
 *     VOLUME_MAX_WAIT_SECONDS (volume-base.ts); at the 2 % start (owner, 10-22)
 *     that is 0.05 SOL of trading;
 *   - 0.06 SOL per saving and 0.05 SOL kept: DEFAULT_VAULT_POLICY's
 *     maxContribution and walletReserve (solana-core's product.ts). settle.rs
 *     pays min(owed, max_contribution), so the rest is never carried; at the
 *     starting rates the cap is a 0.3 SOL gain or 3 SOL of trading;
 *   - below the reserve the settle waits with its frontier where it is
 *     (reserveDecision, settle-decision.ts) and goes once the wallet is funded;
 *   - about 0.00001 SOL: one settle's fee, 10 000 lamports;
 *   - the steps are VaultCard's own labels (VAULT_COPY.changeLimits,
 *     mostPerSettlement, alwaysLeft, saveLimits), and the delay is its
 *     nonceNotice: a limit change forgives no trade (policy-boundary.ts).
 * Round-ups' cadence is the one its own page states, with no figure (owner, 10-22).
 */

import { DocLink, H2, List, P, Steps } from "@/components/docs/docs-content";

export default function TimingAndLimitsBody() {
  return (
    <>
      <P>
        SaverFi checks your linked trading wallets, the wallets you trade from, about once a minute, and saves whatever
        is owed. Three things apply to every saving: the most it can move, a reserve your trading wallet always keeps,
        and a small network fee.
      </P>

      <H2>How soon a saving happens</H2>
      <List>
        <li>
          <strong>Profit:</strong> usually within a minute or two of the sell that puts you ahead.
        </li>
        <li>
          <strong>Volume:</strong> as soon as 0.001 SOL is owed. Smaller amounts wait up to an hour after your oldest
          unsaved trade. At 2 %, that is any trading under 0.05 SOL.
        </li>
        <li>
          <strong>Round-ups:</strong> gathered and saved together once enough has built up, or within the hour.
        </li>
      </List>

      <H2>The most one saving moves</H2>
      <P>
        By default, one saving moves at most 0.06 SOL. Anything above that is not saved, and is not carried over to the
        next saving. For example, at 20 % of profit that is a gain of 0.3 SOL, and at 2 % of volume about 3 SOL of
        trading in one saving. <DocLink to="round-ups">Round-ups</DocLink> also have a daily cap.
      </P>

      <H2>What your trading wallet keeps</H2>
      <P>
        By default, your trading wallet always keeps at least 0.05 SOL, so you can keep paying for trades. A saving that
        would take it lower waits, and goes once you top the wallet up. The wallet also pays each saving’s network fee,
        about 0.00001 SOL.
      </P>

      <H2>Change these limits</H2>
      <Steps>
        <li>
          Open <strong>Manage wallets</strong>, then the <strong>Vault</strong> tab.
        </li>
        <li>
          Open <strong>Change these limits</strong>.
        </li>
        <li>
          Set <strong>Most per settlement</strong> and <strong>Always left in the trading wallet</strong>. The app
          calls each saving a settlement.
        </li>
        <li>
          Press <strong>Sign new limits</strong>, and approve in your wallet app.
        </li>
      </Steps>
      <P>
        A saving already on its way may be delayed by a few minutes. Nothing is lost. If nothing arrives at all, see{" "}
        <DocLink to="not-saving" />.
      </P>
    </>
  );
}
