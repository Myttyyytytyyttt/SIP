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
 * PRIVY IS NOT MOUNTED UNTIL ASKED FOR. <Providers> builds PrivyProvider, which
 * mounts iframes and talks to auth.privy.io. A visit that never opens the modal
 * should pay none of that, so the provider appears on the first open and stays —
 * a second open is instant and the session survives closing.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import Providers from "@/app/providers";
import { WalletsModal } from "@/components/wallets/WalletsModal";
import type { PublicConfig } from "@/lib/config";

/** null when the server could not assemble a config: the trigger stays a link to /wallets. */
const OpenerContext = createContext<(() => void) | null>(null);

/** The opener, or null when wallets cannot be managed here. Safe outside the host. */
export function useWalletsOpener(): (() => void) | null {
  return useContext(OpenerContext);
}

export function WalletsHost({ config, children }: { config: PublicConfig | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const opener = useCallback(() => {
    setMounted(true);
    setOpen(true);
  }, []);

  const value = useMemo(() => (config === null ? null : opener), [config, opener]);

  return (
    <OpenerContext.Provider value={value}>
      {children}
      {config !== null && mounted ? (
        <Providers config={config}>
          <WalletsModal config={config} open={open} onOpenChange={setOpen} />
        </Providers>
      ) : null}
    </OpenerContext.Provider>
  );
}
