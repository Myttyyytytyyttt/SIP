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
 * /wallets — so on any half-configured deployment (which is every deployment
 * before the contracts exist) clicking "Manage wallets" NAVIGATED AWAY, the one
 * thing this component was built to prevent, and did it silently: the click
 * looked like a broken modal rather than a missing variable. Now the config
 * decides WHICH modal opens, never WHETHER one does. Without a config it is
 * WalletsSetupModal, which needs no provider and no chain and names what is
 * missing.
 *
 * PRIVY IS NOT MOUNTED UNTIL ASKED FOR. <Providers> builds PrivyProvider, which
 * mounts iframes and talks to auth.privy.io. A visit that never opens the modal
 * should pay none of that, so the provider appears on the first open and stays —
 * a second open is instant and the session survives closing.
 */

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

import Providers from "@/app/providers";
import { WalletsModal } from "@/components/wallets/WalletsModal";
import { WalletsSetupModal } from "@/components/wallets/WalletsSetupModal";
import type { ConfigProblem, PublicConfig } from "@/lib/config";

/** null only OUTSIDE a host — inside one there is always a modal to open. */
const OpenerContext = createContext<(() => void) | null>(null);

/** The opener, or null when this subtree has no host. Safe to call anywhere. */
export function useWalletsOpener(): (() => void) | null {
  return useContext(OpenerContext);
}

export function WalletsHost({
  config,
  problems,
  children,
}: {
  config: PublicConfig | null;
  /** Why there is no config. Ignored when there is one. */
  problems?: readonly ConfigProblem[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const opener = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

  return (
    <OpenerContext.Provider value={opener}>
      {config !== null ? (
        // THE PROVIDER NOW WRAPS THE TREE, and no longer sits beside it.
        //
        // It used to mount lazily, next to `children`, so a visitor who never
        // opened the wallets modal never paid for Privy. That was right while
        // nothing above the modal needed to know who was connected. It stopped
        // being right when the page itself became the answer to "whose pension
        // is this": the shell reads the pension key to decide between the
        // landing and the dashboard, and a hook cannot reach a provider that is
        // its sibling.
        //
        // The MODAL is still lazy, which is where the weight actually was.
        <Providers config={config}>
          {children}
          {mounted ? <WalletsModal config={config} open={open} onOpenChange={setOpen} /> : null}
        </Providers>
      ) : (
        <>
          {children}
          {mounted ? <WalletsSetupModal problems={problems ?? []} open={open} onOpenChange={setOpen} /> : null}
        </>
      )}
    </OpenerContext.Provider>
  );
}
