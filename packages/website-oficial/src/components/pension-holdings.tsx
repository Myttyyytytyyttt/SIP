import Image from "next/image";

import { Num } from "@/components/num";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MONO } from "@/lib/classes";
import { pct, shares, usd } from "@/lib/format";
import { cn } from "@/lib/utils";
// The leaf, not the barrel: `@/mocks` also re-exports the seeded dataset.
import { tickerLogo, type Holding, type SavingsRule, type SavingsStats } from "@/mocks/types";

/**
 * What the pension holds, one row per asset, in the order they arrive: the
 * mock derives them from the rule's targets (INDEX, then SPYx, then GLDx), so
 * ordering is the data's contract, not this leaf's. Server component: a table
 * and three sums, nothing to click.
 */
export function PensionHoldings({
  holdings,
  stats,
  className,
}: {
  holdings: readonly Holding[];
  rule: SavingsRule;
  stats: SavingsStats;
  className?: string;
}) {
  const sums = [
    ["Holdings", stats.holdingsUsd],
    ["Pending", stats.pendingUsd],
    ["Pension", stats.pensionValueUsd],
  ] as const;

  return (
    <section className={cn("space-y-3", className)} aria-labelledby="pension-holdings-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="pension-holdings-heading" className="text-sm font-medium">
          Holdings
        </h3>
        <p className="text-xs text-muted-foreground">What the pension holds</p>
      </div>

      {holdings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No investments yet</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Asset</TableHead>
              {/* Below sm the shares figure moves under the symbol: four columns
                  plus the weight bar do not fit a phone without scrolling. */}
              <TableHead className="hidden text-right sm:table-cell">Shares</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead className="text-right">Weight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holdings.map((holding) => (
              <TableRow key={holding.symbol}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    {/* max-w-none: preflight's percentage max-width counts as 0 in
                        the table's min-content, so without it the logo overflows
                        into the next column instead of widening this one. */}
                    <Image
                      src={tickerLogo(holding.symbol)}
                      alt={holding.symbol}
                      width={20}
                      height={20}
                      className="size-5 shrink-0 max-w-none rounded-full"
                    />
                    <span>
                      <span className="block font-medium">{holding.symbol}</span>
                      <span className="block font-mono text-xs tabular-nums text-muted-foreground sm:hidden">
                        {shares(holding.shares)}
                      </span>
                    </span>
                  </span>
                </TableCell>
                <TableCell className={cn(MONO, "hidden text-right sm:table-cell")}>
                  {holding.sharesText ?? shares(holding.shares)}
                </TableCell>
                <TableCell className={cn(MONO, "text-right")}>{usd(holding.valueUsd)}</TableCell>
                <TableCell className="text-right">
                  {/* A weight nobody can work out (a leg with no price) is a dash and no bar — never an empty bar reading 0 %. */}
                  {holding.weightBps === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <div className="ml-auto w-20 space-y-1 sm:w-24">
                      <div className={MONO}>{pct(holding.weightBps, 0)}</div>
                      <Progress value={holding.weightBps / 100} className="h-1" aria-label={`${holding.symbol} weight`} />
                      {holding.targetWeightBps === null ? null : (
                        <div className="text-xs text-muted-foreground">
                          <Num>{pct(holding.targetWeightBps, 0)}</Num> target
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
            <dd className={MONO}>{usd(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
