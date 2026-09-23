"use client";

import type { FocusEvent, KeyboardEvent, ReactNode } from "react";
import Image from "next/image";
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
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MONO, SAVED } from "@/lib/classes";
import { clockLabel, fillLabel, shares, shortHex, timeAgo, usd, usdSigned } from "@/lib/format";
import { cn } from "@/lib/utils";
// The leaf, not the barrel: `@/mocks` also re-exports the seeded dataset, and this file ships to the browser.
import { tickerLogo, type ActivityEvent, type OtherEvent } from "@/mocks/types";

/** The glyph an `other` row leads with — the same ones the live feed has always used. */
const GLYPHS: Readonly<Record<OtherEvent["icon"], LucideIcon>> = {
  wrap: Package,
  convert: ArrowLeftRight,
  withdraw: ArrowUpFromLine,
  vault: Sparkles,
  rule: Settings2,
  policy: ScrollText,
  link: Link2,
  unlink: Link2Off,
  receive: ArrowDownToLine,
  failed: TriangleAlert,
  upkeep: Coins,
  other: FileText,
};

/** An asset's mark, from art chosen by mint when the row brings one. */
const mark = (symbol: string, logo: string | undefined, size: number): ReactNode => (
  <Image src={logo ?? tickerLogo(symbol)} alt={symbol} width={size} height={size} className="rounded-full" />
);

interface RowParts {
  readonly leading: ReactNode;
  readonly title: string;
  readonly sub: ReactNode;
  readonly amount: string;
  readonly amountClass: string | undefined;
  /** A third line, for the one row that needs it: a settlement the rule's ceiling cut short. */
  readonly note?: string;
  readonly failed?: boolean;
}

/**
 * One switch on `kind`; the union has no optionals, so neither does this.
 * A trade row is the fill and its slice in one line — there is no separate
 * "put aside" event.
 */
