"use client";

/**
 * ONE OWNER FOR THE WALLETS MODAL, for the whole dashboard.
 *
 * Two places open it — the sidebar's "Manage wallets" on desktop, and the same
 * row inside the header's Sheet on mobile — and both must drive the SAME modal.
 * An earlier shape gave each its own, which meant two <Providers> could mount on
 * a resize and Privy said so out loud: "Multiple PrivyProvider instances found".
 *
 * So the state lives here, above both, and travels by context. The dashboard
 * stays a server component; only this wrapper and its children cross into the
 * client, and `children` is still server-rendered because it is passed in.
 *
 * IT ALWAYS OPENS. An earlier shape handed back a null opener when the server
 * could not assemble a config, and the trigger fell back to a plain link to
 * /wallets — so on any half-configured deployment clicking "Manage wallets"
 * NAVIGATED AWAY, the one thing this component was built to prevent, and did it
 * silently: the click looked like a broken modal rather than a missing variable.
 * Now the config decides WHICH modal opens, never WHETHER one does. Without a
 * config it is WalletsSetupModal, which needs no provider and names what is
 * missing.
 *
 * With a config the modal is WalletsModal: the same WalletsScreen as /wallets.
 *
 * THE OPENER CAN NAME A SECTION (10-06): the modal's tabs, and a caller that
 * knows what the person came for — "Link a wallet" — opens on that tab instead
 * of the overview. The argument is optional, so every `() => void` caller and
 * override still fits.
 *
 * WHAT WAS JUST SIGNED IS KEPT HERE TOO (10-09, plan B4): the last write that
 * landed anywhere on the page — the modal, the rule card's gear, the first-buy
 * card, the setup — so the live page can say "updating your pension" until it
 * shows it (components/live/last-write-context.ts). Here, above both, because
 * the vault is created inside the modal, which the live page cannot see into.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { usePrivy } from "@privy-io/react-auth";
import Providers from "@/app/providers";
import { LastWriteHost } from "@/components/live/last-write-context";
import { VaultScreen } from "@/components/wallets/VaultScreen";
import { pensionKeyOf } from "@/lib/pension-key";
import { WalletsModal } from "@/components/wallets/WalletsModal";
import { WalletsSetupModal } from "@/components/wallets/WalletsSetupModal";
import type { ConfigProblem, SolanaPublicConfig } from "@/lib/config";
import { DEFAULT_WALLETS_SECTION, isWalletsSection, type WalletsSection } from "@/lib/wallets-sections";

/** Opens the wallets modal, on `section` when one is named and on the overview otherwise. */
type WalletsOpener = (section?: WalletsSection) => void;

/** null only OUTSIDE a host — inside one there is always a modal to open. */
const OpenerContext = createContext<WalletsOpener | null>(null);

/** Whether the wallets modal is on screen. The new-user setup waits while it is: two dialogs never stack. */
const WalletsOpenContext = createContext(false);

export function useWalletsModalOpen(): boolean {
  return useContext(WalletsOpenContext);
}

type Unsubscribe = () => void;
const ClosedContext = createContext<((listener: () => void) => Unsubscribe) | null>(null);

/** Hands the host the page's own Disconnect, or null to take it back. */
const DisconnectRegistry = createContext<((handler: (() => void) | null) => void) | null>(null);

/**
 * THE MODAL'S DISCONNECT IS THE PAGE'S (owner, 10-08: "the modal's Disconnect
 * also goes to the landing"). The modal is drawn by this host, beside the page
 * rather than inside it, so it cannot be handed the page's Disconnect the way
 * an override hands a subtree its opener: the page registers it here instead.
 * The dashboard frame registers the one that lands a visitor on the front door
 * (dashboard-shell.tsx, onDisconnect); with none registered, the modal's
 * Disconnect is WalletsScreen's own bare logout, as on /wallets.
 */
export function useWalletsDisconnect(handler: () => void): void {
  const register = useContext(DisconnectRegistry);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (register === null) return undefined;
    register(() => latest.current());
    return () => register(null);
  }, [register]);
}

/** The opener, or null when this subtree has no host. Safe to call anywhere. */
export function useWalletsOpener(): WalletsOpener | null {
  return useContext(OpenerContext);
}

/**
 * Hands this subtree a different opener, or the host's own when `opener` is
 * null. The dashboard uses it while a connected key has no vault: every way into
 * the wallets modal then opens the new-user setup instead, so there is one way
 * to make a vault on the page, not two different forms for the same thing. An
 * override that takes no section (resumeOnboarding) fits, and ignores it.
 */
export function WalletsOpenerOverride({ opener, children }: { readonly opener: WalletsOpener | null; readonly children: ReactNode }) {
  const inherited = useContext(OpenerContext);
  return <OpenerContext.Provider value={opener ?? inherited}>{children}</OpenerContext.Provider>;
}

