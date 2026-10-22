/**
 * Change your settings — the body of /docs/change-settings.
 *
 * THE GEAR ON THE SAVINGS RULE CARD (owner, 09-25), as a reader meets it: what
 * Vault settings changes, how a change is approved, and the three things worth
 * knowing before a switch. The title, the one line under it and the clip are
 * not written here: the page around this body draws them from the index
 * (src/lib/docs/pages.ts).
 *
 * EVERY FIGURE IS THE PRODUCT'S OWN, read 10-22: the rate ranges (2.01–100 %
 * and 0.01–2 %) are RATE_RANGES and volume starts at VOLUME_START_BPS, 2 %
 * (owner, 10-22), both in src/lib/rule-settings.ts; $10 is
 * BASE_THRESHOLD_USD; one approval per half is rule-settings-plan.ts's
 * `approvals`. A vault pause stops settling, converting and buying (the
 * program's settle, convert and invest all refuse a paused vault); withdrawals
 * ignore it. The words in quotes are SETTINGS_COPY's and VAULT_COPY's.
 *
 * ROUND-UPS IS A THIRD MODE (owner, 10-22: written as live, with no unit or cap
 * figure), so Mode names it as its own page does. What forgives is the keeper's
 * policy-boundary.ts: a change of mode or of the volume rate, never a pause or
 * a limit. The picker's ceiling of five is left out while two stocks are
 * offered, and the cap and the reserve are the timing page's, not repeated
 * here (editor, 10-22).
 */

import { Callout, DocLink, H2, List, P, Steps } from "@/components/docs/docs-content";

export default function ChangeSettingsBody() {
  return (
    <>
      <P>
        The gear on the Savings rule card of your Pension page opens <strong>Vault settings</strong>: how you save and
        what you buy, in one place. Each title has a “?” that explains it.
      </P>

      <H2>What you can change</H2>
      <List>
        <li>
          <strong>Mode</strong>: <DocLink to="saving-from-profit">Profit</DocLink>,{" "}
          <DocLink to="saving-from-volume">Volume</DocLink> or <DocLink to="round-ups">Round-ups</DocLink>.
        </li>
        <li>
          <strong>Rate</strong>: drag the bar or pick a common rate. Profit goes from 2.01 % to 100 %. Volume goes from
          0.01 % to 2 %, and starts at 2 % when you switch to it. Round-ups take a unit instead.
        </li>
        <li>
          <strong>Pause saving</strong>: stops saving, converting and buying until you switch it back on.
        </li>
        <li>
          <strong>What your savings buy</strong>: SOL, or a basket of stocks and each one’s share of every buy. The
          shares must add up to 100 %, and <strong>Split evenly</strong> does it for you.
        </li>
        <li>
          <strong>Investment threshold</strong>: how much your savings wait for before buying in one go. It is $10
          unless you change it.
        </li>
      </List>

      <H2>Saving a change</H2>
      <Steps>
        <li>
          Make your changes, then press <strong>Save changes</strong>.
        </li>
        <li>
          Approve in your wallet app: one approval for a change to how you save, and one for a change to what you
          buy.
        </li>
        <li>The card says “Signed · updating your pension…” until the page shows your new rule.</li>
      </Steps>
      <Callout>
        A change can delay a saving already on its way by a few minutes. Nothing already in your vault is touched.
      </Callout>

      <H2>Before you switch</H2>
      <List>
        <li>
          Switching to Volume, or changing its rate, forgives trades not saved yet: Volume counts only trades made
          after the change. Switching back to Profit forgives nothing.
        </li>
        <li>
          Pausing never stops a withdrawal. To keep saving but stop buying, use <strong>Pause investing</strong> in
          Manage wallets → Investing: new savings then stay as SOL.
        </li>
        <li>
          The most one saving can move and the SOL always left in your trading wallet are changed in Manage wallets →
          Vault: see <DocLink to="timing-and-limits" />.
        </li>
      </List>
    </>
  );
}
