"use client";

/**
 * THE FRONT DOOR ON DEMAND (owner, 09-25). "/" shows the landing only to a
 * visitor: a connected pension key goes straight to its own pension, so the
 * front door does not flash past on every return. The navbar's logo leads
 * here instead, where the landing shows whoever is looking.
 *
 * Scrolling into the app goes where "See the app" goes — the sample for a
 * visitor; a connected key is taken on to its own pension from there
 * (lib/dashboard-mode.ts, rule 4). A Connect that succeeds here goes on to
 * ?mode=live: this page shows whoever is looking, so without that the visitor
 * would stay on the front door, connected.
 *
 * RULE 4a, FROM HERE TOO. A key with no vault that closed its setup in this tab
 * is shown the sample, and the app header's Connect reopens the setup. This
 * page sits inside the same frame (the (dashboard) layout), so it reads that
 * state and does the same: the button is "Connect", and its click clears the
 * close, so the setup opens where it was left — and ?mode=live, once the fade
 * has run, keeps it open rather than normalizing straight back to the sample.
 */

import { useRouter } from "next/navigation";

import { useDashboard } from "@/components/dashboard-shell";
import { Landing } from "@/components/landing";
import { urlWithMode } from "@/lib/dashboard-mode";
import { setOnboardingClosed } from "@/lib/onboarding-memory";

export function WelcomeLanding({ walletsConfigured }: { readonly walletsConfigured: boolean }) {
  const router = useRouter();
  const dashboard = useDashboard();
  const setupKey = dashboard?.state.account === "connect-onboarding" ? dashboard.pensionKey : null;
  return (
    <Landing
      onEnter={(to) => router.push(urlWithMode("/", to))}
      walletsConfigured={walletsConfigured}
      resumeSetup={setupKey === null ? null : () => setOnboardingClosed(setupKey, false)}
    />
  );
}
