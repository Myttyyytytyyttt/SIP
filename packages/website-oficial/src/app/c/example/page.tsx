/** /c/example — the sample's shared card on Grid (lib/share-example.ts): built once, at build time. */
import type { Metadata } from "next";

import { SharedCardPage, sharedCardMetadata } from "@/components/shared-card-page";
import { exampleShared } from "@/lib/share-example";

export const dynamic = "force-static";

const shared = exampleShared("grid");

export const metadata: Metadata = sharedCardMetadata(shared);

export default function ExampleCard() {
  return <SharedCardPage page={shared.page} card={shared.card} unit={shared.unit} />;
}
