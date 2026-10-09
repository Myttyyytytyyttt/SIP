/**
 * WHAT IS ON ITS WAY, OVER THE FEED (owner, 2026-10-08).
 *
 * The steps come from src/lib/live-pending.ts. Each is drawn in the feed row's
 * own language (activity-row.tsx): the square on the left, the title and its
 * line, the amount on the right, the same colours — grey for the machinery
 * converting and for anything resting, blue for a buy under way. A step under
 * way puts a small turning mark in the square; one that rests puts a still
 * glyph there and says why. When the chain catches up the step drops out of
 * this list, and the feed below holds the transaction that did it. A trading
 * wallet the chain said changed, and not yet saved from, leads the list
 * ("Trading wallet 1: checking your latest activity"): grey, with no amount, because
 * nothing is known yet about what it will save. Its title wraps instead of
 * truncating: it has no amount beside it, and in the 263 px column of the lg
 * layout the one-line title lost its last words.
 *
 * THE REGION IS ALWAYS THERE, EMPTY OR NOT. A polite live region announces what
 * changes inside it, which needs it to exist before the change; it holds
 * nothing and draws nothing while no step is pending. The turning mark stops
 * for anyone who asked for reduced motion.
 *
 * TWO PLACES, ONE PER SCREEN WIDTH (LiveBody.tsx). From lg up the steps lead
 * the activity column. Below lg that column lives in a sheet nobody has opened,
 * so a "card" copy leads the page's own top instead — out of the flow while it
 * is empty (sr-only keeps the region in the accessibility tree, so the first
 * step is still announced, without adding a gap to the column it sits in).
 *
 * A CONVERTING ROW'S DOLLARS ARE NOT READ OUT. They are re-priced at every
 * read's SOL price, and inside a live region every cent would be announced
 * again; the SOL, which only changes when the step does, is what is spoken
 * (PendingLine.amountSpoken).
 */

import { ArrowLeftRight, Clock, Loader2, Pause, PiggyBank } from "lucide-react";

import { MONO } from "@/lib/classes";
import { PENDING_COPY } from "@/lib/live-copy";
import type { PendingLine } from "@/lib/live-pending";
import { cn } from "@/lib/utils";

/**
 * The feed's own tiles (activity-row.tsx): blue is a buy, and only a buy under
 * way wears it; the conversion, and anything resting, is the machinery's grey.
 */
const tileOf = (line: PendingLine): string => (line.active && line.kind === "buying" ? "bg-blue-500/12 text-blue-600 dark:text-blue-400" : "bg-muted text-muted-foreground");
const amountOf = (line: PendingLine): string => (line.active && line.kind === "buying" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground");

function Glyph({ line }: { readonly line: PendingLine }) {
  if (line.active) return <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden data-pending-loader="" />;
  if (
    line.rest === "paused" ||
    line.rest === "protocol_paused" ||
    line.rest === "buying_off" ||
    line.rest === "conversion_off" ||
    line.rest === "price_limits" ||
    line.rest === "safety_floor"
  ) {
    return <Pause className="size-4" aria-hidden />;
  }
  if (line.rest === "slow") return <Clock className="size-4" aria-hidden />;
  return line.kind === "buying" ? <PiggyBank className="size-4" aria-hidden /> : <ArrowLeftRight className="size-4" aria-hidden />;
}

export function PendingRows({
  lines,
  className,
  announce = true,
  variant = "column",
}: {
  readonly lines: readonly PendingLine[];
  readonly className?: string;
  /** "card": framed, for the top of the page below lg, and out of the flow while empty. */
  readonly variant?: "column" | "card";
  /**
   * False for a copy drawn beside another that already announces: on /activity
   * the sidebar and the page's own list show the same steps at once, and one
   * change read out twice is noise.
   */
  readonly announce?: boolean;
}) {
  return (
    <div
      {...(announce ? { role: "status", "aria-live": "polite" as const } : {})}
      className={cn(variant === "card" && (lines.length === 0 ? "sr-only" : "overflow-hidden rounded-md border bg-card"), className) || undefined}
      data-pending-steps={lines.length}
    >
      {lines.length === 0 ? null : (
        <>
          <div className="px-4 py-2 text-xs text-muted-foreground">{PENDING_COPY.heading}</div>
          {lines.map((line) => (
            <div
              key={line.key}
              className="flex w-full items-start gap-3 px-4 py-2.5"
              data-pending-step={line.kind}
              data-state={line.active ? "active" : "waiting"}
            >
              <span className={cn("relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md", tileOf(line))}>
                <Glyph line={line} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm", line.kind === "measuring" ? "break-words" : "truncate")}>{line.title}</span>
                <span className="block text-xs text-muted-foreground">{line.sub}</span>
              </span>
              <span className={cn("shrink-0 text-right text-sm", MONO, amountOf(line))} {...(line.amountSpoken === null ? {} : { "aria-hidden": true })}>
                {line.amount}
              </span>
              {line.amountSpoken ? <span className="sr-only">{line.amountSpoken}</span> : null}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
