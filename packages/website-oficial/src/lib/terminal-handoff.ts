/**
 * TAKING A TRADING WALLET TO A TERMINAL, without SaverFi ever holding its key.
 *
 * Researched 2026-10-22 (reports/TERMINAL_HANDOFF_AND_AUTOMATIONS_2026-10-22.md):
 * no terminal checked takes a key by link, and none has a URL for its import
 * screen. So the most SaverFi can do is open the terminal's own page, let Privy
 * copy the key (the one "Copy key" button in its iframe on auth.privy.io), and
 * say exactly where to paste it.
 *
 * THE ROW SHOWS EACH TERMINAL'S ICON BESIDE EXPORT KEY (owner, 10-22). Where
 * the browser has a floating window, a press opens SaverFi's guide in one, and
 * the guide's first step opens the terminal; where it does not, the press opens
 * the terminal and the guide shows inside the row (TerminalShortcuts).
 *
 * EVERY DESTINATION IS A CONSTANT. A start URL is fixed here, on an exact host
 * the guide names: before its own link opens it where the guide floats, and in
 * every flow before the paste ("Paste it only into … on host"). Nothing a
 * visitor, a prop or a page's state passes in can change where these links go.
 * A clone of them on another site can point anywhere, of course: what catches it
 * is the host the person reads before pasting. The tests pin each URL's origin
 * to its host.
 *
 * NO KEY EVER GOES IN A URL — not the path, the query or the fragment. A URL is
 * kept in history and its sync, in the destination's CDN logs, in extensions
 * and in link previews, and "open this link with your key in it" is the shape
 * of a phishing kit.
 *
 * WHAT EACH TERMINAL DOES WITH THE KEY IS ITS OWN. Pasted into a terminal, the
 * key is held under that terminal's custody, and SaverFi's policy does not
 * reach the copy. The keeper's seat is on the signer, not the wallet, so it is
 * untouched.
 */

export type DestinationId = "axiom" | "gmgn";

export interface TerminalDestination {
  readonly id: DestinationId;
  readonly name: string;
  /** The exact host the guide names and opens. */
  readonly host: string;
  /** Where the terminal opens: the page closest to its import screen. Its origin is always https://host. */
  readonly startUrl: string;
  /** Its icon, served by this site (img-src 'self'): the same file the landing shows. */
  readonly icon: string;
  /** What to do there before the paste, in the destination's own words, each one line. */
  readonly steps: readonly string[];
  /** Where the key goes. */
  readonly pasteInto: string;
  /** What to do once it is pasted. */
  readonly afterPaste: string;
}

/**
 * THE TERMINALS WITH AN ICON, in the order the row shows them, read 2026-10-22:
 * Axiom from its public code, GMGN from its docs. A terminal's screens change
 * without notice, so the steps say where to look, never what the screen will show.
 *
 * Terminal (Padre) and Trojan were researched too and can come back once their
 * icons are here. Left out on purpose: Telegram bots (the key would sit in a
 * cloud chat), Photon (no documented import) and BullX (trading disabled).
 */
export const TERMINAL_DESTINATIONS: readonly TerminalDestination[] = [
  {
    id: "axiom",
    name: "Axiom",
    host: "axiom.trade",
    startUrl: "https://axiom.trade/portfolio",
    icon: "/landing/terminals/axiom.png",
    steps: ["Log in to Axiom.", "Open Portfolio, then press Import."],
    pasteInto: "Axiom's Import box",
    afterPaste: "Then confirm in Axiom.",
  },
  {
    id: "gmgn",
    name: "GMGN",
    host: "gmgn.ai",
    startUrl: "https://gmgn.ai/?chain=sol",
    icon: "/landing/terminals/gmgn.png",
    steps: ["Log in to GMGN.", "Open Wallet Manager, then press Import wallet."],
    pasteInto: "GMGN's Import wallet box",
    afterPaste: "Then confirm in GMGN.",
  },
];

export type GuideStepKind = "open" | "do" | "copy" | "paste" | "trade";

export interface GuideStep {
  readonly kind: GuideStepKind;
  readonly text: string;
}

/**
 * THE GUIDE'S STEPS: the terminal opens first, then its own steps, then Copy key
 * right before the paste, so the key is copied as late as it can be. The last
 * step is the trade; it ticks itself when the wallet moves on chain, or the
 * person ticks it.
 */
export function guideSteps(destination: TerminalDestination): readonly GuideStep[] {
  return [
    { kind: "open", text: TERMINAL_COPY.stepOpen(destination.host) },
    ...destination.steps.map((text) => ({ kind: "do" as const, text })),
    { kind: "copy", text: TERMINAL_COPY.stepCopy },
    { kind: "paste", text: `${TERMINAL_COPY.stepPaste(destination.pasteInto, destination.host)} ${destination.afterPaste}` },
    { kind: "trade", text: TERMINAL_COPY.guideTradeStep },
  ];
}

export function destinationById(id: DestinationId): TerminalDestination {
  const found = TERMINAL_DESTINATIONS.find((destination) => destination.id === id);
  if (found === undefined) throw new Error(`Unknown terminal destination: ${id}`);
  return found;
}

