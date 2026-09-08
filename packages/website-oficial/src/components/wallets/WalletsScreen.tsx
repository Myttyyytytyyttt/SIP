"use client";

/**
 * The wallets surface, past the server's configuration check: the pension-key
 * gate, then the vault this key owns, its trading wallets, and what each has
 * put aside.
 *
 * TWO CONTAINERS, ONE COMPONENT. The /wallets route renders it as a page; the
 * dashboard's <WalletsModal> renders it inside a Dialog. Nothing forks: the
 * route passes `{ config }` and gets exactly what it always got, and the modal
 * passes `view` + `variant="modal"` to drive the flows and to drop the chrome
 * the dialog already provides. Only the edges move.
 *
 * WHERE THE FLOWS LIVE. On the page, Import and Link are Dialogs of their own.
 * In the modal they cannot be — two overlays, two focus traps, one Escape key.
 * So the shell owns a view and publishes it on a context; the flow components
 * read it with `useWalletsView()` and swap themselves in place of the list.
 * The context is absent (null) on the route, which is the signal to keep the
 * Dialogs. Prop drilling would have crossed three owners' files to reach them.
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
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { cn } from "@/lib/utils";
import { describeError } from "@/lib/wallets/judge";

/** The wire shapes of GET /api/vault, under the names the rows use. */
export type LinkStatus = VaultAccountStatus;
export type VaultAccount = VaultAccountView;
export type VaultResponse = VaultByAdminResponse;

// ── the shell contract: what a modal container drives, what the flows read ──

/** Which container this is in. `"modal"` drops the page-level chrome the dialog already draws. */
export type WalletsVariant = "page" | "modal";

/**
 * The one view on screen inside the modal. `link` names the wallet by address:
 * the row that owns that address already holds its ConnectedWallet and its
 * vault account, so nothing has to be carried through the shell.
 */
export type WalletsView =
  | { readonly kind: "list" }
  | { readonly kind: "import" }
  | { readonly kind: "link"; readonly address: Address };

/** How a flow asks the shell to change view. The shell owns the state; the flows only ask. */
export interface WalletsViewApi {
  readonly view: WalletsView;
  /** Take over the modal body — `show({ kind: "import" })`, `show({ kind: "link", address })`. */
  readonly show: (next: WalletsView) => void;
  /** Back to the list. The shell's header renders this too; a flow calls it when it finishes or cancels. */
  readonly back: () => void;
  /**
   * Hold the shell open. A flow raises this while a signature or an import is
   * in flight — it is the same lock the flows' own Dialogs use on /wallets
   * (`showCloseButton={busy === null}`), moved to the one shell that now owns
   * the chrome. Always lower it again, in a finally.
   */
  readonly setBusy: (busy: boolean) => void;
}

const WalletsViewContext = createContext<WalletsViewApi | null>(null);

/**
 * The modal's view API, or null when there is no modal — on /wallets each flow
 * keeps its own Dialog. `null` is the whole test: `const view = useWalletsView()`,
 * then `view === null ? <Dialog…> : <the same body, inline>`.
 */
export function useWalletsView(): WalletsViewApi | null {
  return useContext(WalletsViewContext);
}

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

