"use client";

/**
 * WHAT ONLY A LIVE PAGE PUTS IN THE SAMPLE'S COLUMN.
 *
 * The column is the sample's own (src/components/wallet-activity.tsx): its
 * header, its day-grouped feed, its counted bar. A real account has a few
 * things the sample's one invented wallet cannot, and each one is a slot the
 * sample never fills — so the sample renders exactly as it did, and a live
 * page says what it must:
 *
 *   (the PENSION KEY is not here: the navbar's account chip carries it, with
 *   its copy button, on every page — twice on one screen was once too many);
 *
 *   a wallet that does NOT save here, which is the single most useful thing
 *   this column can say — its link badge, only when it is not the linked one;
 *
 *   any NUMBER of wallets rather than one — the list, when no single wallet
 *   can lead without guessing;
 *
 *   a history that could NOT BE READ — said over the rows, with the retry,
 *   never as "no activity yet";
 *
 *   the rows the feed leaves out — the keeper's account-keeping, dust —
 *   COUNTED, and opened by the control that counts them.
 */

import { useState } from "react";

import { ActivityRow } from "@/components/activity-row";
import { CopyButton } from "@/components/copy-button";
import { secondsUntil } from "@/components/live/LiveStates";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatSol, formatUsd, usdcRawForLamports } from "@/lib/amounts";
import { MONO } from "@/lib/classes";
import { relativeDayLabel } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import type { LiveWalletView } from "@/lib/live-types";
import { shortAddress } from "@/lib/vault-copy";
import type { ActivityEvent } from "@/mocks/types";

const solscanAccountUrl = (address: string): string => `https://solscan.io/account/${address}`;

/** One wallet's link, as a badge. Four outcomes, and each is said as itself. */
export function LinkBadge({ wallet }: { readonly wallet: LiveWalletView }) {
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
 * UNDER THE LEAD WALLET'S BALANCE: what is true of it that the sample's wallet
 * never needed saying. The badge only when it does NOT save here — a linked
 * wallet saving into this vault is the ordinary case the column already shows
 * — and the reserve note when it cannot settle yet. Nothing at all otherwise.
 */
export function LeadNotes({ wallet }: { readonly wallet: LiveWalletView }) {
  const unlinked = wallet.linkStatus !== "this_vault";
  const stuck = wallet.canSettle === false && wallet.linkStatus === "this_vault";
  if (!unlinked && !stuck) return null;
  return (
    <div className="space-y-1.5">
      {unlinked ? <LinkBadge wallet={wallet} /> : null}
      {stuck ? <p className="text-xs text-amber-700 dark:text-amber-400">{LIVE_COPY.reserveNoteShort}</p> : null}
    </div>
  );
}

/**
 * NO SINGLE WALLET TO LEAD WITH — none, several with none uniquely linked, or
 * one whose balance nobody could read — so the column lists them rather than
 * promoting one by guess: a card per wallet, under the column's own heading.
 */
export function WalletList({ wallets, usdcRawPerSol }: { readonly wallets: readonly LiveWalletView[]; readonly usdcRawPerSol: bigint | null }) {
  return (
    <div className="space-y-2">
        {wallets.length === 0 ? (
          <p className="text-xs text-muted-foreground">{LIVE_COPY.noWalletsYet}</p>
        ) : (
          <ul className="space-y-2">
            {wallets.map((wallet) => {
              const balance = wallet.lamports === null ? null : formatSol(wallet.lamports);
              const dollars = wallet.lamports === null || usdcRawPerSol === null ? null : formatUsd(usdcRawForLamports(wallet.lamports, usdcRawPerSol));
              const settlements = wallet.settlementNonce === null ? null : LIVE_COPY.settlementCount(wallet.settlementNonce.toString());
              return (
                <li key={wallet.address} className="space-y-1 rounded-md border p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{wallet.label}</span>
                    <LinkBadge wallet={wallet} />
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Num className="text-xs">{shortAddress(wallet.address)}</Num>
                    <CopyButton value={wallet.address} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <Num className={MONO}>{balance === null ? LIVE_COPY.unknownFigure : `${balance} SOL`}</Num>
                    {dollars === null ? null : <> ≈ {dollars}</>}
                    {settlements === null ? null : <> · {settlements}</>}
                  </div>
                  {wallet.canSettle === false && wallet.linkStatus === "this_vault" ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">{LIVE_COPY.reserveNoteShort}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}

/**
 * A FAILED READ IS A NOTE ABOVE THE HISTORY, NOT INSTEAD OF IT. The hook keeps
 * the rows it already had when a poll fails, and they stay on screen under
 * this. The button counts down to when the server said it will answer again,
 * rather than offering a press that walks into the same refusal.
 */
export function FeedBanner({ onRetry, retryAt, nowMs }: { readonly onRetry?: () => void; readonly retryAt: number | null; readonly nowMs: number }) {
  const left = secondsUntil(retryAt, nowMs);
  return (
    <div className="space-y-2 border-b px-4 py-3" role="status">
      <p className="text-sm text-muted-foreground">{ACTIVITY_COPY.unreadableNow}</p>
      {onRetry === undefined ? null : (
        <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={left !== null}>
          {left === null ? LIVE_COPY.retry : LIVE_COPY.retryIn(left)}
        </Button>
      )}
    </div>
  );
}

/**
 * THE COUNT, AND THE ROWS IT COUNTS. The keeper's account-keeping is hidden
 * because listing it buries the settlements — but a count nobody can open is a
 * sentence nobody can check against Solscan, so it opens, into the sample's
 * own rows. One panel id per feed: the aside and the sheet are mounted at
 * once, and a shared id would point both controls at the first.
 */
export function HiddenRows({
  events,
  upkeep,
  dust,
  now,
  id,
}: {
  readonly events: readonly ActivityEvent[];
  readonly upkeep: number;
  readonly dust: number;
  readonly now: string;
  readonly id: string;
}) {
  const [open, setOpen] = useState(false);
  const words = [upkeep > 0 ? ACTIVITY_COPY.hiddenUpkeep(String(upkeep)) : null, dust > 0 ? ACTIVITY_COPY.hiddenDust(String(dust)) : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
  if (events.length === 0 || words === "") return null;
  const panelId = `${id}-hidden`;
  const days = new Map<string, ActivityEvent[]>();
  for (const event of events) {
    const day = event.at === null ? "" : event.at.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), event]);
  }

  return (
    <div className="border-t">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((shown) => !shown)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span>{words}</span>
        <span className="shrink-0 underline underline-offset-4">{open ? ACTIVITY_COPY.hideHidden : ACTIVITY_COPY.showHidden}</span>
      </button>
      <div id={panelId} hidden={!open}>
        {open
          ? Array.from(days).map(([day, rows]) => (
              <div key={day === "" ? "unknown" : day}>
                <div className="sticky top-0 z-10 bg-background px-4 py-2 text-xs text-muted-foreground">{day === "" ? "Time unknown" : relativeDayLabel(day, now)}</div>
                {rows.map((event) => (
                  <ActivityRow key={event.id} event={event} now={now} />
                ))}
              </div>
            ))
          : null}
      </div>
    </div>
  );
}
