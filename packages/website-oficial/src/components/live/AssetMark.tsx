/**
 * WHAT AN ASSET LOOKS LIKE, and what it is called.
 *
 * SPYx has a mark under public/stocks; SOL, wSOL and USDC do not, and inventing
 * one for them is not this branch's job — they get a lettered disc instead, which
 * reads as deliberate rather than as a broken image.
 *
 * '@/mocks/types' IS THE ONLY MOCK IMPORT ALLOWED HERE, and it is a type module
 * plus one pure path helper: `tickerLogo`. The barrel '@/mocks' also re-exports
 * the seeded dataset, and a live panel must never be one import away from a
 * stranger's invented savings (src/components/live/no-mock-import.test.ts).
 */

import Image from "next/image";

import { TICKERS, tickerLogo, type Ticker } from "@/mocks/types";
import { cn } from "@/lib/utils";

const KNOWN: ReadonlySet<string> = new Set(TICKERS);

const isTicker = (symbol: string): symbol is Ticker => KNOWN.has(symbol);

/**
 * One asset's mark at `size` px. A ticker with artwork gets it; anything else
 * gets its first letter on the muted disc every other icon on the page sits on.
 */
export function AssetMark({ symbol, size = 20, className }: { readonly symbol: string; readonly size?: number; readonly className?: string }) {
  if (isTicker(symbol)) {
    // max-w-none: preflight's percentage max-width counts as 0 in a table's
    // min-content, and without it the mark overflows into the next column.
    return <Image src={tickerLogo(symbol)} alt="" width={size} height={size} className={cn("shrink-0 max-w-none rounded-full", className)} />;
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
