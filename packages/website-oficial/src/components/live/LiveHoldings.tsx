"use client";

/**
 * WHAT THE VAULT HOLDS, one row per asset — the sample's table
 * (src/components/pension-holdings.tsx) wired to the chain. Its heading and
 * caption, its four column heads, its row and weight cells and its three sums
 * are the sample's own, word for word. What differs below is either a fact the
 * chain has and the sample never had, or a state the sample cannot be in.
 *
 * SHARES COME FROM THE RPC'S OWN DISPLAY AMOUNT, never from raw units: SPYx is
 * a Token-2022 scaledUiAmount mint whose display amount carries a multiplier the
 * issuer can change. The VALUE is computed the other way round — from raw units
 * at the pool rate — which is why the two cannot be derived from each other.
 * That rule lives in live-model.ts; this table only prints what it produced.
 *
 * THE DOLLAR COLUMN IS ALL OR NOTHING. With prices unread every value is null,
 * the column says so once, and no row quietly keeps a stale figure beside a
 * total that says unavailable.
 *
 * TOKENS THAT COULD NOT BE READ ARE SAID TO BE UNREADABLE — never shown as a
 * vault holding nothing.
 */

import { AssetMark } from "@/components/live/AssetMark";
import { NATIVE_SOL } from "@/lib/asset-art";
import { Num } from "@/components/num";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatSol, formatUsd } from "@/lib/amounts";
import { MONO } from "@/lib/classes";
import { pct } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveHoldingRow } from "@/lib/live-types";
import { cn } from "@/lib/utils";

/**
 * What a row shows in the Shares column: SOL as SOL, a token EXACTLY as the RPC
 * wrote it.
 *
 * The sample puts its figure through `shares()` from @/lib/format; this one must
 * not. `uiAmount` is already text, and a scaledUiAmount mint's display amount
 * cannot be derived from its raw units — so re-rounding it here would drop
 * digits the issuer's multiplier put there and nothing on this page could put
 * back.
 */
const sharesOf = (row: LiveHoldingRow): string => (row.kind === "sol" ? formatSol(row.amountRaw) : (row.uiAmount ?? "—"));

