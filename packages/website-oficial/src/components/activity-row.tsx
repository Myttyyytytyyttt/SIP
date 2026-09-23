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
import { tickerLogo, type ActivityEvent, type Backdrop, type OtherEvent } from "@/mocks/types";

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

/**
 * WHAT KIND OF THING HAPPENED, AT A GLANCE (owner, 09-23):
 *
 *   saved    green   money coming in — a slice the rule put aside (from gains
 *                    or from volume), and SOL that simply arrived;
 *   invest   blue    the pension buying what it holds;
 *   setting  mustard a change to how the pension behaves, and only that — a
 *                    new rule, a signed policy, a wallet linked or unlinked,
 *                    the vault itself created;
 *   quiet    grey    the system doing its job — a conversion, a wrap, the
 *                    keeper's upkeep, a settlement that found nothing to take,
 *                    a withdrawal whose minus sign already says it. Correct
 *                    and expected, so it steps back and lets the rest be seen;
 *   failed   red     kept rare on purpose: a transaction that did not land, or
 *                    one nobody could read. Red that shows up every day stops
 *                    meaning anything.
 *
 * The tint is on the icon's square and on the amount, never on the words: the
 * row still reads the same in any colour, and nothing is said only by hue.
 */
type Tone = "saved" | "invest" | "setting" | "quiet" | "failed";

const TILE: Readonly<Record<Tone, string>> = {
  saved: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  invest: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
  setting: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  quiet: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
};

const AMOUNT: Readonly<Record<Tone, string>> = {
  saved: SAVED,
  invest: "text-blue-600 dark:text-blue-400",
  setting: "text-amber-700 dark:text-amber-400",
  // Muted, not the page's ink: in the dark theme plain white would be the
  // loudest figure in the column, on the rows that matter least.
  quiet: "text-muted-foreground",
  failed: "text-destructive",
};

/**
 * WHAT THE SQUARE SHOWS BEHIND ITS GLYPH — the marks of what the transaction
 * touched, or the figure it set — faint, so the glyph still leads. Two marks
 * sit at the square's edges, half out of it, with the glyph between them: SOL
 * going in on the left, USDC coming out on the right. One mark peeks from the
 * corner: centred, a full disc would cover the square and grey its colour out.
 * Hovering the row lifts them a little: the square answers the pointer, as the
 * row does.
 */
function BackdropArt({ art }: { readonly art: Backdrop }) {
  const fade = "opacity-25 transition-opacity duration-300 group-hover/row:opacity-50 group-focus-visible/row:opacity-50";
  if (art.text !== undefined) {
    return (
      <span aria-hidden className={cn("absolute inset-0 grid place-items-center font-mono text-[11px] leading-none font-bold tracking-tighter", fade)}>
        {art.text}
      </span>
    );
  }
  const [first, second] = art.logos ?? [];
  if (first === undefined) return null;
  if (second === undefined) {
    return <Image aria-hidden src={first} alt="" width={20} height={20} className={cn("absolute -right-1.5 -bottom-1.5 size-5 rounded-full", fade)} />;
  }
  return (
    <>
      <Image aria-hidden src={first} alt="" width={20} height={20} className={cn("absolute top-1/2 -left-2 size-5 -translate-y-1/2 rounded-full", fade)} />
      <Image aria-hidden src={second} alt="" width={20} height={20} className={cn("absolute top-1/2 -right-2 size-5 -translate-y-1/2 rounded-full", fade)} />
    </>
  );
}

/** What each `other` row is, by its glyph: money in is green, a setting is mustard, the machinery is quiet, a failure is a failure. */
const TONE_OF_OTHER: Readonly<Record<OtherEvent["icon"], Tone>> = {
  // A change to how the pension behaves.
  vault: "setting",
  rule: "setting",
  policy: "setting",
  link: "setting",
  unlink: "setting",
  // The system doing its job.
  wrap: "quiet",
  convert: "quiet",
  withdraw: "quiet",
  upkeep: "quiet",
  other: "quiet",
  // Money coming in, like a slice put aside — though never counted as one.
  receive: "saved",
  failed: "failed",
};

