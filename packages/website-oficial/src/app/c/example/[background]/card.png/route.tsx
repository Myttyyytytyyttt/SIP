/** /c/example/<background>/card.png — the sample's card on Streaks or Vault, drawn once at build time. */
import { shareCardImage } from "@/components/share-og";
import { EXAMPLE_SUBPAGES, exampleShared } from "@/lib/share-example";
import type { ShareBackground } from "@/lib/live-share";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams(): { background: string }[] {
  return EXAMPLE_SUBPAGES.map((background) => ({ background }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ background: string }> }): Promise<Response> {
  const { background } = await params;
  if (!(EXAMPLE_SUBPAGES as readonly string[]).includes(background)) return new Response("Not found", { status: 404 });
  return shareCardImage(exampleShared(background as ShareBackground));
}