/**
 * Runs `onClosed` each time the wallets modal closes.
 *
 * WHY THE DASHBOARD CARES: every write that changes the chain happens inside
 * that modal — the vault created, a wallet linked, investing signed, SOL taken
 * out. Waiting out a poll afterwards would show the person the old numbers for
 * up to a minute and read as "it did not work", so the dashboard reads again as
 * soon as the modal is out of the way (still behind the 10 s floor).
 */
export function useWalletsClosed(onClosed: () => void): void {
  const subscribe = useContext(ClosedContext);
  const latest = useRef(onClosed);
  latest.current = onClosed;
  useEffect(() => {
    if (subscribe === null) return undefined;
    return subscribe(() => latest.current());
  }, [subscribe]);
}

export function WalletsHost({
  config,
  problems,
  children,
}: {
  config: SolanaPublicConfig | null;
  /** Why there is no config. Ignored when there is one. */
  problems?: readonly ConfigProblem[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [section, setSection] = useState<WalletsSection>(DEFAULT_WALLETS_SECTION);
  const listeners = useRef(new Set<() => void>());

  /*
   * THE ARGUMENT IS CHECKED, NOT TRUSTED. The sidebar's Manage wallets and the
   * landing's Connect hand this opener straight to onClick, so what arrives first
   * is often a click event, whatever the type says: anything that is not a
   * section id opens the overview. Radix unmounts the closed dialog's content, so
   * each open starts on the section asked for, not on the tab last left.
   */
  const opener = useCallback((requested?: unknown) => {
    setSection(isWalletsSection(requested) ? requested : DEFAULT_WALLETS_SECTION);
    setMounted(true);
    setOpen(true);
  }, []);

  // The page's Disconnect, when it registered one: the modal closes, then the page disconnects.
  const [pageDisconnect, setPageDisconnect] = useState<(() => void) | null>(null);
  const registerDisconnect = useCallback((handler: (() => void) | null) => setPageDisconnect(() => handler), []);

  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  /** Closing is the interesting edge: something on chain may just have changed. */
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) for (const listener of listeners.current) listener();
  }, []);

  // Closed first: a logout re-mounts everything under the vault screen, the modal
  // included, and an open modal would come back showing its Connect card over the landing.
  const modalDisconnect = useMemo(
    () =>
      pageDisconnect === null
        ? undefined
        : () => {
            onOpenChange(false);
            pageDisconnect();
          },
    [pageDisconnect, onOpenChange],
  );

  return (
    <OpenerContext.Provider value={opener}>
      <WalletsOpenContext.Provider value={open}>
      <ClosedContext.Provider value={subscribe}>
      <DisconnectRegistry.Provider value={registerDisconnect}>
      <LastWriteHost>
      {config !== null ? (
        // THE PROVIDER WRAPS THE TREE, and does not sit beside it: the shell
        // reads the pension key to decide between the landing and the dashboard,
        // and a hook cannot reach a provider that is its sibling. The MODAL is
        // still lazy, mounted on the first open and kept, so a second open is
        // instant.
        <Providers config={config}>
          <SharedVaultScreen>
            {children}
            {mounted ? <WalletsModal open={open} onOpenChange={onOpenChange} section={section} onDisconnect={modalDisconnect} /> : null}
          </SharedVaultScreen>
        </Providers>
      ) : (
        <>
          {children}
          {mounted ? <WalletsSetupModal problems={problems ?? []} open={open} onOpenChange={onOpenChange} /> : null}
        </>
      )}
      </LastWriteHost>
      </DisconnectRegistry.Provider>
      </ClosedContext.Provider>
      </WalletsOpenContext.Provider>
    </OpenerContext.Provider>
  );
}

/**
 * THE VAULT SCREEN THE WHOLE PAGE SHARES: the dashboard's rule card and the
 * wallets modal write through the same lock, so one signature at a time runs
 * on the page wherever it was started. Mounted only for someone connected with
 * a pension key — the one read it makes is of that key's vault — and it sits
 * inside Providers because it reads Privy. The modal's own VaultScreen finds it
 * and adds nothing.
 *
 * IT DOES NOT POLL. The dashboard's live store reads and hears the chain
 * already; the shell tells this screen when the vault moved and when the
 * modal opens (useVaultFollowsLive), so one clock reads the vault, not two.
 */
function SharedVaultScreen({ children }: { readonly children: ReactNode }) {
  const { ready, authenticated, user } = usePrivy();
  const pensionKey = useMemo(() => (user === null ? null : pensionKeyOf(user)), [user]);
  if (!ready || !authenticated || pensionKey === null) return <>{children}</>;
  return (
    <VaultScreen pensionKey={pensionKey} poll={false}>
      {children}
    </VaultScreen>
  );
}
