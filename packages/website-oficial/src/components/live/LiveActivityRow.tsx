"use client";

/**
 * ONE TRANSACTION OF A VAULT'S HISTORY, as a row that opens it on Solscan.
 *
 * THE ROW IS AN ANCHOR, not a tooltip trigger like the mock's. Every row here is
 * a real transaction that really landed, so the useful thing to do with one is
 * look at it on chain — and a link is the one control that survives a middle
 * click, a long press and a screen reader's list of links.
 *
 * NOTHING IS DRESSED UP AS A SAVING. The SAVED accent appears on exactly one
 * kind of row — a `settled` whose `paid` is above zero — because that is the
 * only event the program itself calls a contribution. A settlement that moved
 * nothing reads "Settled, nothing to save"; SOL that merely arrived reads
 * "Received", with "a plain transfer, not counted as saved" under it. There are
 * deliberately no Bought/Sold fills here: the chain has no trades to show.
 *
 * WHAT WAS NOT PAID IS SAID OUT LOUD. A capped settlement carries a second,
 * muted line naming what was owed and what the cap kept, because the difference
 * between "20 % of your gain" and the number on the row is otherwise invisible.
 *
 * AN AMOUNT THE CHAIN DID NOT GIVE IS LEFT OUT, never guessed: the classifier
 * reports null where a token balance was missing, and the amount COLUMN
 * empties rather than the row inventing a figure. The title does not change —
 * it carries no figure to lose. Every title used to, and the row then printed
 * the same number twice: once inside a sentence that ran out of room in a
 * 320px column and was cut mid-word, and once in full on the right.
 */

import type { FocusEvent, KeyboardEvent, ReactNode } from "react";

import { AssetMark } from "@/components/live/AssetMark";

import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Coins,
  FileText,
  Link2,
  Link2Off,
  Package,
  PiggyBank,
  ScrollText,
  Settings2,
  ShoppingCart,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { Figure } from "@/components/live/Figure";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { formatSol, formatUsd, rawFrom } from "@/lib/amounts";
import { SAVED } from "@/lib/classes";
import { clockLabel, shortHex } from "@/lib/format";
import { ACTIVITY_COPY, LIVE_COPY } from "@/lib/live-copy";
import { symbolOfMint } from "@/lib/live-symbols";
import type { LiveRow, VaultEventJson } from "@/lib/live-types";
import { cn } from "@/lib/utils";
import { ratePercent } from "@/lib/vault-copy";

/** Raw lamports as SOL text, or null when the chain did not say. */
const sol = (raw: string | null | undefined): string | null => {
  const value = rawFrom(raw);
  return value === null ? null : formatSol(value);
};

/** Raw USDC as dollars, or null when the chain did not say. */
const usd = (raw: string | null | undefined): string | null => {
  const value = rawFrom(raw);
  return value === null ? null : formatUsd(value);
};

/** "$1,234.56" without its sign, for a sentence that already says USDC. */
const bare = (dollars: string): string => dollars.replace("$", "");

export interface RowParts {
  readonly icon: ReactNode;
  readonly title: string;
  /** The muted detail that leads the sub line. */
  readonly detail: string | null;
  /** A second muted line, for what a cap kept back. */
  readonly note: string | null;
  readonly amount: string | null;
  readonly amountClass: string | undefined;
  /** A failed transaction wears a badge and never an accent. */
  readonly failed: boolean;
}

const mark = (Glyph: typeof PiggyBank, className?: string): ReactNode => <Glyph className={cn("size-4 text-muted-foreground", className)} aria-hidden />;

/**
 * A ROW ABOUT AN ASSET WEARS THE ASSET, not a verb.
 *
 * A glyph is right for what the vault DID — wrapped, converted, linked, swept —
 * and wrong for a row whose whole subject is which token was bought. The
 * sample has always drawn the token's mark on those rows and live drew a grey
 * shopping cart, which is most of why one column reads as a product and the
 * other as a log. Keyed by the MINT the event carries, so it is that token's
 * mark and not whoever else uses those three letters; an asset with no art
 * falls through to the same lettered disc, which still says which one it was.
 */
