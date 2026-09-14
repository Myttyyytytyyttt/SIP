/**
 * POST /api/solana-tx {"action":"send","signedTxBase64":"…"} — verified broadcast.
 *
 * The browser signs (Privy useSignTransaction: the pension key first, then, for a
 * link, the trading wallet) and posts the finished bytes here. This route never
 * signs and never holds a key. Before anything reaches an endpoint the core's
 * verifier requires, among other rules:
 * - one owner-facing SIP instruction (create_vault_v2, set_policy_v2, link_wallet,
 *   unlink_wallet, withdraw, withdraw_token, set_invest_policy), plus at most a
 *   bounded ComputeBudget;
 * - discriminators and account order taken from the IDL;
 * - canonical bytes with no lookup tables, and 1 or 2 signatures, every one valid;
 * - the owner bound to the fee payer, and wallet != owner for a link.
 * Nuvem's old program id is refused anywhere in the message. Only a transaction
 * that verified spends the process-wide send budget. It is then simulated with
 * sigVerify, sent without a second preflight, and answered with its signature.
 * The client confirms through /api/solana-rpc. A send the endpoint never
 * acknowledged is 502 send_unconfirmed and still carries the signature: confirm
 * it before the owner signs again, or a second write can land.
 *
 * 404 unless SIP_CHAIN=solana. The build actions arrive with the vault screens.
 */
import { solanaTxRoute } from "@/lib/solana-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = solanaTxRoute();

export const POST = route.POST;
export const GET = route.GET;
