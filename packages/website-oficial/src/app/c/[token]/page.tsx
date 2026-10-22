/**
 * /c/<token> — A SHARED CARD (owner, 10-22: "Enlace con vista previa"): the page
 * a post on X links to, whose preview is the card (components/shared-card-page.tsx).
 *
 * The token is the card: lib/share-token.ts verifies it — the MAC under the
 * secret in force, then a schema that accepts nothing it does not name — and
 * anything else is a 404. Rendered per request (a token is not a page the build
 * knows, and random ones must not fill a cache), but it reads nothing: no chain,
 * no RPC, only the token.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SharedCardPage, sharedCardMetadata } from "@/components/shared-card-page";
import { NOT_INDEXED } from "@/lib/seo";
import { openShareToken } from "@/lib/share-token";

export const dynamic = "force-dynamic";

type Props = { readonly params: Promise<{ readonly token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const opened = openShareToken(token);
  return opened === null ? { robots: NOT_INDEXED } : sharedCardMetadata({ page: `/c/${token}`, card: opened.card, unit: opened.unit });
}

export default async function SharedCard({ params }: Props) {
  const { token } = await params;
  const opened = openShareToken(token);
  if (opened === null) notFound();
  return <SharedCardPage page={`/c/${token}`} card={opened.card} unit={opened.unit} />;
}
