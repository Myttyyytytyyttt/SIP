"use client";

/**
 * THE WALLETS SCREEN, one component in two containers: the /wallets route and the
 * dashboard's "Manage wallets" modal. Both mount it inside <Providers>.
 *
 * HYDRATION. Nothing that depends on Privy renders before `ready`: the server
 * paints the skeleton and so does the first client frame. If Privy never becomes
 * ready (auth.privy.io blocked, or an origin the Privy app does not allow), the
 * skeleton says so after a while instead of pulsing forever.
 *
 * THE PENSION KEY is the external Solana wallet the user signed in with
 * (src/lib/pension-key.ts). It owns the pension and is the only key that can
 * withdraw, so this screen shows it and never offers to export it: it lives in the
 * user's own wallet app. A session without one gets a way out rather than a dead
 * end, and the way out is Disconnect, because Privy ignores login() for a user who
 * is already signed in.
 *
 * TOP TO BOTTOM: the pension key, its vault (create it, or what it holds), the
 * trading wallets, each with its link to the vault, investing (the policy, or the
 * form that signs it) and taking money out. One read of the chain feeds them all,
 * and one write at a time runs on the whole screen (VaultScreen). Every
 * confirmation is an inline panel, never a nested dialog, so the Manage wallets
 * modal's untrapped focus scope keeps working with Privy's dialogs on top.
 */

import { useLogin, usePrivy } from "@privy-io/react-auth";
import { LogOut, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AddressLine } from "@/components/wallets/AddressLine";
import { InvestingCard } from "@/components/wallets/InvestingCard";
import { TradingWalletsCard } from "@/components/wallets/TradingWalletsCard";
import { VaultCard } from "@/components/wallets/VaultCard";
import { VaultScreen } from "@/components/wallets/VaultScreen";
import { WithdrawCard } from "@/components/wallets/WithdrawCard";
import { LABEL } from "@/lib/classes";
import { pensionKeyOf } from "@/lib/pension-key";
import { PRIVY_PATIENCE_MS } from "@/lib/privy-patience";
import { privyFailure } from "@/lib/privy-failure";

/**
 * How long Privy may take to become ready before the skeleton stops pretending
 * it is about to. It moved to src/lib/privy-patience.ts, where the dashboard
 * waits on the same number; re-exported so this screen's old import still works.
 */
export { PRIVY_PATIENCE_MS } from "@/lib/privy-patience";

export function WalletsScreen() {
  const { ready, authenticated, user, logout } = usePrivy();
  // Derived, never stored: the app keeps no copy of who you are.
  const pensionKey = useMemo(() => (user === null ? null : pensionKeyOf(user)), [user]);

  if (!ready) return <ScreenSkeleton />;
  if (!authenticated) return <ConnectCard />;
  // Privy can report the session a frame before the user object arrives.
  if (user === null) return <ScreenSkeleton />;

  const disconnect = () => void logout();
  if (pensionKey === null) return <KeylessCard onDisconnect={disconnect} />;

  return (
    <VaultScreen pensionKey={pensionKey}>
      <div className="space-y-4">
        <PensionKeyCard address={pensionKey} onDisconnect={disconnect} />
        <VaultCard />
        <TradingWalletsCard />
        <InvestingCard />
        <WithdrawCard />
      </div>
    </VaultScreen>
  );
}

/** Logged out. Privy's own dialog does the connecting; this says what is being connected, and what went wrong. */
function ConnectCard() {
  const [failure, setFailure] = useState<string | null>(null);
  const { login } = useLogin({
    onError: (code) => {
      const described = privyFailure(code);
      // Closing Privy's dialog is a choice, not an error.
      setFailure(described.kind === "exited" ? null : described.message);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect your pension key</CardTitle>
        <CardDescription>
          Your pension key is a Solana wallet you already hold: Phantom, Backpack, Solflare or another. It owns the
          pension and is the only key that can withdraw — the team has no access to your funds. Trading wallets are
          created here once it is connected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* An explicit call: Privy's login() reads a click event passed straight through as options. */}
        <Button
          type="button"
          onClick={() => {
            setFailure(null);
            login();
          }}
        >
          Connect pension key
        </Button>
        {failure !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A session with no external Solana wallet: say so, and offer the one control that helps. */
function KeylessCard({ onDisconnect }: { onDisconnect: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>This session has no pension key</CardTitle>
        <CardDescription>
          You are signed in without a Solana wallet of your own, and the pension key must be one. Disconnect, then
          connect Phantom, Backpack, Solflare or another Solana wallet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" size="sm" onClick={onDisconnect}>
          <LogOut aria-hidden />
          Disconnect
        </Button>
      </CardContent>
    </Card>
  );
}

function PensionKeyCard({ address, onDisconnect }: { address: string; onDisconnect: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pension key</CardTitle>
        <CardDescription>
          The wallet you connected. It owns your pension and is the only key that can withdraw. It stays in your
          wallet app: SaverFi never holds it and never exports it.
        </CardDescription>
        <CardAction>
          <Button type="button" variant="outline" size="sm" onClick={onDisconnect}>
            <LogOut aria-hidden />
            Disconnect
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className={LABEL}>Address</div>
        <AddressLine address={address} />
      </CardContent>
    </Card>
  );
}

/** The same shape on the server and in the first client frame; after PRIVY_PATIENCE_MS, the reason instead. */
function ScreenSkeleton() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), PRIVY_PATIENCE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (slow) {
    return (
      <Card role="status">
        <CardHeader>
          <CardTitle>Privy has not loaded</CardTitle>
          <CardDescription>
            Wallet sign-in comes from Privy (auth.privy.io), and it has not answered. Reload the page. If this keeps
            happening, a browser extension may be blocking auth.privy.io, or this site&apos;s address is not an allowed
            origin of the Privy app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RefreshCw aria-hidden />
            Reload
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading wallets">
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-44 w-full rounded-xl" />
    </div>
  );
}
