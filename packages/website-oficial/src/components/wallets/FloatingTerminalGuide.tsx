"use client";

/**
 * THE TERMINAL GUIDE (owner, 10-22): the steps to take a trading wallet to a
 * terminal. Where the browser has Document Picture-in-Picture it floats in a
 * SaverFi window that stays on top while the person works in the terminal's own
 * tab; anywhere else it shows the same steps inside the row (`target` null).
 *
 * IT NEVER SEES THE TERMINAL. The terminal's tab belongs to another origin, so
 * the guide cannot tell whether a step was done there: the person ticks each one.
 * The first step ticks itself when its link is pressed (the middle button too),
 * since that press is the guide's own (TerminalLink); a new tab from the link's
 * context menu is not heard, and its Done button stays. Once that step is behind,
 * the terminal's link stays at the foot of the guide, for a tab closed or never
 * opened.
 * The last step is the one thing it can see for itself, from the chain: the
 * wallet moving. "Moved", never "traded" — a deposit, a withdrawal or a
 * settlement moves it too. A trade made before that step was reached is not
 * heard, so the step can also be ticked by hand.
 *
 * COPY KEY OPENS PRIVY IN THE SAVERFI TAB, NOT IN THE FLOATING WINDOW. Privy
 * 3.36.0 renders its dialogs through a Headless UI dialog in the document its
 * provider is mounted in, which is the SaverFi tab, and has no option to put one
 * anywhere else. Measured 10-22 in Chrome: a Privy dialog asked for from the
 * window appeared in the SaverFi tab's document and not in the window's,
 * although an auth.privy.io iframe does load there. So the floating guide's
 * button says where Privy opens, and the window has no "back to tab" button of
 * the browser's own (use-floating-window.ts): it would close the guide at the
 * very moment it sends the person to that tab.
 */

import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { ClearClipboard } from "@/components/wallets/ClearClipboard";
import { browserSocket, watchAccounts } from "@/lib/live-socket";
import { TERMINAL_COPY, guideSteps, linkPress, type GuideStepKind, type TerminalDestination } from "@/lib/terminal-handoff";

export interface GuideCopy {
  readonly run: () => Promise<void>;
  readonly busy: boolean;
  readonly failure: string | null;
}