export function LiveHoldings({
  holdings,
  worthNowUsdcRaw,
  notInvestedUsdcRaw,
  rentOnlyLamports,
  tokensReadable,
  pricesKnown,
  className,
}: {
  readonly holdings: readonly LiveHoldingRow[];
  readonly worthNowUsdcRaw: bigint | null;
  readonly notInvestedUsdcRaw: bigint | null;
  /** The vault's SOL is all rent, so no row carries that fact. Said here instead. */
  readonly rentOnlyLamports: bigint | null;
  readonly tokensReadable: boolean;
  /** Whether the pools answered at all. False hides every dollar rather than showing $0. */
  readonly pricesKnown: boolean;
  readonly className?: string;
}) {
  const legs = holdings.filter((row) => row.kind === "leg");
  const investedUsdcRaw = legs.some((row) => row.valueUsdcRaw === null) ? null : legs.reduce((total, row) => total + (row.valueUsdcRaw ?? 0n), 0n);

  /*
   * THE SAMPLE'S ORDER — parts, then total — WITH TWO OF ITS THREE WORDS.
   *
   * Its first sum is called "Holdings" because in the sample `holdings` IS the
   * leg list, so the word names exactly the table above it. Here the same table
   * also lists SOL, wSOL and USDC, which this sum excludes: a vault before its
   * first buy would print "Holdings $0.00" under a table visibly listing a
   * holding worth $20.01. So the first sum keeps the label that is true of what
   * it adds up, and the last keeps "Worth now" rather than the sample's
   * "Pension" — the sample can call its total the pension because its total is
   * every row; this one is a valuation that goes to "—" when the pools are
   * unread, and "Pension —" is a heavier claim than "Worth now —".
   */
  const sums: readonly (readonly [string, bigint | null])[] = [
    [LIVE_COPY.invested, investedUsdcRaw],
    [LIVE_COPY.pending, notInvestedUsdcRaw],
    [LIVE_COPY.worthNow, worthNowUsdcRaw],
  ];

  return (
    <section className={cn("space-y-3", className)} aria-labelledby="live-holdings-heading">
      <div className="flex items-baseline justify-between gap-3">
        {/* WHAT THIS TABLE DOES NOT COVER, on the heading rather than on a line
            of its own. It reads the vault's own associated accounts, so a token
            the vault holds in any other account is absent from every row AND
            from all three sums — a fact worth keeping and not worth a permanent
            sentence under a table nobody acts on. Manage wallets lists them,
            and is where they can be withdrawn. */}
        <h3 id="live-holdings-heading" title={LIVE_COPY.holdingsFootnote} className="text-sm font-medium">
          {LIVE_COPY.holdings}
        </h3>
        <p className="text-xs text-muted-foreground">{LIVE_COPY.holdingsCaption}</p>
      </div>

      {holdings.length === 0 ? (
        // An empty table reads two ways and only one of them is the sample's:
        // a vault that has bought nothing yet, or a token list nobody could read.
        <p className="text-sm text-muted-foreground">{tokensReadable ? "No investments yet" : LIVE_COPY.tokensUnreadable}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{LIVE_COPY.asset}</TableHead>
              {/* Below sm the shares figure moves under the symbol: four columns
                  plus the weight bar do not fit a phone without scrolling. */}
              <TableHead className="hidden text-right sm:table-cell">{LIVE_COPY.shares}</TableHead>
              <TableHead className="text-right">{LIVE_COPY.value}</TableHead>
              {/* The target the weight is read against sits under the bar, so the
                  head is the sample's one word rather than a repeat of it. */}
              <TableHead className="text-right">Weight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holdings.map((row) => (
              <TableRow key={row.key}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <AssetMark symbol={row.symbol} mint={row.kind === "sol" ? NATIVE_SOL : row.mint} className="size-5" />
                    <span>
                      <span className="block font-medium">{row.symbol}</span>
                      <span className="block font-mono text-xs tabular-nums text-muted-foreground sm:hidden">{sharesOf(row)}</span>
                      {row.kind === "sol" && row.rentFloor !== null ? (
                        // Capped and wrapping below sm: a table cell sizes to its
                        // content, and this sentence is long enough to push the
                        // Value column off a 375px screen entirely.
                        <span className="block max-w-36 text-xs whitespace-normal text-muted-foreground sm:max-w-none">{LIVE_COPY.solKeptAsRent(formatSol(row.rentFloor))}</span>
                      ) : null}
                    </span>
                  </span>
                </TableCell>
                <TableCell className={cn(MONO, "hidden text-right sm:table-cell")}>{sharesOf(row)}</TableCell>
                <TableCell className={cn(MONO, "text-right")}>{row.valueUsdcRaw === null ? "—" : formatUsd(row.valueUsdcRaw)}</TableCell>
                <TableCell className="text-right">
                  {/* SOL, wSOL and USDC are not in the basket, so they have no
                      weight and no target — the sample has no such row. */}
                  {row.kind !== "leg" || row.weightBps === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <div className="ml-auto w-20 space-y-1 sm:w-24">
                      <div className={MONO}>{pct(row.weightBps, 0)}</div>
                      <Progress value={row.weightBps / 100} className="h-1" aria-label={`${row.symbol} weight`} />
                      {row.targetWeightBps === null ? null : (
                        <div className="text-xs text-muted-foreground">
                          <Num>{pct(row.targetWeightBps, 0)}</Num> {LIVE_COPY.target}
                        </div>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Three cells until xl: the inline row needs ~370px and the panel has less
          on a phone and again beside the lg sidebar, where a wrap under
          justify-between left "Pension" orphaned on its own line. */}
      <dl className="grid grid-cols-3 gap-3 text-sm xl:flex xl:justify-between">
        {sums.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 xl:flex-row xl:items-baseline xl:gap-1.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={MONO}>{value === null ? "—" : formatUsd(value)}</dd>
          </div>
        ))}
      </dl>

      {/* States, not footnotes: each of these says that a figure above is absent
          for a reason, and none of them appears when there is nothing to say. */}
      {rentOnlyLamports === null ? null : <p className="text-xs text-muted-foreground">{LIVE_COPY.solRentOnly(formatSol(rentOnlyLamports))}</p>}
      {!pricesKnown ? <p className="text-xs text-muted-foreground">{LIVE_COPY.pricesUnreadableNote}</p> : null}
      {/* Only when the table itself is not already saying it: with no rows the
          empty state above prints this very sentence, and it was rendering twice. */}
      {!tokensReadable && holdings.length > 0 ? <p className="text-xs text-muted-foreground">{LIVE_COPY.tokensUnreadable}</p> : null}
    </section>
  );
}
