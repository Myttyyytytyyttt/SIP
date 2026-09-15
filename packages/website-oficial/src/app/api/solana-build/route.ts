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
 * - {"action":"investPolicy","owner","maxPerCall"?,"maxRolling30d"?,"enabled"?} →
 *   set_invest_policy for SPYx at floors read from the pools right now (90 % of
 *   SOL's price, 95 % of SPYx's rate), behind a CreateIdempotent for each of the
 *   vault's wSOL, USDC and SPYx accounts it lacks, paid by the owner; the floors,
 *   those accounts and every rent come with it.
 * - {"action":"withdraw","owner","lamports"} → withdraw, at most what the vault
 *   holds above its rent floor.
 * - {"action":"withdrawToken","owner","mint","amountRaw"} → withdraw_token from
 *   the vault's largest holding of that mint, its account and token program read
 *   from the chain.
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