export function WalletsScreen({
  config,
  view = null,
  variant,
}: {
  config: PublicConfig;
  /** A modal container's view state. Absent on the route, where every flow keeps its own Dialog. */
  view?: WalletsViewApi | null;
  /** Defaults to "modal" when `view` is given — the two always travel together, but say it anyway. */
  variant?: WalletsVariant;
}) {
  const { ready, authenticated, user, login, logout, linkWallet } = usePrivy();
  const surface: WalletsVariant = variant ?? (view === null ? "page" : "modal");

  const body = (() => {
    if (!ready) return <ScreenSkeleton />;

    if (!authenticated || user === null) {
      return (
        <Panel
          variant={surface}
          title="Connect your pension key"
          description="The wallet you connect owns the pension. Only it can withdraw — the team has no access to your funds. Your trading wallets are separate, and never hold the savings."
        >
          <Button type="button" onClick={() => login()}>
            Connect pension key
          </Button>
        </Panel>
      );
    }

    const admin = pensionKeyOf(user);
    if (admin === null) {
      return (
        <Panel
          variant={surface}
          title="No pension key on this session"
          description="You are signed in without an external wallet. The pension key must be a wallet you hold yourself — connect one to continue."
          bodyClassName="flex flex-wrap gap-2"
        >
          <Button type="button" onClick={() => linkWallet()}>
            Connect a wallet
          </Button>
          <Button type="button" variant="outline" onClick={() => void logout()}>
            <LogOut aria-hidden />
            Disconnect
          </Button>
        </Panel>
      );
    }

    return <VaultView admin={admin} config={config} variant={surface} view={view} onDisconnect={() => void logout()} />;
  })();

  // Published even when null, so a flow nested any depth down can ask.
  return <WalletsViewContext.Provider value={view}>{body}</WalletsViewContext.Provider>;
}

function VaultView({
  admin,
  config,
  variant,
  view,
  onDisconnect,
}: {
  admin: Address;
  config: PublicConfig;
  variant: WalletsVariant;
  view: WalletsViewApi | null;
  onDisconnect: () => void;
}) {
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

  // A flow has taken over the body: everything that is not the flow steps out
  // of the way, so the modal reads as one task and not as a page with a form
  // buried in it. On the page there is no flow and nothing ever hides.
  const inFlow = view !== null && view.view.kind !== "list";

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
      {inFlow ? null : (
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
      )}

      {read.status === "loading" ? (
        <VaultSkeleton />
      ) : read.status === "unknown" ? (
        <Panel
          variant={variant}
          title="Pension unknown"
          description="The chain could not be read, so nothing here is known — not even whether a pension exists."
          bodyClassName="space-y-3"
        >
          <p role="alert" className="text-sm text-destructive">
            {read.error}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            <RefreshCw aria-hidden />
            Try again
          </Button>
        </Panel>
      ) : read.value.vault === null ? (
        <CreateVaultCard admin={admin} config={config} wallet={adminWallet} onCreated={reload} />
      ) : (
        <VaultDetails
          admin={admin}
          adminWallet={adminWallet}
          config={config}
          vault={read.value.vault}
          data={read.value}
          inFlow={inFlow}
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
  inFlow,
  onChanged,
}: {
  admin: Address;
  adminWallet: ConnectedWallet | null;
  config: PublicConfig;
  vault: Address;
  data: VaultResponse;
  /** True while an import or link view owns the modal body: everything around it stands down. */
  inFlow: boolean;
  onChanged: () => void;
}) {
  const address = getAddress(vault);
  const explorer = explorerAddressUrl(config.explorerUrl, address);
  const linked = data.accounts.filter((account) => account.status === "ACTIVE" || account.status === "PAUSED").length;

  return (
    <>
      {inFlow ? null : (
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
      )}

      {/* Always mounted: it holds the flows, and it is what swaps itself for one. */}
      <TradingWalletsList
        config={config}
        admin={admin}
        adminWallet={adminWallet}
        vault={address}
        accounts={data.accounts}
        accountsError={data.accountsError}
        onChanged={onChanged}
      />

      {inFlow ? null : (
        <SkimStatus vault={address} wallets={data.accounts.map((account) => getAddress(account.address))} />
      )}
    </>
  );
}

/**
 * A whole-surface state — connect, no key, unknown.
 *
 * On the page it is a Card. In the modal the dialog IS the card, so the frame
 * goes and the same words come back as a section heading — a framed box inside
 * a framed box reads as a mistake, but the state still has to name itself.
 */
function Panel({
  variant,
  title,
  description,
  bodyClassName,
  children,
}: {
  variant: WalletsVariant;
  title: string;
  description: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  if (variant === "modal") {
    return (
      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className={cn(bodyClassName)}>{children}</div>
      </section>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className={cn(bodyClassName)}>{children}</CardContent>
    </Card>
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
