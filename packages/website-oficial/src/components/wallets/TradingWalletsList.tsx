"use client";

/**
 * Every trading wallet this pension could know about, one row each.
 *
 * THE UNION OF TWO LISTS. What Privy holds for this user (created and
 * imported wallets) and what the vault's logs say (invited, activated,
 * revoked accounts). A wallet that Privy created and the link never finished
 * for exists in the first and not the second — and it is exactly the case
 * this list is FOR: HEAD's column listed only the chain's accounts, said
 * "None yet" over three real embedded wallets, and offered no way to repair
 * any of them.
 *
 * WHAT THE CHAIN SAYS, NOT WHAT THE LOG SCAN MISSED. A held wallet absent
 * from the vault's accounts is not thereby "not linked": the accounts come
 * from an eth_getLogs scan that can be truncated, and a LIVE wallet painted
 * as unlinked under a Link button whose invite reverts is the incident HEAD
 * recorded. So every such wallet is asked of the factory (`activeVaultOf`,
 * through /api/vault?account=) and an unreadable answer stays UNKNOWN.
 *
 * Ported from HEAD (fd927b0) src/components/WalletsPanel.tsx.
 */

import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useEffect, useMemo, useState } from "react";
import { getAddress, type Address } from "viem";

import { CreateWalletButton } from "@/components/wallets/CreateWalletButton";
import { ImportWalletDialog } from "@/components/wallets/ImportWalletDialog";
import { TradingWalletRow } from "@/components/wallets/TradingWalletRow";
import type { LinkStatus, VaultAccount } from "@/components/wallets/WalletsScreen";
import type { VaultByAccountResponse } from "@/lib/api-types";
import { LABEL } from "@/lib/classes";
import type { PublicConfig } from "@/lib/config";
import { parseTagged } from "@/lib/serialize";
import { describeError } from "@/lib/wallets/judge";

export type Origin = "created" | "imported" | "external";

export interface WalletRow {
  readonly address: Address;
  readonly origin: Origin;
  /** The wallet as Privy connects it — the only shape that can sign here — or null. */
  readonly wallet: ConnectedWallet | null;
  /** Whether Privy holds the key (created or imported). */
  readonly held: boolean;
  /** What the vault's logs say, or null when they say nothing. */
  readonly account: VaultAccount | null;
}

/** The factory's answer for a wallet the vault's logs do not list. */
export type LinkProbe =
  | { readonly kind: "listed" }
  | { readonly kind: "checking" }
  | { readonly kind: "free" }
  | { readonly kind: "here" }
  | { readonly kind: "elsewhere"; readonly vault: Address }
  | { readonly kind: "unknown"; readonly error: string };

/** Active first; the ones that can still put aside outrank the ones that cannot. */
const RANK: Record<LinkStatus | "NONE", number> = { ACTIVE: 0, PAUSED: 1, PENDING: 2, NONE: 3, REVOKED: 4 };

