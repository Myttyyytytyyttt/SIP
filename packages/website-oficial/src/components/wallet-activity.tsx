import { Settings } from "lucide-react";

import { ActivityRow } from "@/components/activity-row";
import { CopyButton } from "@/components/copy-button";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LABEL, MONO } from "@/lib/classes";
import { relativeDayLabel, shortHex, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityEvent, Wallet } from "@/mocks";

/**
 * Radix wraps the viewport's children in an inline `display:table` div, so
 * the feed is as wide as its widest row and `truncate` never engages. Back to
 * block — the trailing `!` is what beats the inline style.
 */
const FEED = "min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!";

/** The one look "Manage wallets" has, whether it navigates or opens the modal. */
const MANAGE = "h-auto p-0 text-xs text-muted-foreground underline hover:text-foreground";

/** Newest first in, newest first out — one bucket per UTC day, in arrival order. */
function groupByDay(activity: readonly ActivityEvent[]): ReadonlyArray<readonly [string, readonly ActivityEvent[]]> {
  const groups = new Map<string, ActivityEvent[]>();
  for (const event of activity) {
    const date = event.at.slice(0, 10);
    const bucket = groups.get(date);
    if (bucket) bucket.push(event);
    else groups.set(date, [event]);
  }
  return Array.from(groups);
}

/**
 * What the wallet did, newest first. Mounted in the desktop aside and in the
 * mobile sheet alike, so it assumes nothing about its container beyond a
 * height to fill — and paints its own surface, since the sticky day headers
 * are `bg-background` and the sheet underneath is `bg-popover`.
 */
export function WalletActivity({
  wallet,
  activity,
  now,
  className,
  id = "activity",
  onManageWallets,
}: {
  wallet: Wallet;
  activity: readonly ActivityEvent[];
  now: string;
  className?: string;
  /** The desktop column is `#activity` (the nav links to it); the sheet passes its own so the two never share an id. */
  id?: string;
  /**
   * Manage the wallets without leaving the dashboard. Optional on purpose: this
   * component is also mounted inside the header's sheet, and a modal opened from
   * inside an overlay is two focus traps and an Escape that closes the wrong one.
   * Absent, it stays a link to /wallets — the same screen, one navigation away.
   */
  onManageWallets?: () => void;
}) {
  const groups = groupByDay(activity);
  const trades = activity.filter((event) => event.kind === "trade").length;

  return (
    <div id={id} className={cn("flex h-full flex-col bg-background", className)}>
      <div className="space-y-3 border-b p-4">
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL}>{wallet.label}</span>
          {/* The ui Button carries the focus ring either way — link or modal. */}
          {onManageWallets === undefined ? (
            <Button variant="link" size="sm" asChild className={MANAGE}>
              <a href="/wallets">
                Manage wallets
                <Settings className="size-3.5" aria-hidden />
              </a>
            </Button>
          ) : (
            <Button type="button" variant="link" size="sm" className={MANAGE} onClick={onManageWallets}>
              Manage wallets
              <Settings className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Num className="text-sm">{shortHex(wallet.address)}</Num>
          <CopyButton value={wallet.address} />
        </div>
        <div className="space-y-0.5">
          <div className={LABEL}>Balance</div>
          <div className={cn(MONO, "text-2xl font-semibold")}>{usd(wallet.balanceUsd)}</div>
        </div>
      </div>

      <ScrollArea className={FEED}>
        {groups.map(([date, events]) => (
          <div key={date}>
            <div className="sticky top-0 z-10 bg-background px-4 py-2 text-xs text-muted-foreground">
              {relativeDayLabel(date, now)}
            </div>
            {events.map((event) => (
              <ActivityRow key={event.id} event={event} now={now} />
            ))}
          </div>
        ))}
      </ScrollArea>

      <div className="flex justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span>
          <Num>{activity.length}</Num> events
        </span>
        <span>
          <Num>{trades}</Num> trades
        </span>
      </div>
    </div>
  );
}
