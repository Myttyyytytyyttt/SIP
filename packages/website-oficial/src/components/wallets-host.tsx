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

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import Providers from "@/app/providers";
import { WalletsModal } from "@/components/wallets/WalletsModal";
import { WalletsSetupModal } from "@/components/wallets/WalletsSetupModal";
import type { ConfigProblem, SolanaPublicConfig } from "@/lib/config";

/** null only OUTSIDE a host — inside one there is always a modal to open. */
const OpenerContext = createContext<(() => void) | null>(null);

type Unsubscribe = () => void;
const ClosedContext = createContext<((listener: () => void) => Unsubscribe) | null>(null);

/** The opener, or null when this subtree has no host. Safe to call anywhere. */
export function useWalletsOpener(): (() => void) | null {
  return useContext(OpenerContext);
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
      <ClosedContext.Provider value={subscribe}>
      {config !== null ? (
        // THE PROVIDER WRAPS THE TREE, and does not sit beside it: the shell
        // reads the pension key to decide between the landing and the dashboard,
        // and a hook cannot reach a provider that is its sibling. The MODAL is
        // still lazy, mounted on the first open and kept, so a second open is
        // instant.
        <Providers config={config}>
          {children}
          {mounted ? <WalletsModal open={open} onOpenChange={onOpenChange} /> : null}
        </Providers>
      ) : (
        <>
          {children}
          {mounted ? <WalletsSetupModal problems={problems ?? []} open={open} onOpenChange={onOpenChange} /> : null}
        </>
      )}
      </ClosedContext.Provider>
    </OpenerContext.Provider>
  );
}
