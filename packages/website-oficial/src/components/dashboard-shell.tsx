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
 * AND ITS ONE EXCEPTION, THE NEW-USER SETUP (owner, 09-23). A connected key with
 * no vault gets the setup over the page (src/components/onboarding): welcome,
 * then its vault. Closing it puts the visitor's sample on screen, and Connect or
 * Live reopens it where it was left. The frame owns that: it reads the key's
 * vault through the shared vault screen, keeps the close per tab, carries it on
 * Back and Forward, and mounts the setup beside the page so it outlives a close.
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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useLogin, usePrivy } from "@privy-io/react-auth";
import { LogOut } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";

import { CopyButton } from "@/components/copy-button";
import { DashboardSource } from "@/components/DashboardSource";
import { DashboardMain, PENSION_SLOT, RULE_SLOT } from "@/components/dashboard-main";
import { DashboardWallets } from "@/components/dashboard-wallets";
import { DataModeToggle } from "@/components/data-mode";
import { Landing } from "@/components/landing";
import { LiveBody } from "@/components/live/LiveBody";
import { LiveConnectCard, LiveKeylessCard, LiveLoading, LivePrivyStalled, LiveUnavailableCard, LiveUnreadable } from "@/components/live/LiveStates";
import { DisconnectButton, PensionKeyChip, worthFrom } from "@/components/account-chip";
import { Num } from "@/components/num";
import { PensionPanel } from "@/components/pension-panel";
import { SavingsRulePanel } from "@/components/savings-rule-panel";
import { SavingsStrip } from "@/components/savings-strip";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletActivity } from "@/components/wallet-activity";
import { OnboardingHost } from "@/components/onboarding/OnboardingHost";
import { WalletsOpenerOverride, useWalletsClosed, useWalletsModalOpen, useWalletsOpener } from "@/components/wallets-host";
import { useLiveDashboard, type LiveDashboardStore } from "@/hooks/use-live-dashboard";
import { useOnboardingClosed } from "@/hooks/use-onboarding-closed";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { decideDashboard, readUrlMode, toggleModeOf, urlWithMode, type DashboardState, type UrlMode } from "@/lib/dashboard-mode";
import { formatUsd } from "@/lib/amounts";
import { LIVE_COPY, MODE_COPY } from "@/lib/live-copy";
import { onboardingWanted, setupIsTheDoor, vaultPresenceOf } from "@/lib/onboarding";
import { ONBOARDING_DONE_KEY, forgetOnboarding, setOnboardingClosed } from "@/lib/onboarding-memory";
import { pensionKeyOf } from "@/lib/pension-key";
import { privyFailure } from "@/lib/privy-failure";
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

/** What stands at the right of the header, for each state the frame can be in. */
function accountSlot(
  state: DashboardState,
  pensionKey: string | null,
  actions: { readonly onConnect: () => void; readonly onDisconnect: () => void; readonly openSetup: () => void; readonly onResume: () => void },
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
    case "connect-onboarding":
      // The visitor's own Connect, word for word: the key is connected already,
      // so it reopens the setup where it was left instead of asking Privy. The
      // setup hands focus back here when it closes (OnboardingDialog).
      return (
        <Button size="sm" onClick={actions.onResume} data-onboarding-resume="">
          {LIVE_COPY.connect}
        </Button>
      );
  }
}

/**
 * The history entries the setup makes carry this tag, so Back and Forward move
 * the close with them: Back from the sample returns to the setup, Forward to the
 * sample. Entries it did not make carry nothing and change nothing.
 */
const SETUP_ENTRY = "saverfiSetup";
type SetupEntry = "open" | "closed";

const setupEntryOf = (state: unknown): SetupEntry | null => {
  const value = typeof state === "object" && state !== null ? (state as Record<string, unknown>)[SETUP_ENTRY] : null;
  return value === "open" || value === "closed" ? value : null;
};

