"use client";

/**
 * THE SIDEBAR: whose pension this is, what saves into it, and what it did.
 *
 * IT IS THE SAMPLE'S COLUMN (src/components/wallet-activity.tsx), wired to the
 * chain: the same header block — a label with Manage wallets, the address with
 * a copy button, one balance in LABEL-over-figure — the same feed under it, and
 * the same counted bar at its foot. Nothing here says anything the sample's
 * column does not, except where a real account has something its one invented
 * wallet could not.
 *
 * WHICH IS THIS, AND IT IS WHY THE COLUMN EXISTS: the pension key is not a
 * trading wallet and gets its own line; there is any number of trading wallets
 * rather than one; and a wallet that is NOT linked saves nothing, which is the
 * single most useful thing this column can say.
 *
 * A LINK'S STATUS HAS FOUR ANSWERS, not two: linked here, linked to somebody
 * else's vault, not linked, and could-not-be-read. The last is never collapsed
 * into "not linked", because offering to link a wallet that may already be
 * linked asks for a signature the program refuses.
 *
 * MOUNTED TWICE, deliberately: in the aside from lg up, and inside the header's
 * sheet below it. They must never share a DOM id, or the roving Tab stop in one
 * would walk the rows of the other. From inside the sheet the Manage wallets
 * button closes the sheet first (SheetClose), because a modal opened from within
 * an overlay is two focus traps and an Escape that closes the wrong one.
 */

import { Settings } from "lucide-react";

import { FeedFooter, LiveActivityFeed } from "@/components/live/LiveActivityFeed";
import { CopyButton } from "@/components/copy-button";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SheetClose } from "@/components/ui/sheet";
import { formatSol, formatUsd, rawFrom, usdcRawForLamports } from "@/lib/amounts";
import { LABEL, MONO } from "@/lib/classes";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard, LiveWalletView } from "@/lib/live-types";
import { cn } from "@/lib/utils";
import { shortAddress } from "@/lib/vault-copy";

/**
 * Radix wraps the viewport's children in an inline `display:table` div, so the
 * feed is as wide as its widest row and `truncate` never engages. Back to block
 * — the trailing `!` is what beats the inline style.
 */
const FEED = "min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!";

/** The one look "Manage wallets" has, in the aside and in the sheet alike. */
const MANAGE = "h-auto p-0 text-xs text-muted-foreground underline hover:text-foreground";

const LINK = "rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const solscanAccountUrl = (address: string): string => `https://solscan.io/account/${address}`;

/** One wallet's link, as a badge. Four outcomes, and each is said as itself. */
function LinkBadge({ wallet }: { readonly wallet: LiveWalletView }) {
  if (wallet.linkStatus === "this_vault") {
    return (
      <a href={solscanAccountUrl(wallet.linkAddress)} target="_blank" rel="noopener noreferrer" className="rounded-4xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <Badge variant="secondary" title={LIVE_COPY.viewLink}>
          {LIVE_COPY.badgeLinked}
        </Badge>
      </a>
    );
  }
  if (wallet.linkStatus === "other_vault") return <Badge variant="destructive">{LIVE_COPY.badgeOtherVault}</Badge>;
  if (wallet.linkStatus === "unreadable") return <Badge variant="outline">{LIVE_COPY.badgeLinkUnreadable}</Badge>;
  return <Badge variant="outline">{LIVE_COPY.badgeNotLinked}</Badge>;
}

/**
 * ONE FIGURE IN THIS COLUMN IS ALLOWED TO BE BIG, and it is the balance of the
 * wallet that actually saves — the sample's own Balance block, in the row it
 * belongs to. The sample can put it in the header because it has one wallet;
 * hoisting a trading wallet's balance under the pension key would say it was
 * the pension's.
 *
 * AT MOST ONE ROW IS PROMOTED, and only when it is unambiguous — one wallet,
 * or exactly one linked to this vault. Several large numbers stacked is not an
 * anchor, it is a wall, and it would push the feed off the screen.
 *
 * A BALANCE NOBODY COULD READ IS NEVER PROMOTED: "—" at 24px is a hole, and
 * the row keeps its quiet line instead.
 */
