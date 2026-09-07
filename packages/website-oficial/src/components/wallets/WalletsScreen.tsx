"use client";

/**
 * The wallets page, past the server's configuration check: the pension-key
 * gate, then the vault this key owns, its trading wallets, and what each has
 * put aside.
 *
 * HYDRATION. Nothing here renders before `ready` from usePrivy(): the server
 * paints the skeleton and so does the first client frame, so no Privy or
 * wallet state can differ between the two.
 *
 * THE PENSION KEY IS THE WALLET THE USER SIGNED IN WITH — an external EOA,
 * never an embedded one. It holds the withdrawal key for every saving in the
 * vault, and an email-recoverable custody model is the wrong place for that.
 *
 * Ported from HEAD (fd927b0) src/components/Onboarding.tsx (the vault-first
 * shape) and src/components/WalletsPanel.tsx; Solana, baskets and profit dropped.
 */

import { usePrivy, useWallets, type ConnectedWallet, type User } from "@privy-io/react-auth";
import { ExternalLink, LogOut, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAddress, type Address } from "viem";

import { CopyButton } from "@/components/copy-button";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateVaultCard } from "@/components/wallets/CreateVaultCard";
import { SkimStatus } from "@/components/wallets/SkimStatus";
import { TradingWalletsList } from "@/components/wallets/TradingWalletsList";
import type { ApiError, VaultAccountStatus, VaultAccountView, VaultByAdminResponse } from "@/lib/api-types";
import { explorerAddressUrl } from "@/lib/chain";
import { LABEL } from "@/lib/classes";
import type { PublicConfig } from "@/lib/config";
import { shortHex } from "@/lib/format";
import { parseTagged } from "@/lib/serialize";
import { describeError } from "@/lib/wallets/judge";

/** The wire shapes of GET /api/vault, under the names the rows use. */
export type LinkStatus = VaultAccountStatus;
export type VaultAccount = VaultAccountView;
export type VaultResponse = VaultByAdminResponse;

/** A failed read is UNKNOWN — never "no vault", never an empty list. */
type VaultRead =
  | { readonly status: "loading" }
  | { readonly status: "unknown"; readonly error: string }
  | { readonly status: "ok"; readonly value: VaultResponse };

/** The pension key: the wallet the user signed in with — never an embedded one. */
export function pensionKeyOf(user: User): Address | null {
  const primary = user.wallet;
  if (primary !== undefined && primary.chainType === "ethereum" && primary.walletClientType !== "privy") {
    return getAddress(primary.address);
  }
  for (const account of user.linkedAccounts) {
    if (account.type === "wallet" && account.chainType === "ethereum" && account.walletClientType !== "privy") {
      return getAddress(account.address);
    }
  }
  return null;
}

export function WalletsScreen({ config }: { config: PublicConfig }) {
  const { ready, authenticated, user, login, logout, linkWallet } = usePrivy();

  if (!ready) return <ScreenSkeleton />;

  if (!authenticated || user === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connect your pension key</CardTitle>
          <CardDescription>
            The wallet you connect owns the pension. Only it can withdraw — the team has no access to your funds. Your
            trading wallets are separate, and never hold the savings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" onClick={() => login()}>
            Connect pension key
          </Button>
        </CardContent>
      </Card>
    );
  }

  const admin = pensionKeyOf(user);
  if (admin === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No pension key on this session</CardTitle>
          <CardDescription>
            You are signed in without an external wallet. The pension key must be a wallet you hold yourself — connect
            one to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => linkWallet()}>
            Connect a wallet
          </Button>
          <Button type="button" variant="outline" onClick={() => void logout()}>
            <LogOut aria-hidden />
            Disconnect
          </Button>
        </CardContent>
      </Card>
    );
  }

  return <VaultView admin={admin} config={config} onDisconnect={() => void logout()} />;
}