/**
 * The state to hand history.pushState/replaceState: the setup's tag and nothing
 * else. NEVER Next's own fields — Next's patched history methods treat a state
 * carrying __NA as its own call and skip syncing the router, so useSearchParams
 * would keep the old URL and Next would later write that old URL back. Next
 * copies its fields onto whatever is passed.
 */
const setupState = (entry: SetupEntry | null): Record<string, unknown> => (entry === null ? {} : { [SETUP_ENTRY]: entry });

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
    account: accountSlot(state, null, { onConnect: openSetup, onDisconnect: openSetup, openSetup, onResume: openSetup }),
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

  // THE NEW-USER SETUP'S INPUTS. The key counts as connected only once Privy
  // has said so; its vault comes from the shared vault screen, which reads it
  // whatever the page shows (wallets-host.tsx) — the live store reads only
  // while the page is Live, and the sample is exactly when it is not.
  const vaultScreen = useVaultScreen();
  const connectedKey = ready && user !== null && user !== undefined ? pensionKey : null;
  const vault = vaultPresenceOf(vaultScreen, connectedKey);
  const closed = useOnboardingClosed(connectedKey);

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
    onboarding: { closed, vault },
  });

  // ?mode=mock with a key connected becomes ?mode=live, once per change, so a
  // reload of a connected tab can never land on the sample or the landing —
  // unless its setup was closed, and then the sample is where it belongs.
  // The entry's own state rides along (the setup's Back/Forward tag), and a
  // traversal still committing is left alone: its pathname is not ours yet.
  useEffect(() => {
    if (state.replaceUrlWith === null) return;
    if (window.location.pathname !== pathname) return;
    window.history.replaceState(setupState(setupEntryOf(window.history.state)), "", state.replaceUrlWith);
  }, [state.replaceUrlWith, pathname]);

  const live = useLiveDashboard({ pensionKey: state.kind === "live" ? pensionKey : null, privyWallets });
  const liveStage = live.view.kind === "ready" ? live.view.data.stage : null;

  // Once the setup has been on screen for this key — or was asked for — a read
  // that fails keeps it up with its own Retry, instead of pulling it away. It
  // waits while the wallets modal is open: two dialogs never stack.
  const [engagedKey, setEngagedKey] = useState<string | null>(null);
  const engaged = connectedKey !== null && engagedKey === connectedKey;
  const walletsOpen = useWalletsModalOpen();
  const wanted = !walletsOpen && onboardingWanted({ kind: state.kind, closed, vault, liveStage, engaged });
  useEffect(() => {
    if (wanted && connectedKey !== null) setEngagedKey(connectedKey);
  }, [wanted, connectedKey]);

  // A vault that exists ends the setup, wherever it was made — its memory and
  // its latch both, so a later failed read can never bring it back. A session
  // that ends drops the latch too.
  useEffect(() => {
    if (connectedKey === null) setEngagedKey(null);
    else if (vault === "exists") {
      forgetOnboarding(connectedKey);
      setEngagedKey(null);
    }
  }, [vault, connectedKey]);

  // Whether the setup's own write is running: then nothing may close it, Back included.
  const setupRunning = useRef(false);
  const onSetupRunning = useCallback((running: boolean) => {
    setupRunning.current = running;
  }, []);

  // The two reads disagree — the vault read says none, the live read shows a
  // vault's stages — so the vault read is the older one: read it again, once.
  const vaultOutdated = vault === "missing" && liveStage !== null && liveStage !== "no_vault" && liveStage !== "vault_unreadable";
  const refreshVaultNow = vaultScreen?.refresh ?? null;
  useEffect(() => {
    if (vaultOutdated) refreshVaultNow?.();
  }, [vaultOutdated, refreshVaultNow]);

  // Back and Forward carry the close with the entries the setup made.
  useEffect(() => {
    if (connectedKey === null) return undefined;
    const onPop = (event: PopStateEvent): void => {
      const entry = setupEntryOf(event.state);
      if (entry === null) return;
      // Back while the wallet is being asked to approve: the setup stays, on an entry of its own again.
      if (entry === "closed" && setupRunning.current) {
        window.history.pushState(setupState("open"), "", urlWithMode(window.location.pathname, "live"));
        return;
      }
      setOnboardingClosed(connectedKey, entry === "closed");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [connectedKey]);

  // Another tab of this browser finished a setup: read the vault again, so a
  // tab showing the sample moves on rather than waiting for a reload.
  const refreshVault = vaultScreen?.refresh ?? null;
  useEffect(() => {
    if (refreshVault === null) return undefined;
    const onStorage = (event: StorageEvent): void => {
      if (event.key === ONBOARDING_DONE_KEY) refreshVault();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refreshVault]);

  /** The setup's X: the sample, as a visitor sees it, on an entry of its own. */
  const closeOnboarding = useCallback(() => {
    if (connectedKey === null) return;
    window.history.replaceState(setupState("open"), "", window.location.href);
    window.history.pushState(setupState("closed"), "", urlWithMode(pathname, "mock"));
    setOnboardingClosed(connectedKey, true);
  }, [connectedKey, pathname]);

  /** Connect, the Live side of the toggle, or any way into the vault while there is none: the setup, where it was left. */
  const resumeOnboarding = useCallback(() => {
    if (connectedKey === null) return;
    setEngagedKey(connectedKey);
    const url = urlWithMode(pathname, "live");
    if (urlMode === "live") window.history.replaceState(setupState("open"), "", url);
    else window.history.pushState(setupState("open"), "", url);
    setOnboardingClosed(connectedKey, false);
  }, [connectedKey, pathname, urlMode]);

  const refreshLive = live.refresh;
  const onVaultCreated = useCallback(() => refreshLive({ discover: true }), [refreshLive]);

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
    // THE FIGURE FOLLOWS THE BODY THAT IS ACTUALLY DRAWN. A read whose VAULT
    // failed still carries prices and token accounts, so "ready" alone put a
    // dollar figure in the bar on the very screen that says the pension could
    // not be read — two answers to one question, on one screen. The stage the
    // page branches on is the one this reads.
    account: accountSlot(
      state,
      pensionKey,
      { onConnect, onDisconnect, openSetup: () => openWallets?.(), onResume: resumeOnboarding },
      worthFrom(live.view),
    ),
    // On the sample of a key whose setup was closed, the toggle's Live side is
    // the same door as its Connect.
    setMode: state.account === "connect-onboarding" ? (mode) => (mode === "live" ? resumeOnboarding() : setMode(mode)) : setMode,
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

  // While this key has no vault, every way into the wallets modal opens the setup
  // instead — unless it already has trading wallets, which only that modal shows.
  const door = connectedKey !== null && privyWallets.length === 0 && setupIsTheDoor(vault, liveStage);

  return (
    <>
      <WalletsOpenerOverride opener={door ? resumeOnboarding : null}>
        <Body value={value} onEnter={() => setMode("mock")} walletsConfigured>
          {children}
        </Body>
      </WalletsOpenerOverride>
      {/* Beside the page, not inside it, so a close — or the landing — never unmounts what it remembers. */}
      {connectedKey !== null && vaultScreen !== null && vaultScreen.pensionKey === connectedKey ? (
        <OnboardingHost
          key={connectedKey}
          pensionKey={connectedKey}
          wanted={wanted}
          onClose={closeOnboarding}
          onCreated={onVaultCreated}
          onDisconnect={onDisconnect}
          onRunningChange={onSetupRunning}
        />
      ) : null}
    </>
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

        <DashboardMain
          // Reads the payload on screen, never the toggle: the two cannot disagree.
          top={<DashboardSource source={load.source} notice={load.notice} />}
          strip={<SavingsStrip trades={trades} rule={rule} now={now} />}
          cards={
            <>
              <SavingsRulePanel rule={rule} stats={stats} activity={activity} now={now} className={RULE_SLOT} />
              <PensionPanel stats={stats} curve={curve} holdings={holdings} days={days} rule={rule} now={now} className={PENSION_SLOT} />
            </>
          }
        />
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
          activityRetryAt={live.activityRetryAt}
        />
      );
    }
  }
}
