/**
 * /c/<token>/card.png — A SHARED CARD'S PICTURE, drawn on the server
 * (components/share-og.tsx) from a token this server signed, never from
 * figures a URL states.
 *
 * ONE ADDRESS PER PICTURE. At ?v=<the renderer's version> it is cached for a
 * year, by browsers and by the CDN (SHARE_IMAGE_IMMUTABLE): X and the rest
 * fetch it once. Any other query is sent there (308), so nobody can make the
 * server draw the same card again by varying the URL. A token that does not
 * verify is a 404, kept five minutes.
 *
 * Outside /api/ on purpose: robots.txt keeps crawlers off /api/, and X's
 * crawler obeys it — a preview behind it would never show.
 */
import { shareCardImage } from "@/components/share-og";
import { shareImagePath } from "@/lib/live-share";
import { SHARE_RENDER_VERSION } from "@/lib/share-render-version";
import { openShareToken } from "@/lib/share-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const opened = openShareToken(token);
  if (opened === null) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
  const canonical = shareImagePath(`/c/${token}`, SHARE_RENDER_VERSION);
  if (new URL(request.url).search !== `?v=${SHARE_RENDER_VERSION}`) return new Response(null, { status: 308, headers: { location: canonical, "cache-control": "public, max-age=3600" } });
  return shareCardImage(opened);
}
