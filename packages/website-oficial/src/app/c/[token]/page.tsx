/**
 * /c/<token> and /c/<code> — A SHARED CARD (owner, 10-22: "Enlace con vista
 * previa"; 10-23, short: "que sean como /c/xxxxxxx y ya"): the page a post on X
 * links to, whose preview is the card (components/shared-card-page.tsx).
 *
 * The address is the card, in either form (lib/share-store.ts openSharedCard).
 * A long token is verified as it always was — the MAC under the secret in
 * force, then a schema that accepts nothing it does not name — and reads
 * nothing. An 8-character code is checked against the secret before anything
 * else, then its record is read from the Blob store, once per instance, and
 * the token in it verified the same way. Anything else is a 404.
 *
 * Rendered per request (a token is not a page the build knows, and random ones
 * must not fill a cache). A code is the same card forever, so its page asks
 * Vercel's CDN to keep it a year (next.config.mjs; best effort, per
 * deployment), and its record is read once per instance either way. A store
 * that cannot answer just now is an error page, a 500, which Vercel's CDN
 * never keeps whatever the header says (it keeps 200, 404, 410, 301, 302, 307
 * and 308 only): the next visit tries again.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SharedCardPage, sharedCardMetadata } from "@/components/shared-card-page";
import { NOT_INDEXED } from "@/lib/seo";
import { openSharedCard } from "@/lib/share-store";

export const dynamic = "force-dynamic";

type Props = { readonly params: Promise<{ readonly token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const shared = await openSharedCard(token);
  return shared.kind !== "card" ? { robots: NOT_INDEXED } : sharedCardMetadata({ page: `/c/${token}`, card: shared.opened.card, unit: shared.opened.unit });
}

export default async function SharedCard({ params }: Props) {
  const { token } = await params;
  const shared = await openSharedCard(token);
  // Not a 404: the link is fine, the store did not answer. A 500 is never kept by the CDN, so the next visit reads again.
  if (shared.kind === "unavailable") throw new Error("This SaverFi link could not be opened just now. Try again in a minute.");
  if (shared.kind === "missing") notFound();
  return <SharedCardPage page={`/c/${token}`} card={shared.opened.card} unit={shared.opened.unit} />;
}
