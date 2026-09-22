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
 * reports null where a token balance was missing, and the label drops to its
 * amount-less form rather than inventing a figure.
 */

import type { FocusEvent, KeyboardEvent, ReactNode } from "react";

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

import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { formatSol, formatUsd, rawFrom } from "@/lib/amounts";
import { SAVED } from "@/lib/classes";
import { clockLabel, shortHex } from "@/lib/format";
import { ACTIVITY_COPY } from "@/lib/live-copy";
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
        title: moved ? ACTIVITY_COPY.settled(formatSol(paid)) : ACTIVITY_COPY.settledNothing,
        detail: ACTIVITY_COPY.settledFrom(labelOf(event.wallet), ratePercent(event.bps), base, measureOf(event.mode)),
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
        title: amount === null ? ACTIVITY_COPY.wrappedPlain : ACTIVITY_COPY.wrapped(amount),
        amount: amount === null ? null : `${amount} SOL`,
      };
    }

    case "converted": {
      const spent = sol(event.lamportsSpent);
      const received = usd(event.usdcReceivedRaw);
      return {
        ...plain,
        icon: mark(ArrowLeftRight),
        // Both halves or neither: "Converted 0.01 SOL to ? USDC" says less than the plain form.
        title: spent === null || received === null ? ACTIVITY_COPY.convertedPlain : ACTIVITY_COPY.converted(spent, bare(received)),
        amount: received,
      };
    }

    case "invested": {
      const symbol = event.symbol ?? symbolOfMint(event.mint) ?? "the basket";
      const spent = usd(event.usdcSpentRaw);
      const got = event.receivedUi;
      return {
        ...plain,
        icon: mark(ShoppingCart),
        title: got === null || spent === null ? ACTIVITY_COPY.investedPlain(symbol) : ACTIVITY_COPY.invested(got, symbol, bare(spent)),
        amount: spent,
      };
    }

    case "withdrew_sol": {
      const amount = sol(event.lamports);
      return {
        ...plain,
        icon: mark(ArrowUpFromLine),
        title: amount === null ? "Withdrew SOL" : ACTIVITY_COPY.withdrewSol(amount),
        amount: amount === null ? null : `−${amount} SOL`,
      };
    }

    case "withdrew_token": {
      // The event carries a mint, never a symbol: the name is looked up here.
      const symbol = symbolOfMint(event.mint) ?? "tokens";
      const shown = event.uiAmount;
      return {
        ...plain,
        icon: mark(ArrowUpFromLine),
        title: shown === null ? `Withdrew ${symbol}` : ACTIVITY_COPY.withdrewToken(shown, symbol),
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

    case "rule_changed":
      return { ...plain, icon: mark(Settings2), title: ACTIVITY_COPY.ruleChanged };

    case "policy_signed":
      return { ...plain, icon: mark(ScrollText), title: event.enabled === false ? ACTIVITY_COPY.investingPaused : ACTIVITY_COPY.policySigned };

    case "linked":
      return { ...plain, icon: mark(Link2), title: ACTIVITY_COPY.linked(labelOf(event.wallet)) };

    case "unlinked":
      return { ...plain, icon: mark(Link2Off), title: ACTIVITY_COPY.unlinked(labelOf(event.wallet)) };

    case "received_sol": {
      const amount = sol(event.lamports) ?? "?";
      return { ...plain, icon: mark(ArrowDownToLine), title: ACTIVITY_COPY.receivedSol(amount), detail: ACTIVITY_COPY.receivedSub, amount: `${amount} SOL` };
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
  const sub = [parts.detail, clock, shortHex(row.signature)].filter((part): part is string => part !== null && part !== "").join(" · ");

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
        <span className="block truncate text-xs text-muted-foreground">{sub}</span>
        {parts.note === null ? null : <span className="block truncate text-xs text-muted-foreground">{parts.note}</span>}
      </span>
      {parts.amount === null ? null : <Num className={cn("shrink-0 text-right text-sm", parts.failed ? "text-muted-foreground" : parts.amountClass)}>{parts.amount}</Num>}
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
      className={className}
    >
      {body}
    </a>
  );
}