function parts(event: ActivityEvent): RowParts {
  // A transaction the chain gave no block time has no clock; its day heading
  // already says the time is unknown.
  const clock = event.at === null ? null : <Num>{clockLabel(event.at)}</Num>;
  /** "<detail> · <clock>", or whichever half exists. */
  const joined = (detail: ReactNode): ReactNode =>
    detail === null ? clock : clock === null ? detail : (
      <>
        {detail} · {clock}
      </>
    );

  switch (event.kind) {
    case "trade": {
      // Same guard as the strip chip: a paused rule can let a fill through with nothing set aside,
      // and the accent means money put aside — so that row reads muted "$0.00" on both surfaces.
      const saved = event.savedUsd > 0;
      return {
        leading: mark(event.symbol, undefined, 20),
        title: fillLabel(event.side, event.symbol),
        sub: joined(<Num>{usd(event.notionalUsd)}</Num>),
        // The slice is the row's number — it is what the product does; the size sits in the sub line.
        amount: usdSigned(event.savedUsd),
        amountClass: saved ? SAVED : "text-muted-foreground",
      };
    }
    case "invested":
      return {
        // Money going into the pension.
        leading: event.logo === undefined ? <PiggyBank className="size-4 text-muted-foreground" aria-hidden /> : mark(event.symbol, event.logo, 20),
        title: `Invested in ${event.symbol}`,
        sub: joined(
          <>
            <Num>{event.sharesText ?? shares(event.shares)}</Num>
            {event.priceUsd === null ? null : (
              <>
                {" "}
                @ <Num>{usd(event.priceUsd)}</Num>
              </>
            )}
          </>,
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
    case "saved": {
      // The trade row's shape, because this IS what a trade row stood for: the
      // slice put aside. It carries the accent only when something moved.
      const saved = event.savedUsd !== null && event.savedUsd > 0;
      return {
        leading: mark("SOL", event.logo, 20),
        title: event.title ?? `Saved from ${event.from}`,
        sub: joined(event.basis),
        amount: usdSigned(event.savedUsd),
        amountClass: saved ? SAVED : "text-muted-foreground",
        ...(event.note === undefined ? {} : { note: event.note }),
      };
    }
    case "other": {
      const Glyph = GLYPHS[event.icon];
      return {
        leading: event.logo === undefined ? <Glyph className="size-4 text-muted-foreground" aria-hidden /> : mark(event.title, event.logo, 20),
        title: event.title,
        sub: joined(event.sub),
        amount: event.amount ?? "",
        amountClass: event.failed ? "text-muted-foreground" : undefined,
        ...(event.failed ? { failed: true } : {}),
      };
    }
  }
}

/**
 * Every row in the same feed. Scoped to the WalletActivity root (`#activity`)
 * because the aside and the sheet can both be mounted, and a hidden row cannot
 * take focus.
 */
function siblings(row: HTMLElement): HTMLElement[] {
  // The feed's own root, whichever id this instance was given (the aside's and
  // the sheet's differ), so the arrows walk every day and not just one.
  const scope = row.closest("[data-activity-feed]") ?? row.closest("#activity") ?? row.parentElement;
  return scope ? Array.from(scope.querySelectorAll<HTMLElement>("[data-activity-row]")) : [row];
}

/**
 * Roving tabindex without a container: a few hundred rows would otherwise be
 * a few hundred Tab stops (each opening its tooltip) before the page's main
 * content. Whichever row gains focus keeps the stop; the rest step out of the
 * Tab order.
 */
function rove(e: FocusEvent<HTMLElement>) {
  for (const row of siblings(e.currentTarget)) row.tabIndex = row === e.currentTarget ? 0 : -1;
}

/** Arrows walk the feed, Home/End jump; focusing scrolls the row into view and `rove` follows. */
function step(e: KeyboardEvent<HTMLElement>) {
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
export function ActivityRow({ event, now, first = false }: { event: ActivityEvent; now: string; first?: boolean }) {
  const { leading, title, sub, amount, amountClass, note, failed } = parts(event);
  const className =
    // Inset ring: the ScrollArea viewport would clip one drawn outside the row.
    "flex w-full items-start gap-3 px-4 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

  const body = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">{leading}</span>
      <span className="min-w-0 flex-1">
        <span className={cn("flex items-center gap-1.5 text-sm", failed && "text-muted-foreground")}>
          <span className="truncate">{title}</span>
          {failed ? (
            <Badge variant="destructive" className="shrink-0">
              Failed
            </Badge>
          ) : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{sub}</span>
        {note === undefined ? null : <span className="block truncate text-xs text-muted-foreground">{note}</span>}
      </span>
      <span className={cn("shrink-0 text-right text-sm", MONO, amountClass)}>{amount}</span>
    </>
  );

  /*
   * A ROW THAT HAS A TRANSACTION TO SHOW IS A LINK TO IT. The sample's rows
   * open a tooltip with a hash nobody can check, because there is nothing to
   * check; a live row's hash is a real transaction, and the explorer is where it
   * is read. Same markup, same roving focus — only the element differs.
   */
  if (event.href !== undefined) {
    const hash = shortHex(event.txHash);
    return (
      <a
        href={event.href}
        target="_blank"
        rel="noopener noreferrer"
        title={hash}
        aria-label={`${title} · Open on Solscan · ${hash}`}
        data-activity-row=""
        aria-keyshortcuts="ArrowUp ArrowDown"
        tabIndex={first ? 0 : -1}
        onFocus={rove}
        onKeyDown={step}
        className={className}
      >
        {body}
      </a>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        data-activity-row=""
        aria-keyshortcuts="ArrowUp ArrowDown"
        onFocus={rove}
        onKeyDown={step}
        className={className}
      >
        {body}
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono">{shortHex(event.txHash)}</span>
        {event.at === null ? null : (
          <>
            <span aria-hidden>·</span>
            <span>{timeAgo(event.at, now)}</span>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
