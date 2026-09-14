/**
 * POST /api/solana-tx {"action":"send","signedTxBase64":"…"} — verified broadcast.
 *
 * The browser signs (Privy useSignTransaction: the pension key first, then, for a
 * link, the trading wallet) and posts the finished bytes here. A link needs one
 * signature before that: the trading wallet's signMessage over the SIP_LINK_V1
 * consent (prepareLinkWalletConsent, then buildLinkWallet in @sip/solana-core),
 * which the transaction carries as an Ed25519SigVerify instruction right before
 * link_wallet. This route never signs and never holds a key. Before anything
 * reaches an endpoint the core's verifier requires, among other rules:
 * - one owner-facing SIP instruction (create_vault_v2, set_policy_v2, link_wallet,
 *   unlink_wallet, withdraw, withdraw_token, set_invest_policy), plus at most a
 *   bounded ComputeBudget and, for link_wallet only, that consent immediately
 *   before it: the wallet's key, the SIP_LINK_V1 bytes for this program, wallet,
 *   vault and owner, and a signature that verifies;
 * - discriminators, account order and fixed addresses taken from the IDL;
 * - canonical bytes with no lookup tables, and 1 or 2 signatures, every one valid;
 * - the owner bound to the fee payer, wallet != owner for a link, and the owner
 *   alone as an unlink's authority and signer.
 * Nuvem's old program id is refused anywhere in the message. Only a transaction
 * that verified spends the process-wide send budget. It is then simulated with
 * sigVerify, sent without a second preflight, and answered with its signature.
 * The client confirms through /api/solana-rpc. A send the endpoint never
 * acknowledged is 502 send_unconfirmed and still carries the signature: confirm
 * it before the owner signs again, or a second write can land.
 *
 * 503, with no detail, when the Solana settings are incomplete or the environment
 * holds a refused name. The build actions arrive with the vault screens.
 */
import { solanaTxRoute } from "@/lib/solana-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = solanaTxRoute();

export const POST = route.POST;
export const GET = route.GET;
