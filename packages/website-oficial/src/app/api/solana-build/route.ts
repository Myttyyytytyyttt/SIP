/**
 * POST /api/solana-build — unsigned owner transactions, built on the server.
 *
 * - {"action":"createVault","owner","mode":0|1,"maxContribution"?,"walletReserve"?,
 *   "skimBps"?,"volumeBps"?} → an unsigned create_vault_v2 behind its compute
 *   budget, and what it costs. Missing fields take the product's defaults; mode 1
 *   is refused while VOLUME is not offered.
 * - {"action":"prepareLink","owner","wallet"} → the SIP_LINK_V1 consent the
 *   trading wallet signs with signMessage.
 * - {"action":"link","owner","wallet","consentSignature"} → the link transaction,
 *   [compute budget, Ed25519SigVerify, link_wallet], that the pension key signs
 *   first and the trading wallet second.
 *
 * WHAT IT IS NOT. It holds no key, signs nothing and takes no blockhash from the
 * browser. Its answer is advice: the page checks the bytes against what the
 * person asked for before any wallet signs, and /api/solana-tx verifies and
 * simulates what comes back. The builders, the refusals, the limits and their
 * order live in @sip/solana-core (build-handler.ts) and are tested there.
 *
 * 503, with no detail, when the Solana settings are incomplete or the environment
 * holds a refused name, exactly like the relay and the send route.
 */
import { solanaBuildRoute } from "@/lib/solana-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A build reads the chain twice at most, each bounded by the pool's timeout.
export const maxDuration = 60;

const route = solanaBuildRoute();

export const POST = route.POST;
export const GET = route.GET;
