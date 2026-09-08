"use client";

/**
 * WHOSE NUMBERS, AND WHETHER THEY ARE REAL. Both questions, answered in one place.
 *
 * THE PROBLEM THIS SOLVES. `/` is a server component and Privy is a browser
 * thing, so the server cannot know who is looking; page.tsx said as much in its
 * own header and, for want of an answer, rendered the seeded mock to everyone.
 * Nothing in the app ever set `?admin=` -- the deep link existed and had no
 * producer. This component is the producer: it reads the pension key from Privy
 * in the browser and asks `/api/dashboard` for that person, a route that was
 * written for exactly this and until now had zero callers.
 *
 * WHY THE MOCK IS STILL RENDERED ON THE SERVER. It arrives as a prop, complete,
 * so switching to Mock costs no request and cannot fail. Live is the one that
 * goes to the network, which is the right way round: the example should never be
 * the thing that breaks.
 *
 * THE RULE THAT MATTERS. On Live, a payload that comes back `source: "mock"` is
 * NOT rendered. loadDashboard answers every degraded case with the seeded data
 * plus a reason -- correct for one mode, dishonest under a control the user set
 * to "Live". It renders LiveEmpty and the reason instead. The badge, meanwhile,
 * always reads the payload actually on screen, never this component's state, so
 * the label and the numbers cannot disagree.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { usePrivy } from "@privy-io/react-auth";
import type { Address } from "viem";

import { DashboardSource } from "@/components/DashboardSource";
import { DashboardWallets } from "@/components/dashboard-wallets";
import { DataModeToggle, type DataMode } from "@/components/data-mode";
import { Landing } from "@/components/landing";
import { LiveEmpty } from "@/components/live-empty";
import { PensionPanel } from "@/components/pension-panel";
import { SavingsRulePanel } from "@/components/savings-rule-panel";
import { SavingsStrip } from "@/components/savings-strip";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Skeleton } from "@/components/ui/skeleton";
import { pensionKeyOf } from "@/components/wallets/WalletsScreen";
import type { DashboardMock } from "@/mocks";

export interface DashboardLoadJson {
  readonly source: "live" | "mock";
  readonly data: DashboardMock;
  readonly notice: string | null;
}

/** The live payload plus the key it was fetched for, so a key change cannot show stale numbers. */
type LiveState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly admin: Address }
  | { readonly status: "ready"; readonly admin: Address; readonly load: DashboardLoadJson }
  | { readonly status: "failed"; readonly admin: Address; readonly detail: string };

export function DashboardShell({
  mock,
  pinnedAdmin,
  initialLive,
}: {
  /** The seeded example, rendered on the server so Mock never needs the network. */
  mock: DashboardLoadJson;
  /** `?admin=0x…` from the URL: a deep link, and the one identity the server can know. */
  pinnedAdmin: Address | null;
  /** What the server already loaded for `pinnedAdmin`, so the deep link does not refetch. */
  initialLive: DashboardLoadJson | null;
}) {
  const { ready, user } = usePrivy();

  // The pension key is derived, never stored: the app keeps no copy of who you
  // are, so a disconnect is a disconnect (WalletsScreen.pensionKeyOf).
  const pensionKey = useMemo(() => (user === null ? null : pensionKeyOf(user)), [user]);
  const admin: Address | null = pinnedAdmin ?? pensionKey;

  const [mode, setMode] = useState<DataMode>("live");
  const [live, setLive] = useState<LiveState>(
    pinnedAdmin !== null && initialLive !== null
      ? { status: "ready", admin: pinnedAdmin, load: initialLive }
      : { status: "idle" },
  );

  const needsFetch =
    admin !== null &&
    mode === "live" &&
    (live.status === "idle" || (live.status !== "loading" && live.admin !== admin));

  useEffect(() => {
    if (!needsFetch || admin === null) return;
    let cancelled = false;
    setLive({ status: "loading", admin });
    // No cache: a pull that landed a minute ago should show, and this is one
    // request per switch, not a poll.
    fetch(`/api/dashboard?admin=${admin}`, { cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(`the dashboard service answered ${response.status}`);
        return body as DashboardLoadJson;
      })
      .then((load) => {
        if (!cancelled) setLive({ status: "ready", admin, load });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLive({ status: "failed", admin, detail: error instanceof Error ? error.message : "unknown error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, admin]);

  const onModeChange = useCallback((next: DataMode) => setMode(next), []);

  // Privy has not decided yet. Rendering the landing here would flash a connect
  // button at somebody who is already connected.
  if (!ready) return <BootSkeleton />;

  // Nobody is connected and the URL names nobody: there is no pension to show.
  if (admin === null) return <Landing />;

  const control = <DataModeToggle mode={mode} onModeChange={onModeChange} />;

  if (mode === "live") {
    if (live.status === "loading" || live.status === "idle") {
      return <Chrome control={control} admin={admin} now={mock.data.now} loading />;
    }
    if (live.status === "failed") {
      return (
        <Chrome control={control} admin={admin} now={mock.data.now}>
          <LiveEmpty notice={`The dashboard could not be read: ${live.detail}.`} />
        </Chrome>
      );
    }
    // THE RULE: a mock payload is never drawn under the Live label.
    if (live.load.source === "mock") {
      return (
        <Chrome control={control} admin={admin} now={mock.data.now}>
          <LiveEmpty notice={live.load.notice} />
        </Chrome>
      );
    }
    return <Body load={live.load} control={control} />;
  }

  return <Body load={mock} control={control} />;
}

/** The full dashboard for one payload. Every component takes exactly the slice it renders. */
function Body({ load, control }: { load: DashboardLoadJson; control: React.ReactNode }) {
  const { now, wallet, rule, stats, curve, days, holdings, trades, activity } = load.data;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader wallet={wallet} activity={activity} now={now} control={control} />

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

/**
 * Header and footer around something that is not a dashboard. The header needs a
 * wallet to render its menu; it gets the example's, which is why the sidebar --
 * where an address is copyable and could be mistaken for the user's own -- is
 * deliberately absent here.
 */
function Chrome({
  control,
  admin,
  now,
  children,
  loading = false,
}: {
  control: React.ReactNode;
  /** The pension key actually on screen. NEVER the example's address. */
  admin: Address;
  now: string;
  children?: React.ReactNode;
  loading?: boolean;
}) {
  // THE HEADER MUST NOT WEAR SOMEBODY ELSE'S ADDRESS. It used to take the
  // example's wallet, which is a plausible-looking 0x7a3f… that a person would
  // read as their own — under a control set to "Live", next to a card saying
  // there is nothing saved. The balance is 0 because that is what is known: no
  // vault means no balance to state, and stating one would be inventing it.
  const wallet = { address: admin, network: "Robinhood Chain", label: "Pension key", balanceUsd: 0 };

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader wallet={wallet} activity={[]} now={now} control={control} />
      {loading ? (
        <main className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
          <Skeleton className="h-8 w-full max-w-md" />
          <Skeleton className="h-64 w-full" />
        </main>
      ) : (
        children
      )}
      <SiteFooter now={now} />
    </div>
  );
}

function BootSkeleton() {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="h-14 border-b" />
      <main className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
        <Skeleton className="h-8 w-full max-w-md" />
        <Skeleton className="h-64 w-full" />
      </main>
    </div>
  );
}
