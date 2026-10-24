/**
 * /c/<token>/card.png and /c/<code>/card.png — A SHARED CARD'S PICTURE, drawn
 * on the server (components/share-og.tsx) from a token this server signed —
 * given in the address, or kept under a short code (lib/share-store.ts) —
 * never from figures a URL states.
 *
 * ONE ADDRESS PER PICTURE. At ?v=<the renderer's version> it is cached for a
 * year, by browsers and by the CDN (SHARE_IMAGE_IMMUTABLE): X and the rest
 * fetch it once. A path or a query that is not exactly that address is sent
 * there (308): another ?v, an extra parameter, a token with a character
 * percent-encoded in the path. A token that does not verify, or a code with no
 * card, is a 404, kept five minutes. A code whose store did not answer just now
 * is a 503 that nothing keeps (10-23): the next ask reads again.
 *
 * AND ONE DRAWING PER INSTANCE (review, 10-22). Next hands a route its query
 * already decoded and re-encoded, so "?%76=<version>" and "?v=<version>&"
 * arrive here as the very address above and cannot be told from it — yet to
 * the CDN each is a key of its own, and each reached this route and drew the
 * card again. So the picture is drawn once per instance and kept by its
 * address (drawnOnce): a variant of a card's URL costs a lookup, not a render.
 * Requests the CDN lets through are the platform's to rate-limit (a firewall
 * rule on the /c/<token>/card.png addresses), not this route's.
 *
 * Outside /api/ on purpose: robots.txt keeps crawlers off /api/, and X's
 * crawler obeys it — a preview behind it would never show.
 */
import { SHARE_IMAGE_IMMUTABLE, drawnOnce, shareCardImage } from "@/components/share-og";
import { shareImagePath } from "@/lib/live-share";
import { SHARE_RENDER_VERSION } from "@/lib/share-render-version";
import { openSharedCard } from "@/lib/share-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const shared = await openSharedCard(token);
  if (shared.kind === "unavailable") {
    return new Response("Try again in a minute", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "60" } });
  }
  if (shared.kind === "missing") return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
  const opened = shared.opened;
  const canonical = shareImagePath(`/c/${token}`, SHARE_RENDER_VERSION);
  const asked = new URL(request.url);
  if (`${asked.pathname}${asked.search}` !== canonical) return new Response(null, { status: 308, headers: { location: canonical, "cache-control": "public, max-age=3600" } });
  const png = await drawnOnce(canonical, () => shareCardImage(opened));
  return new Response(png as BodyInit, { status: 200, headers: { "content-type": "image/png", "cache-control": SHARE_IMAGE_IMMUTABLE } });
}
