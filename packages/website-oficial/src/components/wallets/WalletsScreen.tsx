"use client";

/**
 * THE WALLETS SCREEN, one component in two containers: the /wallets route and the
 * dashboard's "Manage wallets" modal. Both mount it inside <Providers>.
 *
 * HYDRATION. Nothing that depends on Privy renders before `ready`: the server
 * paints the skeleton and so does the first client frame. If Privy never becomes
 * ready (auth.privy.io blocked, or an origin the Privy app does not allow), the
 * skeleton says so after a while instead of pulsing forever.
 *
 * THE PENSION KEY is the external Solana wallet the user signed in with
 * (src/lib/pension-key.ts). It owns the pension and is the only key that can
 * withdraw, so this screen shows it and never offers to export it: it lives in the
 * user's own wallet app. A session without one gets a way out rather than a dead
 * end, and the way out is Disconnect, because Privy ignores login() for a user who
 * is already signed in.
 *
 * TABS ON THE LEFT, AN OVERVIEW FIRST (owner, 10-06). The full screen is a rail
 * of five sections: the overview (the pension key, Disconnect, and where each
 * area stands), the vault (create it, or what it holds), the trading wallets,
 * each with its link to the vault, investing (the policy, or the form that signs
 * it) and taking money out. One read of the chain feeds them all, and one write
 * at a time runs on the whole screen (VaultScreen). Every confirmation is an
 * inline panel, never a nested dialog, so the Manage wallets modal's untrapped
 * focus scope keeps working with Privy's dialogs on top.
 *
 * EVERY PANEL STAYS MOUNTED. A card keeps its write's progress in its own state
 * (useVaultWrite): the ladder, "Not confirmed yet" with its Check again, and the
 * guard that stops a sent-but-unconfirmed withdrawal from being offered twice.
 * Radix unmounts an inactive tab's content unless told otherwise, and a tab
 * switch mid-signature would then lose all of that, so every panel is
 * force-mounted and only hidden.
 */

import { useLogin, usePrivy } from "@privy-io/react-auth";
import { ArrowUpFromLine, ChartLine, LayoutDashboard, LogOut, RefreshCw, Vault, Wallet, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InvestingCard } from "@/components/wallets/InvestingCard";
import { TradingWalletsCard } from "@/components/wallets/TradingWalletsCard";
import { VaultCard } from "@/components/wallets/VaultCard";
import { VaultScreen } from "@/components/wallets/VaultScreen";
import { WalletsTabsSkeleton } from "@/components/wallets/WalletsTabsSkeleton";
import { WalletsOverview, useWalletsAttention } from "@/components/wallets/WalletsOverview";
import { WalletsSectionContext } from "@/components/wallets/wallets-section-context";
import { WithdrawCard } from "@/components/wallets/WithdrawCard";
import { pensionKeyOf } from "@/lib/pension-key";
import { PRIVY_PATIENCE_MS } from "@/lib/privy-patience";
import { privyFailure } from "@/lib/privy-failure";
import { cn } from "@/lib/utils";
import { WALLETS_COPY } from "@/lib/vault-copy";
import { DEFAULT_WALLETS_SECTION, WALLETS_SECTIONS, isWalletsSection, type WalletsSection } from "@/lib/wallets-sections";

/**
 * How long Privy may take to become ready before the skeleton stops pretending
 * it is about to. It moved to src/lib/privy-patience.ts, where the dashboard
 * waits on the same number; re-exported so this screen's old import still works.
 */
export { PRIVY_PATIENCE_MS } from "@/lib/privy-patience";

/**
 * Where the screen sits. In the modal it fills a fixed-height dialog body, and
 * each panel scrolls on its own while the rail stays still; on /wallets the page
 * scrolls and the rail stays in view under the header.
 */
type WalletsFrame = "modal" | "page";

export function WalletsScreen({
  initialSection = DEFAULT_WALLETS_SECTION,
  frame = "page",
  onDisconnect,
}: {
  /** The tab it opens on. Read once, on mount: the modal mounts afresh on every open. */
  readonly initialSection?: WalletsSection;
  readonly frame?: WalletsFrame;
  /** What Disconnect does: the page's own when it has one (the modal over the dashboard); Privy's logout otherwise. */
  readonly onDisconnect?: () => void;
}) {
  const { ready, authenticated, user, logout } = usePrivy();
  // Derived, never stored: the app keeps no copy of who you are.
  const pensionKey = useMemo(() => (user === null ? null : pensionKeyOf(user)), [user]);

  // The states before the tabs have no rail. In the modal they still need the scrolling, padded body the
  // dialog's own body used to give everything; on the page, the page scrolls.
  const gate = (node: ReactNode): ReactNode => (frame === "modal" ? <div className="min-h-0 overflow-y-auto p-4">{node}</div> : node);

  if (!ready) return gate(<ScreenSkeleton frame={frame} />);
  if (!authenticated) return gate(<ConnectCard />);
  // Privy can report the session a frame before the user object arrives.
  if (user === null) return gate(<ScreenSkeleton frame={frame} />);

  // Called with nothing, whatever the button hands its onClick.
  const disconnect = onDisconnect === undefined ? () => void logout() : () => onDisconnect();
  if (pensionKey === null) return gate(<KeylessCard onDisconnect={disconnect} />);

  return (
    <VaultScreen pensionKey={pensionKey}>
      <WalletsTabs pensionKey={pensionKey} onDisconnect={disconnect} initialSection={initialSection} frame={frame} />
    </VaultScreen>
  );
}

