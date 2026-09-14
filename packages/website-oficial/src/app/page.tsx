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
 * the deployment's configuration at request time -- the keyed RPC URL never
 * reaches the browser -- and it renders the seeded example completely, on the
 * server, so the example costs no request and cannot fail.
 *
 * WHOSE PENSION IS THIS? The server knows nobody -- Privy lives in the browser --
 * so it hands the shell the example and the shell asks the browser. An
 * unconnected visitor gets a landing page and a Connect button. There is no live
 * data yet: it arrives with the Solana vault screens, and until then everyone who
 * walks in sees the example under its Sample data badge.
 */

import { DashboardShell, type DashboardLoadJson } from "@/components/dashboard-shell";
import { WalletsHost } from "@/components/wallets-host";
import { toSolanaPublicConfig } from "@/lib/config";
import { loadConfig } from "@/lib/load-config";
import { mock } from "@/mocks";

// The configuration is read at request time, never at build time.
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  // `?mode=mock` opens the example directly — how the landing's "see the app"
  // enters, and how a screenshot of the example is taken by URL alone.
  const initialMode = params.mode === "mock" ? "mock" : "live";

  // The example, always. The shell adds the one note that goes over it.
  const sample: DashboardLoadJson = { source: "mock", data: mock, notice: null };

  // "Manage wallets" opens a modal over this page rather than leaving for
  // /wallets — ALWAYS, which is why the problems travel with the config. The
  // modal mounts Privy, so it needs the WHOLE configuration the example itself
  // can do without; when that is incomplete the host opens the setup modal
  // instead, carrying exactly this list. The /wallets route stays as the deep
  // link and renders the same list server-side.
  const forWallets = loadConfig();
  const walletsConfig = forWallets.ok ? toSolanaPublicConfig(forWallets.config) : null;
  const walletsProblems = forWallets.ok ? [] : forWallets.problems;

  return (
    <WalletsHost config={walletsConfig} problems={walletsProblems}>
      <DashboardShell mock={sample} initialMode={initialMode} walletsConfigured={walletsConfig !== null} />
    </WalletsHost>
  );
}
