/**
 * A SHARED CARD'S OWN PAGE, /c/<token> and /c/example (owner, 10-22: "Enlace
 * con vista previa"). What a post on X links to: X reads this page's metadata
 * and shows the card under the post; a person who clicks lands here.
 *
 * WHAT IT SHOWS: the card, where its figures came from and when ("Read from
 * Solana by SaverFi on Oct 22, 2026" — the token's day), and the two ways on:
 * "Start your pension" to the landing, and the docs. Nothing of anyone's: the
 * card has no address on it, and neither has the page or its link.
 *
 * WHAT IT TELLS A CRAWLER: the card as og:image and twitter:image
 * (summary_large_image), at its versioned address (lib/share-render-version.ts);
 * a headline and a line in the third person (SHARE_COPY.page); noindex with
 * its links followed — one person's dated moment is not a page for a search
 * result — and no canonical. The noindex is also an X-Robots-Tag header on
 * /c/ (next.config.mjs): metadata a page streams can land after <head> for a
 * client outside Next's list of HTML-limited bots.
 *
 * A server component with no client code: no wallet loads here.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { DOCS_HOME } from "@/lib/docs/pages";
import { BRAND, SHARE_COPY } from "@/lib/live-copy";
import { SHARE_CARD, shareHero, shareImagePath, type ShareCardData, type ShareUnit } from "@/lib/live-share";
import { SHARE_RENDER_VERSION } from "@/lib/share-render-version";
import { NOT_INDEXED } from "@/lib/seo";

export interface SharedCard {
  /** The page's own path: "/c/<token>", "/c/example/vault". */
  readonly page: string;
  readonly card: ShareCardData;
  readonly unit: ShareUnit;
}

/** The headline, and the image's description, for this card. */
function wordsOf({ card, unit }: SharedCard): { readonly title: string; readonly alt: string } {
  const hero = shareHero(card, unit);
  const figure = hero === null ? null : hero.unit === null ? hero.number : `${hero.number} ${hero.unit}`;
  const rule = `${card.rate} ${SHARE_COPY.card.measure[card.mode]}`;
  if (card.example) return { title: SHARE_COPY.page.example.title, alt: SHARE_COPY.page.example.alt(figure ?? rule) };
  if (figure !== null) return { title: SHARE_COPY.page.title(figure), alt: SHARE_COPY.page.alt(figure) };
  return card.paused ? { title: SHARE_COPY.page.titleZeroPaused, alt: SHARE_COPY.page.altZero(rule) } : { title: SHARE_COPY.page.titleZero(rule), alt: SHARE_COPY.page.altZero(rule) };
}

/** The card's picture, at the renderer's version. */
export const sharedImageOf = (shared: SharedCard): string => shareImagePath(shared.page, SHARE_RENDER_VERSION);

export function sharedCardMetadata(shared: SharedCard): Metadata {
  const { title, alt } = wordsOf(shared);
  const description = SHARE_COPY.page.description;
  const image = { url: sharedImageOf(shared), width: SHARE_CARD.width, height: SHARE_CARD.height, type: "image/png", alt };
  return {
    title,
    description,
    robots: NOT_INDEXED,
    openGraph: { siteName: BRAND, type: "website", locale: "en_US", title, description, url: shared.page, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export function SharedCardPage(shared: SharedCard) {
  const { alt } = wordsOf(shared);
  const said = shared.card.example ? SHARE_COPY.page.example.readOn : SHARE_COPY.page.readOn(shared.card.asOf);
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10 text-foreground sm:px-6">
      {/* A plain <img>: the picture is already the size X takes, and it is this site's own address. */}
      <img
        src={sharedImageOf(shared)}
        width={SHARE_CARD.width}
        height={SHARE_CARD.height}
        alt={alt}
        className="block h-auto w-full max-w-3xl rounded-xl bg-[#0A0B11] shadow-lg ring-1 ring-foreground/10"
      />
      <p className="max-w-3xl text-center text-sm text-muted-foreground">{said}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button asChild size="lg" className="px-4">
          <Link href="/">{SHARE_COPY.page.start}</Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="px-4">
          <Link href={DOCS_HOME}>{SHARE_COPY.page.docs}</Link>
        </Button>
      </div>
    </main>
  );
}
