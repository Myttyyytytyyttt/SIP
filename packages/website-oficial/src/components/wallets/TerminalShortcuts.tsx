"use client";

/**
 * THE TERMINALS' ICONS BESIDE EXPORT KEY (owner, 10-22): press one and SaverFi's
 * guide for that terminal opens.
 *
 * TWO PRESSES, NEVER ONE: THE GUIDE FIRST, THEN THE TERMINAL. A press lets a page
 * open one window, and a tab opened first leaves the floating window none:
 *  * measured 10-22 in the owner's Brave: the icon's link opened the terminal's
 *    tab, the window asked for 150 ms later was refused — "Document PiP requires
 *    user activation", the SaverFi tab hidden, the press used up — on every try
 *    after the first;
 *  * asked for in the same moment as the tab, one of the two is refused (Chrome,
 *    10-22).
 * So where the browser has the floating window, the icon opens only the guide,
 * asked for inside the press (pressShortcut), and the guide's first step is the
 * terminal's link: the second press, made in the window that stays on top of it.
 * Where it has none (Safari, phones), the icon is the plain link it is drawn as:
 * the terminal opens and the guide shows inside the row, its first step done. So
 * it does for a press that asks the browser for a new tab (Cmd or Ctrl, or the
 * middle button), wherever it is made. A window the browser refuses gets the same
 * guide inside the row, from its first step, so the terminal's link is still one
 * press away. Alt, or Shift alone, does not open a tab everywhere (linkPress):
 * where the window exists such a press is a plain one; where it does not, the
 * page opens the terminal itself. A press on an icon whose guide already shows
 * keeps that guide and its ticked steps: a floating one stays and is focused (a
 * press for a tab still gets its tab), one in the row stays while the terminal
 * opens.
 */

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FloatingTerminalGuide, type GuideCopy } from "@/components/wallets/FloatingTerminalGuide";
import { useFloatingWindow, useFloatingWindowSupported } from "@/hooks/use-floating-window";
import { TERMINAL_COPY, TERMINAL_DESTINATIONS, destinationById, linkPress, type DestinationId, type LinkPress } from "@/lib/terminal-handoff";

/** The floating window's size: the guide's steps without a scrollbar on a laptop. */
const GUIDE_SIZE = { width: 360, height: 620 } as const;

export type Guide = { readonly id: DestinationId; readonly mode: "floating" | "inline"; readonly startAt: number };

/**
 * WHAT A PRESS ON AN ICON DOES, apart from React so a test holds it to the rule
 * above. Synchronous on purpose: on a press that is not "tab", where the floating
 * window exists and no guide of this terminal floats yet, open() is called before
 * this returns, inside the press, and the link's own navigation is cancelled.
 * Nothing may await, or wait, before it.
 */
export function pressShortcut(
  id: DestinationId,
  press: {
    /** linkPress of the click; "tab" for the middle button. */
    readonly kind: LinkPress;
    readonly preventDefault: () => void;
    /** Opens the terminal's start URL from this press, with window.open (see linkPress). */
    readonly openTab: () => void;
  },
  floating: {
    readonly supported: boolean;
    /** The terminal whose guide floats right now, if any. */
    readonly showing: DestinationId | null;
    /** The terminal whose guide shows inside the row right now, if any. */
    readonly showingInRow: DestinationId | null;
    readonly open: () => Promise<boolean>;
    readonly focus: () => void;
  },
  show: (guide: Guide) => void,
): void {
  // Pressed again while its guide floats: the steps already ticked stay. A press that asks for a tab gets one.
  if (floating.showing === id) {
    if (press.kind !== "tab") {
      press.preventDefault();
      floating.focus();
    }
    return;
  }
  // Pressed again while its guide shows in the row: the guide stays, and the press opens the terminal.
  if (floating.showingInRow === id) {
    if (press.kind === "other") {
      press.preventDefault();
      press.openTab();
    }
    return;
  }
  if (press.kind === "tab") {
    show({ id, mode: "inline", startAt: 1 });
    return;
  }
  if (!floating.supported) {
    if (press.kind === "other") {
      press.preventDefault();
      press.openTab();
    }
    show({ id, mode: "inline", startAt: 1 });
    return;
  }
  press.preventDefault();
  show({ id, mode: "floating", startAt: 0 });
  void floating.open().then((opened) => {
    if (!opened) show({ id, mode: "inline", startAt: 0 });
  });
}

