"use client";

/**
 * THE PICKER: the catalogue, the ticks, and the share against each.
 *
 * It lives beside InvestingCard rather than inside it because that file was
 * already 679 lines of a different job — the policy form, its caps, its floors
 * and its signing flow — and this is a list with its own rules.
 *
 * WHAT IT DECIDES AND WHAT IT DOES NOT. It owns the rows: which assets are
 * offered, which are ticked, what share each carries, and the refusals under
 * the ones that are not offered. It owns NO arithmetic: the window of caps, the
 * binding leg and the ceiling are computed by basket-picker.ts over the same
 * rows and are rendered by the card, beside the boxes they constrain, because
 * that is where the owner is typing when they bite.
 *
 * THREE RULES THIS COMPONENT ENFORCES, each for a reason that costs money:
 *  * AT MOST FIVE. MAX_PICKED_LEGS is the owner's "maximo como 5". The program
 *    would take eight; five is the product's choice and the size every rule on
 *    the shelf was measured at (CATALOGUE_REFERENCE_LEG_RAW is max_per_call
 *    over five).
 *  * AN UNTICKED ASSET IS REMOVED, NEVER HELD AT 0 %. set_invest_policy
 *    requires weight_bps > 0, so a row kept at zero builds a transaction the
 *    chain rejects after Phantom has already asked for a signature.
 *  * NOTHING IS REPAIRED. The shares are not normalised to 100 and a missing
 *    one is not filled in. What is offered instead is a BUTTON that evens them
 *    out, which the owner presses on purpose — an affordance is worth more than
 *    an error message, and a silent repair is worth less than either.
 */

import { useId } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatUsd } from "@/lib/amounts";
import { PICKER_MAX_LEGS, catalogueRows, evenedOut, percentTotal, toggled, withPercent, type PickedRow } from "@/lib/basket-picker";
import { LABEL } from "@/lib/classes";
import { INVEST_COPY, PICKER_COPY, listAnd, ratePercent } from "@/lib/vault-copy";
import { XSTOCKS_POWERS, type CatalogueAsset } from "@sip/solana-core/client";

/**
 * What an asset's market was measured at, with the day AND THE KIND OF
 * MEASUREMENT on its face — or that nobody measured it.
 *
 * THE SCOPE TRAVELS WITH THE NUMBER, which it did not before. A route census
 * and a venue-wide figure were rendered in identical words, so FIGUREAI's
 * "$50,000.00" — a whole venue's book — read exactly like SPYx's counted route,
 * under a sentence below calling every line a count. The two differed by
 * forty-five times on ANTHROPIC on the day both were read, and conflating them
 * is the failure this whole feature exists to prevent (basket-picker.ts).
 */
function depthWords(asset: CatalogueAsset): string {
  // The ROUTE census first, because it is the one a cap is divided by; the
  // shelf's own screening figure only when there is no census to show.
  const reading = asset.routeCensus ?? asset.depth;
  if (reading === null || reading === undefined) return PICKER_COPY.depthUnread;
  return PICKER_COPY.depthLine(reading.venue, formatUsd(reading.usdcRaw), reading.readOn, reading.scope, reading.derived === true);
}

