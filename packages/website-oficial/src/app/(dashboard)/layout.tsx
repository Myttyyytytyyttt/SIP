/**
 * THE DASHBOARD'S ONE FRAME, around both of its pages.
 *
 * WHY A ROUTE GROUP. `/` and `/activity` are the same screen looking at two
 * things, and they must share one PrivyProvider and one live store: mounting a
 * second provider is the "Multiple PrivyProvider instances found" bug, and a
 * second store would read Solana twice for one person. Navigating between them
 * now re-renders the middle and reads nothing again.
 *
 * `/wallets` STAYS OUTSIDE THIS GROUP, deliberately: it mounts its own provider,
 * and two in one tree is the failure above.
 *
 * STILL A SERVER COMPONENT, and still reads the configuration at request time —
 * the keyed RPC URL never reaches the browser — and still renders the seeded
 * example completely, on the server, so the sample costs no request and cannot
 * fail. Whether that example is ever SHOWN is the frame's decision, in the
 * browser, once Privy has said who is looking.
 */

import { DashboardFrame, type DashboardLoadJson } from "@/components/dashboard-shell";
import { WalletsHost } from "@/components/wallets-host";
import { toSolanaPublicConfig } from "@/lib/config";
import { loadConfig } from "@/lib/load-config";
import { mock } from "@/mocks";

// The configuration is read at request time, never at build time.
export const dynamic = "force-dynamic";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // The example, always. The frame adds the one note that goes over it.
  const sample: DashboardLoadJson = { source: "mock", data: mock, notice: null };

  // "Manage wallets" opens a modal over this page rather than leaving for
  // /wallets — ALWAYS, which is why the problems travel with the config. The
  // modal mounts Privy, so it needs the WHOLE configuration the example itself
  // can do without; when that is incomplete the host opens the setup modal
  // instead, carrying exactly this list.
  const loaded = loadConfig();
  const walletsConfig = loaded.ok ? toSolanaPublicConfig(loaded.config) : null;
  const walletsProblems = loaded.ok ? [] : loaded.problems;

  return (
    <WalletsHost config={walletsConfig} problems={walletsProblems}>
      <DashboardFrame mock={sample} walletsConfigured={walletsConfig !== null}>
        {children}
      </DashboardFrame>
    </WalletsHost>
  );
}
