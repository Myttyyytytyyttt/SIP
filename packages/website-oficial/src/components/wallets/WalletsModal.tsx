"use client";

/**
 * "MANAGE WALLETS", OVER THE DASHBOARD: the WalletsScreen the /wallets route
 * renders, inside a Dialog, so the two containers never fork.
 *
 * PRIVY'S DIALOGS OPEN ON TOP OF THIS ONE — the login, and the key export — and a
 * stock Radix modal fights them twice over. It traps focus, so nothing inside
 * Privy's dialog can keep it; and it reads a pointer-down inside Privy's dialog as
 * a click outside itself, and closes mid-flow. Privy's troubleshooting page
 * ("Multiple dialogs", Radix UI dialogs) prescribes the two changes made here: an
 * UNTRAPPED FocusScope around the content, and no dismissal while Privy's own
 * dialog is open. The stock DialogContent in components/ui renders its own portal
 * and cannot take the wrapper, and ui/* is generated code, so this composes the
 * same parts with the same classes.
 *
 * WHY THE WRAPPER WORKS. Radix keeps one stack of focus scopes and only the top
 * one traps. React runs a parent's effects after its children's, so the outer
 * scope registers after the content's own and sits on top of it, untrapped, for
 * as long as the dialog is open. Both mount inside the portal, only when it opens.
 *
 * Full screen below sm, the shape WalletsSetupModal has, so the two read as one
 * product; from sm up a sheet of at most 85vh whose body scrolls under the header.
 */

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { FocusScope } from "radix-ui/internal";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { WalletsScreen } from "@/components/wallets/WalletsScreen";
import { cn } from "@/lib/utils";

/** Whether one of Privy's flows is on screen: its modal is a headless-ui dialog with this id, present only while open. */
function privyDialogOpen(): boolean {
  return typeof document !== "undefined" && document.getElementById("privy-dialog") !== null;
}

/** components/ui/dialog.tsx's DialogContent classes, then the full-screen-below-sm shape. */
const CONTENT = cn(
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
  "h-dvh max-h-dvh w-dvw max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[85vh] sm:w-full sm:max-w-2xl sm:rounded-xl",
);

export function WalletsModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <FocusScope.Root trapped={false}>
          <DialogPrimitive.Content
            data-slot="dialog-content"
            className={CONTENT}
            // A pointer-down or an Escape meant for Privy's dialog must not close this one underneath it.
            onPointerDownOutside={(event) => {
              if (privyDialogOpen()) event.preventDefault();
            }}
            onEscapeKeyDown={(event) => {
              if (privyDialogOpen()) event.preventDefault();
            }}
          >
            {/* pr-12 keeps the title clear of the close button, which sits absolute in the corner. */}
            <DialogHeader className="border-b p-4 pr-12 text-left">
              <DialogTitle>Wallets</DialogTitle>
              <DialogDescription>Your pension key, and the trading wallets that put a slice of every trade aside.</DialogDescription>
            </DialogHeader>

            <div className="min-h-0 overflow-y-auto p-4">
              <WalletsScreen />
            </div>

            <DialogPrimitive.Close data-slot="dialog-close" asChild>
              <Button variant="ghost" className="absolute top-2 right-2" size="icon-sm">
                <XIcon aria-hidden />
                <span className="sr-only">Close</span>
              </Button>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </FocusScope.Root>
      </DialogPortal>
    </Dialog>
  );
}
