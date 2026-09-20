"use client";

/**
 * WHOSE NUMBERS, AND WHETHER THEY ARE REAL — decided in one place
 * (src/lib/dashboard-mode.ts) and rendered here.
 *
 * THE OWNER'S RULE, IN TWO SENTENCES. With a pension key connected the dashboard
 * is Live and the Live|Mock control leaves the navbar; a ?mode=mock in the
 * address bar is normalized away rather than obeyed. With nobody connected the
 * choice is offered, and Live shows an honest connect card — never the sample
 * under a label promising somebody their own pension.
 *
 * NOTHING IS PAINTED BEFORE PRIVY ANSWERS. `ready` is false on the server, so a
 * request for /?mode=mock renders a skeleton and the sample HTML is never sent
 * to a browser that might be a connected user's. The landing is the one
 * exception, and deliberately so: it holds no numbers.
 *
 * THE FRAME SPLITS ON `walletsConfigured` BEFORE ANY PRIVY HOOK RUNS. Without a
 * configuration there is no PrivyProvider in the tree, and usePrivy() inside one
 * would be a hook reaching for a context that is not there. The unconfigured
 * frame never calls it at all.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useLogin, usePrivy } from "@privy-io/react-auth";
import { LogOut } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";

import { CopyButton } from "@/components/copy-button";
import { DashboardSource } from "@/components/DashboardSource";
import { DashboardWallets } from "@/components/dashboard-wallets";
import { DataModeToggle } from "@/components/data-mode";
import { Landing } from "@/components/landing";
import { LiveBody } from "@/components/live/LiveBody";
import { LiveConnectCard, LiveKeylessCard, LiveLoading, LivePrivyStalled, LiveUnavailableCard, LiveUnreadable } from "@/components/live/LiveStates";
import { Num } from "@/components/num";
import { PensionPanel } from "@/components/pension-panel";
import { SavingsRulePanel } from "@/components/savings-rule-panel";
import { SavingsStrip } from "@/components/savings-strip";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletActivity } from "@/components/wallet-activity";
import { useWalletsClosed, useWalletsOpener } from "@/components/wallets-host";
import { useLiveDashboard, type LiveDashboardStore } from "@/hooks/use-live-dashboard";
import { decideDashboard, readUrlMode, toggleModeOf, urlWithMode, type DashboardState, type UrlMode } from "@/lib/dashboard-mode";
import { formatUsd } from "@/lib/amounts";
import { LIVE_COPY, MODE_COPY } from "@/lib/live-copy";
import { pensionKeyOf } from "@/lib/pension-key";
import { privyFailure } from "@/lib/privy-failure";
import { rememberSession } from "@/lib/session-hint";
import { PRIVY_PATIENCE_MS } from "@/lib/privy-patience";
import { shortAddress } from "@/lib/vault-copy";
import { tradingWalletsOf } from "@/lib/trading-wallets";
import type { DashboardMock } from "@/mocks";

export interface DashboardLoadJson {
  readonly source: "live" | "mock";
  readonly data: DashboardMock;
  readonly notice: string | null;
}

interface DashboardContextValue {
  readonly state: DashboardState;
  readonly mock: DashboardLoadJson;
  readonly live: LiveDashboardStore | null;
  /** The connected external Solana wallet, when there is one. The live body is shown ITS pension. */
  readonly pensionKey: string | null;
  readonly account: ReactNode;
  readonly setMode: (mode: UrlMode) => void;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  /** The way out of a state that holds no numbers, and the 15 s fallback's second button. */
  readonly onSeeSample: () => void;
  readonly loginFailure: string | null;
  readonly stalled: boolean;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

/** The frame's decision and data. Null outside a frame. */
export const useDashboard = (): DashboardContextValue | null => useContext(DashboardContext);

const solscanAccountUrl = (address: string): string => `https://solscan.io/account/${address}`;

