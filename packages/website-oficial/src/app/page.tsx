/**
 * THE ONE SCREEN, and the structure it borrows.
 *
 * Three regions, taken from the reference layout and nothing else from it:
 * a sidebar on the left (there: chat; here: what the wallet did), a strip
 * across the top of the main column (there: past multipliers; here: what
 * each trade put aside), and the main panel (there: the game; here: the
 * pension — a narrow rule panel where the bet controls were, the figure and
 * its chart where the round played out).
 *
 * SERVER COMPONENT. The dashboard is read here once and handed down as props; a
 * component takes exactly the slice it renders, so the swap from the mock to
 * real rows touched this file and no other — every component's props are
 * unchanged, because `src/mocks/types.ts` is the contract both sides satisfy.
 *
 * WHOSE PENSION IS THIS? Only a pension key identifies one, and this page runs
 * before any wallet is connected: Privy lives in the browser, so the server
 * knows nobody unless the URL says so (`/?admin=0x…`). Without one the seeded
 * mock renders exactly as it always did, with a banner saying so. That is
 * deliberate — a dashboard that greets a visitor with an empty chart looks
 * broken, and a dashboard that greets them with someone else's numbers is
 * worse.
 */

import { getAddress, isAddress } from "viem";

import { DashboardSource } from "@/components/DashboardSource";
import { DashboardWallets } from "@/components/dashboard-wallets";
import { WalletsHost } from "@/components/wallets-host";
import { PensionPanel } from "@/components/pension-panel";
import { SavingsRulePanel } from "@/components/savings-rule-panel";
import { SavingsStrip } from "@/components/savings-strip";
import { SiteHeader } from "@/components/site-header";
import { loadConfig, toPublicConfig } from "@/lib/config";
import { loadDashboard, type DashboardLoad } from "@/lib/dashboard";
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
  const { source, data, notice }: DashboardLoad = config.ok
    ? await loadDashboard(config.config, admin)
    : {
        source: "mock",
        data: mock,
        notice: "This deployment is not configured to read the chain, so this is example data.",
      };

  // "Manage wallets" opens a modal over this page rather than leaving for
  // /wallets — ALWAYS, which is why the problems travel with the config. The
  // modal mounts Privy and reads the factory, so it needs the WHOLE
  // configuration the dashboard itself can do without; when that is incomplete
  // the host opens the setup modal instead, carrying exactly this list. The
  // /wallets route stays as the deep link and renders the same list server-side.
  const forWallets = loadConfig();
  const walletsConfig = forWallets.ok ? toPublicConfig(forWallets.config) : null;
  const walletsProblems = forWallets.ok ? [] : forWallets.problems;

  const { now, wallet, rule, stats, curve, days, holdings, trades, activity } = data;

  return (
    <WalletsHost config={walletsConfig} problems={walletsProblems}>
      <div className="flex min-h-dvh flex-col">
      <SiteHeader wallet={wallet} activity={activity} now={now} />

      <div className="flex flex-1">
        {/* The sidebar is a column from lg up; below that the header opens the same component in a sheet. */}
        <aside className="hidden w-80 shrink-0 border-r lg:block xl:w-88">
          <DashboardWallets
            wallet={wallet}
            activity={activity}
            now={now}
            className="sticky top-14 h-[calc(100dvh-3.5rem)]"
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
          <DashboardSource source={source} notice={notice} />

          <SavingsStrip trades={trades} rule={rule} now={now} />

          {/* Two columns only where they fit: at lg the sidebar has just taken 320px, and a 320px rule column would leave the pension narrower than on a phone — stack until xl. */}
          <div className="grid gap-4 lg:gap-6 md:grid-cols-[minmax(16rem,20rem)_1fr] lg:grid-cols-1 xl:grid-cols-[minmax(16rem,20rem)_1fr]">
            <SavingsRulePanel rule={rule} stats={stats} activity={activity} now={now} className="order-2 md:order-1 lg:order-2 xl:order-1" />
            <PensionPanel stats={stats} curve={curve} holdings={holdings} days={days} rule={rule} now={now} className="order-1 md:order-2 lg:order-1 xl:order-2" />
          </div>
        </main>
      </div>
      </div>
    </WalletsHost>
  );
}