export function FloatingTerminalGuide({
  target,
  destination,
  walletLabel,
  address,
  saving,
  wsUrl,
  copy,
  startAt = 0,
  onClose,
}: {
  /** The floating window this renders into, or null for the same steps inside the row. */
  readonly target: Window | null;
  readonly destination: TerminalDestination;
  readonly walletLabel: string;
  readonly address: string;
  /** Whether the row saves today: only then does the guide's end say SaverFi measures the trades. */
  readonly saving: boolean;
  /** The key-free public WebSocket the page already uses (config.solanaWsUrl). */
  readonly wsUrl: string;
  readonly copy: GuideCopy;
  /** The first step to show as current: 1 when the icon's own press left the terminal's tab to the browser. */
  readonly startAt?: number;
  /** Inside the row only: the floating window has its own close button. */
  readonly onClose?: () => void;
}) {
  const steps = guideSteps(destination);
  const tradeAt = steps.findIndex((step) => step.kind === "trade");
  const [current, setCurrent] = useState(startAt);
  const [copyAsked, setCopyAsked] = useState(false);
  const [moved, setMoved] = useState(false);
  const done = moved || current >= steps.length;
  const floating = target !== null;
  // The clipboard of the window the person is pressing in: the press gives that window the focus a write needs.
  const clipboard = () => (target ?? (typeof window === "undefined" ? null : window))?.navigator.clipboard;

  // The chain is watched only once the trade step is the current one, so a move before it (a settlement, a
  // deposit made while setting up) is not taken for the trade.
  const watching = current === tradeAt && !moved;
  useEffect(() => {
    if (!watching) return;
    const watch = watchAccounts({ url: wsUrl, addresses: [address], onChange: () => setMoved(true), open: browserSocket });
    return () => watch.close();
  }, [watching, wsUrl, address]);

  const next = () => setCurrent((step) => Math.min(step + 1, steps.length));
  const restart = () => {
    setCurrent(0);
    setCopyAsked(false);
    setMoved(false);
  };

  const body: ReactNode = (
    <div
      className={floating ? "space-y-3 p-4 text-sm" : "space-y-3 rounded-md border px-3 py-2 text-xs"}
      data-terminal-guide={destination.id}
      data-mode={floating ? "floating" : "inline"}
      data-step={done ? "done" : String(current)}
    >
      <p className="font-medium">{TERMINAL_COPY.guideTitle(walletLabel, destination.name)}</p>

      <ol className="divide-y">
        {steps.map((step, index) => {
          const state = done || index < current ? "done" : index === current ? "now" : "later";
          return (
            <li key={`${step.kind}-${index}`} className="flex gap-2.5 py-2" data-state={state}>
              <span
                aria-hidden
                className={
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] " +
                  (state === "done"
                    ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                    : state === "now"
                      ? "border-primary text-primary"
                      : "text-muted-foreground")
                }
              >
                {state === "done" ? <Check className="size-3" /> : index + 1}
              </span>
              <div className="min-w-0 space-y-1.5">
                <p className={state === "later" ? "text-muted-foreground" : undefined}>{step.text}</p>
                {state === "now" ? (
                  <StepControls
                    kind={step.kind}
                    floating={floating}
                    clipboard={clipboard}
                    destination={destination}
                    copy={copy}
                    copyAsked={copyAsked}
                    onCopy={() => {
                      setCopyAsked(true);
                      void copy.run();
                    }}
                    onDone={next}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {done ? (
        <div className="space-y-1.5">
          <p role="status" className={saving ? "text-xs text-emerald-700 dark:text-emerald-400" : "text-xs text-muted-foreground"}>
            {moved
              ? saving
                ? TERMINAL_COPY.guideMoved
                : TERMINAL_COPY.guideMovedNotSaving
              : saving
                ? TERMINAL_COPY.guideFinished
                : TERMINAL_COPY.guideFinishedNotSaving}
          </p>
          {/* Still here at the end, for whoever pressed Done before clearing. */}
          <div className="text-xs">
            <ClearClipboard clipboard={clipboard} />
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{TERMINAL_COPY.guideStepOf(current + 1, steps.length)}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {/* The fixed host's link again, ticking nothing: the open step's own one leaves with that step. */}
        {current > 0 ? <TerminalLink destination={destination} variant="ghost" again /> : null}
        <Button type="button" size="sm" variant="ghost" onClick={restart}>
          {TERMINAL_COPY.guideRestart}
        </Button>
        {!floating && onClose !== undefined ? (
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {TERMINAL_COPY.guideClose}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return target !== null ? createPortal(body, target.document.body) : body;
}

/**
 * THE TERMINAL'S LINK, AS THE GUIDE DRAWS IT. A plain press, Cmd or Ctrl, and
 * the middle button are the browser's: each opens a tab. Alt or Shift alone does
 * not open one everywhere (linkPress), so that press opens the terminal itself,
 * from the window it was made in (the floating one, or the SaverFi tab). `onOpened`
 * runs after the browser has acted on the press, since the link may leave the
 * page with it.
 */
function TerminalLink({
  destination,
  variant,
  onOpened,
  again = false,
}: {
  readonly destination: TerminalDestination;
  readonly variant: "outline" | "ghost";
  readonly onOpened?: () => void;
  /** The copy at the guide's foot. */
  readonly again?: boolean;
}) {
  const opened = () => {
    if (onOpened !== undefined) setTimeout(onOpened, 0);
  };
  return (
    <Button size="sm" variant={variant} asChild>
      <a
        href={destination.startUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-terminal-link-again={again ? "" : undefined}
        onClick={(event) => {
          if (linkPress(event) === "other") {
            event.preventDefault();
            (event.currentTarget.ownerDocument.defaultView ?? window).open(destination.startUrl, "_blank", "noopener,noreferrer");
          }
          opened();
        }}
        onAuxClick={(event) => {
          if (event.button === 1) opened();
        }}
      >
        {TERMINAL_COPY.open(destination.host)}
        <ExternalLink aria-hidden />
      </a>
    </Button>
  );
}

function StepControls({
  kind,
  floating,
  clipboard,
  destination,
  copy,
  copyAsked,
  onCopy,
  onDone,
}: {
  readonly kind: GuideStepKind;
  readonly floating: boolean;
  readonly clipboard: () => Clipboard | undefined;
  readonly destination: TerminalDestination;
  readonly copy: GuideCopy;
  readonly copyAsked: boolean;
  readonly onCopy: () => void;
  readonly onDone: () => void;
}) {
  return (
    <div className="space-y-1.5">
      {kind === "copy" ? <p className="text-xs text-muted-foreground">{TERMINAL_COPY.clipboard}</p> : null}
      {kind === "paste" ? <p className="text-xs text-muted-foreground">{TERMINAL_COPY.neverAsks}</p> : null}
      {kind === "trade" ? <p className="text-xs text-muted-foreground">{TERMINAL_COPY.guideTradeNote}</p> : null}
      {/* After the paste, and again on the trade step: the press happens in the window the person is looking at. */}
      {kind === "paste" || kind === "trade" ? <ClearClipboard clipboard={clipboard} /> : null}
      <div className="flex flex-wrap gap-2">
        {/* Pressed, it ticks its step. */}
        {kind === "open" ? <TerminalLink destination={destination} variant="outline" onOpened={onDone} /> : null}
        {kind === "copy" ? (
          <Button type="button" size="sm" variant="outline" disabled={copy.busy} aria-busy={copy.busy} onClick={onCopy}>
            {copy.busy ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : null}
            {copy.busy ? TERMINAL_COPY.copying : floating ? TERMINAL_COPY.guideCopyHere : TERMINAL_COPY.copy}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {TERMINAL_COPY.guideDone}
        </Button>
      </div>
      {/* Only while Privy's dialog is really open, after a press made here (the row's Export key shares that dialog's
          state), and only when it opened elsewhere. */}
      {kind === "copy" && floating && copyAsked && copy.busy ? <p className="text-xs text-muted-foreground">{TERMINAL_COPY.guideCopyElsewhere}</p> : null}
      {kind === "copy" && copyAsked && copy.failure !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {copy.failure}
        </p>
      ) : null}
    </div>
  );
}