/**
 * The connected pension key: its short address, a copy button, and WHAT THE
 * PENSION IS WORTH.
 *
 * THE BALANCE REPLACED A SOLSCAN LINK. The link was the third way to reach the
 * same explorer from this screen and answered a question nobody had in the
 * chrome; the balance is the one number somebody wants following them around.
 * Null prices show nothing rather than a zero — a pension whose worth could not
 * be read has not lost its money.
 */
function PensionKeyChip({ address, worthUsdcRaw }: { readonly address: string; readonly worthUsdcRaw: bigint | null }) {
  return (
    <span className="hidden items-center gap-1.5 rounded-md border px-2 py-1 sm:inline-flex">
      <Num className="text-xs">{shortAddress(address)}</Num>
      <CopyButton value={address} />
      {worthUsdcRaw === null ? null : (
        <>
          <span aria-hidden className="h-3.5 w-px bg-border" />
          <Num className="text-xs font-medium">{formatUsd(worthUsdcRaw)}</Num>
          <span className="sr-only">{LIVE_COPY.worthNow}</span>
        </>
      )}
    </span>
  );
}

function DisconnectButton({ onDisconnect }: { readonly onDisconnect: () => void }) {
  return (
    <>
      <Button size="sm" variant="outline" className="hidden sm:inline-flex" onClick={onDisconnect}>
        {LIVE_COPY.disconnect}
      </Button>
      <Button size="sm" variant="outline" className="sm:hidden" aria-label={LIVE_COPY.disconnect} onClick={onDisconnect}>
        <LogOut aria-hidden />
      </Button>
    </>
  );
}

/** What stands at the right of the header, for each state the frame can be in. */
function accountSlot(
  state: DashboardState,
  pensionKey: string | null,
  actions: { readonly onConnect: () => void; readonly onDisconnect: () => void; readonly openSetup: () => void },
  worthUsdcRaw: bigint | null = null,
): ReactNode {
  switch (state.account) {
    case "connect-setup":
      return (
        <Button size="sm" onClick={actions.openSetup}>
          {LIVE_COPY.connect}
        </Button>
      );
    case "placeholder":
      // Never a Connect that cannot act yet: a button that does nothing when
      // pressed is worse than one that has not arrived.
      return (
        <>
          <Skeleton className="h-8 w-24" aria-hidden />
          <span className="sr-only">{LIVE_COPY.checking}</span>
        </>
      );
    case "connect":
      return (
        <Button size="sm" onClick={actions.onConnect}>
          {LIVE_COPY.connect}
        </Button>
      );
    case "disconnect":
      return <DisconnectButton onDisconnect={actions.onDisconnect} />;
    case "key-and-disconnect":
      return (
        <>
          {pensionKey === null ? null : <PensionKeyChip address={pensionKey} worthUsdcRaw={worthUsdcRaw} />}
          <DisconnectButton onDisconnect={actions.onDisconnect} />
        </>
      );
  }
}

// ── the frame ────────────────────────────────────────────────────────────────

export function DashboardFrame({
  mock,
  walletsConfigured,
  knownSession = false,
  children,
}: {
  readonly mock: DashboardLoadJson;
  readonly walletsConfigured: boolean;
  /** From the server's cookie read, before the first paint. */
  readonly knownSession?: boolean;
  readonly children: ReactNode;
}) {
  return walletsConfigured ? (
    <ConfiguredFrame mock={mock} knownSession={knownSession}>
      {children}
    </ConfiguredFrame>
  ) : (
    <UnconfiguredFrame mock={mock}>{children}</UnconfiguredFrame>
  );
}

/** The URL is the mode's home, so Back undoes a switch and a reload keeps it. */
function useMode(): { readonly urlMode: UrlMode | null; readonly pathname: string; readonly setMode: (mode: UrlMode) => void } {
  const params = useSearchParams();
  const pathname = usePathname() ?? "/";
  const urlMode = readUrlMode(params.get("mode"));
  const setMode = useCallback(
    (mode: UrlMode) => {
      // Next keeps useSearchParams in step with pushState, so the decision runs
      // again and Back undoes the switch without a router round trip.
      window.history.pushState({}, "", urlWithMode(pathname, mode));
    },
    [pathname],
  );
  return { urlMode, pathname, setMode };
}

