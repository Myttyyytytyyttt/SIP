import { Settings } from "lucide-react";
import type { ReactNode } from "react";

import { ActivityRow } from "@/components/activity-row";
import { CopyButton } from "@/components/copy-button";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SheetClose } from "@/components/ui/sheet";
import { LABEL, MONO } from "@/lib/classes";
import { relativeDayLabel, shortHex, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityEvent, Wallet } from "@/mocks/types";

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
    // No block time, no day: its own bucket, headed "Time unknown", rather than filed under today.
    const date = event.at === null ? "" : event.at.slice(0, 10);
    const bucket = groups.get(date);
    if (bucket) bucket.push(event);
    else groups.set(date, [event]);
  }
  return Array.from(groups);
}

/**
 * WHAT ONLY A LIVE PAGE PUTS IN THIS COLUMN (src/components/live/LiveColumn.tsx
 * builds each piece). Every slot is one the sample never fills, so without this
 * the column is the sample's exactly.
 */
export interface LiveColumnSlots {
  /** Under the lead wallet's balance: whatever about that wallet needs saying (a link it lacks, a reserve it cannot clear). */
  readonly below: ReactNode;
  /** In place of the address and balance when no single wallet can lead: every wallet, listed. */
  readonly list: ReactNode;
  /** Over the rows: the history could not be read, and the retry. */
  readonly banner: ReactNode;
  /** Under the rows: what the feed leaves out, counted, and the control that opens it. */
  readonly hidden: ReactNode;
  /** What a feed with nothing to list says instead — never nothing. */
  readonly empty: string;
  /** Inside the header's sheet: pressing Manage wallets closes the sheet before the modal opens. */
  readonly inSheet: boolean;
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
  live,
}: {
  /** Null when there is no single wallet to lead with; the header then names no address and no balance. */
  wallet: Wallet | null;
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
  /** A live page's own pieces. Absent on the sample. */
  live?: LiveColumnSlots;
}) {
  const groups = groupByDay(activity);
  // What the right of the bar counts: the sample's trades, or — on a live page — the settlements that stand for them.
  const trades = activity.filter((event) => event.kind === (live === undefined ? "trade" : "saved")).length;
  // The first row takes the feed's one Tab stop; the rest are reached with the arrows.
  const firstId = activity[0]?.id;

  return (
    <div id={id} className={cn("flex h-full flex-col bg-background", className)}>
      <div className="space-y-3 border-b p-4">
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL}>{wallet?.label ?? "Trading wallets"}</span>
          {/* The ui Button carries the focus ring either way — link or modal. */}
          {onManageWallets === undefined ? (
            <Button variant="link" size="sm" asChild className={MANAGE}>
              <a href="/wallets">
                Manage wallets
                <Settings className="size-3.5" aria-hidden />
              </a>
            </Button>
          ) : live?.inSheet === true ? (
            // A modal opened from inside an overlay is two focus traps and an
            // Escape that closes the wrong one: the sheet goes first.
            <SheetClose asChild>
              <Button type="button" variant="link" size="sm" className={MANAGE} onClick={onManageWallets}>
                Manage wallets
                <Settings className="size-3.5" aria-hidden />
              </Button>
            </SheetClose>
          ) : (
            <Button type="button" variant="link" size="sm" className={MANAGE} onClick={onManageWallets}>
              Manage wallets
              <Settings className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
        {wallet === null ? (
          (live?.list ?? null)
        ) : (
          <>
            <div className="flex items-center gap-1">
              <Num className="text-sm">{shortHex(wallet.address)}</Num>
              <CopyButton value={wallet.address} />
            </div>
            <div className="space-y-0.5">
              <div className={LABEL}>Balance</div>
              <div className={cn(MONO, "text-2xl font-semibold")}>{usd(wallet.balanceUsd)}</div>
            </div>
            {live?.below ?? null}
          </>
        )}
      </div>

      <ScrollArea className={FEED}>
        {live?.banner ?? null}
        {/* Nothing to list is a sentence, never an empty column — and never "no activity yet" over a read that failed. */}
        {live !== undefined && activity.length === 0 && live.banner === null ? (
          <div className="px-4 py-6">
            <p className="text-sm text-muted-foreground">{live.empty}</p>
          </div>
        ) : null}
        {groups.map(([date, events]) => (
          <div key={date === "" ? "unknown" : date}>
            <div className="sticky top-0 z-10 bg-background px-4 py-2 text-xs text-muted-foreground">
              {date === "" ? "Time unknown" : relativeDayLabel(date, now)}
            </div>
            {events.map((event) => (
              <ActivityRow key={event.id} event={event} now={now} first={event.id === firstId} />
            ))}
          </div>
        ))}
        {live?.hidden ?? null}
      </ScrollArea>

      <div className="flex justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
        <span>
          <Num>{activity.length}</Num> events
        </span>
        <span>
          <Num>{trades}</Num> {live === undefined ? "trades" : trades === 1 ? "settlement" : "settlements"}
        </span>
      </div>
    </div>
  );
}