function anchorOf(wallets: readonly LiveWalletView[]): string | null {
  const readable = wallets.filter((wallet) => wallet.lamports !== null);
  if (readable.length === 1) return readable[0]!.address;
  const linked = readable.filter((wallet) => wallet.linkStatus === "this_vault");
  return linked.length === 1 ? linked[0]!.address : null;
}

function WalletRow({ wallet, usdcRawPerSol, anchor }: { readonly wallet: LiveWalletView; readonly usdcRawPerSol: bigint | null; readonly anchor: boolean }) {
  const balance = wallet.lamports === null ? null : formatSol(wallet.lamports);
  const dollars = wallet.lamports === null || usdcRawPerSol === null ? null : formatUsd(usdcRawForLamports(wallet.lamports, usdcRawPerSol));
  const settlements = wallet.settlementNonce === null ? null : LIVE_COPY.settlementCount(wallet.settlementNonce.toString());

  return (
    <li className="space-y-1 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{wallet.label}</span>
        <LinkBadge wallet={wallet} />
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Num className="text-xs">{shortAddress(wallet.address)}</Num>
        <CopyButton value={wallet.address} />
      </div>
      {anchor ? (
        /*
         * DOLLARS LEAD, SOL SITS UNDER THEM — the sample's shape, and a balance
         * converted at today's pool price is a figure this screen can source.
         *
         * UNLESS THE POOLS WERE NOT READ, and then SOL leads: a hero reading
         * "—" is worse than a hero in the unit the chain actually records.
         */
        <div className="space-y-0.5 pt-0.5">
          <div className={LABEL}>{LIVE_COPY.walletBalance}</div>
          <div className={cn(MONO, "text-2xl font-semibold")}>{dollars ?? `${balance ?? ""} SOL`}</div>
          {/* The SOL line exists to keep the chain's own unit under a dollar
              conversion. With no conversion the figure above IS that line, and
              it was printing the same thing twice, stacked. */}
          {dollars === null && settlements === null ? null : (
            <div className="text-xs text-muted-foreground">
              {dollars === null ? null : <Num className="text-xs">{balance === null ? LIVE_COPY.unknownFigure : `${balance} SOL`}</Num>}
              {dollars !== null && settlements !== null ? <> · </> : null}
              {settlements}
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          <Num>{balance === null ? LIVE_COPY.unknownFigure : `${balance} SOL`}</Num>
          {dollars === null ? null : <> ≈ {dollars}</>}
          {settlements === null ? null : <> · {settlements}</>}
        </div>
      )}
      {/* Linked, funded below the floor: nothing can be settled from it yet. */}
      {wallet.canSettle === false && wallet.linkStatus === "this_vault" ? <p className="text-xs text-amber-700 dark:text-amber-400">{LIVE_COPY.reserveNoteShort}</p> : null}
    </li>
  );
}

export function LiveSidebar({
  data,
  pensionKey,
  now,
  labelOf,
  id,
  inSheet = false,
  onOpenWallets,
  onRetryActivity,
  activityUnreadable,
  activityRetryAt = null,
  nowMs,
  emptyNote,
  className,
}: {
  readonly data: LiveDashboard;
  readonly pensionKey: string;
  readonly now: string;
  readonly labelOf: (wallet: string | null) => string;
  /** This column's own id: the aside and the sheet must never share one. */
  readonly id: string;
  readonly inSheet?: boolean;
  readonly onOpenWallets: () => void;
  readonly onRetryActivity?: () => void;
  /**
   * The history could not be read, so the feed says that instead of "none yet".
   *
   * REQUIRED, and deliberately so. It defaulted to false, no caller passed it,
   * and the honest branch below was dead code for every real failure.
   */
  readonly activityUnreadable: boolean;
  /** When the server said the history may be asked for again. */
  readonly activityRetryAt?: number | null;
  /** The BROWSER's clock, for the retry countdown only. */
  readonly nowMs?: number;
  readonly emptyNote?: string;
  readonly className?: string;
}) {
  const usdcRawPerSol = rawFrom(data.prices?.usdcRawPerSol);
  // FROM settlementRows, NOT the feed. A settlement read from a wallet's link
  // is deliberately not in the vault's page, and a footer reading "0
  // settlements" under a strip showing one is the screen disagreeing with
  // itself. `transactions` stays the feed's own count; the disclosure inside
  // the feed counts what it leaves out.
  const settlements = data.settlementRows.length;
  const anchor = anchorOf(data.wallets);

  const manage = (
    <Button type="button" variant="link" size="sm" className={MANAGE} onClick={onOpenWallets}>
      {LIVE_COPY.manageWallets}
      <Settings className="size-3.5" aria-hidden />
    </Button>
  );

  return (
    <div id={id} className={cn("flex h-full flex-col bg-background", className)}>
      <div className="space-y-4 border-b p-4">
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL}>{LIVE_COPY.pensionKey}</span>
          {inSheet ? <SheetClose asChild>{manage}</SheetClose> : manage}
        </div>
        <div className="flex items-center gap-1">
          <Num className="text-sm">{shortAddress(pensionKey)}</Num>
          <CopyButton value={pensionKey} />
          {/* The key is the one account a stranger can check this whole page against. */}
          <a href={solscanAccountUrl(pensionKey)} target="_blank" rel="noopener noreferrer" className={LINK}>
            {LIVE_COPY.solscanAccount}
          </a>
        </div>

        <div className="space-y-2">
          <span className={LABEL}>{LIVE_COPY.tradingWallets}</span>
          {data.wallets.length === 0 ? (
            <p className="text-xs text-muted-foreground">{LIVE_COPY.noWalletsYet}</p>
          ) : (
            <ul className="space-y-2">
              {data.wallets.map((wallet) => (
                <WalletRow key={wallet.address} wallet={wallet} usdcRawPerSol={usdcRawPerSol} anchor={wallet.address === anchor} />
              ))}
            </ul>
          )}
        </div>
      </div>

      <ScrollArea className={FEED}>
        <LiveActivityFeed
          rows={data.rows}
          now={now}
          labelOf={labelOf}
          maxContribution={data.vault.maxContribution}
          id={id}
          hiddenRows={data.hiddenRows}
          hiddenUpkeep={data.hiddenUpkeep}
          hiddenDust={data.hiddenDust}
          unreadable={activityUnreadable}
          retryAt={activityRetryAt}
          {...(nowMs === undefined ? {} : { nowMs })}
          {...(onRetryActivity === undefined ? {} : { onRetry: onRetryActivity })}
          {...(emptyNote === undefined ? {} : { emptyNote })}
        />
      </ScrollArea>

      {/*
        The sample's counted bar, with this chain's two counts in it.

        TRANSACTIONS COUNTS WHAT THE PAGE HOLDS, NOT WHAT THE FEED LISTS. On
        2026-09-19 twelve of fifteen loaded signatures were keeper upkeep, and
        a bar reading "0 transactions" sat directly under a disclosure reading
        "15 account upkeep transactions hidden" — the column contradicting
        itself inside sixty pixels. The hidden rows are transactions; they are
        behind a control, not absent.

        AND NEITHER COUNT IS A LIFETIME. Both are over the pages loaded so far,
        which on this page has no neighbour to say so — so the bar says it
        itself, on its title rather than on a line of its own.
      */}
      <div className="flex justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
        <FeedFooter transactions={data.rows.length + data.hiddenRows.length} settlements={settlements} title={ACTIVITY_COPY.countsAreLoaded} />
        <a href="/activity" className={LINK}>
          {ACTIVITY_COPY.seeAll}
        </a>
      </div>
    </div>
  );
}
