"use client";

/**
 * THE TURN OF THE PAGE BETWEEN TABS (owner, 09-23): the same loader a visitor
 * sees entering the app — the mark filling inside a spinning ring — for a
 * moment, every time a tab is chosen.
 *
 * IT STARTS ON THE CLICK, NOT ON THE NEW ROUTE. Waiting for the pathname to
 * change would paint one frame of the new page and then cover it; the header's
 * links call `start()` as they are pressed, so the loader is up before anything
 * moves underneath it.
 *
 * IT ENDS WHEN THE NEW PAGE IS THERE, but never sooner than MIN_MS after it
 * began: a flash of a loader reads as a glitch, a short beat reads as intended.
 * And never later than MAX_MS, whatever happens — a navigation that fails or is
 * cancelled must not leave the screen covered.
 *
 * THE NEW PAGE ARRIVES AS THE LOADER LIFTS. While it is up, the root carries
 * `data-turning`, and every entrance underneath (`.rise-in`, globals.css) waits
 * at its first frame; they play together the moment it goes.
 *
 * Mounted once, in the root layout, because the tabs cross layouts: / and
 * /activity live under (dashboard), /leaderboard and /wallets do not, and only
 * the root survives the crossing.
 */

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

const MIN_MS = 550;
const MAX_MS = 3_000;

type Start = (href: string) => void;

/**
 * Where a tab's link turns the page to, or null when it does not turn it: an
 * anchor, somewhere off the site, or the page already showing. Only the path
 * counts — a query or a fragment is the same page.
 */
export function turnsTo(href: string, pathname: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const path = href.split(/[?#]/, 1)[0] || "/";
  return path === pathname ? null : path;
}

const StartContext = createContext<Start | null>(null);

/** Null outside the provider (a test, a page rendered alone): links then simply navigate. */
export function useRouteLoader(): Start | null {
  return useContext(StartContext);
}

export function RouteLoaderProvider({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const [shown, setShown] = useState(false);
  const began = useRef(0);
  const target = useRef<string | null>(null);

  const start = useCallback<Start>(
    (href) => {
      const path = turnsTo(href, pathname);
      if (path === null) return;
      target.current = path;
      began.current = Date.now();
      setShown(true);
    },
    [pathname],
  );

  // The new page is in: let the loader go once it has been up for MIN_MS.
  useEffect(() => {
    if (!shown || pathname !== target.current) return undefined;
    const timer = setTimeout(() => setShown(false), Math.max(0, MIN_MS - (Date.now() - began.current)));
    return () => clearTimeout(timer);
  }, [shown, pathname]);

  // The entrances underneath wait for the loader to lift.
  useEffect(() => {
    document.documentElement.toggleAttribute("data-turning", shown);
  }, [shown]);

  // Whatever happens, it never stays.
  useEffect(() => {
    if (!shown) return undefined;
    const timer = setTimeout(() => setShown(false), MAX_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  return (
    <StartContext.Provider value={start}>
      {children}
      <div className="app-loader" {...(shown ? { "data-shown": "" } : {})} role="status" aria-live="polite" aria-hidden={!shown}>
        <div className="app-loader-spin">
          <svg className="app-loader-ring" viewBox="0 0 80 80" aria-hidden>
            <circle cx="40" cy="40" r="37" fill="none" stroke="currentColor" strokeOpacity="0.08" strokeWidth="1.5" />
            <circle cx="40" cy="40" r="37" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="58 175" />
          </svg>
          <span className="app-loader-mark" aria-hidden />
        </div>
        {shown ? <span className="sr-only">Loading</span> : null}
      </div>
    </StartContext.Provider>
  );
}
