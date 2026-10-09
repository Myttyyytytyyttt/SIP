"use client";

/**
 * WHETHER THE SERVER RUNS A NEWER BUILD THAN THIS TAB (diagnosis 10-09,
 * inventory D5): a tab opened before a deploy keeps its old bundle for as long
 * as it stays open, and nothing said so. Data only — what the page draws for
 * it (a chip, a reload) is the page's.
 *
 * PLUMBING ONLY, FOR NOW (review 2026-10-09): nothing mounts this yet, so no
 * tab asks /api/version and a stale tab still says nothing. It is meant for
 * the dashboard frame, beside the UI that draws `updateAvailable`; until that
 * lands, D5 is not fixed — only made fixable.
 *
 * It asks GET /api/version when the tab is looked at again or takes focus, at
 * most once a minute (VERSION_CHECK_FLOOR_MS), and every VERSION_CHECK_MS
 * while it stays visible; a hidden tab asks nothing. Once an update is
 * available it stops asking: the answer cannot become less true. A bundle
 * built without a commit ("dev": a local server, the Docker rehearsal) never
 * asks at all. Rules and the request: src/lib/build-version.ts.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { BUNDLE_COMMIT, DEV_COMMIT, VERSION_CHECK_MS, fetchServedCommit, newVersionServed, versionCheckDue } from "@/lib/build-version";

export interface NewVersion {
  /** The server runs a different commit than the one this bundle was built from. */
  readonly updateAvailable: boolean;
}

export function useNewVersion(): NewVersion {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  // This bundle was loaded a moment ago: the first check waits out the floor.
  const lastCheckAt = useRef<number>(Date.now());

  useEffect(() => {
    if (BUNDLE_COMMIT === DEV_COMMIT || updateAvailable || typeof document === "undefined") return undefined;
    let alive = true;
    const check = (): void => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (!versionCheckDue({ lastCheckAt: lastCheckAt.current, now })) return;
      lastCheckAt.current = now;
      void fetchServedCommit().then((served) => {
        if (alive && newVersionServed(BUNDLE_COMMIT, served)) setUpdateAvailable(true);
      });
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    const timer = window.setInterval(check, VERSION_CHECK_MS);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      window.clearInterval(timer);
    };
  }, [updateAvailable]);

  return useMemo(() => ({ updateAvailable }), [updateAvailable]);
}
