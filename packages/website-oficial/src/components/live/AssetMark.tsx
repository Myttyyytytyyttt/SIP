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

import { artForMint, issuerBadgeFor } from "@/lib/asset-art";
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
  badge = true,
  className,
}: {
  readonly symbol: string;
  /** The asset's mint, which is what the artwork is really keyed by. */
  readonly mint?: string | null;
  readonly size?: number;
  /** The issuer's badge in the corner. Off where the mark is too small to carry one. */
  readonly badge?: boolean;
  readonly className?: string;
}) {
  const src = artForMint(mint) ?? (isTicker(symbol) ? tickerLogo(symbol) : null);
  const issuer = badge && size >= 20 ? issuerBadgeFor(mint) : null;

  const face =
    src !== null ? (
      // max-w-none: preflight's percentage max-width counts as 0 in a table's
      // min-content, and without it the mark overflows into the next column.
      <Image src={src} alt="" width={size} height={size} className={cn("max-w-none rounded-full", issuer === null && "shrink-0", className)} />
    ) : (
      <span
        aria-hidden
        style={{ width: size, height: size }}
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium text-muted-foreground",
          issuer === null && "shrink-0",
          className,
        )}
      >
        {symbol.slice(0, 1).toUpperCase()}
      </span>
    );

  if (issuer === null) return face;

  /*
   * THE COMPANY IS THE FACE, THE ISSUER IS THE CORNER. A person looks for
   * Anthropic; what decides what can happen to the token is that it is a
   * PreStocks product — one key that can freeze it, pause it and charge a
   * transfer fee. Both facts, in the order somebody reads them.
   *
   * The badge sits on the page's own background rather than on the logo, so a
   * mark with a white face and a mark with a black one both keep it legible.
   */
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      {face}
      <span
        aria-hidden
        title={issuer.label}
        style={{ width: Math.round(size * 0.46), height: Math.round(size * 0.46) }}
        className="absolute -right-0.5 -bottom-0.5 inline-flex items-center justify-center overflow-hidden rounded-full bg-background ring-1 ring-background"
      >
        <Image src={issuer.src} alt="" width={16} height={16} className="size-full max-w-none object-contain p-px" />
      </span>
    </span>
  );
}
