"use client";

/**
 * Wallet management over the dashboard, instead of away from it.
 *
 * WHY A MODAL AND NOT THE SIDEBAR. What this surface has to show per wallet —
 * address, origin, seat, link status, rate control, actions, and the skim
 * table under all of it — is a table's worth of width. The sidebar is 320px,
 * and swapping it would cost the activity feed for as long as the user is
 * configuring, which is the one thing they watch. A modal keeps the dashboard
 * behind it, which is what "do not send me to another page" actually means.
 *
 * ONE OVERLAY, THREE VIEWS. ImportWalletDialog and LinkWalletDialog are
 * Dialogs of their own on /wallets. Nested inside this one they would stack
 * two overlays, two focus traps and an Escape that closes the wrong one — so
 * here they are VIEWS: this shell owns `view`, hands the flows a way to change
 * it, and renders a back control in its header. Escape still closes the whole
 * modal, at any depth.
 *
 * IT CARRIES ITS OWN PRIVY. The dashboard is a server component with no
 * <Providers> around it. The provider is mounted by WalletsHost, which owns the
 * open state for both entry points and mounts it lazily on the first open; two
 * providers at once is an error Privy reports as "Multiple PrivyProvider
 * instances found". If a caller renders this modal, it must supply <Providers>
 * ever wraps the dashboard itself, drop the wrapper below rather than nesting
 * two PrivyProviders.
 *
 * /wallets stays a route: it is a deep link and it is where the server-rendered
 * setup checklist lives. It renders the same WalletsScreen, so nothing forks.
 */

import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WalletsScreen, type WalletsView, type WalletsViewApi } from "@/components/wallets/WalletsScreen";
import type { PublicConfig } from "@/lib/config";

/** Stable identity, so the reset effect and `back()` never make a new object. */
const LIST: WalletsView = { kind: "list" };

/** The header says which view is on screen — a modal whose title never moves reads as one page that changed under you. */
const HEADING: Record<WalletsView["kind"], { readonly title: string; readonly description: string }> = {
  list: {
    title: "Wallets",
    description:
      "Your pension key, the pension it owns, and the trading wallets that put a slice of every buy and sell aside.",
  },
  import: {
    title: "Import a trading wallet",
    description: "Bring in a wallet you already trade with. Its key goes straight into Privy's enclave — it never reaches our server.",
  },
  link: {
    title: "Link a trading wallet",
    description: "Two signatures bind this wallet to your pension. It can only add; only the pension key can withdraw.",
  },
};

export function WalletsModal({
  config,
  open,
  onOpenChange,
}: {
  config: PublicConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [view, setView] = useState<WalletsView>(LIST);
  // Raised by a flow mid-signature: the close and back controls go, exactly as
  // they do in the flows' own Dialogs on /wallets.
  const [busy, setBusy] = useState(false);

  // Reopening lands on the list. A modal that comes back mid-flow — half an
  // import, a link waiting on a signature nobody asked for — is a trap.
  useEffect(() => {
    if (open) {
      setView(LIST);
      setBusy(false);
    }
  }, [open]);

  const api = useMemo<WalletsViewApi>(
    () => ({ view, show: (next) => setView(next), back: () => setView(LIST), setBusy }),
    [view],
  );

  const heading = HEADING[view.kind];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Wide, because the work is wide: rows of address + status + rate + actions.
        Below sm it is the whole viewport — a 3xl dialog letterboxed on a phone is
        unusable — and from sm up it is a sheet of at most 85vh whose BODY scrolls,
        so the header and its back control never leave the screen.
      */}
      <DialogContent
        showCloseButton={!busy}
        className="grid h-dvh max-h-dvh w-dvw max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[85vh] sm:w-full sm:max-w-3xl sm:rounded-xl"
      >
        {/* pr-12 keeps the title clear of the close button, which sits absolute in the corner. */}
        <DialogHeader className="border-b p-4 pr-12 text-left">
          <div className="flex items-center gap-2">
            {view.kind === "list" || busy ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Back to wallets"
                onClick={() => setView(LIST)}
              >
                <ArrowLeft aria-hidden />
              </Button>
            )}
            <DialogTitle>{heading.title}</DialogTitle>
          </div>
          <DialogDescription>{heading.description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto p-4">
          <WalletsScreen config={config} view={api} variant="modal" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
