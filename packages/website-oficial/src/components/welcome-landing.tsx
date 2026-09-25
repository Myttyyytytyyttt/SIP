"use client";

/**
 * THE FRONT DOOR ON DEMAND (owner, 09-25). "/" shows the landing only to a
 * visitor: a connected pension key goes straight to its own pension, so the
 * front door does not flash past on every return. The navbar's logo leads
 * here instead, where the landing shows whoever is looking.
 *
 * Scrolling into the app goes where "See the app" goes — the sample for a
 * visitor; a connected key is taken on to its own pension from there
 * (lib/dashboard-mode.ts, rule 4).
 */

import { useRouter } from "next/navigation";

import { Landing } from "@/components/landing";

export function WelcomeLanding({ walletsConfigured }: { readonly walletsConfigured: boolean }) {
  const router = useRouter();
  return <Landing onEnter={() => router.push("/?mode=mock")} walletsConfigured={walletsConfigured} />;
}