function VaultView({ admin, config, onDisconnect }: { admin: Address; config: PublicConfig; onDisconnect: () => void }) {
  const { connectWallet } = usePrivy();
  const { wallets } = useWallets();
  // The pension key as Privy connects it — what signs. Null when the browser
  // has not (re)connected it, which the row below says rather than hides.
  const adminWallet = useMemo(
    () =>
      wallets.find((wallet) => wallet.walletClientType !== "privy" && wallet.address.toLowerCase() === admin.toLowerCase()) ??
      null,
    [wallets, admin],
  );

  const [read, setRead] = useState<VaultRead>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    // A refetch keeps the last good answer on screen; only the first read shows a skeleton.
    setRead((current) => (current.status === "ok" ? current : { status: "loading" }));
    void (async () => {
      try {
        const response = await fetch(`/api/vault?admin=${admin}`, { cache: "no-store" });
        const text = await response.text();
        if (cancelled) return;
        if (!response.ok) {
          let message = `HTTP ${response.status}`;
          try {
            const body = JSON.parse(text) as Partial<ApiError>;
            if (typeof body.error === "string") message = body.error;
          } catch {
            /* keep the status */
          }
          setRead({ status: "unknown", error: message });
          return;
        }
        setRead({ status: "ok", value: parseTagged<VaultResponse>(text) });
      } catch (error) {
        if (!cancelled) setRead({ status: "unknown", error: describeError(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [admin, tick]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
        <span className={LABEL}>Pension key</span>
        <Num className="text-sm">{shortHex(admin)}</Num>
        <CopyButton value={admin} />
        {adminWallet === null ? (
          <Button type="button" variant="outline" size="xs" onClick={() => connectWallet()}>
            Reconnect to sign
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onDisconnect}>
          <LogOut aria-hidden />
          Disconnect
        </Button>
      </div>

      {read.status === "loading" ? (
        <VaultSkeleton />
      ) : read.status === "unknown" ? (
        <Card>
          <CardHeader>
            <CardTitle>Pension unknown</CardTitle>
            <CardDescription>
              The chain could not be read, so nothing here is known — not even whether a pension exists.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {read.error}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={reload}>
              <RefreshCw aria-hidden />
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : read.value.vault === null ? (
        <CreateVaultCard admin={admin} config={config} wallet={adminWallet} onCreated={reload} />
      ) : (
        <VaultDetails
          admin={admin}
          adminWallet={adminWallet}
          config={config}
          vault={read.value.vault}
          data={read.value}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function VaultDetails({
  admin,
  adminWallet,
  config,
  vault,
  data,
  onChanged,
}: {
  admin: Address;
  adminWallet: ConnectedWallet | null;
  config: PublicConfig;
  vault: Address;
  data: VaultResponse;
  onChanged: () => void;
}) {
  const address = getAddress(vault);
  const explorer = explorerAddressUrl(config.explorerUrl, address);
  const linked = data.accounts.filter((account) => account.status === "ACTIVE" || account.status === "PAUSED").length;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Your pension</CardTitle>
          <CardDescription>
            Everything put aside lands here. Only the pension key can withdraw; the trading wallets below can only add.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <div className={LABEL}>Address</div>
            <div className="flex flex-wrap items-center gap-1">
              <Num className="break-all text-sm">{address}</Num>
              <CopyButton value={address} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span>
              <span className={LABEL}>Cohort</span> <Num>{String(data.cohortId)}</Num>
            </span>
            <span>
              <span className={LABEL}>Linked</span> <Num>{linked}</Num>
              {data.accountsError !== null ? <span className="text-muted-foreground"> or more</span> : null}
            </span>
            {explorer !== null ? (
              <Button variant="outline" size="sm" asChild className="ml-auto">
                <a href={explorer} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden />
                  View on explorer
                </a>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <TradingWalletsList
        config={config}
        admin={admin}
        adminWallet={adminWallet}
        vault={address}
        accounts={data.accounts}
        accountsError={data.accountsError}
        onChanged={onChanged}
      />

      <SkimStatus vault={address} wallets={data.accounts.map((account) => getAddress(account.address))} />
    </>
  );
}

// ── skeletons: the same shape on the server and in the first client frame ───

function ScreenSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-10 w-full" />
      <VaultSkeleton />
    </div>
  );
}

function VaultSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-36 w-full rounded-xl" />
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full rounded-lg" />
    </div>
  );
}
