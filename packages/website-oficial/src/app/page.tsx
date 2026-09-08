/**
 * THE ONE SCREEN, and the structure it borrows.
 *
 * Three regions, taken from the reference layout and nothing else from it:
 * a sidebar on the left (there: chat; here: what the wallet did), a strip
 * across the top of the main column (there: past multipliers; here: what
 * each trade put aside), and the main panel (there: the game; here: the
 * pension). The layout itself now lives in DashboardShell.
 *
 * WHAT THIS FILE STILL DOES, AND WHY IT IS STILL A SERVER COMPONENT. It reads
 * the deployment's configuration and the ledger -- the keyed RPC URL and the
 * connection string never reach the browser -- and it renders the seeded example
 * completely, on the server, so switching to Mock costs no request and cannot
 * fail. Live is the mode that goes to the network, which is the right way round.
 *
 * WHOSE PENSION IS THIS? Two answers, and they no longer contradict each other.
 * `/?admin=0x…` is a deep link the server can resolve on its own. Without one,
 * the server knows nobody -- Privy lives in the browser -- so it hands the shell
 * the example and the shell asks the browser. What it no longer does is show a
 * visitor the example as though it were a dashboard: an unconnected visitor gets
 * a landing page and a Connect button.
 */

import { getAddress, isAddress } from "viem";

import { DashboardShell, type DashboardLoadJson } from "@/components/dashboard-shell";
import { WalletsHost } from "@/components/wallets-host";
import { loadConfig, toPublicConfig } from "@/lib/config";
import { loadDashboard } from "@/lib/dashboard";
import { mock } from "@/mocks";

// The ledger and the RPC are read at request time, never at build time.
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams).admin;
  const candidate = typeof requested === "string" ? requested.trim() : "";
  // strict: false — a key pasted lowercase names the same account as the
  // checksummed form. Anything that is not an address is simply nobody.
  const admin = isAddress(candidate, { strict: false }) ? getAddress(candidate) : null;

  const config = loadConfig(process.env, { needPrivyAppId: false });

  // The example, always: it is what Mock renders, and it is the header's wallet
  // while Live has nothing to show.
  const sample: DashboardLoadJson = {
    source: "mock",
    data: mock,
    notice: "Example data. Nobody's pension — switch to Live to see your own.",
  };

  // Only the deep link can be resolved here; anyone else is resolved in the browser.
  const initialLive: DashboardLoadJson | null =
    admin !== null && config.ok ? await loadDashboard(config.config, admin) : null;

  // "Manage wallets" opens a modal over this page rather than leaving for
  // /wallets — ALWAYS, which is why the problems travel with the config. The
  // modal mounts Privy and reads the factory, so it needs the WHOLE
  // configuration the dashboard itself can do without; when that is incomplete
  // the host opens the setup modal instead, carrying exactly this list. The
  // /wallets route stays as the deep link and renders the same list server-side.
  const forWallets = loadConfig();
  const walletsConfig = forWallets.ok ? toPublicConfig(forWallets.config) : null;
  const walletsProblems = forWallets.ok ? [] : forWallets.problems;

  return (
    <WalletsHost config={walletsConfig} problems={walletsProblems}>
      <DashboardShell mock={sample} pinnedAdmin={admin} initialLive={initialLive} />
    </WalletsHost>
  );
}
