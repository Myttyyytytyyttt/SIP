"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * A SMALL SAVERFI WINDOW THAT STAYS ON TOP OF ANOTHER APP, for the terminal guide.
 *
 * Document Picture-in-Picture: Chrome and Edge 116+, Firefox 151+, desktop only;
 * not Safari, not phones (MDN's compatibility data, read 2026-10-22). Its window:
 *  * opens only from a press — requestWindow() rejects without one, and a
 *    press that just opened a tab may have none left (TerminalShortcuts);
 *  * floats above every other window, the terminal's included;
 *  * cannot be navigated, and is same-origin with this page, like a blank
 *    window.open(). So React renders into it with a portal, the page's own
 *    stylesheets are copied in, and no new origin reaches the CSP.
 *
 * WHAT IT CANNOT DO: see or touch the terminal. It is SaverFi's own document,
 * floating; the terminal's tab stays the terminal's.
 */

interface DocumentPictureInPicture {
  requestWindow(options?: { readonly width?: number; readonly height?: number; readonly disallowReturnToOpener?: boolean }): Promise<Window>;
}

function pictureInPicture(): DocumentPictureInPicture | null {
  if (typeof window === "undefined") return null;
  const api = (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
  return api ?? null;
}

const never = () => () => {};

/** Whether this browser can open the window. False on the server and while hydrating, so the two agree. */
export function useFloatingWindowSupported(): boolean {
  return useSyncExternalStore(never, () => pictureInPicture() !== null, () => false);
}

/**
 * THE PAGE'S LOOK, CARRIED OVER. Every stylesheet of this document, as a link
 * when it has a URL (same-origin, so style-src 'self' admits it) and as its
 * rules otherwise (Next's inline style tags; style-src allows inline styles),
 * plus the classes next-themes and next/font put on <html> and <body>, which
 * hold the dark mode and the font variables.
 */
export function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    if (sheet.href !== null) {
      const link = to.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      to.head.appendChild(link);
      continue;
    }
    try {
      const style = to.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      to.head.appendChild(style);
    } catch {
      // A sheet whose rules cannot be read is left out; the window still works, only plainer.
    }
  }
  to.documentElement.className = from.documentElement.className;
  to.documentElement.style.colorScheme = from.documentElement.style.colorScheme;
  to.body.className = from.body.className;
}

export type FloatingFailure = "unsupported" | "refused";

export interface FloatingWindow {
  /** The open window, or null. */
  readonly window: Window | null;
  /** Call from a press: the browser opens nothing otherwise. True when the window opened. */
  readonly open: () => Promise<boolean>;
  readonly close: () => void;
  readonly failure: FloatingFailure | null;
}

/** One floating window at a time; closed with the component that opened it. */
export function useFloatingWindow(size: { readonly width: number; readonly height: number }): FloatingWindow {
  const [floating, setFloating] = useState<Window | null>(null);
  const [failure, setFailure] = useState<FloatingFailure | null>(null);
  const { width, height } = size;

  const open = useCallback(async () => {
    const api = pictureInPicture();
    if (api === null) {
      setFailure("unsupported");
      return false;
    }
    try {
      // NO "BACK TO TAB" BUTTON. The browser's own one closes the window, and the guide's progress with it,
      // at the very step that sends the person to the SaverFi tab (Chrome 124+, Firefox 151+; ignored before).
      const opened = await api.requestWindow({ width, height, disallowReturnToOpener: true });
      copyStyles(document, opened.document);
      opened.document.title = "SaverFi guide";
      // The person can close it from its own title bar: the page follows. Only for THIS window: a new request
      // replaces an open one, and the old one's pagehide must not take the new one with it.
      opened.addEventListener("pagehide", () => setFloating((now) => (now === opened ? null : now)), { once: true });
      setFailure(null);
      setFloating(opened);
      return true;
    } catch {
      setFailure("refused");
      return false;
    }
  }, [width, height]);

  const close = useCallback(() => {
    floating?.close();
    setFloating(null);
  }, [floating]);

  // Leaving the page, or the row unmounting, takes the window with it.
  useEffect(() => () => floating?.close(), [floating]);

  return { window: floating, open, close, failure };
}
