"use client";

/**
 * THE NEW-USER SETUP'S SHELL: WalletsModal's Privy-safe dialog, narrower.
 *
 * PRIVY'S DIALOGS CAN OPEN ON TOP (the wallet's approval can be one), so this
 * composes the same parts WalletsModal does, for the same reasons: an UNTRAPPED
 * focus scope around the content, and no dismissal while Privy's dialog is open
 * or a re-seat runs (closeHeldBack, guardedOpenChange). See WalletsModal.tsx.
 *
 * CLOSING IS A CHOICE THAT CHANGES THE PAGE: it puts the sample on screen
 * (src/lib/dashboard-mode.ts, rule 4a). So only the X and Escape close it —
 * never a stray click on the dimmed page — and NOTHING closes it while the
 * person's wallet is being asked to approve (`holdClose`): the page would swap to
 * example numbers under a real rent payment, and the answer would land nowhere.
 *
 * FOCUS goes to the step's primary button, marked data-onboarding-primary, and
 * never to the first tabbable thing: on the first screen that would be
 * Disconnect, and Enter would sign the person out. Closed, it returns to the
 * header's Connect that reopens it (data-onboarding-resume).
 *
 * Full screen below sm, the shape of WalletsModal; from sm up a sheet of at most
 * 85vh whose body scrolls between a fixed header and a fixed footer.
 */

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { FocusScope } from "radix-ui/internal";
import { useSyncExternalStore, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { closeHeldBack, guardedOpenChange } from "@/components/wallets/WalletsModal";
import { ONBOARDING_COPY } from "@/lib/live-copy";
import { reseatRunning, subscribeSeatActivity } from "@/lib/seat-activity";
import { cn } from "@/lib/utils";

/** Marks the button that takes focus when a step appears. */
export const PRIMARY_ATTRIBUTE = "data-onboarding-primary";

/** The button that takes focus inside `root`; the dialog itself when that button is disabled or absent. */
export function focusPrimary(root: HTMLElement | null | undefined): void {
  const target = root?.querySelector<HTMLButtonElement>(`[${PRIMARY_ATTRIBUTE}]`);
  if (target !== null && target !== undefined && !target.disabled) target.focus();
  else root?.focus();
}

/** components/ui/dialog.tsx's DialogContent classes, then the full-screen-below-sm shape. */
const CONTENT = cn(
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
  "h-dvh max-h-dvh w-dvw max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[88vh] sm:w-full sm:max-w-xl sm:rounded-xl",
);

export interface OnboardingHeading {
  /** "Step 1 of 2", or null on the last screen. Read as part of the title. */
  readonly eyebrow: string | null;
  readonly title: string;
  readonly description: string;
}

export function OnboardingDialog({
  open,
  onOpenChange,
  holdClose,
  heading,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The person's wallet is being asked: nothing closes the setup until it answers. */
  readonly holdClose: boolean;
  readonly heading: OnboardingHeading;
  readonly children: ReactNode;
}) {
  const reseating = useSyncExternalStore(subscribeSeatActivity, reseatRunning, reseatRunning);
  const held = holdClose || reseating;
  const guarded = guardedOpenChange(onOpenChange);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && holdClose) return;
        guarded(next);
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <FocusScope.Root trapped={false}>
          <DialogPrimitive.Content
            data-slot="dialog-content"
            data-onboarding="open"
            className={CONTENT}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              focusPrimary(event.currentTarget as HTMLElement | null);
            }}
            // Closed, focus goes to the Connect that reopens it (it did not open from a button), or the page.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              window.requestAnimationFrame(() => {
                const target = document.querySelector<HTMLElement>("[data-onboarding-resume]") ?? document.querySelector<HTMLElement>("main");
                target?.focus({ preventScroll: true });
              });
            }}
            // A click on the dimmed page never closes it: closing swaps the page to the sample.
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              if (holdClose || closeHeldBack()) event.preventDefault();
            }}
          >
            {/* pr-12 keeps the title clear of the close button, which sits absolute in the corner. */}
            <DialogHeader className="border-b p-4 pr-12 text-left sm:px-6 sm:pt-5">
              <DialogTitle className="text-lg leading-snug">
                {heading.eyebrow !== null ? <span className="mb-1 block text-xs font-medium tracking-wide text-muted-foreground uppercase">{heading.eyebrow}</span> : null}
                {heading.title}
              </DialogTitle>
              <DialogDescription>{heading.description}</DialogDescription>
            </DialogHeader>

            {children}

            <DialogPrimitive.Close data-slot="dialog-close" asChild>
              <Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" disabled={held}>
                <XIcon aria-hidden />
                <span className="sr-only">{held ? ONBOARDING_COPY.closeHeld : ONBOARDING_COPY.close}</span>
              </Button>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </FocusScope.Root>
      </DialogPortal>
    </Dialog>
  );
}
