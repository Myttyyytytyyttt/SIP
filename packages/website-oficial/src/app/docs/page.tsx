/**
 * /docs — the first page of the index. A redirect rather than a second copy of
 * that page, so every page has exactly one address.
 *
 * PERMANENT (308, 10-22): a temporary one (307) tells a search engine to keep
 * /docs as an address of its own; a permanent one hands it on to the page.
 */

import { permanentRedirect } from "next/navigation";

import { FIRST_DOC, docHref } from "@/lib/docs/pages";

export default function DocsIndex(): never {
  permanentRedirect(docHref(FIRST_DOC.slug));
}
