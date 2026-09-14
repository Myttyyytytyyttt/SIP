/**
 * POST /api/solana-rpc — the browser's only Solana HTTP RPC, and a narrow one.
 *
 * WHY IT EXISTS. Privy's Solana signing UI needs an RPC it can reach from the
 * page (solana.rpcs in src/app/providers.tsx), and the upstream for this
 * deployment, SIP_SOLANA_RPC_URLS, carries a Helius key. So the browser gets this
 * same-origin endpoint, and the key never leaves the server.
 *
 * WHAT IT RELAYS: only what Privy's signing UI and the pages' live reads need:
 * blockhash, fee, a constrained simulation, balances, account reads with bounded
 * shapes, signature status and block height. History and link listing
 * (getProgramAccounts, getSignaturesForAddress, getTransaction) are NOT relayed;
 * they are read server-side. sendTransaction is not relayed either: broadcasts go
 * through /api/solana-tx, verified. The allowlist, the per-method parameter
 * rules, the weights, the per-client, per-network and process-wide budgets, the
 * in-flight caps, the body cap and the per-method response caps, and the refusal
 * order all live in @sip/solana-core (relay-policy.ts, handlers.ts) and are
 * tested there.
 *
 * 503, with no detail, when the Solana settings are incomplete or the environment
 * holds a refused name (the page's setup checklist names them).
 */
import { solanaRpcRoute } from "@/lib/solana-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = solanaRpcRoute();

export const POST = route.POST;
export const GET = route.GET;
