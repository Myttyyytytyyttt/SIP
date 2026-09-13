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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { Button } from "@/components/ui/button";
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
  initialMode = "live",
  walletsConfigured,
}: {
  /** The seeded example, rendered on the server so Mock never needs the network. */
  mock: DashboardLoadJson;
  /** `?admin=0x…` from the URL: a deep link, and the one identity the server can know. */
  pinnedAdmin: Address | null;
  /** What the server already loaded for `pinnedAdmin`, so the deep link does not refetch. */
  initialLive: DashboardLoadJson | null;
  /** `?mode=mock` opens on the example. */
  initialMode?: DataMode;
  /** Whether the wallets modal has a configuration; the landing's Connect depends on it. */
  walletsConfigured: boolean;
}) {
  const { ready, user, login } = usePrivy();

  // ENTERED WITHOUT A KEY. The landing lets a visitor walk into the example
  // without connecting — scroll, or click the screenshot. Nothing about them is
  // known, so Live is not merely empty, it is impossible: the toggle greys it
  // out, and the example stays under its Sample data badge until a key exists.
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
  // are, so a disconnect is a disconnect (WalletsScreen.pensionKeyOf).
  const pensionKey = useMemo(() => (user === null ? null : pensionKeyOf(user)), [user]);
  const admin: Address | null = pinnedAdmin ?? pensionKey;

  const [mode, setMode] = useState<DataMode>(initialMode);
  const [live, setLive] = useState<LiveState>(
    pinnedAdmin !== null && initialLive !== null
      ? { status: "ready", admin: pinnedAdmin, load: initialLive }
      : { status: "idle" },
  );

  const needsFetch =
    admin !== null &&
    mode === "live" &&
    (live.status === "idle" || (live.status !== "loading" && live.admin !== admin));

  // KEYED ON A GENERATION, NOT CANCELLED IN CLEANUP. A first version dropped
  // the answer when the effect re-ran, and left `live` at "loading" with nothing
  // that would ever refetch: a Mock click during the skeleton, or a key change
  // mid-load, stranded a connected user on a skeleton until reload. Now an
  // old answer is simply ignored, and the render never draws a payload that was
  // fetched for another key.
  const generation = useRef(0);
  useEffect(() => {
    if (!needsFetch || admin === null) return;
    const mine = ++generation.current;
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
        if (generation.current === mine) setLive({ status: "ready", admin, load });
      })
      .catch((error: unknown) => {
        if (generation.current === mine) {
          setLive({ status: "failed", admin, detail: error instanceof Error ? error.message : "unknown error" });
        }
      });
  }, [needsFetch, admin]);

  // A person who walked in on the example and then connects should land on
  // their own numbers — unless they have touched the toggle themselves.
  const touched = useRef(false);
  const onModeChange = useCallback((next: DataMode) => {
    touched.current = true;
    setMode(next);
  }, []);
  const hadKey = useRef(admin !== null);
  useEffect(() => {
    if (admin !== null && !hadKey.current && !touched.current) setMode("live");
    hadKey.current = admin !== null;
  }, [admin]);

  // THE FRONT DOOR DOES NOT WAIT FOR PRIVY. It used to: a skeleton until
  // `ready`, so a returning user never saw a Connect button flash before the
  // dashboard. Measured in a headless browser, `ready` never came, and the
  // page stayed blank for as long as anyone cared to wait — a front door that
  // depends on a third party's initialisation to open at all. So the landing
  // renders at once; only its Connect button waits (it shows a placeholder
  // until Privy can act), and when Privy does resolve with a key, this
  // component simply re-renders into the dashboard. A returning user sees the
  // landing for the length of that handshake, which is the better trade.
  if (admin === null && !entered) return <Landing onEnter={onEnter} walletsConfigured={walletsConfigured} />;

  // With no key there is no Live. The control shows that rather than hiding it.
  const control = <DataModeToggle mode={admin === null ? "mock" : mode} onModeChange={onModeChange} disabled={admin === null} />;

  if (admin === null) {
    // Browse mode, honestly: the notice does not tell the visitor to switch to
    // a control that is disabled, and the header wears a real Connect instead
    // of the example's fake wallet menu. `ready` gates it exactly as the
    // landing's does — on an incomplete deployment there is no provider.
    return (
      <Body
        load={{ ...mock, notice: "Example data. Nobody\u2019s pension \u2014 connect to see your own." }}
        control={control}
        account={
          <Button size="sm" onClick={() => login()} disabled={!ready}>
            Connect
          </Button>
        }
      />
    );
  }

  if (mode === "live") {
    if (live.status === "loading" || live.status === "idle" || live.admin !== admin) {
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