export function BasketPicker({
  picked,
  onPicked,
  blocked,
  problem,
  perBuyRaw,
}: {
  readonly picked: readonly PickedRow[];
  readonly onPicked: (rows: readonly PickedRow[]) => void;
  readonly blocked: boolean;
  /** Why this basket cannot be signed, from the card's own read of it; null when it can. */
  readonly problem: string | null;
  /** The cap in the box, so each row can say what it would be handed out of a full buy. Null while it is unreadable. */
  readonly perBuyRaw: bigint | null;
}) {
  const listId = useId();
  const rows = catalogueRows();
  const chosen = new Map(picked.map((row) => [row.mint, row.percent]));
  const full = picked.length >= PICKER_MAX_LEGS;
  const total = percentTotal(picked);

  // THE THREE RULES LIVE IN basket-picker.ts, not in these closures: unticked
  // is removed rather than zeroed, a full basket does not grow, a refused asset
  // never enters one, and nothing is repaired except by the button below. Each
  // of those is pinned by a test over the function rather than argued for here.
  const toggle = (mint: string, on: boolean): void => onPicked(toggled(picked, mint, on));
  const setPercent = (mint: string, percent: string): void => onPicked(withPercent(picked, mint, percent));
  const evenOut = (): void => onPicked(evenedOut(picked));

  return (
    <div className="space-y-2">
      <div className={LABEL}>{PICKER_COPY.title}</div>
      <p className="text-xs text-muted-foreground">{PICKER_COPY.hint(PICKER_MAX_LEGS)}</p>

      {/* WHERE HE PICKS, not three boxes below it. */}
      <div className="rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs">{PICKER_COPY.allOrNothing}</div>

      <ul id={listId} className="divide-y rounded-md border">
        {rows.map(({ asset, offerable, problems }) => {
          const isChosen = chosen.has(asset.mint);
          const percent = chosen.get(asset.mint) ?? "";
          const bps = /^[0-9]{1,3}$/.test(percent.trim()) ? Number(percent.trim()) * 100 : null;
          return (
            <li key={asset.mint} className="space-y-1 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex flex-1 items-start gap-2">
                  <input
                    type="checkbox"
                    id={`invest-pick-${asset.mint}`}
                    name={`invest-pick-${asset.mint}`}
                    checked={isChosen}
                    // A refused asset is not tickable, and a full basket does
                    // not grow: the limit is enforced where it is reached, so
                    // nobody meets it for the first time at Sign.
                    disabled={blocked || !offerable || (full && !isChosen)}
                    onChange={(event) => toggle(asset.mint, event.target.checked)}
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                  />
                  <span>
                    <span className="font-medium text-foreground">{asset.symbol}</span> <span className="text-muted-foreground">{asset.name}</span>
                  </span>
                </label>
                {offerable ? null : <Badge variant="outline">{PICKER_COPY.notOffered}</Badge>}
                {isChosen ? (
                  <span className="flex items-center gap-2">
                    <Label htmlFor={`invest-weight-${asset.mint}`} className="sr-only">
                      {asset.symbol}
                    </Label>
                    <Input
                      id={`invest-weight-${asset.mint}`}
                      inputMode="numeric"
                      autoComplete="off"
                      value={percent}
                      disabled={blocked}
                      onChange={(event) => setPercent(asset.mint, event.target.value)}
                      className="h-8 w-16 font-mono"
                    />
                    <span className="text-muted-foreground">%</span>
                  </span>
                ) : null}
              </div>
              <p className="text-muted-foreground">{depthWords(asset)}</p>
              {/* EVERY rule that refused it, each with the dated reading behind it. */}
              {problems.map((failure) => (
                <p key={failure.rule} className="text-muted-foreground">
                  {PICKER_COPY.refusedBecause(failure.why)}
                </p>
              ))}
              {isChosen && bps !== null && perBuyRaw !== null ? (
                <p className="text-muted-foreground">{PICKER_COPY.legShare(asset.symbol, ratePercent(bps), formatUsd((perBuyRaw * BigInt(bps)) / 10_000n))}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={total === 100 ? "text-muted-foreground" : "text-destructive"}>
          {total === 100 ? PICKER_COPY.exact : total < 100 ? PICKER_COPY.short(ratePercent((100 - total) * 100)) : PICKER_COPY.over(ratePercent((total - 100) * 100))}
        </span>
        {/* THE FIX, AS A PRESS. It is offered whenever the shares are not
            exactly 100, including when a box is empty or unreadable. */}
        {total === 100 || picked.length === 0 ? null : (
          <Button type="button" size="sm" variant="outline" disabled={blocked} onClick={evenOut}>
            {PICKER_COPY.evenOut}
          </Button>
        )}
        {full ? <span className="text-muted-foreground">{PICKER_COPY.full(PICKER_MAX_LEGS)}</span> : null}
      </div>

      <p className="text-xs text-muted-foreground">{INVEST_COPY.weightsHint}</p>
      <p className="text-xs text-muted-foreground">{PICKER_COPY.depthMeaning}</p>
      <p className="text-xs text-muted-foreground">{PICKER_COPY.xstockGroup(listAnd([...XSTOCKS_POWERS.mintsRead]))}</p>
      <p className="text-xs text-muted-foreground">{PICKER_COPY.prestockGroup}</p>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
