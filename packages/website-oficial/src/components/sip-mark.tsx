/**
 * THE MARK, ONE PER THEME.
 *
 * The source art is two flat PNGs with no alpha — black on white, white on
 * black — so either one dropped straight in would paint its own rectangle over
 * the page. `public/logo/sip-mark-*.png` are the ink cut out of them: the same
 * shape, transparent ground, trimmed to the glyph (218 x 256 of the original
 * 5504 x 3072 sheet, which was almost all margin).
 *
 * Two <Image>s rather than one recoloured asset, because a PNG cannot take
 * `currentColor`. `dark:` is the class-strategy variant next-themes sets on
 * <html> before React hydrates, so the right one is on screen from the first
 * paint — no flash of the wrong ink.
 *
 * alt="" on purpose: the wordmark beside it already says SIP, and a screen
 * reader announcing the name twice is worse than not announcing the image.
 *
 * A MODULE OF ITS OWN (10-22, measured): it lived in site-footer.tsx, and the
 * docs' client chrome importing it from there shipped the whole footer to every
 * /docs page — its links and the dashboard's mode logic with them. site-footer
 * re-exports it, so nothing else had to change.
 */

import Image from "next/image";

import { cn } from "@/lib/utils";

const MARK = { width: 218, height: 256 } as const;

export function SipMark({ className }: { className?: string }) {
  return (
    <>
      <Image alt="" className={cn("dark:hidden", className)} src="/logo/sip-mark-black.png" {...MARK} />
      <Image alt="" className={cn("hidden dark:block", className)} src="/logo/sip-mark-white.png" {...MARK} />
    </>
  );
}
