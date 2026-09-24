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
/** A step led by its motion is wider: the motion and its line of points lead. */
const HERO_WIDTH = "sm:max-w-2xl";

const CONTENT = cn(
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
  "h-dvh max-h-dvh w-dvw max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none p-0 sm:h-auto sm:max-h-[88vh] sm:w-full sm:max-w-xl sm:rounded-xl",
);

export interface OnboardingHeading {
  /** "Step 1 of 2", or null on the last screen. Read as part of the title. */
  readonly eyebrow: string | null;
  readonly title: string;
  /** Read before the title by a screen reader only ("Welcome to"), so the big word can be the brand alone. */
  readonly titleLead?: string;
  readonly description: string;
  /** Short points in one running line, "·" between them, in place of the sentence. */
  readonly points?: readonly string[];
  /** A step led by its motion: a bigger title, and a wider sheet. */
  readonly hero?: boolean;
  /** The title is the brand's name, and the mark takes the place of its "S". */
  readonly brand?: boolean;
}

/**
 * THE MARK IS THE WORD'S "S". Sized in em to the font's cap height (Geist,
 * ~0.72em) and sitting on the baseline, at the mark's own 218:256 proportion,
 * with the tight gap a real letter would leave — so "S" + "averFi" reads as one
 * word. Drawn in the text's colour, so it follows the theme.
 */
function BrandWord({ word }: { readonly word: string }) {
  const mask = 'url("/logo/sip-mark-white.png") center / contain no-repeat';
  // Only a word that starts with the mark's letter can lend it its first letter.
  if (!word.startsWith("S")) return <>{word}</>;
  return (
    <>
      <span className="mr-[0.03em] inline-block h-[0.72em] w-[0.613em] bg-current align-baseline" style={{ mask, WebkitMask: mask }} />
      {word.slice(1)}
    </>
  );
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
            className={cn(CONTENT, heading.hero === true && HERO_WIDTH)}
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
            {/* The title keeps clear of the close button in the corner; the line of points may run under it. */}
            <DialogHeader className={cn("border-b p-4 text-left sm:px-6 sm:pt-5", heading.hero === true && "gap-2 sm:pb-5")}>
              <DialogTitle className="pr-10 text-lg leading-snug">
                {heading.eyebrow !== null ? <span className="mb-1 block text-xs font-medium tracking-wide text-muted-foreground uppercase">{heading.eyebrow}</span> : null}
                {heading.hero === true ? (
                  <>
                    {/* Heard whole; seen as the brand word, its "S" the mark. */}
                    <span className="sr-only">{heading.titleLead === undefined ? heading.title : `${heading.titleLead} ${heading.title}`}</span>
                    <span aria-hidden className={cn("block font-semibold tracking-tight", heading.brand === true ? "text-4xl sm:text-[2.75rem]" : "text-3xl sm:text-4xl")}>
                      {heading.brand === true ? <BrandWord word={heading.title} /> : heading.title}
                    </span>
                  </>
                ) : (
                  <>
                    {heading.titleLead !== undefined ? <span className="sr-only">{heading.titleLead} </span> : null}
                    {heading.title}
                  </>
                )}
              </DialogTitle>
              {heading.points !== undefined ? (
                <DialogDescription asChild>
                  <ul className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    {heading.points.map((point, index) => (
                      <li key={point} className="flex items-center gap-2">
                        {index > 0 ? <span aria-hidden className="size-1 rounded-full bg-muted-foreground/50" /> : null}
                        {point}
                      </li>
                    ))}
                  </ul>
                </DialogDescription>
              ) : (
                <DialogDescription>{heading.description}</DialogDescription>
              )}
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
