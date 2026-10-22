/** /c/example/card.png — the sample's card on Grid, drawn once at build time (components/share-og.tsx). */
import { shareCardImage } from "@/components/share-og";
import { exampleShared } from "@/lib/share-example";

export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return shareCardImage(exampleShared("grid"));
}
