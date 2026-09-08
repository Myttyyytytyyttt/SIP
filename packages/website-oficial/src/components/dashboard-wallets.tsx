"use client";

/**
 * The dashboard's sidebar. It no longer owns the modal — WalletsHost does, so
 * that the header's mobile sheet opens the same one — and this is now just the
 * seam that turns "Manage wallets" from a link into a button when the host says
 * wallets can be managed here.
 */

import { WalletActivity } from "@/components/wallet-activity";
import { useWalletsOpener } from "@/components/wallets-host";
import type { ActivityEvent, Wallet } from "@/mocks";

export function DashboardWallets({
  wallet,
  activity,
  now,
  className,
}: {
  wallet: Wallet;
  activity: readonly ActivityEvent[];
  now: string;
  className?: string;
}) {
  const open = useWalletsOpener();
  return (
    <WalletActivity
      wallet={wallet}
      activity={activity}
      now={now}
      className={className}
      {...(open === null ? {} : { onManageWallets: open })}
    />
  );
}
