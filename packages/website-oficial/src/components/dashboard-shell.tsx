"use client";

/**
 * WHOSE NUMBERS, AND WHETHER THEY ARE REAL. Both questions, answered in one place.
 *
 * `/` is a server component and Privy is a browser thing, so the server cannot
 * know who is looking. This component asks Privy in the browser whether there
 * is a session, and decides between the landing and the dashboard by that; the
 * pension key (src/lib/pension-key.ts) says whether the session has one.
 *
 * THERE IS NO LIVE DATA YET. It arrives with the Solana vault screens, and until
 * then nothing is fetched: whoever walks in, connected or not, sees the example
 * under its Sample data badge with Live greyed out, and one note says why. The
 * note never tells anyone to switch to a control they cannot use.
 *
 * WHY THE MOCK IS RENDERED ON THE SERVER. It arrives as a prop, complete, so the
 * example costs no request and cannot fail. The badge reads the payload actually
 * on screen, never the toggle, so the label and the numbers cannot disagree.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { usePrivy } from "@privy-io/react-auth";

import { DashboardSource } from "@/components/DashboardSource";
import { DashboardWallets } from "@/components/dashboard-wallets";
import { DataModeToggle, type DataMode } from "@/components/data-mode";
import { Landing } from "@/components/landing";
import { PensionPanel } from "@/components/pension-panel";
import { SavingsRulePanel } from "@/components/savings-rule-panel";
import { SavingsStrip } from "@/components/savings-strip";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { pensionKeyOf } from "@/lib/pension-key";
import type { DashboardMock } from "@/mocks";

export interface DashboardLoadJson {
  readonly source: "live" | "mock";
  readonly data: DashboardMock;
  readonly notice: string | null;
}

/** The one note over the example, for everyone, until there is live data to show. */
const SAMPLE_NOTICE = "Example data. Nobody’s pension. Live data arrives with the Solana vault screens.";

/** The note instead, for a session with no pension key: what to do about it. */
const KEYLESS_NOTICE =
  "Example data. Nobody’s pension. This session has no Solana wallet: disconnect, then connect Phantom, Backpack, Solflare or another Solana wallet.";

/** Live is disabled and Mock is already selected, so the control has nothing to change. */
const keepMock = (): void => undefined;

export function DashboardShell({
  mock,
  initialMode = "live",
  walletsConfigured,
}: {
  /** The seeded example, rendered on the server so it never needs the network. */
  mock: DashboardLoadJson;
  /** `?mode=mock` opens on the example instead of the landing. */
  initialMode?: DataMode;
  /** Whether the wallets modal has a configuration; the landing's Connect depends on it. */
  walletsConfigured: boolean;
}) {
  const { ready, user, login, logout } = usePrivy();

  // ENTERED WITHOUT A KEY. The landing lets a visitor walk into the example
  // without connecting — scroll, or click the screenshot.
  const [entered, setEntered] = useState(initialMode === "mock");
  // Entering pushes the URL the links already carry, so the hydrated path and
  // the no-JS path converge: reload lands on the example, Back returns to the
  // landing. Next patches pushState itself, so no router round trip is needed.
  const onEnter = useCallback(() => {
    setEntered(true);
    window.history.pushState({}, "", "/?mode=mock");
  }, []);
  useEffect(() => {
    const onPop = () => setEntered(new URLSearchParams(window.location.search).get("mode") === "mock");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The pension key is derived, never stored: the app keeps no copy of who you
  // are, so a disconnect is a disconnect.
  const pensionKey = useMemo(() => (user === null ? null : pensionKeyOf(user)), [user]);

  // THE FRONT DOOR DOES NOT WAIT FOR PRIVY. Measured in a headless browser,
  // `ready` never came, and a page gated on it stayed blank — a front door that
  // depends on a third party's initialisation to open at all. So the landing
  // renders at once; only its Connect button waits (it shows a placeholder
  // until Privy can act), and when Privy resolves with a session, this component
  // simply re-renders into the dashboard.
  //
  // BY SESSION, NOT BY KEY. A session with no external Solana wallet (one
  // restored from the old EVM site on this origin, say) has no pension key. On
  // the landing it would be stuck: Privy ignores login() for a user who is
  // already signed in. So it gets the example, a note, and a real Disconnect.
  if (user === null && !entered) return <Landing onEnter={onEnter} walletsConfigured={walletsConfigured} />;

  // Live is impossible until there is live data, connected or not. The control
  // shows that rather than hiding it.
  const control = <DataModeToggle mode="mock" onModeChange={keepMock} disabled />;

  // The header wears a real Connect or a real Disconnect, never the example's
  // fake wallet menu: a Privy session exists or it does not. `ready` gates both —
  // on an incomplete deployment there is no provider.
  const account =
    user === null ? (
      <Button size="sm" onClick={() => login()} disabled={!ready}>
        Connect
      </Button>
    ) : (
      <Button size="sm" variant="outline" onClick={() => void logout()} disabled={!ready}>
        Disconnect
      </Button>
    );

  const notice = user !== null && pensionKey === null ? KEYLESS_NOTICE : SAMPLE_NOTICE;

  return <Body load={{ ...mock, notice }} control={control} account={account} />;
}

/** The full dashboard for one payload. Every component takes exactly the slice it renders. */
function Body({
  load,
  control,
  account,
}: {
  load: DashboardLoadJson;
  control: React.ReactNode;
  account?: React.ReactNode;
}) {
  const { now, wallet, rule, stats, curve, days, holdings, trades, activity } = load.data;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader wallet={wallet} activity={activity} now={now} control={control} account={account} />

      <div className="flex flex-1">
        <aside className="hidden w-80 shrink-0 border-r lg:block xl:w-88">
          <DashboardWallets
            wallet={wallet}
            activity={activity}
            now={now}
            className="sticky top-14 h-[calc(100dvh-3.5rem)]"
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
          {/* Reads the payload on screen, never the toggle: the two cannot disagree. */}
          <DashboardSource source={load.source} notice={load.notice} />

          <SavingsStrip trades={trades} rule={rule} now={now} />

          <div className="grid gap-4 lg:gap-6 md:grid-cols-[minmax(16rem,20rem)_1fr] lg:grid-cols-1 xl:grid-cols-[minmax(16rem,20rem)_1fr]">
            <SavingsRulePanel
              rule={rule}
              stats={stats}
              activity={activity}
              now={now}
              className="order-2 md:order-1 lg:order-2 xl:order-1"
            />
            <PensionPanel
              stats={stats}
              curve={curve}
              holdings={holdings}
              days={days}
              rule={rule}
              now={now}
              className="order-1 md:order-2 lg:order-1 xl:order-2"
            />
          </div>
        </main>
      </div>

      <SiteFooter now={now} />
    </div>
  );
}
