/**
 * GET and PUT /api/wallet-names — an account's own names for its trading
 * wallets (lib/wallet-names-server.ts; owner, 10-23).
 *
 * Node, and dynamic: the store is reached with the OIDC token Vercel hands each
 * request, so nothing here may run at build time or outside a request. Under
 * /api/, so robots.txt keeps crawlers off it.
 */
import { walletNamesRoute } from "@/lib/wallet-names-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = walletNamesRoute();

export const GET = route.GET;
export const PUT = route.PUT;
