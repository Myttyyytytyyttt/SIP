/**
 * POST /api/solana-live — what the CONNECTED dashboard reads, and nothing else.
 *
 * Two actions. {"action":"snapshot"} answers the vault, its investment policy,
 * the protocol config, the pinned pools' prices, the vault's own wSOL, USDC and
 * SPYx accounts, the rents, and each trading wallet's balance and link — all in
 * ONE upstream batch, so a dashboard that polls once a minute costs four calls.
 * {"action":"activity"} answers one page of the vault's history with every
 * transaction already classified (settled, wrapped, converted, invested,
 * withdrew…), so the browser labels a row without re-deriving it from log text.
 *
 * Each read keeps its own outcome, and a read that failed is "unreadable", never
 * "missing": the dashboard then says it could not read, instead of showing a
 * zero balance or offering to create a vault that may already exist.
 *
 * Its per-client buckets are its own, so the Manage wallets modal's
 * /api/solana-vault reads cannot starve it; upstream it charges the one reads
 * budget the build and vault routes already share. The handler and its readers
 * live in @sip/solana-core (readers.ts, build-handler.ts) and are tested there.
 *
 * Unauthenticated on purpose: it returns public chain state only. 503, with no
 * detail, when the Solana settings are incomplete or the environment holds a
 * refused name.
 */
import { solanaLiveRoute } from "@/lib/solana-routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const route = solanaLiveRoute();

export const POST = route.POST;
export const GET = route.GET;
