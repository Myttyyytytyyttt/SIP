"use client";

/**
 * THE SAME BAR ON THE PUBLIC PAGE, for somebody who is already connected.
 *
 * WHY IT IS NOT ALWAYS MOUNTED. /leaderboard is public: most of its readers
 * have no wallet and no session, and making every one of them download a wallet
 * SDK to render a corner of the chrome is a bad trade. So the SERVER decides —
 * it already reads the session hint cookie before the first paint — and mounts
 * this only for a browser that has connected before. A stranger gets a link and
 * no Privy at all; somebody coming back gets their key, their balance and their
 * way out, exactly as inside the app.
 *
 * A STALE HINT COSTS NOTHING. If the session has since ended, Privy answers
 * "not authenticated", this falls back to the same link the stranger sees, and
 * the hint clears itself (SessionHintKeeper, in providers.tsx).
 *
 * IT READS THE CHAIN ONLY FOR THE BALANCE, and only when there is a pension key
 * to read for. That is one snapshot per connected visitor — the same read the
 * dashboard makes, through the same cached route.
 */

import Link from "next/link";

import { usePrivy } from "@privy-io/react-auth";

import Providers from "@/app/providers";
import { DisconnectButton, PensionKeyChip, worthFrom } from "@/components/account-chip";
import { OpenPension } from "@/components/open-pension";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveDashboard } from "@/hooks/use-live-dashboard";
import type { SolanaPublicConfig } from "@/lib/config";
import { LIVE_COPY } from "@/lib/live-copy";
import { pensionKeyOf } from "@/lib/pension-key";
import { tradingWalletsOf } from "@/lib/trading-wallets";

function Account() {
  const { ready, authenticated, user, logout } = usePrivy();
  const pensionKey = user === null || user === undefined ? null : pensionKeyOf(user);
  const privyWallets = tradingWalletsOf(user ?? null).map((wallet) => wallet.address);
  // NO KEY, NO READ. The hook takes a null pension key as "nothing to read",
  // so a session without an external Solana wallet costs no request.
  const live = useLiveDashboard({ pensionKey, privyWallets });

  if (!ready) {
    // Never a control that cannot act yet: a button that does nothing when
    // pressed is worse than one that has not arrived.
    return (
      <>
        <Skeleton className="h-8 w-24" aria-hidden />
        <span className="sr-only">{LIVE_COPY.checking}</span>
      </>
    );
  }
  if (!authenticated) return <OpenPension returning={false} />;
  return (
    <>
      {pensionKey === null ? null : <PensionKeyChip address={pensionKey} worthUsdcRaw={worthFrom(live.view)} />}
      {/* The way back in, beside the way out: this page is not the app. */}
      <Button asChild size="sm" variant="ghost" className="hidden lg:inline-flex">
        <Link href="/">Back to my pension</Link>
      </Button>
      <DisconnectButton onDisconnect={() => void logout()} />
    </>
  );
}

export function LeaderboardAccount({ config }: { readonly config: SolanaPublicConfig }) {
  return (
    <Providers config={config}>
      <Account />
    </Providers>
  );
}