export function TradingWalletsList({
  config,
  admin,
  adminWallet,
  vault,
  accounts,
  accountsError,
  onChanged,
}: {
  config: PublicConfig;
  admin: Address;
  adminWallet: ConnectedWallet | null;
  vault: Address;
  accounts: readonly VaultAccount[];
  /** Why `accounts` may be INCOMPLETE, or null. Rendered as "may be incomplete", never as "no wallets". */
  accountsError: string | null;
  onChanged: () => void;
}) {
  const { user } = usePrivy();
  const { wallets } = useWallets();

  const rows = useMemo(() => {
    const byAddress = new Map<string, WalletRow>();
    // 1. Privy's connected embedded wallets — they can sign here.
    for (const wallet of wallets) {
      if (wallet.walletClientType !== "privy") continue;
      const address = getAddress(wallet.address);
      byAddress.set(address.toLowerCase(), {
        address,
        origin: wallet.imported ? "imported" : "created",
        wallet,
        held: true,
        account: null,
      });
    }
    // 2. Embedded wallets the user record knows but useWallets has not
    //    surfaced yet — createWallet() resolves before the hook catches up.
    for (const account of user?.linkedAccounts ?? []) {
      if (account.type !== "wallet" || account.chainType !== "ethereum" || account.walletClientType !== "privy") continue;
      const key = account.address.toLowerCase();
      if (byAddress.has(key)) continue;
      byAddress.set(key, {
        address: getAddress(account.address),
        origin: account.imported ? "imported" : "created",
        wallet: null,
        held: true,
        account: null,
      });
    }
    // 3. The vault's accounts — anything the chain knows, held here or not.
    for (const account of accounts) {
      const address = getAddress(account.address);
      const key = address.toLowerCase();
      const existing = byAddress.get(key);
      byAddress.set(key, existing !== undefined ? { ...existing, account } : { address, origin: "external", wallet: null, held: false, account });
    }
    return [...byAddress.values()].sort((a, b) => {
      const rank = RANK[a.account?.status ?? "NONE"] - RANK[b.account?.status ?? "NONE"];
      return rank !== 0 ? rank : a.address.localeCompare(b.address);
    });
  }, [wallets, user, accounts]);

  // The wallets the logs do not list, asked of the factory one by one.
  const unlisted = rows.filter((row) => row.account === null).map((row) => row.address);
  const unlistedKey = unlisted.join(",");
  const [probes, setProbes] = useState<Readonly<Record<string, LinkProbe>>>({});
  useEffect(() => {
    const list = unlistedKey === "" ? [] : (unlistedKey.split(",") as Address[]);
    if (list.length === 0) return;
    let live = true;
    setProbes((current) => {
      const next: Record<string, LinkProbe> = { ...current };
      for (const address of list) next[address.toLowerCase()] = { kind: "checking" };
      return next;
    });
    void Promise.all(
      list.map(async (address): Promise<readonly [string, LinkProbe]> => {
        try {
          const response = await fetch(`/api/vault?account=${address}`, { cache: "no-store" });
          const text = await response.text();
          if (!response.ok) return [address.toLowerCase(), { kind: "unknown", error: `HTTP ${response.status}` }];
          const { activeVaultOf } = parseTagged<VaultByAccountResponse>(text);
          if (activeVaultOf === null || BigInt(activeVaultOf) === 0n) return [address.toLowerCase(), { kind: "free" }];
          if (activeVaultOf.toLowerCase() === vault.toLowerCase()) return [address.toLowerCase(), { kind: "here" }];
          return [address.toLowerCase(), { kind: "elsewhere", vault: getAddress(activeVaultOf) }];
        } catch (error) {
          return [address.toLowerCase(), { kind: "unknown", error: describeError(error) }];
        }
      }),
    ).then((answers) => {
      if (!live) return;
      setProbes((current) => ({ ...current, ...Object.fromEntries(answers) }));
    });
    return () => {
      live = false;
    };
  }, [unlistedKey, vault]);

  const held = rows.filter((row) => row.held).map((row) => row.address);

  return (
    <section aria-labelledby="trading-wallets" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="trading-wallets" className="text-sm font-medium">
            Trading wallets
          </h2>
          <p className="text-xs text-muted-foreground">
            Each one puts aside its rate of every buy and sell. Only the pension key can withdraw.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <ImportWalletDialog config={config} admin={admin} vault={vault} embedded={held} onImported={onChanged} />
          <CreateWalletButton config={config} hasEmbedded={held.length > 0} onCreated={onChanged} />
        </div>
      </div>

      {accountsError !== null ? (
        <p role="status" className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
          This list may be incomplete — the vault&apos;s logs could not be fully read: {accountsError}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border p-6 text-center">
          <p className="text-sm">No trading wallets yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one and Privy holds its key, or import the wallet you already trade with. Then link it.
          </p>
        </div>
      ) : (
        <>
          <ul className="divide-y rounded-lg border">
            {rows.map((row) => (
              <TradingWalletRow
                key={row.address}
                row={row}
                probe={row.account !== null ? { kind: "listed" } : (probes[row.address.toLowerCase()] ?? { kind: "checking" })}
                config={config}
                admin={admin}
                adminWallet={adminWallet}
                vault={vault}
                onChanged={onChanged}
              />
            ))}
          </ul>
          <p className={LABEL}>
            {rows.length} {rows.length === 1 ? "wallet" : "wallets"}
          </p>
        </>
      )}
    </section>
  );
}
