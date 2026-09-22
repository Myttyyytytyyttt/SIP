/**
 * WHAT AN ASSET LOOKS LIKE, and what it is called.
 *
 * THE MINT DECIDES, and the symbol is only a label. A ticker belongs to
 * whoever issued the token, so keying artwork by it hangs one issuer's logo on
 * another's mint the first time two of them agree on three letters — which on
 * a panel reading mainnet is a question of when, not whether. src/lib/asset-art.ts
 * holds the map; this file only draws what it answers.
 *
 * THE SYMBOL IS STILL ACCEPTED as a second key, for the seeded sample's own
 * tickers under public/stocks: those ARE the dataset's own names and cannot
 * collide with anything. A live caller passes the mint and gets the mint's
 * answer.
 *
 * AN UNMAPPED ASSET GETS A LETTERED DISC, not a broken image — the same muted
 * disc every other icon on this page sits on. That is what lets a leg be
 * listed the day the policy names it, with its artwork following later.
 *
 * '@/mocks/types' IS THE ONLY MOCK IMPORT ALLOWED HERE, and it is a type module
 * plus one pure path helper. The barrel '@/mocks' also re-exports the seeded
 * dataset, and a live panel must never be one import away from a stranger's
 * invented savings (src/components/live/no-mock-import.test.ts).
 */

import Image from "next/image";

import { artForMint } from "@/lib/asset-art";
import { TICKERS, tickerLogo, type Ticker } from "@/mocks/types";
import { cn } from "@/lib/utils";

const KNOWN: ReadonlySet<string> = new Set(TICKERS);

const isTicker = (symbol: string): symbol is Ticker => KNOWN.has(symbol);

/**
 * One asset's mark at `size` px: its mint's artwork, else its ticker's, else
 * its first letter on the muted disc.
 */
export function AssetMark({
  symbol,
  mint = null,
  size = 20,
  className,
}: {
  readonly symbol: string;
  /** The asset's mint, which is what the artwork is really keyed by. */
  readonly mint?: string | null;
  readonly size?: number;
  readonly className?: string;
}) {
  const src = artForMint(mint) ?? (isTicker(symbol) ? tickerLogo(symbol) : null);
  if (src !== null) {
    // max-w-none: preflight's percentage max-width counts as 0 in a table's
    // min-content, and without it the mark overflows into the next column.
    return <Image src={src} alt="" width={size} height={size} className={cn("shrink-0 max-w-none rounded-full", className)} />;
  }
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium text-muted-foreground", className)}
    >
      {symbol.slice(0, 1).toUpperCase()}
    </span>
  );
}
