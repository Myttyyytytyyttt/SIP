"use client";

/**
 * THE ONE LINE THAT KEEPS PRIVY OFF A STRANGER'S PAGE.
 *
 * The server decides who gets the connected bar, but a STATIC import does not
 * care what the server decided: the module joins the page's graph and every
 * reader downloads it. Measured on the public leaderboard before this file
 * existed — 7 of the 27 chunks an anonymous visitor fetched carried Privy, for
 * a component that never rendered for them.
 *
 * `dynamic` with `ssr: false` makes the wallet SDK a chunk that is requested
 * only when this actually renders, which is only for a browser the server has
 * already decided has a session. A stranger never asks for it.
 *
 * THE WRAPPER EXISTS BECAUSE `ssr: false` IS A CLIENT-SIDE CHOICE: a Server
 * Component may not pass it, so the page renders this, and this renders that.
 */

import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";
import type { SolanaPublicConfig } from "@/lib/config";
import { LIVE_COPY } from "@/lib/live-copy";

const LeaderboardAccount = dynamic(() => import("@/components/leaderboard-account").then((module) => module.LeaderboardAccount), {
  ssr: false,
  // Never a control that cannot act yet: the same placeholder the app's own bar
  // wears while Privy is being asked.
  loading: () => (
    <>
      <Skeleton className="h-8 w-24" aria-hidden />
      <span className="sr-only">{LIVE_COPY.checking}</span>
    </>
  ),
});

export function LeaderboardAccountHost({ config }: { readonly config: SolanaPublicConfig }) {
  return <LeaderboardAccount config={config} />;
}