export function TerminalShortcuts({
  address,
  walletLabel,
  saving,
  wsUrl,
  copy,
}: {
  readonly address: string;
  readonly walletLabel: string;
  /** Whether the row saves today (linked, with a permission, not paused): only then does the guide's end promise it. */
  readonly saving: boolean;
  readonly wsUrl: string;
  readonly copy: GuideCopy;
}) {
  const supported = useFloatingWindowSupported();
  const floating = useFloatingWindow(GUIDE_SIZE);
  const [guide, setGuide] = useState<Guide | null>(null);
  const shown = guide === null ? null : destinationById(guide.id);
  // A floating guide closed from its own title bar leaves nothing to show here.
  const visible = guide !== null && (guide.mode === "inline" || floating.window !== null);
  // A guide that moved into the row (a refused window, or a press for a tab on the other terminal's icon) leaves no
  // empty window behind.
  const { window: floatingWindow, close: closeFloating } = floating;
  useEffect(() => {
    if (guide?.mode === "inline" && floatingWindow !== null) closeFloating();
  }, [guide?.mode, floatingWindow, closeFloating]);
  const floatingNow = {
    supported,
    showing: guide?.mode === "floating" && floatingWindow !== null ? guide.id : null,
    showingInRow: guide?.mode === "inline" ? guide.id : null,
    open: floating.open,
    focus: () => floatingWindow?.focus(),
  };

  return (
    <>
      {TERMINAL_DESTINATIONS.map((destination) => (
        <Tooltip key={destination.id}>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="outline" asChild>
              <a
                href={destination.startUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={TERMINAL_COPY.shortcut(destination.name)}
                data-terminal-shortcut={destination.id}
                onClick={(event) => {
                  const openTab = () => window.open(destination.startUrl, "_blank", "noopener,noreferrer");
                  pressShortcut(destination.id, { kind: linkPress(event), preventDefault: () => event.preventDefault(), openTab }, floatingNow, setGuide);
                }}
                // The middle button fires no click: its new tab is the browser's. The guide follows in the row, unless
                // this terminal's guide already floats, which stays as it is.
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  pressShortcut(destination.id, { kind: "tab", preventDefault: () => event.preventDefault(), openTab: () => {} }, floatingNow, setGuide);
                }}
              >
                <img src={destination.icon} alt="" width={16} height={16} className="size-4 rounded-sm" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{TERMINAL_COPY.shortcut(destination.name)}</TooltipContent>
        </Tooltip>
      ))}

      {visible && guide !== null && shown !== null ? (
        // A whole line of the row's control strip, under the buttons.
        <div className="basis-full">
          {guide.mode === "floating" && floating.window !== null ? (
            <>
              <p className="text-xs text-muted-foreground" role="status">
                {TERMINAL_COPY.guideFloating(shown.name)}
              </p>
              <FloatingTerminalGuide
                key={`${guide.id}-floating`}
                target={floating.window}
                destination={shown}
                walletLabel={walletLabel}
                address={address}
                saving={saving}
                wsUrl={wsUrl}
                copy={copy}
                startAt={guide.startAt}
              />
            </>
          ) : guide.mode === "inline" ? (
            <FloatingTerminalGuide
              key={`${guide.id}-inline`}
              target={null}
              destination={shown}
              walletLabel={walletLabel}
              address={address}
              saving={saving}
              wsUrl={wsUrl}
              copy={copy}
              startAt={guide.startAt}
              onClose={() => setGuide(null)}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}
