/**
 * /docs — the first page of the index. A redirect rather than a second copy of
 * that page, so every page has exactly one address.
 */

import { redirect } from "next/navigation";

import { FIRST_DOC, docHref } from "@/lib/docs/pages";

export default function DocsIndex(): never {
  redirect(docHref(FIRST_DOC.slug));
}