/** No Solana configuration: Privy never mounts, so no Privy hook is ever called. */
function UnconfiguredFrame({ mock, children }: { readonly mock: DashboardLoadJson; readonly children: ReactNode }) {
  const { urlMode, pathname, setMode } = useMode();
  const openWallets = useWalletsOpener();
  const openSetup = useCallback(() => openWallets?.(), [openWallets]);

  const state = decideDashboard({
    walletsConfigured: false,
    // No provider here, so rule 1 answers before the hint could matter.
    knownSession: false,
    privyGaveUp: false,
    ready: false,
    authenticated: false,
    hasUser: false,
    pensionKey: null,
    urlMode,
    pathname,
    landingAllowed: pathname === "/",
  });

  const value: DashboardContextValue = {
    state,
    mock,
    live: null,
    pensionKey: null,
    account: accountSlot(state, null, { onConnect: openSetup, onDisconnect: openSetup, openSetup }),
    setMode,
    onConnect: openSetup,
    onDisconnect: openSetup,
    onSeeSample: () => setMode("mock"),
    loginFailure: null,
    stalled: false,
  };
  return (
    <Body value={value} onEnter={() => setMode("mock")} walletsConfigured={false}>
      {children}
    </Body>
  );
}

function ConfiguredFrame({
  mock,
  knownSession,
  children,
}: {
  readonly mock: DashboardLoadJson;
  readonly knownSession: boolean;
  readonly children: ReactNode;
}) {
  const { ready, authenticated, user, logout } = usePrivy();
  const { urlMode, pathname, setMode } = useMode();
  const [loginFailure, setLoginFailure] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [stalled, setStalled] = useState(false);
  const openWallets = useWalletsOpener();

  const { login } = useLogin({
    onError: (code) => {
      const described = privyFailure(code);
      // Closing Privy's dialog is a choice, not an error.
      setLoginFailure(described.kind === "exited" ? null : described.message);
    },
  });

  // The pension key is derived, never stored: the app keeps no copy of who you
  // are, so a disconnect is a disconnect.
  const pensionKey = useMemo(() => (user === null || user === undefined ? null : pensionKeyOf(user)), [user]);
  const privyWallets = useMemo(() => tradingWalletsOf(user ?? null).map((wallet) => wallet.address), [user]);

  // After the patience runs out, say so rather than pulsing forever.
  useEffect(() => {
    if (ready) return undefined;
    const timer = window.setTimeout(() => setStalled(true), PRIVY_PATIENCE_MS);
    return () => window.clearTimeout(timer);
  }, [ready]);

  const state = decideDashboard({
    walletsConfigured: true,
    knownSession,
    privyGaveUp: gaveUp,
    ready,
    authenticated,
    hasUser: user !== null && user !== undefined,
    pensionKey,
    urlMode,
    pathname,
    landingAllowed: pathname === "/",
  });

  // ?mode=mock with a key connected becomes ?mode=live, once per change, so a
  // reload of a connected tab can never land on the sample or the landing.
  useEffect(() => {
    if (state.replaceUrlWith === null) return;
    window.history.replaceState({}, "", state.replaceUrlWith);
  }, [state.replaceUrlWith]);

  // THE HINT IS WRITTEN FROM WHAT PRIVY SAYS, never from what a button did: a
  // session restored on load sets it just as a fresh login does, and a session
  // that ended anywhere — logout here, expiry, another tab — clears it.
  useEffect(() => {
    if (!ready) return;
    rememberSession(authenticated);
  }, [ready, authenticated]);

  const live = useLiveDashboard({ pensionKey: state.kind === "live" ? pensionKey : null, privyWallets });

  // Every chain write happens in the wallets modal; read again as it closes
  // rather than showing the old numbers for up to a minute.
  useWalletsClosed(
    useCallback(() => {
      if (state.kind === "live") live.refresh({ discover: true });
    }, [state.kind, live]),
  );

  const onDisconnect = useCallback(() => {
    // Land on the Live connect card, not back on the landing.
    window.history.replaceState({}, "", urlWithMode(pathname, "live"));
    void logout();
  }, [logout, pathname]);

  const onConnect = useCallback(() => {
    setLoginFailure(null);
    login();
  }, [login]);

  const value: DashboardContextValue = {
    state,
    mock,
    live,
    pensionKey,
    // The worth follows the same read the page below draws from, so the bar and
    // the card can never disagree about what the pension is holding.
    account: accountSlot(
      state,
      pensionKey,
      { onConnect, onDisconnect, openSetup: () => openWallets?.() },
      live.view.kind === "ready" ? live.view.data.worthNowUsdcRaw : null,
    ),
    setMode,
    onConnect,
    onDisconnect,
    // The 15 s fallback's "View sample data": it must also stop waiting for
    // Privy, or the skeleton would come straight back.
    onSeeSample: () => {
      setGaveUp(true);
      setMode("mock");
    },
    loginFailure,
    stalled: stalled && !ready && !gaveUp,
  };

  return (
    <Body value={value} onEnter={() => setMode("mock")} walletsConfigured>
      {children}
    </Body>
  );
}

