/**
 * POST /api/share — the share card's signed links (lib/share-server.ts).
 *
 * {"action":"link","owner":…,"streak":[…]} answers the card as the server reads
 * it from the chain, and one /c/<token> link per background and unit, signed
 * with SIP_SHARE_SECRET. Without that secret it is 404 share_links_off, before
 * any read, and the dialog shares the site as it did before.
 *
 * Unauthenticated on purpose, like /api/solana-live: it reads public chain
 * state only, and the links it signs carry nothing but what the card prints.
 * Rate-limited per client and per network like the Solana routes, from the
 * reads budget they share, plus a budget of its own. Under /api/, so robots.txt
 * keeps crawlers off it; the pages and images it links to are under /c/.
 */
import { shareRoute } from "@/lib/share-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const route = shareRoute();

export const POST = route.POST;
export const GET = route.GET;
