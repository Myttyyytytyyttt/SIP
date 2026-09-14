"use client";

/**
 * THE SAME MODAL, WHEN THERE IS NOTHING TO MANAGE YET.
 *
 * "Manage wallets" must open a modal — never navigate — and that promise cannot
 * depend on the environment being complete. But the real modal mounts Privy, so
 * with a half-set environment there is no honest screen to put inside it. This is
 * the other half: the same overlay, carrying the setup
 * checklist the /wallets route renders server-side.
 *
 * It mounts NO provider and reads NO chain, so it works with a completely empty
 * environment — which is exactly the state it exists to explain.
 */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SetupChecklist } from "@/components/wallets/SetupChecklist";
import type { ConfigProblem } from "@/lib/config";

export function WalletsSetupModal({
  problems,
  open,
  onOpenChange,
}: {
  problems: readonly ConfigProblem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Narrower than the real one: this is prose, not a table of wallets. Same full-screen-below-sm shape so the two do not feel like different products. */}
      <DialogContent className="grid h-dvh max-h-dvh w-dvw max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[85vh] sm:w-full sm:max-w-xl sm:rounded-xl">
        <DialogHeader className="border-b p-4 pr-12 text-left">
          <DialogTitle>Wallets are not configured yet</DialogTitle>
          <DialogDescription>
            This deployment is missing what the wallets screen needs to read the chain. Set these in the
            package&apos;s environment, restart the server, and reload.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto p-4">
          <SetupChecklist problems={problems} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
