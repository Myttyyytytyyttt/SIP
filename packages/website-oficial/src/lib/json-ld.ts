/**
 * STRUCTURED DATA (schema.org JSON-LD): what SaverFi is, said to a search engine
 * in a form it does not have to guess at (owner, 10-22: found when someone
 * searches "SaverFi").
 *
 * - THE LANDING says who publishes the site (Organization, whose logo Google
 *   may show beside the results) and what the site is called (WebSite, on the
 *   home page, is what Google asks for to name a site above its results). Only
 *   what the site itself says: no sameAs until the footer's X and GitHub links
 *   are real (they are "#" today).
 * - NO WebApplication (review, 10-22). Google reads it as a Software App, whose
 *   rich result REQUIRES an aggregateRating or a review: without one, Search
 *   Console lists the landing as an invalid item, and the site has no rating to
 *   give — inventing one is out. It earned nothing for a search for "SaverFi"
 *   either: the site's name comes from WebSite, its logo from Organization.
 * - EVERY DOCS PAGE says where it sits: SaverFi › Docs › (its parent) › the page.
 *
 * Every address is absolute, on the configured site (src/lib/site-url.ts).
 */

import { BRAND } from "@/lib/live-copy";
import { DOCS_HOME, docHref, docPage, type DocEntry } from "@/lib/docs/pages";
import { SITE_LOGO } from "@/lib/seo";
import { absoluteUrl } from "@/lib/site-url";

export type JsonLdNode = { readonly "@type": string } & Readonly<Record<string, unknown>>;
export type JsonLdDocument = { readonly "@context": "https://schema.org"; readonly "@graph": readonly JsonLdNode[] };

/** The landing's publisher and its site, as one graph whose nodes point at each other by @id. */
export function homeJsonLd(site: URL): JsonLdDocument {
  const home = absoluteUrl("/", site);
  const organization = `${home}#organization`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organization,
        name: BRAND,
        url: home,
        logo: { "@type": "ImageObject", url: absoluteUrl(SITE_LOGO.path, site), width: SITE_LOGO.width, height: SITE_LOGO.height },
        description: `${BRAND} builds you a pension from your trading, on Solana.`,
      },
      {
        "@type": "WebSite",
        "@id": `${home}#website`,
        name: BRAND,
        alternateName: ["Saver Fi"],
        url: home,
        inLanguage: "en",
        publisher: { "@id": organization },
      },
    ],
  };
}

/**
 * A docs page's place: SaverFi › Docs › its parent, if it is a sub-page › the
 * page. The first page IS the docs' home (the header's Docs link lands there),
 * so its trail ends at "Docs" instead of naming the same address twice.
 */
export function docBreadcrumbJsonLd(page: DocEntry, site: URL): JsonLdDocument {
  const trail: { readonly name: string; readonly path: string }[] = [{ name: BRAND, path: "/" }, { name: "Docs", path: DOCS_HOME }];
  const parent = page.parent === undefined ? null : docPage(page.parent);
  if (parent !== null) trail.push({ name: parent.title, path: docHref(parent.slug) });
  if (docHref(page.slug) !== DOCS_HOME) trail.push({ name: page.title, path: docHref(page.slug) });
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: trail.map((step, at) => ({ "@type": "ListItem", position: at + 1, name: step.name, item: absoluteUrl(step.path, site) })),
      },
    ],
  };
}

/**
 * The text that goes inside <script type="application/ld+json">. JSON is not
 * safe there as it is: a "</script>" inside a string would end the element, so
 * every "<", ">" and "&" leaves as its \u escape — still the same JSON to any
 * parser — and so do U+2028 and U+2029, which old JavaScript parsers read as
 * line ends.
 */
export function serializeJsonLd(data: JsonLdDocument): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