function Body({
  value,
  children,
  onEnter,
  walletsConfigured,
}: {
  readonly value: DashboardContextValue;
  readonly children: ReactNode;
  readonly onEnter: () => void;
  readonly walletsConfigured: boolean;
}) {
  // The front door is its own page: no header, no numbers, and it never waits.
  if (value.state.kind === "landing") return <Landing onEnter={onEnter} walletsConfigured={walletsConfigured} />;
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

// ── the view each page renders ───────────────────────────────────────────────

/** The sample, exactly as it was: today's components, today's data, one notice over it. */
function MockBody({ load, control, account, current }: { readonly load: DashboardLoadJson; readonly control: ReactNode; readonly account: ReactNode; readonly current: "pension" | "activity" }) {
  const { now, wallet, rule, stats, curve, days, holdings, trades, activity } = load.data;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader activitySheet={<WalletActivity wallet={wallet} activity={activity} now={now} id="activity-sheet" className="min-h-0 flex-1" />} control={control} account={account} current={current} />

      <div className="flex flex-1">
        <aside className="hidden w-80 shrink-0 border-r lg:block xl:w-88">
          <DashboardWallets wallet={wallet} activity={activity} now={now} className="sticky top-14 h-[calc(100dvh-3.5rem)]" />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
          {/* Reads the payload on screen, never the toggle: the two cannot disagree. */}
          <DashboardSource source={load.source} notice={load.notice} />
          <SavingsStrip trades={trades} rule={rule} now={now} />
          <div className="grid gap-4 lg:gap-6 md:grid-cols-[minmax(16rem,20rem)_1fr] lg:grid-cols-1 xl:grid-cols-[minmax(16rem,20rem)_1fr]">
            <SavingsRulePanel rule={rule} stats={stats} activity={activity} now={now} className="order-2 md:order-1 lg:order-2 xl:order-1" />
            <PensionPanel stats={stats} curve={curve} holdings={holdings} days={days} rule={rule} now={now} className="order-1 md:order-2 lg:order-1 xl:order-2" />
          </div>
        </main>
      </div>

      <SiteFooter now={now} />
    </div>
  );
}

/**
 * Every state that holds no numbers: one card, centred, under the same header.
 *
 * `now` is a PROP, never the clock. A `new Date()` here renders one string on
 * the server and possibly another in the browser, which React reports as a
 * hydration mismatch on every load — the reason every date on this page comes
 * from one payload's own `now` (src/lib/format.ts).
 */