const assetMark = (symbol: string, mint: string | null): ReactNode => <AssetMark symbol={symbol} mint={mint} size={16} className="shrink-0" />;

/**
 * What a settlement measured, from the mode THAT SETTLEMENT carries — never
 * from the vault's mode today. Exported so the settlement strip says the same
 * word about the same transaction.
 */
export const measureOf = (mode: number): string => (mode === 1 ? ACTIVITY_COPY.measureVolume : ACTIVITY_COPY.measureProfit);

/**
 * One event, in words. A pure switch over the classifier's union, so a kind
 * added there cannot quietly render as an empty row.
 */
export function partsOf(event: VaultEventJson, labelOf: (wallet: string | null) => string, maxContribution: bigint | null): RowParts {
  const plain = { detail: null, note: null, amount: null, amountClass: undefined, failed: false } as const;

  switch (event.kind) {
    case "settled": {
      const paid = rawFrom(event.paid) ?? 0n;
      const owed = rawFrom(event.owed);
      const base = sol(event.baseLamports) ?? "?";
      const moved = paid > 0n;
      return {
        ...plain,
        icon: mark(PiggyBank, moved ? SAVED : undefined),
        title: moved ? ACTIVITY_COPY.settled(labelOf(event.wallet)) : ACTIVITY_COPY.settledNothing(labelOf(event.wallet)),
        detail: ACTIVITY_COPY.settledFrom(ratePercent(event.bps), base, measureOf(event.mode)),
        // The cap is stated where the shortfall would otherwise be invisible.
        note: event.capped && owed !== null && maxContribution !== null ? ACTIVITY_COPY.settledCapped(formatSol(owed), formatSol(maxContribution)) : null,
        amount: moved ? `+${formatSol(paid)} SOL` : "0 SOL",
        amountClass: moved ? SAVED : "text-muted-foreground",
      };
    }

    case "wrapped": {
      const amount = sol(event.lamports);
      return {
        ...plain,
        icon: mark(Package),
        title: ACTIVITY_COPY.wrapped,
        amount: amount === null ? null : `${amount} SOL`,
      };
    }

    case "converted": {
      const spent = sol(event.lamportsSpent);
      const received = usd(event.usdcReceivedRaw);
      return {
        ...plain,
        icon: mark(ArrowLeftRight),
        title: ACTIVITY_COPY.converted,
        // The SOL side goes where the sample puts the other half of a trade.
        detail: spent === null ? null : ACTIVITY_COPY.convertedFrom(spent),
        amount: received,
      };
    }

    case "invested": {
      const symbol = event.symbol ?? symbolOfMint(event.mint) ?? "the basket";
      const spent = usd(event.usdcSpentRaw);
      const got = event.receivedUi;
      return {
        ...plain,
        icon: assetMark(symbol, event.mint),
        title: ACTIVITY_COPY.invested(symbol),
        // The quantity, as the sample puts it. NOT a unit price: usdcSpentRaw
        // is the WHOLE transaction's USDC delta, so two legs in one
        // transaction would each silently show twice what they paid. Today's
        // keeper sends one invest per transaction, which is a property of the
        // keeper and not of the data.
        detail: got,
        amount: spent,
      };
    }

    case "withdrew_sol": {
      const amount = sol(event.lamports);
      return {
        ...plain,
        icon: mark(ArrowUpFromLine),
        title: ACTIVITY_COPY.withdrewSol,
        amount: amount === null ? null : `−${amount} SOL`,
      };
    }

    case "withdrew_token": {
      // The event carries a mint, never a symbol: the name is looked up here.
      const symbol = symbolOfMint(event.mint) ?? "tokens";
      const shown = event.uiAmount;
      return {
        ...plain,
        icon: assetMark(symbol, event.mint),
        title: ACTIVITY_COPY.withdrewToken(symbol),
        amount: shown === null ? null : `−${shown} ${symbol}`,
      };
    }

    case "vault_created": {
      const volume = event.mode === 1;
      const bps = volume ? event.volumeBps : event.skimBps;
      const measure = volume ? "Volume" : "Profit";
      return {
        ...plain,
        icon: mark(Sparkles),
        title: bps === null ? ACTIVITY_COPY.vaultCreatedPlain : ACTIVITY_COPY.vaultCreated(`${measure} · ${ratePercent(bps)}`),
      };
    }

    case "rule_changed": {
      // BOTH the mode and ITS rate, or nothing. Reading skimBps when the mode
      // did not decode would print "Profit · 0 %" over a volume vault.
      const volume = event.mode === 1;
      const bps = event.mode === null ? null : volume ? event.volumeBps : event.skimBps;
      return {
        ...plain,
        icon: mark(Settings2),
        title: ACTIVITY_COPY.ruleChanged,
        detail: bps === null ? null : ACTIVITY_COPY.ruleChangedTo(volume ? LIVE_COPY.modeVolume(ratePercent(bps)) : LIVE_COPY.modeProfit(ratePercent(bps))),
      };
    }

    case "policy_signed": {
      // A cap `rawFrom` rejects is unread, never "$0.00 per buy".
      const cap = rawFrom(event.maxPerCall);
      return {
        ...plain,
        icon: mark(ScrollText),
        title: event.enabled === false ? ACTIVITY_COPY.investingPaused : ACTIVITY_COPY.policySigned,
        detail: cap === null ? null : ACTIVITY_COPY.policyCaps(formatUsd(cap)),
      };
    }

    case "linked":
      return { ...plain, icon: mark(Link2), title: ACTIVITY_COPY.linked(labelOf(event.wallet)) };

    case "unlinked":
      return { ...plain, icon: mark(Link2Off), title: ACTIVITY_COPY.unlinked(labelOf(event.wallet)) };

    case "received_sol": {
      const amount = sol(event.lamports);
      return {
        ...plain,
        icon: mark(ArrowDownToLine),
        title: ACTIVITY_COPY.receivedSol,
        detail: ACTIVITY_COPY.receivedSub,
        /*
         * SIGNED, BECAUSE SOL ARRIVED. The sample signs its own deposit the
         * same way ("+$500.00") and leaves it uncoloured, which is exactly the
         * distinction this row needs: money came IN, and it is NOT savings.
         * The green on this page is the SAVED accent and it means one thing —
         * a slice the rule put aside — so a plain transfer may take the plus
         * and must not take the colour.
         */
        amount: amount === null ? null : `+${amount} SOL`,
      };
    }

    case "failed":
      return { ...plain, icon: mark(TriangleAlert), title: ACTIVITY_COPY.other, failed: true };

    case "unreadable":
      return { ...plain, icon: mark(TriangleAlert), title: ACTIVITY_COPY.unreadable };

    case "upkeep":
      // Behind a disclosure in the feed, not dropped — and with its own words:
      // twelve of these under one "Vault transaction" was twelve identical rows.
      return { ...plain, icon: mark(Coins), title: ACTIVITY_COPY.upkeepTitle, detail: ACTIVITY_COPY.upkeepSub };

    case "other":
      return { ...plain, icon: mark(FileText), title: ACTIVITY_COPY.other };
  }
}

