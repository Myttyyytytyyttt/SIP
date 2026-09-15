/**
 * POST /api/solana-vault {"action":"state","owner","wallets":[…]} — what the
 * wallets screen shows, read server-side.
 *
 * The pension key's vault, investment policy and the protocol config; for each
 * of up to 10 trading wallets, whether it saves into this vault, another one, or
 * none; the rent a vault and a link cost; and the live SOL/USDC and SPYx/USDC
 * pool rates. Each read keeps its own outcome, and a read that failed is
 * "unreadable", never "missing", so the page never offers to create what may
 * already exist. Bigints travel as decimal strings.
 *
 * Unauthenticated on purpose: it returns public chain state only, and it is
 * rate-limited like the build route. The readers and the handler live in
 * @sip/solana-core (readers.ts, build-handler.ts) and are tested there.
 *
 * 503, with no detail, when the Solana settings are incomplete or the environment
 * holds a refused name.
 */
import { solanaVaultRoute } from "@/lib/solana-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const route = solanaVaultRoute();

export const POST = route.POST;
export const GET = route.GET;