function PlainBody({
  control,
  account,
  current,
  sidebar,
  now,
  children,
}: {
  readonly control: ReactNode;
  readonly account: ReactNode;
  readonly current: "pension" | "activity";
  readonly sidebar: ReactNode;
  readonly now: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader activitySheet={sidebar} control={control} account={account} current={current} />
      <div className="flex flex-1">
        <aside className="hidden w-80 shrink-0 border-r lg:block xl:w-88">
          <div className="sticky top-14 p-4 text-sm text-muted-foreground">{sidebar}</div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      <SiteFooter now={now} />
    </div>
  );
}

export function DashboardView({ view }: { readonly view: "pension" | "activity" }) {
  const context = useDashboard();
  if (context === null) return null;
  const { state, mock, live, account, pensionKey, setMode, onSeeSample } = context;

  const control = state.toggle ? <DataModeToggle mode={toggleModeOf(state.kind)} onModeChange={setMode} /> : null;
  const plain = (sidebar: ReactNode, children: ReactNode) => (
    <PlainBody control={control} account={account} current={view} sidebar={sidebar} now={mock.data.now}>
      {children}
    </PlainBody>
  );

  switch (state.kind) {
    case "landing":
      return null;

    case "mock": {
      const notice = state.notice === "keyless" ? MODE_COPY.keyless : MODE_COPY.sample;
      return <MockBody load={{ ...mock, notice }} control={control} account={account} current={view} />;
    }

    case "loading":
      // The 15 s fallback: a skeleton that never resolves is worse than a reason.
      return context.stalled
        ? plain(LIVE_COPY.checking, <LivePrivyStalled onSeeSample={onSeeSample} />)
        : plain(<Skeleton className="h-24 w-full rounded-md" aria-hidden />, <LiveLoading />);

    case "live-connect":
      return plain(LIVE_COPY.connectSidebar, <LiveConnectCard onConnect={context.onConnect} onSeeSample={onSeeSample} failure={context.loginFailure} />);

    case "live-keyless":
      return plain(LIVE_COPY.connectSidebar, <LiveKeylessCard onDisconnect={context.onDisconnect} />);

    case "live-unavailable":
      return plain(LIVE_COPY.unavailableSidebar, <LiveUnavailableCard onConnect={context.onConnect} onSeeSample={onSeeSample} />);

    case "live": {
      // The first read, still in flight: skeletons, never the example.
      if (live === null || pensionKey === null || live.view.kind === "idle" || live.view.kind === "loading") {
        return plain(LIVE_COPY.readingSidebar, <LiveLoading label={LIVE_COPY.reading} />);
      }
      // The browser's own clock, and ONLY for countdowns — every label on the
      // page below is measured against the snapshot's own `readAtMs`.
      const clock = Date.now();
      if (live.view.kind === "unreadable") {
        return plain(LIVE_COPY.readingSidebar, <LiveUnreadable message={live.view.message} retryAt={live.view.retryAt} now={clock} onRetry={() => live.refresh()} />);
      }
      // A 200 whose VAULT could not be read is not a vault that does not exist.
      // It gets the unreadable card, never an offer to create one that may
      // already be there — that asks for a signature the chain must refuse.
      if (live.view.data.stage === "vault_unreadable") {
        return plain(LIVE_COPY.readingSidebar, <LiveUnreadable message={LIVE_COPY.unreadableBody} retryAt={null} now={clock} onRetry={() => live.refresh()} />);
      }
      return (
        <LiveBody
          view={view}
          data={live.view.data}
          stale={live.view.stale}
          pensionKey={pensionKey}
          control={control}
          account={account}
          older={live.older}
          onRefresh={() => live.refresh()}
          onLoadOlder={() => live.loadOlder()}
          nowMs={clock}
          activityUnreadable={live.activityUnreadable}
        />
      );
    }
  }
}
