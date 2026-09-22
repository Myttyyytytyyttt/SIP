"use client";

/**
 * WHAT THE VAULT HOLDS, one row per asset.
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
import { Num } from "@/components/num";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatSol, formatUsd } from "@/lib/amounts";
import { MONO } from "@/lib/classes";
import { pct } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveHoldingRow } from "@/lib/live-types";
import { cn } from "@/lib/utils";

/** What a row shows in the Shares column: SOL as SOL, a token as the RPC said. */
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

  const sums: readonly (readonly [string, bigint | null])[] = [
    [LIVE_COPY.notInvestedYet, notInvestedUsdcRaw],
    [LIVE_COPY.invested, investedUsdcRaw],
    [LIVE_COPY.worthNow, worthNowUsdcRaw],
  ];

  return (
    <section className={cn("space-y-3", className)} aria-labelledby="live-holdings-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="live-holdings-heading" className="text-sm font-medium">
          {LIVE_COPY.holdings}
        </h3>
      </div>

      {holdings.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tokensReadable ? LIVE_COPY.notInvestedYet : LIVE_COPY.tokensUnreadable}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{LIVE_COPY.asset}</TableHead>
              {/* Below sm the shares figure moves under the symbol: four columns plus the weight bar do not fit a phone. */}
              <TableHead className="hidden text-right sm:table-cell">{LIVE_COPY.shares}</TableHead>
              <TableHead className="text-right">{LIVE_COPY.value}</TableHead>
              <TableHead className="text-right">{LIVE_COPY.weightVsTarget}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holdings.map((row) => (
              <TableRow key={row.key}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <AssetMark symbol={row.symbol} className="size-5" />
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

      <dl className="grid grid-cols-3 gap-3 text-sm xl:flex xl:justify-between">
        {sums.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-0.5 xl:flex-row xl:items-baseline xl:gap-1.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className={MONO}>{value === null ? "—" : formatUsd(value)}</dd>
          </div>
        ))}
      </dl>

      {rentOnlyLamports === null ? null : <p className="text-xs text-muted-foreground">{LIVE_COPY.solRentOnly(formatSol(rentOnlyLamports))}</p>}
      {!pricesKnown ? <p className="text-xs text-muted-foreground">{LIVE_COPY.pricesUnreadableNote}</p> : null}
      {!tokensReadable ? <p className="text-xs text-muted-foreground">{LIVE_COPY.tokensUnreadable}</p> : null}
      <p className="text-xs text-muted-foreground">{LIVE_COPY.holdingsFootnote}</p>
    </section>
  );
}