/** Each section's mark in the rail, beside its name. */
const SECTION_ICONS: Readonly<Record<WalletsSection, LucideIcon>> = {
  overview: LayoutDashboard,
  vault: Vault,
  trading: Wallet,
  investing: ChartLine,
  withdraw: ArrowUpFromLine,
};

/** /wallets' sticky header (h-14): a screen whose top has gone under it has been scrolled past. */
const PAGE_HEADER_PX = 56;

/** Tailwind's md, the breakpoint where the header's nav appears too: a rail from here up, a strip below. */
const WIDE = "(min-width: 48rem)";
const subscribeWide = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/**
 * Whether the screen is wide enough for the rail. ORIENTATION IS A ROOT PROP, NOT
 * CSS: it decides which arrow keys move between tabs and which side the active
 * line sits on, so a strip styled by breakpoint alone would answer Up and Down.
 * False on the server; the tabs never render there anyway (Privy is not ready).
 */
function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
}

/**
 * The tabs, inside VaultScreen so the overview and the rail's dots read the same
 * single read the cards do. The state lives here, inside the dialog's content, so
 * the modal opens on the section it was asked for every time: Radix unmounts a
 * closed dialog's content.
 */
function WalletsTabs({
  pensionKey,
  onDisconnect,
  initialSection,
  frame,
}: {
  readonly pensionKey: string;
  readonly onDisconnect: () => void;
  readonly initialSection: WalletsSection;
  readonly frame: WalletsFrame;
}) {
  const [section, setSection] = useState<WalletsSection>(initialSection);
  const wide = useWide();
  const attention = useWalletsAttention();
  const modal = frame === "modal";

  /*
   * A SWITCH FROM INSIDE A PANEL MOVES FOCUS TO THE RAIL. The button pressed
   * ("Create your vault", an overview row) sits in the panel that is about to be
   * hidden, and a hidden element drops focus to the page itself, so a keyboard
   * user would start again from the top. The new active tab takes it instead,
   * and Tab from there goes into its panel. A tab clicked in the rail already
   * holds focus, so this runs only for switches made through goTo.
   *
   * ON THE PAGE A NEW PANEL STARTS AT ITS TOP. The rail stays in view while the
   * page scrolls, so a tab can be picked from far down a long panel, and the next
   * one would then show from wherever the page was left, or past its end. In the
   * modal every panel scrolls on its own and keeps its place.
   */
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const focusTab = useRef(false);
  const shown = useRef(section);
  const goTo = useCallback((next: WalletsSection) => {
    focusTab.current = true;
    setSection(next);
  }, []);
  useEffect(() => {
    // Nothing on mount: the page's own scroll, and the dialog's own first focus, are left alone.
    if (shown.current === section) return;
    shown.current = section;
    if (focusTab.current) list.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.focus();
    focusTab.current = false;
    const top = root.current?.getBoundingClientRect().top;
    if (!modal && top !== undefined && top < PAGE_HEADER_PX) root.current?.scrollIntoView({ block: "start" });
  }, [section, modal]);

  // ONE OF EACH. The overview summarises and switches tabs; it never mounts a card of its own, so every
  // write card, row and form id exists exactly once on the screen.
  const panels: Readonly<Record<WalletsSection, ReactNode>> = {
    overview: <WalletsOverview pensionKey={pensionKey} onDisconnect={onDisconnect} onSelect={goTo} />,
    vault: <VaultCard />,
    trading: <TradingWalletsCard />,
    investing: <InvestingCard />,
    withdraw: <WithdrawCard />,
  };

  return (
    <WalletsSectionContext.Provider value={goTo}>
      <Tabs
        value={section}
        onValueChange={(value) => {
          if (isWalletsSection(value)) setSection(value);
        }}
        orientation={wide ? "vertical" : "horizontal"}
        ref={root}
        // scroll-mt-20 brings the panel back under the header to where the rail sits (top-20).
        // min-w-0: the strip below md is one long row; without it the tabs' width would set the screen's.
        className={cn("min-w-0 flex-col md:flex-row", modal ? "min-h-0 flex-1 gap-0" : "scroll-mt-20 gap-6")}
      >
        {/*
         * THE TAB LIST COMES FIRST IN THE DOM. Opening the dialog focuses the first
         * thing that takes focus: that is now the tab list, which hands it to the
         * active tab, rather than the overview's Disconnect, where an Enter would
         * sign the person out.
         *
         * Below md the list scrolls sideways inside this div, not on its own: the
         * active line sits 5px below the trigger, and an overflow on the list
         * would clip it. From md up the div steps out of the layout (contents) and
         * the list is the rail itself.
         */}
        <div className={cn("no-scrollbar shrink-0 overflow-x-auto border-b px-2 pb-1.5 md:contents", modal && "pt-1.5")}>
          <TabsList
            ref={list}
            variant="line"
            aria-label={WALLETS_COPY.sections}
            className={cn(
              // pr-1 lands the active line, which sits 4px outside its trigger, on the rail's border.
              "md:w-52 md:shrink-0 md:items-stretch md:justify-start md:gap-0.5 md:border-r md:p-2 md:pr-1",
              // The modal's rail runs the body's full height; the page's stays in view under the 56px header.
              modal ? "md:h-auto" : "md:sticky md:top-20 md:self-start",
            )}
          >
            {WALLETS_SECTIONS.map((id) => {
              const Icon = SECTION_ICONS[id];
              return (
                <TabsTrigger key={id} value={id} className="flex-none gap-2 px-2 md:h-9 md:justify-start md:px-2.5">
                  <Icon aria-hidden />
                  <span>{WALLETS_COPY.tabs[id]}</span>
                  {attention.has(id) ? (
                    <>
                      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500 md:ml-auto" />
                      {/* The comma keeps the tab's name two phrases, "Vault, needs your attention". */}
                      <span className="sr-only">, {WALLETS_COPY.needsAttention}</span>
                    </>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        {WALLETS_SECTIONS.map((id) => (
          <TabsContent
            key={id}
            value={id}
            // Mounted always, hidden when inactive: with forceMount Radix no longer hides anything itself.
            forceMount
            className={cn("min-w-0 data-[state=inactive]:hidden", modal && "min-h-0 flex-1 overflow-y-auto p-4 md:p-6")}
          >
            {/* A short rise as the panel shows; an animation replays each time it leaves display:none. */}
            <div className="rise-in">{panels[id]}</div>
          </TabsContent>
        ))}
      </Tabs>
    </WalletsSectionContext.Provider>
  );
}

/** Logged out. Privy's own dialog does the connecting; this says what is being connected, and what went wrong. */
function ConnectCard() {
  const [failure, setFailure] = useState<string | null>(null);
  const { login } = useLogin({
    onError: (code) => {
      const described = privyFailure(code);
      // Closing Privy's dialog is a choice, not an error.
      setFailure(described.kind === "exited" ? null : described.message);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect your pension key</CardTitle>
        <CardDescription>
          Your pension key is a Solana wallet you already hold: Phantom, Backpack, Solflare or another. It owns the
          pension and is the only key that can withdraw — the team has no access to your funds. Trading wallets are
          created or imported here once it is connected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* An explicit call: Privy's login() reads a click event passed straight through as options. */}
        <Button
          type="button"
          onClick={() => {
            setFailure(null);
            login();
          }}
        >
          Connect pension key
        </Button>
        {failure !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A session with no external Solana wallet: say so, and offer the one control that helps. */
function KeylessCard({ onDisconnect }: { onDisconnect: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>This session has no pension key</CardTitle>
        <CardDescription>
          You are signed in without a Solana wallet of your own, and the pension key must be one. Disconnect, then
          connect Phantom, Backpack, Solflare or another Solana wallet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" size="sm" onClick={onDisconnect}>
          <LogOut aria-hidden />
          Disconnect
        </Button>
      </CardContent>
    </Card>
  );
}

/** The same shape on the server and in the first client frame; after PRIVY_PATIENCE_MS, the reason instead. */
function ScreenSkeleton({ frame }: { readonly frame: WalletsFrame }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), PRIVY_PATIENCE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (slow) {
    return (
      <Card role="status">
        <CardHeader>
          <CardTitle>Privy has not loaded</CardTitle>
          <CardDescription>
            Wallet sign-in comes from Privy (auth.privy.io), and it has not answered. Reload the page. If this keeps
            happening, a browser extension may be blocking auth.privy.io, or this site&apos;s address is not an allowed
            origin of the Privy app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RefreshCw aria-hidden />
            Reload
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading wallets</span>
      {/* On /wallets, the route's own skeleton's shape (loading.tsx), so the page does not jump between the two. */}
      {frame === "page" ? (
        <WalletsTabsSkeleton />
      ) : (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-44 w-full rounded-xl" />
        </div>
      )}
    </div>
  );
}