/**
 * HOW A BROWSER TREATS A PRESS ON A LINK THAT OPENS A NEW TAB, as far as the
 * terminal's links care (the icons and the guide's own):
 *  * "other": Alt (Option) held with anything, or Shift alone. Chromium and
 *    Safari save the page as a file on Alt (Firefox opens it), and by
 *    Chromium's link rules it still does when Alt comes with a key that is not
 *    its new-tab key (the Windows key); on Shift, Chromium and Firefox open a new window, and Safari
 *    adds the page to its Reading List. So such a press is never left to the
 *    browser. On the guide's links, and on an icon where there is no floating
 *    window, the page opens the terminal itself with window.open (measured
 *    10-22 in Brave 151 and Chrome 155 on macOS: a tab on Alt, no file; on Shift
 *    Chromium still makes it a new window, as Shift asks there). On an icon
 *    where the floating window exists, it opens the guide, as a plain press does.
 *  * "tab": Cmd or Ctrl, with or without Shift — the new-tab press (Cmd on a
 *    Mac, Ctrl elsewhere; measured: Cmd in those two browsers). It is left to
 *    the browser. The other key of the two does no harm there: Ctrl-click on a
 *    Mac is the context menu, which fires no click, and the Windows key alone
 *    leaves the link's own new tab. So is the middle button, which fires no
 *    click and is not read here.
 *  * "plain": no key held — the link's own new tab (on an icon where the
 *    floating window exists, the guide instead: pressShortcut).
 */
export type LinkPress = "plain" | "tab" | "other";

export function linkPress(press: { readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean }): LinkPress {
  if (press.altKey) return "other";
  if (press.metaKey || press.ctrlKey) return "tab";
  if (press.shiftKey) return "other";
  return "plain";
}

/** Every sentence the terminal icons and the guide say, in one place. */
export const TERMINAL_COPY = {
  /** The icon's name for a screen reader and its tooltip. True of both presses: the guide first, or the terminal first. */
  shortcut: (name: string) => `Use this wallet in ${name}`,
  stepOpen: (host: string) => `Open ${host} in a new tab.`,
  open: (host: string) => `Open ${host}`,
  stepCopy: "Copy the key with Privy, then paste it straight away.",
  copy: "Copy key",
  copying: "Privy dialog open…",
  stepPaste: (where: string, host: string) => `Paste it only into ${where} on ${host}.`,
  /** SaverFi's own key field is Import, for wallets from elsewhere: the warning says so instead of "never asks". */
  neverAsks: "SaverFi never asks for this wallet's key. Its only key field is Import, for wallets from elsewhere.",
  clipboard:
    "The key goes through your clipboard. If your clipboard history or cloud sync is on, turn it off first, and paste right away.",
  /**
   * NOTHING CLEARS THE CLIPBOARD BY ITSELF: a page can write to it only while it
   * has focus (Firefox and Safari also want a press), and after the paste the
   * focus is in the terminal's tab. So clearing is a button, pressed after the
   * paste, and it says what it cannot reach.
   */
  clear: "Clear clipboard",
  cleared: "Clipboard cleared",
  clearFailed: "This browser did not let SaverFi clear the clipboard. Copy something else over it.",
  clearNote: "It can't clear your clipboard history, its cloud sync, or anything another app already read.",
  guideTitle: (wallet: string, name: string) => `Use ${wallet} in ${name}`,
  guideDone: "Done",
  guideClose: "Close guide",
  /**
   * PRIVY'S DIALOG OPENS IN THE SAVERFI TAB, NOT IN THE FLOATING WINDOW (measured
   * 10-22): Privy 3.36.0 mounts its dialogs in the document its provider lives
   * in. So the floating guide's button says where it opens before it is pressed,
   * and the sentence after it shows only while the dialog is really open.
   */
  guideCopyHere: "Open Copy key in the SaverFi tab",
  guideCopyElsewhere: "Privy's window is open in the SaverFi tab. Switch to that tab, press Copy key there, then come back to the terminal.",
  guideTradeStep: "Make a trade with this wallet",
  guideTradeNote: "This ticks itself when the wallet moves on chain. If you already traded, press Done.",
  guideMoved: "This wallet just moved on chain. SaverFi measures your trades from there.",
  guideFinished: "All steps done. SaverFi measures your trades from the chain.",
  /** The end of the guide on a row that does not save today. */
  guideMovedNotSaving: "This wallet just moved on chain. It saves only while it's linked to your vault, has SaverFi's permission and saving isn't paused.",
  guideFinishedNotSaving: "All steps done. This wallet saves only while it's linked to your vault, has SaverFi's permission and saving isn't paused.",
  guideStepOf: (step: number, total: number) => `Step ${step} of ${total}`,
  guideRestart: "Start over",
  /** Said in the row while the guide floats, so the row is not silent about the window it opened. */
  guideFloating: (name: string) => `SaverFi's guide for ${name} is open in a floating window.`,
} as const;
