"use client";

import type { FocusEvent, KeyboardEvent, ReactNode } from "react";
import Image from "next/image";
import { ArrowDownToLine, PiggyBank } from "lucide-react";

import { Num } from "@/components/num";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MONO, SAVED } from "@/lib/classes";
import { clockLabel, fillLabel, shares, shortHex, timeAgo, usd, usdSigned } from "@/lib/format";
import { cn } from "@/lib/utils";
// The leaf, not the barrel: `@/mocks` also re-exports the seeded dataset, and this file ships to the browser.
import { tickerLogo, type ActivityEvent } from "@/mocks/types";

interface RowParts {
  readonly leading: ReactNode;
  readonly title: string;
  readonly sub: ReactNode;
  readonly amount: string;
  readonly amountClass: string | undefined;
}

/**
 * One switch on `kind`; the union has no optionals, so neither does this.
 * A trade row is the fill and its slice in one line — there is no separate
 * "put aside" event.
 */
function parts(event: ActivityEvent): RowParts {
  const clock = <Num>{clockLabel(event.at)}</Num>;

  switch (event.kind) {
    case "trade": {
      // Same guard as the strip chip: a paused rule can let a fill through with nothing set aside,
      // and the accent means money put aside — so that row reads muted "$0.00" on both surfaces.
      const saved = event.savedUsd > 0;
      return {
        leading: (
          <Image src={tickerLogo(event.symbol)} alt={event.symbol} width={20} height={20} className="rounded-full" />
        ),
        title: fillLabel(event.side, event.symbol),
        sub: (
          <>
            <Num>{usd(event.notionalUsd)}</Num> · {clock}
          </>
        ),
        // The slice is the row's number — it is what the product does; the size sits in the sub line.
        amount: usdSigned(event.savedUsd),
        amountClass: saved ? SAVED : "text-muted-foreground",
      };
    }
    case "invested":
      return {
        // Money going into the pension.
        leading: <PiggyBank className="size-4 text-muted-foreground" aria-hidden />,
        title: `Invested in ${event.symbol}`,
        sub: (
          <>
            <Num>{shares(event.shares)}</Num> @ <Num>{usd(event.priceUsd)}</Num> · {clock}
          </>
        ),
        amount: usd(event.amountUsd),
        amountClass: undefined,
      };
    case "deposit":
      return {
        leading: <ArrowDownToLine className="size-4 text-muted-foreground" aria-hidden />,
        title: "Funded wallet",
        sub: clock,
        amount: usdSigned(event.amountUsd),
        amountClass: undefined,
      };
  }
}

/**
 * Every row in the same feed. Scoped to the WalletActivity root (`#activity`)
 * because the aside and the sheet can both be mounted, and a hidden row cannot
 * take focus.
 */
function siblings(row: HTMLButtonElement): HTMLButtonElement[] {
  const scope = row.closest("#activity") ?? row.parentElement;
  return scope ? Array.from(scope.querySelectorAll<HTMLButtonElement>("[data-activity-row]")) : [row];
}

/**
 * Roving tabindex without a container: a few hundred rows would otherwise be
 * a few hundred Tab stops (each opening its tooltip) before the page's main
 * content. Whichever row gains focus keeps the stop; the rest step out of the
 * Tab order.
 */
function rove(e: FocusEvent<HTMLButtonElement>) {
  for (const row of siblings(e.currentTarget)) row.tabIndex = row === e.currentTarget ? 0 : -1;
}

/** Arrows walk the feed, Home/End jump; focusing scrolls the row into view and `rove` follows. */
function step(e: KeyboardEvent<HTMLButtonElement>) {
  const rows = siblings(e.currentTarget);
  const i = rows.indexOf(e.currentTarget);
  const next =
    e.key === "ArrowDown"
      ? rows[i + 1]
      : e.key === "ArrowUp"
        ? rows[i - 1]
        : e.key === "Home"
          ? rows[0]
          : e.key === "End"
            ? rows.at(-1)
            : undefined;
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/**
 * One feed row. The whole row is the tooltip trigger (a real button, so it is
 * keyboard reachable); the tooltip carries the hash and the relative time.
 */
export function ActivityRow({ event, now }: { event: ActivityEvent; now: string }) {
  const { leading, title, sub, amount, amountClass } = parts(event);

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        data-activity-row=""
        aria-keyshortcuts="ArrowUp ArrowDown"
        onFocus={rove}
        onKeyDown={step}
        // Inset ring: the ScrollArea viewport would clip one drawn outside the row.
        className="flex w-full items-start gap-3 px-4 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">{leading}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">{sub}</span>
        </span>
        <span className={cn("shrink-0 text-right text-sm", MONO, amountClass)}>{amount}</span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono">{shortHex(event.txHash)}</span>
        <span aria-hidden>·</span>
        <span>{timeAgo(event.at, now)}</span>
      </TooltipContent>
    </Tooltip>
  );
}
