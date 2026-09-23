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
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { usePrivy } from "@privy-io/react-auth";
import Providers from "@/app/providers";
import { VaultScreen } from "@/components/wallets/VaultScreen";
import { pensionKeyOf } from "@/lib/pension-key";
import { WalletsModal } from "@/components/wallets/WalletsModal";
import { WalletsSetupModal } from "@/components/wallets/WalletsSetupModal";
import type { ConfigProblem, SolanaPublicConfig } from "@/lib/config";

/** null only OUTSIDE a host — inside one there is always a modal to open. */
const OpenerContext = createContext<(() => void) | null>(null);

/** Whether the wallets modal is on screen. The new-user setup waits while it is: two dialogs never stack. */
const WalletsOpenContext = createContext(false);

export function useWalletsModalOpen(): boolean {
  return useContext(WalletsOpenContext);
}

type Unsubscribe = () => void;
const ClosedContext = createContext<((listener: () => void) => Unsubscribe) | null>(null);

/** The opener, or null when this subtree has no host. Safe to call anywhere. */
export function useWalletsOpener(): (() => void) | null {
  return useContext(OpenerContext);
}

/**
 * Hands this subtree a different opener, or the host's own when `opener` is
 * null. The dashboard uses it while a connected key has no vault: every way into
 * the wallets modal then opens the new-user setup instead, so there is one way
 * to make a vault on the page, not two different forms for the same thing.
 */
export function WalletsOpenerOverride({ opener, children }: { readonly opener: (() => void) | null; readonly children: ReactNode }) {
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
  const listeners = useRef(new Set<() => void>());

  const opener = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

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

  return (
    <OpenerContext.Provider value={opener}>
      <WalletsOpenContext.Provider value={open}>
      <ClosedContext.Provider value={subscribe}>
      {config !== null ? (
        // THE PROVIDER WRAPS THE TREE, and does not sit beside it: the shell
        // reads the pension key to decide between the landing and the dashboard,
        // and a hook cannot reach a provider that is its sibling. The MODAL is
        // still lazy, mounted on the first open and kept, so a second open is
        // instant.
        <Providers config={config}>
          <SharedVaultScreen>
            {children}
            {mounted ? <WalletsModal open={open} onOpenChange={onOpenChange} /> : null}
          </SharedVaultScreen>
        </Providers>
      ) : (
        <>
          {children}
          {mounted ? <WalletsSetupModal problems={problems ?? []} open={open} onOpenChange={onOpenChange} /> : null}
        </>
      )}
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
 */
function SharedVaultScreen({ children }: { readonly children: ReactNode }) {
  const { ready, authenticated, user } = usePrivy();
  const pensionKey = useMemo(() => (user === null ? null : pensionKeyOf(user)), [user]);
  if (!ready || !authenticated || pensionKey === null) return <>{children}</>;
  return <VaultScreen pensionKey={pensionKey}>{children}</VaultScreen>;
}