// ── the roving Tab stop, scoped to one feed ──────────────────────────────────

/** Every row of the SAME feed: the aside and the sheet can both be mounted. */
function siblings(row: HTMLAnchorElement): HTMLAnchorElement[] {
  const scope = row.closest("[data-live-feed]") ?? row.parentElement;
  return scope === null ? [row] : Array.from(scope.querySelectorAll<HTMLAnchorElement>("[data-live-row]"));
}

/** Whichever row has focus keeps the Tab stop; the rest step out of the order. */
function rove(event: FocusEvent<HTMLAnchorElement>): void {
  for (const row of siblings(event.currentTarget)) row.tabIndex = row === event.currentTarget ? 0 : -1;
}

/** Arrows walk the feed, Home and End jump. */
function step(event: KeyboardEvent<HTMLAnchorElement>): void {
  const rows = siblings(event.currentTarget);
  const index = rows.indexOf(event.currentTarget);
  const next =
    event.key === "ArrowDown" ? rows[index + 1] : event.key === "ArrowUp" ? rows[index - 1] : event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : undefined;
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}

/**
 * One row. An anchor when the signature makes a Solscan link, and a plain span
 * when it does not: a link that goes nowhere is worse than no link at all.
 */
export function LiveActivityRow({
  row,
  labelOf,
  maxContribution,
  first = false,
}: {
  readonly row: LiveRow;
  readonly labelOf: (wallet: string | null) => string;
  readonly maxContribution: bigint | null;
  /** The feed's single Tab stop, until a row takes focus. */
  readonly first?: boolean;
}) {
  const parts = partsOf(row.event, labelOf, maxContribution);
  const clock = row.at === null ? null : clockLabel(row.at);
  /*
   * THE SIGNATURE LEFT THE SUB LINE. In a 320px column it took most of the
   * width and pushed the clock — the one part of that line anybody reads — out
   * of the truncation. The row IS the link to the transaction, so nothing is
   * lost: the hash is the anchor's title on hover, and its accessible name
   * carries the whole row so a screen reader's link list still says which one.
   */
  const hash = shortHex(row.signature);
  const sub = [parts.detail, clock].filter((part): part is string => part !== null && part !== "").join(" · ");
  /*
   * MONO IS FOR FIGURES, NOT FOR SENTENCES.
   *
   * The sample sets this line in the page's ordinary face and puts <Num> round
   * each NUMBER in it — `<Num>{shares}</Num> @ <Num>{price}</Num> · {clock}`.
   * Live wrapped the whole joined string instead, so "a plain transfer, not
   * counted as saved" came out in a typewriter face: prose pretending to be a
   * quantity, and the one obvious typographic difference between the two
   * columns at a glance.
   *
   * `detail` is a bare quantity on some rows and a sentence on others, and only
   * the first is a figure. The clock always is.
   */
  const detailIsFigure = parts.detail !== null && /^[\d.,]+$/.test(parts.detail);

  const label = `${parts.title}${sub === "" ? "" : ` · ${sub}`} · ${ACTIVITY_COPY.openOnSolscan} · ${hash}`;

  const className = cn(
    "flex w-full items-start gap-3 px-4 py-2.5 text-left outline-none",
    // Inset ring: a ScrollArea viewport would clip one drawn outside the row.
    "hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  );

  const body = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">{parts.icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn("flex items-center gap-1.5 text-sm", parts.failed && "text-muted-foreground")}>
          <span className="truncate">{parts.title}</span>
          {parts.failed ? (
            <Badge variant="destructive" className="shrink-0">
              {ACTIVITY_COPY.failedBadge}
            </Badge>
          ) : null}
        </span>
        {/* NO Figure HERE either. Its tail is a SIZE step, and this is already
            the smallest face on the page: 0.85em of 12px is a difference
            nobody sees. A quantity too long for this line is too long, full
            stop — a different fix from setting it. */}
        <span className="block truncate text-xs text-muted-foreground">
          {parts.detail === null || parts.detail === "" ? null : detailIsFigure ? <Num>{parts.detail}</Num> : parts.detail}
          {parts.detail !== null && parts.detail !== "" && clock !== null ? " · " : null}
          {clock === null ? null : <Num>{clock}</Num>}
        </span>
        {parts.note === null ? null : <span className="block truncate text-xs text-muted-foreground">{parts.note}</span>}
      </span>
      {/* The column the sample keeps as an even ladder of "$48.62"s. Ours are
          nine-decimal lamports, so the digits past the fourth step down and the
          eye gets a ladder back without a single digit leaving the page. */}
      {parts.amount === null ? null : (
        <Num className={cn("shrink-0 text-right text-sm", parts.failed ? "text-muted-foreground" : parts.amountClass)}>
          <Figure>{parts.amount}</Figure>
        </Num>
      )}
    </>
  );

  if (row.explorerUrl === null) {
    return (
      <span className={className} data-live-row="">
        {body}
      </span>
    );
  }

  return (
    <a
      href={row.explorerUrl}
      target="_blank"
      rel="noopener noreferrer"
      data-live-row=""
      tabIndex={first ? 0 : -1}
      aria-keyshortcuts="ArrowUp ArrowDown"
      onFocus={rove}
      onKeyDown={step}
      title={hash}
      aria-label={label}
      className={className}
    >
      {body}
    </a>
  );
}
