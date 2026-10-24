"use client";

/**
 * THE SHARE BUTTON BESIDE THE HERO'S FIGURE (owner, 10-22): "arriba de lo que
 * es el gráfico, a lado derecho del número de saved so far". It opens a dialog
 * with an image of the pension to post — GMGN's and Axiom's PnL cards, in
 * SaverFi's dress (SharePanel.tsx draws it).
 *
 * ON THE LIVE PAGE AND ON THE SAMPLE. PensionPanel shows it where a page passes
 * `share`. It was Live only at first — the landing's app-loop video is recorded
 * from /?mode=mock (owner, 10-22: "no grabes nuevo video para landing") — and
 * then the owner put it on the sample too, the same day: "en el mock también
 * puede aparecer pero con los datos del mock claro". The sample passes a card of
 * its own figures (exampleShareCardOf), and that card names itself: the button
 * and the dialog say "this example", and the image says "Example" on itself
 * (share-canvas.ts). The video stays as it was recorded; the sample's goldens
 * changed by this button's markup alone.
 *
 * GREEN WHEN THERE IS SOMETHING TO SHOW, GREY WHEN THERE IS NOT (owner, 10-22:
 * "si está con savings ya el user el botón está verde y con un pulso verde
 * disimulado; si no tiene nada dentro, que se ponga gris"):
 *   saved    emerald, with the page's own halo (.live-halo) breathing out of
 *            the icon — 20 px growing to 52 px in half its colour, so what
 *            clears the 32 px button is a faint ring fading out. Under reduced
 *            motion the halo is not drawn at all (globals.css): a still green
 *            button.
 *   zero     grey, no halo, and it still opens: the card then states the rule.
 *   unknown  grey and off: the total could not be read, and a card of it would
 *            be a guess. Off by aria-disabled rather than `disabled`, so its
 *            tooltip can still say why.
 *
 * THE BUTTON DOES NOT MOVE THE HERO: 32 px, centred on the figure's 40/48 px
 * line, and a figure too long to share its line with it is set one step
 * smaller on a line of the same height (pension-panel.tsx) — or, in the
 * header's tight bands, drawn a step smaller where it stands, the button beside
 * it out of the flow (review, 10-22: the sample's hero grew 32 px at 1424 wide;
 * HERO_ROW_TIGHT, globals.css).
 *
 * THE DIALOG'S CODE ARRIVES ON FIRST OPEN (SharePanel.tsx, with the canvas):
 * the Live page's first load does not carry it, and a pointer resting on the
 * button starts fetching it.
 *
 * AND IF IT NEVER ARRIVES, ONLY THE DIALOG SAYS SO (review, 10-22). A lazy
 * component whose code fails to load throws to the nearest error boundary, and
 * the app has none of its own: Next's root one replaced the whole Live page
 * with "This page couldn't load" — for one optional button. PanelBoundary keeps
 * the failure inside the preview's frame. Its way out is a reload, not a retry:
 * Turbopack keeps a chunk that failed as failed for the page's life (measured
 * on next dev: a retry after the network came back requested nothing), and a
 * reload is the one thing that fetches it again.
 */

import { RefreshCw, Share } from "lucide-react";
import { Component, Suspense, lazy, useState, type ReactNode } from "react";

import { SharePreviewFrame } from "@/components/live/share-frame";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SAVED } from "@/lib/classes";
import { SHARE_COPY } from "@/lib/live-copy";
import { shareWords, type ShareCardData, type ShareLinkSource } from "@/lib/live-share";
import { cn } from "@/lib/utils";

const loadPanel = () => import("@/components/live/SharePanel");
const SharePanel = lazy(() => loadPanel().then((module) => ({ default: module.SharePanel })));

/** Fetch the dialog's code ahead of the click. A failure here is retried by the click itself. */
const prefetch = (): void => {
  loadPanel().catch(() => undefined);
};

/** The dialog's body failing — its code not loading, or a throw while it renders — stays in the dialog. */
class PanelBoundary extends Component<{ readonly children: ReactNode; readonly fallback: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** What stands in the dialog when its body could not load: the frame, in words, and the reload that fetches it again. */
export function SharePanelFailed() {
  return (
    <>
      <SharePreviewFrame failed={SHARE_COPY.loadFailed} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => window.location.reload()} data-share-action="reload">
          <RefreshCw aria-hidden />
          {SHARE_COPY.reload}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The trigger's look in each state: the round button, and the icon's own colour. */
export const SHARE_TRIGGER = {
  saved: cn(
    "bg-emerald-500/12 ring-emerald-500/35 hover:bg-emerald-500/20 aria-expanded:bg-emerald-500/20 dark:hover:bg-emerald-500/20",
    SAVED,
    "hover:text-emerald-700 aria-expanded:text-emerald-700 dark:hover:text-emerald-400 dark:aria-expanded:text-emerald-400",
  ),
  grey: "bg-muted text-muted-foreground ring-foreground/10",
} as const;

/**
 * `link` is where the dialog's Post on X link comes from (owner, 10-22): the
 * Live page passes its pension key and its streak's proof, the sample passes
 * "example". It changes nothing on the button — the hero and the sample's
 * goldens stay as they are — and is only read once the dialog opens.
 */
export function ShareSavings({ card, link }: { card: ShareCardData; link?: ShareLinkSource }) {
  const [open, setOpen] = useState(false);
  const saved = card.state === "saved";
  const unknown = card.state === "unknown";
  const words = shareWords(card);

  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={words.trigger}
      data-share-savings={card.state}
      {...(unknown ? { "aria-disabled": true } : {})}
      className={cn("shrink-0 rounded-full ring-1 ring-inset", saved ? SHARE_TRIGGER.saved : SHARE_TRIGGER.grey, unknown && "cursor-not-allowed opacity-50 hover:bg-muted")}
      onPointerEnter={unknown ? undefined : prefetch}
      onFocus={unknown ? undefined : prefetch}
    >
      {/* The halo's box: .live-halo fills its parent (inset 0, unlayered, so no utility can shrink it), and 20 px × 2.6 is the pulse's reach. */}
      <span aria-hidden className="relative flex size-5 items-center justify-center">
        {/* The page's own halo, in half its colour: the "pulso verde disimulado". Not a class on the button (globals.test.ts). */}
        {saved ? <span className="live-halo pointer-events-none text-emerald-500/50" data-share-halo="" /> : null}
        <Share className="relative size-4" />
      </span>
    </Button>
  );

  if (unknown) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{SHARE_COPY.triggerUnknown}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>{button}</DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>{words.triggerTip}</TooltipContent>
      </Tooltip>
      {/*
        A 16:9-ish image wants the width: 672 px, scrolling within the screen on a short one.
        auto-rows-max (review, 10-22): the dialog is a grid, and with its height capped its rows
        shrank to fit — the preview's frame (overflow hidden) gave way, and the picker and the
        video row were drawn over the card on a 390×664 phone and a 1366×768 laptop (Chrome,
        WebKit). Rows at their content's height make it scroll instead.
      */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] auto-rows-max overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{words.title}</DialogTitle>
          <DialogDescription>{words.description}</DialogDescription>
        </DialogHeader>
        <PanelBoundary fallback={<SharePanelFailed />}>
          <Suspense fallback={<SharePreviewFrame drawing />}>
            <SharePanel card={card} {...(link === undefined ? {} : { link })} />
          </Suspense>
        </PanelBoundary>
      </DialogContent>
    </Dialog>
  );
}