interface RowParts {
  /** Which colour the row wears; see Tone. */
  readonly tone: Tone;
  /** What the square shows behind the glyph; see BackdropArt. */
  readonly backdrop?: Backdrop;
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
        tone: saved ? "saved" : "quiet",
        leading: mark(event.symbol, undefined, 20),
        title: fillLabel(event.side, event.symbol),
        sub: joined(<Num>{usd(event.notionalUsd)}</Num>),
        // The slice is the row's number — it is what the product does; the size sits in the sub line.
        amount: usdSigned(event.savedUsd),
        amountClass: AMOUNT[saved ? "saved" : "quiet"],
      };
    }
    case "invested":
      return {
        // Money going into the pension.
        tone: "invest",
        leading: event.logo === undefined ? <PiggyBank className="size-4" aria-hidden /> : mark(event.symbol, event.logo, 20),
        // The sample's buy has no mark of its own in the square, so the asset it bought sits behind the piggy bank.
        ...(event.logo === undefined ? { backdrop: event.backdrop ?? { logos: [tickerLogo(event.symbol)] } } : {}),
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
        amountClass: AMOUNT.invest,
      };
    case "deposit":
      return {
        // A deposit is money coming in, as a receipt is on a live page.
        tone: "saved",
        leading: <ArrowDownToLine className="size-4" aria-hidden />,
        title: "Funded wallet",
        sub: clock,
        amount: usdSigned(event.amountUsd),
        amountClass: AMOUNT.saved,
      };
    case "saved": {
      // The trade row's shape, because this IS what a trade row stood for: the
      // slice put aside. It carries the accent only when something moved.
      const saved = event.savedUsd !== null && event.savedUsd > 0;
      return {
        tone: saved ? "saved" : "quiet",
        leading: mark("SOL", event.logo, 20),
        title: event.title ?? `Saved from ${event.from}`,
        sub: joined(event.basis),
        amount: usdSigned(event.savedUsd),
        amountClass: AMOUNT[saved ? "saved" : "quiet"],
        ...(event.note === undefined ? {} : { note: event.note }),
      };
    }
    case "other": {
      const Glyph = GLYPHS[event.icon];
      return {
        tone: event.failed ? "failed" : TONE_OF_OTHER[event.icon],
        ...(event.backdrop === undefined ? {} : { backdrop: event.backdrop }),
        leading: event.logo === undefined ? <Glyph className="size-4" aria-hidden /> : mark(event.title, event.logo, 20),
        title: event.title,
        sub: joined(event.sub),
        amount: event.amount ?? "",
        amountClass: AMOUNT[event.failed ? "failed" : TONE_OF_OTHER[event.icon]],
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
export function ActivityRow({
  event,
  now,
  first = false,
  order,
}: {
  event: ActivityEvent;
  now: string;
  first?: boolean;
  /** Its place in the feed's entrance: rows rise in one after another, the first dozen in a short cascade. */
  order?: number;
}) {
  const { tone, leading, title, sub, amount, amountClass, note, failed, backdrop } = parts(event);
  const className = cn(
    // Inset ring: the ScrollArea viewport would clip one drawn outside the row.
    "group/row flex w-full items-start gap-3 px-4 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    order === undefined ? undefined : "rise-in",
  );
  const rise = order === undefined ? undefined : ({ ["--rise" as string]: `${Math.min(order, 12) * 35}ms` } as const);

  const body = (
    <>
      <span className={cn("relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md", TILE[tone])}>
        {backdrop === undefined ? null : <BackdropArt art={backdrop} />}
        {/* The glyph leads, and leans in a touch when the row is pointed at. */}
        <span className="relative flex transition-transform duration-300 group-hover/row:scale-110">{leading}</span>
      </span>
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
      <span className={cn("shrink-0 text-right text-sm", MONO, amountClass ?? AMOUNT[tone])}>{amount}</span>
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
        style={rise}
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
        style={rise}
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
