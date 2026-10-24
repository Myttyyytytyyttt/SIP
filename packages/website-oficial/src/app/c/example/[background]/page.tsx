/** /c/example/streaks and /c/example/vault — the sample's shared card on the other backgrounds (lib/share-example.ts), built at build time. */
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SharedCardPage, sharedCardMetadata } from "@/components/shared-card-page";
import { EXAMPLE_SUBPAGES, exampleShared } from "@/lib/share-example";
import type { ShareBackground } from "@/lib/live-share";

export const dynamic = "force-static";
export const dynamicParams = false;

type Props = { readonly params: Promise<{ readonly background: string }> };

export function generateStaticParams(): { background: string }[] {
  return EXAMPLE_SUBPAGES.map((background) => ({ background }));
}

const known = (name: string): ShareBackground | null => (EXAMPLE_SUBPAGES as readonly string[]).includes(name) ? (name as ShareBackground) : null;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const background = known((await params).background);
  return background === null ? {} : sharedCardMetadata(exampleShared(background));
}

export default async function ExampleCardOn({ params }: Props) {
  const background = known((await params).background);
  if (background === null) notFound();
  const shared = exampleShared(background);
  return <SharedCardPage page={shared.page} card={shared.card} unit={shared.unit} />;
}
