"use client";

/**
 * The dashboard's sidebar. It no longer owns the modal — WalletsHost does, so
 * that the header's mobile sheet opens the same one — and this is now just the
 * seam that hands WalletActivity the host's opener.
 *
 * Under a host that opener always exists, so the trigger is always a button.
 * The null branch is what WalletActivity does OUTSIDE a host, where there is no
 * modal to open and /wallets is the only way through; it is kept because this
 * component must not depend on being mounted under one.
 */

import { WalletActivity } from "@/components/wallet-activity";
import { useWalletsOpener } from "@/components/wallets-host";
import type { ActivityEvent, Wallet } from "@/mocks/types";

export function DashboardWallets({
  wallet,
  activity,
  now,
  className,
}: {
  wallet: Wallet | null;
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
