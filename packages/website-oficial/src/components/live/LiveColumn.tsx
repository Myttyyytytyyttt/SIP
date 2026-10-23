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
 *   a wallet's NAME that its account chose, and the pencil that changes it
 *   (owner, 10-23: components/wallets/WalletName.tsx), in the list and on the
 *   lead wallet alike;
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
import { RetryButton } from "@/components/live/RetryButton";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { WalletName } from "@/components/wallets/WalletName";
import { formatSol, formatSolDown, formatUsd, usdcRawForLamports } from "@/lib/amounts";
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
 * A LINKED WALLET THAT CANNOT SETTLE YET says so in its badge (owner, 10-23:
 * each wallet card is two rows, so the reserve note no longer gets a line of its
 * own). Amber, in the place "Linked" would be; the note itself is its tooltip
 * and is read with it by a screen reader. Every other wallet wears its link's
 * own badge (LinkBadge).
 */
export function WalletStatusBadge({ wallet }: { readonly wallet: LiveWalletView }) {
  if (wallet.canSettle !== false || wallet.linkStatus !== "this_vault") return <LinkBadge wallet={wallet} />;
  return (
    <Badge variant="outline" title={LIVE_COPY.reserveNoteShort} data-reserve="" className="border-amber-600/40 text-amber-700 dark:text-amber-400">
      {LIVE_COPY.badgeCannotSettle}
      <span className="sr-only">. {LIVE_COPY.reserveNoteShort}</span>
    </Badge>
  );
}

/**
 * A wallet's balance at a glance (owner, 10-23: "aparece x.xxx SOL"): three
 * places, cut DOWN so it never shows SOL the wallet does not hold, and "<0.001"
 * rather than a 0 for dust (amounts.ts formatSolDown). Every lamport is in its
 * tooltip; the dollars are what they were.
 *
 * THE DOLLARS SHOW WHOLE OR NOT AT ALL. A big balance on a phone ("1,999.999
 * SOL ≈ $200,077.42") is wider than the room beside the address, and an
 * ellipsis in the middle of a dollar figure reads as a different figure. So
 * the dollars are the second item of a one-line row that wraps and clips: when
 * they do not fit beside the SOL they wrap out of sight, and the SOL stays
 * whole. Both are still in the tooltip, and a screen reader still reads both.
 */
function WalletBalance({ lamports, usdcRawPerSol }: { readonly lamports: bigint | null; readonly usdcRawPerSol: bigint | null }) {
  if (lamports === null) return <Num className="text-xs">{LIVE_COPY.unknownFigure}</Num>;
  const dollars = usdcRawPerSol === null ? null : formatUsd(usdcRawForLamports(lamports, usdcRawPerSol));
  return (
    <span className="flex h-4 min-w-0 flex-wrap justify-end gap-x-1 overflow-hidden" title={`${formatSol(lamports)} SOL${dollars === null ? "" : ` ≈ ${dollars}`}`}>
      <Num className="min-w-0 truncate text-xs">{formatSolDown(lamports, 3)} SOL</Num>
      {dollars === null ? null : <span>≈ {dollars}</span>}
    </span>
  );
}

/**
 * NO SINGLE WALLET TO LEAD WITH — none, several with none uniquely linked, or
 * one whose balance nobody could read — so the column lists them rather than
 * promoting one by guess: a card per wallet, under the column's own heading.
 *
 * TWO ROWS A CARD (owner, 10-23: "dejamos solo: Nombre, Estado, wallet y saldo
 * de wallet, y que sean solo 2 filas"): the name — with its pencil when the
 * account's names can be saved (WalletName) — and the status; then the address
 * with its copy, and the balance. The settlement count is gone from here: the
 * column's bar and the pension card already count settlements.
 *
 * THE LIST SCROLLS ITSELF, NOT THE PAGE (owner, 10-23: "si se añaden más
 * wallets eventualmente se hace scroll pero solo de ese cuadrado"). Past about
 * three cards it stops growing and scrolls inside its own box, the next card
 * showing its top edge so the box reads as one that scrolls; overscroll stays in
 * it, so reaching its end never drags the feed or the page along. The inset
 * keeps a focused pencil's or badge's ring inside the box rather than clipped by
 * its edge.
 */
export function WalletList({ wallets, usdcRawPerSol }: { readonly wallets: readonly LiveWalletView[]; readonly usdcRawPerSol: bigint | null }) {
  if (wallets.length === 0) return <p className="text-xs text-muted-foreground">{LIVE_COPY.noWalletsYet}</p>;
  return (
    <ul aria-label={LIVE_COPY.tradingWallets} data-wallet-list="" className="-mx-1 max-h-[15.5rem] space-y-1.5 overflow-y-auto overscroll-contain px-1 py-0.5">
      {wallets.map((wallet) => (
        <li key={wallet.address} className="space-y-0.5 rounded-md border px-2.5 py-1.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <WalletName address={wallet.address} name={wallet.label} className="text-sm font-medium" />
            <WalletStatusBadge wallet={wallet} />
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex shrink-0 items-center gap-1">
              <Num className="text-xs">{shortAddress(wallet.address)}</Num>
              <CopyButton value={wallet.address} />
            </span>
            <WalletBalance lamports={wallet.lamports} usdcRawPerSol={usdcRawPerSol} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * A FAILED READ IS A NOTE ABOVE THE HISTORY, NOT INSTEAD OF IT. The hook keeps
 * the rows it already had when a poll fails, and they stay on screen under
 * this. The button counts down to when a press will read at once — the
 * server's retry-after, or the floor after the last read — rather than
 * offering a press that walks into the same refusal (RetryButton.tsx).
 *
 * One banner for every feed: the column's, and /activity's (LiveActivityFeed).
 * THE SENTENCE IS THE LIVE REGION, NOT THE BANNER: the button's countdown
 * ticks now, and inside a polite region every second of it would be read out.
 */
export function FeedBanner({ onRetry, retryAt, readyAt }: { readonly onRetry?: () => void; readonly retryAt: number | null; readonly readyAt: number }) {
  return (
    <div className="space-y-2 border-b px-4 py-3">
      <p className="text-sm text-muted-foreground" role="status">
        {ACTIVITY_COPY.unreadableNow}
      </p>
      {onRetry === undefined ? null : <RetryButton retryAt={retryAt} readyAt={readyAt} onRetry={onRetry} />}
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
                {rows.map((event, index) => (
                  <ActivityRow key={event.id} event={event} now={now} order={index} />
                ))}
              </div>
            ))
          : null}
      </div>
    </div>
  );
}
